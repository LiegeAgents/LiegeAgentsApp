// Network values verified against Robinhood's official documentation, 26 Sep 2026.
export const ROBINHOOD = Object.freeze({
  chainId: '0x1237', chainName: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'],
  blockExplorerUrls: ['https://robinhoodchain.blockscout.com'],
})
export const WALLETS = {
  phantom: { name: 'Phantom', install: 'https://phantom.com/download', rdns: 'app.phantom' },
  metamask: { name: 'MetaMask', install: 'https://metamask.io/download', rdns: 'io.metamask' },
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
  if (kind === 'phantom' && [4902, 4200, -32601, -32602].includes(code)) return 'Enable Robinhood Chain in Phantom → Settings → Active Networks, then try again. Update Phantom if the network is missing.'
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
  const announced = e => { const d = e.detail; const kind = providerKind(d?.provider, d?.info?.rdns); if (kind) onProvider(kind, d.provider, true) }
  const fallback = () => {
    const phantom = target.phantom?.ethereum
    if (providerKind(phantom) === 'phantom') onProvider('phantom', phantom, false)
    const ethereum = target.ethereum
    const providers = Array.isArray(ethereum?.providers) ? ethereum.providers : [ethereum]
    providers.forEach(p => { const kind = providerKind(p); if (kind) onProvider(kind, p, false) })
    target.dispatchEvent(new Event('eip6963:requestProvider'))
  }
  target.addEventListener('eip6963:announceProvider', announced)
  target.addEventListener('ethereum#initialized', fallback)
  target.addEventListener('focus', fallback)
  fallback()
  const timers = [300, 1500, 4000].map(ms => setTimeout(fallback, ms))
  return () => { timers.forEach(clearTimeout); target.removeEventListener('eip6963:announceProvider', announced); target.removeEventListener('ethereum#initialized', fallback); target.removeEventListener('focus', fallback) }
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
  const accounts = await provider.request({method:'eth_requestAccounts'})
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
  if (!appUrl || !WALLETS[kind]) return null
  const url = new URL(appUrl)
  url.searchParams.set('wallet', kind)
  return kind === 'phantom'
    ? `https://phantom.app/ul/browse/${encodeURIComponent(url.href)}?ref=${encodeURIComponent(url.origin)}`
    : `https://link.metamask.io/dapp/${url.href.replace(/^https:\/\//,'')}`
}
