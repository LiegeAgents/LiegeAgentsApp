// Network values verified against Robinhood's official documentation, 26 Sep 2026.
export const ROBINHOOD = Object.freeze({
  chainId: '0x1237', chainName: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'],
  blockExplorerUrls: ['https://robinhoodchain.blockscout.com'],
})
export const WALLETS = {
  walletconnect: { name: 'WalletConnect' },
}
export const chainHex = value => { try { return '0x' + BigInt(value).toString(16) } catch { return null } }
export const firstAccount = accounts => Array.isArray(accounts) ? accounts.find(a => typeof a === 'string' && /^0x[\da-f]{40}$/i.test(a)) || null : null
export const shortAddress = address => address ? `${address.slice(0,6)}…${address.slice(-4)}` : ''
export const errorCode = error => Number(error?.code ?? error?.data?.originalError?.code ?? error?.cause?.code)
export function walletError(error, kind) {
  const code = errorCode(error)
  if (code === 4001) return 'Request cancelled in your wallet. You can try again when you’re ready.'
  if (code === -32002) return 'A request is already waiting in your wallet. Open the extension or app and approve or dismiss it first.'
  if (code === 4900 || code === 4901) return 'Your wallet is offline. Open it, check your connection, and try again.'
  if (kind === 'walletconnect' && [4902, 4200, -32601, -32602].includes(code)) return 'Select Robinhood Chain in your wallet, then reconnect through WalletConnect.'
  if (code === 4200 || code === -32601) return 'This wallet version cannot switch networks here. Select Robinhood Chain in your wallet, then reconnect.'
  return error?.userMessage || 'The wallet could not complete this connection. Open your wallet and try again.'
}
export function providerKind(provider, rdns) {
  if (!provider || typeof provider.request !== 'function') return null
  if (rdns) return Object.keys(WALLETS).find(k => WALLETS[k].rdns === rdns) || null
  if (provider.isPhantom) return 'phantom'
  if (provider.isMetaMask && !provider.isBraveWallet && !provider.isRabby && !provider.isCoinbaseWallet) return 'metamask'
  return null
}
export function discoverWallets(target, onProvider) {
  // WalletConnect owns provider discovery and mobile deep links. Keeping this no-op
  // maintains the WalletProvider interface without exposing extension-only choices.
  return () => {}
}
export async function createWalletConnectProvider(projectId) {
  if (!projectId) throw { userMessage: 'WalletConnect is not configured. Add VITE_WALLETCONNECT_PROJECT_ID and redeploy.' }
  const { EthereumProvider } = await import('@walletconnect/ethereum-provider')
  return EthereumProvider.init({
    projectId,
    chains: [4663],
    optionalChains: [4663],
    rpcMap: { 4663: ROBINHOOD.rpcUrls[0] },
    showQrModal: true,
    metadata: { name: 'Liege', description: 'Agent work marketplace on Robinhood Chain', url: location.origin, icons: [`${location.origin}/brand/logo-transparent.png`] },
  })
}
function ensureActive(signal) { if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError') }
export async function readWallet(provider) {
  const [accounts, chain] = await Promise.all([provider.request({method:'eth_accounts'}), provider.request({method:'eth_chainId'})])
  return {address:firstAccount(accounts), chain:chainHex(chain)}
}
export async function switchToRobinhood(provider, kind, signal) {
  ensureActive(signal)
  if (chainHex(await provider.request({method:'eth_chainId'})) !== ROBINHOOD.chainId) {
    ensureActive(signal)
    try { await provider.request({method:'wallet_switchEthereumChain',params:[{chainId:ROBINHOOD.chainId}]}) }
    catch (error) {
      ensureActive(signal)
      // Phantom supports this network natively; never attempt to add an unsupported custom chain.
      if (errorCode(error) !== 4902 || kind !== 'metamask') throw error
      await provider.request({method:'wallet_addEthereumChain',params:[ROBINHOOD]})
      ensureActive(signal)
      await provider.request({method:'wallet_switchEthereumChain',params:[{chainId:ROBINHOOD.chainId}]})
    }
  }
  ensureActive(signal)
  const result = await readWallet(provider)
  ensureActive(signal)
  if (!result.address) throw {userMessage:'No Ethereum account was shared. Unlock your wallet and connect an account.'}
  if (result.chain !== ROBINHOOD.chainId) throw {userMessage:'Your wallet is still on another network. Select Robinhood Chain and try again.'}
  return result
}
export async function connectWallet(provider, kind, signal) {
  ensureActive(signal)
  const accounts = kind === 'walletconnect' && typeof provider.enable === 'function'
    ? await provider.enable()
    : await provider.request({method:'eth_requestAccounts'})
  ensureActive(signal)
  if (!firstAccount(accounts)) throw {userMessage:'No Ethereum account was shared. Unlock your wallet and connect an account.'}
  return switchToRobinhood(provider, kind, signal)
}
export function publicAppUrl(configured, current) {
  try {
    const url = new URL(configured || current)
    const host = url.hostname.toLowerCase()
    if (url.protocol !== 'https:' || url.username || url.password || !host.includes('.') || /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || /\.(localhost|local|test|invalid)$/.test(host) || host.includes(':')) return null
    // Forward only the product route, never arbitrary query strings or fragments.
    const path = new URL(current).pathname
    url.pathname = path === '/app' || path.startsWith('/marketplace') ? path : '/'
    url.search = ''; url.hash = ''
    return url.toString()
  } catch { return null }
}
export function mobileWalletLink(kind, appUrl) {
  return null
}
