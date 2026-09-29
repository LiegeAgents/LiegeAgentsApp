import type { Pool, PoolClient } from 'pg'
import { createPublicClient, createWalletClient, decodeEventLog, erc20Abi, http, parseUnits, type Address, type Chain, type Hash } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { env } from './config.js'
import { decryptEscrowPrivateKey, encryptEscrowPrivateKey } from './crypto.js'
import { ApiError } from './http.js'

type Queryable = Pool | PoolClient
type EscrowWallet = { job_id: string; address: string; encrypted_private_key: string }
type FundingInput = { usdgTxHash: string; gasTxHash: string; quoteId: string }
const robinhoodChain: Chain = { id: env.RHC_ID, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [env.RHC_RPC_URL] } } }
const publicClient = createPublicClient({ chain: robinhoodChain, transport: http(env.RHC_RPC_URL) })
const usdg = () => {
  if (!env.USDG_TOKEN_ADDRESS) throw new ApiError(503, 'onchain_escrow_unconfigured', 'On-chain escrow is not configured.')
  return env.USDG_TOKEN_ADDRESS.toLowerCase() as Address
}
const address = (value: string) => value.toLowerCase() as Address
const hash = (value: string) => {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new ApiError(422, 'invalid_transaction_hash', 'A valid transaction hash is required.')
  return value.toLowerCase() as Hash
}

export async function ensureEscrowWallet(client: Queryable, jobId: string) {
  const existing = await client.query<EscrowWallet>('SELECT * FROM escrow_wallets WHERE job_id = $1', [jobId])
  if (existing.rowCount) return { address: existing.rows[0].address }
  const privateKey = generatePrivateKey()
  const account = privateKeyToAccount(privateKey)
  const created = await client.query<EscrowWallet>(
    'INSERT INTO escrow_wallets (job_id, address, encrypted_private_key) VALUES ($1,$2,$3) ON CONFLICT (job_id) DO UPDATE SET job_id = EXCLUDED.job_id RETURNING *',
    [jobId, account.address.toLowerCase(), encryptEscrowPrivateKey(privateKey)],
  )
  return { address: created.rows[0].address }
}

