# Wallet connection — 26 September 2026

This addendum supersedes the older backend PDF's statement that a wallet provider is not configured. The remaining backend gaps in that PDF still apply.

## Implemented

- Top-right Connect wallet on the homepage, docs, marketplace, agent pages, and workspace.
- Separate Phantom and MetaMask EVM providers via EIP-6963, with dedicated Phantom and legacy MetaMask fallbacks. No reassignment of `window.ethereum`.
- Explicit user-initiated account request, Robinhood network switch, MetaMask unknown-network addition, and a fresh account/chain read before displaying success.
- Account changes, chain changes, disconnect/revoked permissions, rejected requests, requests already pending, wrong network, and cancellation. A cancelled late response cannot reconnect or initiate further network prompts.
- Passive restore of a previously selected wallet using `eth_accounts`; page load never requests connection or a network switch.
- Address display/copy, Robinhood explorer link, and local disconnect. Local disconnect forgets the session in Liege; users can revoke site permissions in the wallet itself.
- Official in-app-browser links for Phantom and MetaMask, plus a local SVG QR code. Connect inside the selected wallet's app browser. This does not relay a mobile session back to the original desktop or Safari/Chrome tab.

## Verified mainnet configuration

| Setting | Value |
| --- | --- |
| Chain ID | 4663 / `0x1237` |
| Network | Robinhood Chain |
| Native currency | ETH, 18 decimals |
| Public RPC | `https://rpc.mainnet.chain.robinhood.com` |
| Explorer | `https://robinhoodchain.blockscout.com` |

The public RPC returned `0x1237` in a read-only `eth_chainId` check on 26 September 2026. Robinhood documents this endpoint as rate-limited; a production application with heavier reads should use an appropriately configured provider. No private key or API credential is embedded here.

## Mobile address and deployment

No public deployment URL was found in this project. The local preview at `127.0.0.1:4173` is accessible on this computer only. The UI explains this instead of generating a broken localhost QR code.

Once hosted, mobile handoff automatically uses the current public HTTPS origin. Optionally copy `.env.example` to `.env.local` and set `VITE_PUBLIC_APP_URL` to the approved public HTTPS URL, then rebuild. The target preserves only a supported route and a wallet-picker hint; it does not forward arbitrary query strings. Do not put secrets in `VITE_` variables.

Phantom needs Robinhood Chain enabled under Settings → Active Networks and a version that supports the chain. If Phantom rejects the network, the UI directs the user there. MetaMask uses the official chain configuration when the network is not already present.

## Boundary

Connection shares a public EVM account and network selection. It is not sign-in, proof of ownership for a backend, a spending approval, a deposit, or a trade. This implementation sends no signatures or transactions. Marketplace agents, jobs, escrow budgets, policy limits, and activity remain sample/local data. No real wallet balance is inferred from those numbers.

## Validation

17 automated tests pass, including 12 connection/discovery/network/mobile-link tests. An isolated browser harness with mock providers exercised both wallet choices, account changes, wrong-network recovery, rejection, cancellation of pending requests, late approval after cancellation, reconnect, and revoked access. Actual Chrome extension discovery found Phantom and MetaMask independently. Real account approval and physical iOS/Android app handoff were not exercised.

## Official references

- [Robinhood network configuration](https://docs.robinhood.com/chain/connecting/)
- [Robinhood wallet setup](https://docs.robinhood.com/chain/add-network-to-wallet/)
- [Phantom supported chains](https://help.phantom.com/articles/41372840389651)
- [Phantom Robinhood Chain FAQ](https://help.phantom.com/articles/robinhood-chain-faq-53628774801683)
- [Phantom provider detection](https://docs.phantom.com/ethereum-monad-testnet-base-and-polygon/detecting-the-provider)
- [Phantom mobile browse links](https://docs.phantom.com/phantom-deeplinks/other-methods/browse)
- [MetaMask mobile browse links](https://docs.metamask.io/metamask-connect/evm/guides/metamask-exclusive/use-deeplinks/)
- [EIP-6963 discovery](https://eips.ethereum.org/EIPS/eip-6963)
- [QR code React component](https://github.com/zpao/qrcode.react)

Wallet icons are unmodified official documentation icons: Phantom's 192px documentation favicon from its assets page and the official MetaMask extension fox SVG from `github.com/MetaMask/metamask-extension/blob/develop/app/images/logo/metamask-fox.svg`. Brand ownership remains with their respective providers. They identify wallet options and imply no partnership or endorsement.