let cachedPrice: { value: number; expiresAt: number } | null = null
async function ethUsdPrice() {
  if (cachedPrice && cachedPrice.expiresAt > Date.now()) return cachedPrice.value
  const sources = [
    async () => Number((await (await fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot', { headers: { Accept: 'application/json' } })).json()).data?.amount),
    async () => Number((await (await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd', { headers: { Accept: 'application/json' } })).json()).ethereum?.usd),
  ]
  for (const source of sources) {
    try { const value = await source(); if (Number.isFinite(value) && value > 0) { cachedPrice = { value, expiresAt: Date.now() + 60_000 }; return value } } catch {}
  }
  throw new ApiError(503, 'eth_price_unavailable', 'Could not obtain an ETH/USD quote. Try again shortly.')
}

export async function createFundingQuote(client: Queryable, jobId: string) {
  const price = await ethUsdPrice()
  const eth = (env.ESCROW_GAS_RESERVE_USD / price).toFixed(18)
  const reserveWei = parseUnits(eth, 18)
  const expiresAt = new Date(Date.now() + env.ESCROW_QUOTE_TTL_SECONDS * 1000)
  const result = await client.query<{ id: string }>(
    'INSERT INTO escrow_funding_quotes (job_id, gas_reserve_wei, eth_usd_price, expires_at) VALUES ($1,$2,$3,$4) RETURNING id',
    [jobId, reserveWei.toString(), price, expiresAt],
  )
  return { quoteId: result.rows[0].id, gasReserveWei: reserveWei.toString(), ethUsdPrice: price, expiresAt }
}

export async function verifyOnchainFunding(client: Queryable, input: FundingInput, expected: { jobId: string; clientAddress: string; budgetUsdg: string; evaluatorFeeUsdg: string }) {
  const quote = await client.query<{ gas_reserve_wei: string }>('SELECT gas_reserve_wei FROM escrow_funding_quotes WHERE id = $1 AND job_id = $2 AND expires_at > now()', [input.quoteId, expected.jobId])
  if (!quote.rowCount) throw new ApiError(422, 'expired_funding_quote', 'This gas-reserve quote has expired. Request a new quote.')
  const wallet = await client.query<EscrowWallet>('SELECT * FROM escrow_wallets WHERE job_id = $1', [expected.jobId])
  if (!wallet.rowCount) throw new ApiError(409, 'escrow_wallet_missing', 'This job does not yet have an escrow wallet.')
  const [tokenReceipt, gasReceipt, tokenTx, gasTx] = await Promise.all([
    publicClient.waitForTransactionReceipt({ hash: hash(input.usdgTxHash), confirmations: env.ESCROW_CONFIRMATIONS }),
    publicClient.waitForTransactionReceipt({ hash: hash(input.gasTxHash), confirmations: env.ESCROW_CONFIRMATIONS }),
    publicClient.getTransaction({ hash: hash(input.usdgTxHash) }),
    publicClient.getTransaction({ hash: hash(input.gasTxHash) }),
  ])
  if (tokenReceipt.status !== 'success' || gasReceipt.status !== 'success') throw new ApiError(422, 'funding_transaction_failed', 'Both USDG and ETH reserve transfers must succeed.')
  const clientAddress = address(expected.clientAddress), escrowAddress = address(wallet.rows[0].address)
  if (tokenTx.from.toLowerCase() !== clientAddress || gasTx.from.toLowerCase() !== clientAddress || gasTx.to?.toLowerCase() !== escrowAddress || gasTx.value !== BigInt(quote.rows[0].gas_reserve_wei)) throw new ApiError(422, 'invalid_funding_sender', 'Funding transfers must come from the client wallet and use the quoted ETH reserve.')
  const expectedRaw = parseUnits(expected.budgetUsdg, env.USDG_DECIMALS) + parseUnits(expected.evaluatorFeeUsdg, env.USDG_DECIMALS)
  const transfer = tokenReceipt.logs.map(log => { try { return { address: log.address, decoded: decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics }) } } catch { return null } }).find(event => event?.decoded.eventName === 'Transfer' && event.address.toLowerCase() === usdg() && event.decoded.args.from?.toLowerCase() === clientAddress && event.decoded.args.to?.toLowerCase() === escrowAddress && event.decoded.args.value === expectedRaw)
  if (!transfer) throw new ApiError(422, 'invalid_usdg_deposit', 'The USDG transfer does not match this job escrow and amount.')
  return { usdgTxHash: hash(input.usdgTxHash), gasTxHash: hash(input.gasTxHash), usdgAmountRaw: expectedRaw.toString(), gasAmountWei: quote.rows[0].gas_reserve_wei, escrowAddress: wallet.rows[0].address }
}

async function escrowAccount(client: Queryable, jobId: string) {
  const wallet = await client.query<EscrowWallet>('SELECT * FROM escrow_wallets WHERE job_id = $1', [jobId])
  if (!wallet.rowCount) throw new ApiError(409, 'escrow_wallet_missing', 'This job does not have an escrow wallet.')
  return privateKeyToAccount(decryptEscrowPrivateKey(wallet.rows[0].encrypted_private_key) as `0x${string}`)
}
async function transferUsdg(client: Queryable, jobId: string, recipient: string, amountRaw: bigint) {
  const account = await escrowAccount(client, jobId)
  const wallet = createWalletClient({ account, chain: robinhoodChain, transport: http(env.RHC_RPC_URL) })
  const txHash = await wallet.writeContract({ address: usdg(), abi: erc20Abi, functionName: 'transfer', args: [address(recipient), amountRaw] })
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: env.ESCROW_CONFIRMATIONS })
  if (receipt.status !== 'success') throw new ApiError(502, 'escrow_payout_failed', 'The escrow USDG transfer failed.')
  return txHash.toLowerCase()
}
async function sweepEth(client: Queryable, jobId: string, recipient: string) {
  const account = await escrowAccount(client, jobId)
  const balance = await publicClient.getBalance({ address: account.address })
  const gasPrice = await publicClient.getGasPrice()
  const cost = 21_000n * gasPrice
  if (balance <= cost) return null
  const wallet = createWalletClient({ account, chain: robinhoodChain, transport: http(env.RHC_RPC_URL) })
  const txHash = await wallet.sendTransaction({ to: address(recipient), value: balance - cost, gas: 21_000n, gasPrice })
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: env.ESCROW_CONFIRMATIONS })
  if (receipt.status !== 'success') throw new ApiError(502, 'gas_reserve_refund_failed', 'The remaining ETH reserve could not be returned.')
  return txHash.toLowerCase()
}

export async function settleOnchainEscrow(client: Queryable, input: { jobId: string; outcome: 'accepted' | 'rejected'; clientAddress: string; providerAddress: string; evaluatorAddress: string; budgetUsdg: string; evaluatorFeeUsdg: string }) {
  const budget = parseUnits(input.budgetUsdg, env.USDG_DECIMALS), evaluatorFee = parseUnits(input.evaluatorFeeUsdg, env.USDG_DECIMALS)
  const providerTxHash = input.outcome === 'accepted' ? await transferUsdg(client, input.jobId, input.providerAddress, budget) : null
  const evaluatorTxHash = input.outcome === 'accepted' && evaluatorFee > 0n ? await transferUsdg(client, input.jobId, input.evaluatorAddress, evaluatorFee) : null
  const refundTxHash = input.outcome === 'rejected' ? await transferUsdg(client, input.jobId, input.clientAddress, budget + evaluatorFee) : null
  const gasRefundTxHash = await sweepEth(client, input.jobId, input.clientAddress)
  return { providerTxHash, evaluatorTxHash, refundTxHash, gasRefundTxHash }
}
