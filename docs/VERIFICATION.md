# Verification record

26 September 2026. See FIDELITY.md for source comparison measurements and limits.

## Browser checks performed

- Desktop homepage, shared navigation/footer and full source-copy section order inspected against Mintlify and the supplied video.
- Source-copy geometry measured at 2560 CSS px, with all recorded section heading coordinates and total page height matching the source. Zero broken reference images after filename repairs.
- Mobile homepage at 390px: typography, ribbons, dashboard preview crop and navigation inspected. These widths were exercised through a local responsive iframe harness because the Chrome viewport override did not change the real viewport; no physical device emulation is claimed. The harness is excluded from the product.
- Workspace at 390px: stacked cards, forms and navigation inspected. Job tables and mobile navigation intentionally scroll inside their containers.
- Documentation at 320px: search success/empty states, a documentation destination, themes, and mobile menu tested. Fixed a 40px menu gap on pages without the announcement. Measured menu/header alignment and zero body overflow after repair.
- Job creation: evaluator-capacity violation surfaced a specific error; valid draft saved. Explicit confirmations exercised Draft → Open → Funded → Submitted → Completed with visible history.
- Wallet policy: per-trade cap greater than total rejected; a valid 750 USDG cap saved; pause state and value survived reload.
- Agents: unmatched search displayed an empty state; clear filters restored the directory; saving Atlas and filtering Saved displayed one agent; local agent draft form created an unpublished profile. Escape dismissed its native dialog.
- Documentation search filtered to the wallet topic and showed an empty state for a nonmatching term. Light/Dark controls changed selection and document theme.

## Automated checks

`pnpm test` exercises five domain tests: evaluator capacity, legal state ordering and terminal expiry, 72-hour challenge boundary, immutable history, and wallet policy limits/expiry. `pnpm build` generates the production Vite bundle. The Rive runtime and fallback WASM are included locally for the baseline.

Final production-preview checks passed: 92 routes/assets responded correctly, all compiled/public asset bytes matched local files, 18 documentation topics mapped correctly, and WASM had the correct MIME type. The handoff PDF and build scripts are not served publicly. The product carousel moved 1072 CSS px when Next was pressed. A fresh preview origin showed the clean three-job seed workspace. At 768px the app body had equal client/scroll widths (753px after the browser scrollbar).

The baseline was rechecked with the locally bundled Rive runtime: all six original state machines were specified, 15 canvases were present, original feature artwork was visible, and zero images were broken. Saved evidence includes baseline-features.png and baseline-repaired-cards.png in addition to the original pass. Application console checks surfaced only pre-existing wallet-extension messages.

The ZIP excludes browser-local QA drafts. Archive CRC and every manifest SHA-256 entry passed. A fresh extraction started successfully with `node scripts/serve.mjs 4174` before dependency installation. Its 92-route/asset verification passed, and its agent market rendered in Chrome with the clean seed data. `pnpm install --frozen-lockfile` then succeeded in that clean workspace, followed by all five domain tests and a successful production rebuild. The final content update only corrected the brand-download description; the final archive was extracted and its preview checks rerun. Git checkpoint history was verified separately. Only the project branch is bundled, excluding internal tool refs and unrelated workspace material.

## Limits

Chrome desktop and constrained CSS-width layouts were checked. This is not a claim of testing Safari, Firefox, physical phones, all assistive technology, or every possible timing-dependent animation frame. Source telemetry/testimonial feeds are captured initial content in the baseline. No production integrations, financial transactions, deployment or real user data were tested. Browser extension wallet-injection errors were observed independently of application code and are not part of this application.

## Follow-up UI verification — 26 September 2026

- Transparent loop: PNG alpha range 0–255, 1,389,209 fully transparent pixels; dark-background inspection confirmed clean wireframe openings and no white matte. Original geometry and dotted perimeter preserved. Both public logo filenames are transparent.
- Eight role tiles: all eight were visible with distinct custom glyphs; computed animation names and running states verified in the browser. USDG uses the official unchanged mark with an animated surrounding ring. Reduced-motion overrides are included.
- Capability carousel: actual pointer drag moved scrollLeft from 0 to 1,428.67 CSS px (maximum 1,429), without navigating. Previous became enabled and Next disabled at the far end. All 14 light/dark card images loaded. Original ribbon fields, centered white plates and source card proportions were visually checked.
- Escrow: the repaired thumbnail was visually inspected inside the original three-column protocol section; title, fee, evaluation state and Fund/Evaluate/Settle labels fit without truncation.
- Desktop hero: headline and dashboard frame share the exact horizontal center (1,272.33 CSS px in the measured 2,545px viewport). Updated preview content fits inside its frame: content bottom 1,350.99, frame bottom 1,380.27. No broken images. Light and dark themes checked.
- Responsive checks used the existing local iframe harness, excluded from the product: 390px and 1,440px frames, with actual inner document widths of 375px and 1,425px after scrollbars. Workspace clientWidth equals scrollWidth at both widths. Phone hero is centered and contained within the document width. Decorative permission-card circles are intentionally clipped within the card.
- Dashboard behavior: Needs review filtered the job desk to the submitted job; Funding filtered activity to funding events. Review submission opened the correct job. Accept sample result required its existing confirmation, then updated active jobs 2→1, escrow 370→250 USDG, completed 1→2, the ring, and the empty review queue together.
- Policy shortcuts: Pause changed the overview to “Sample execution paused”; Resume restored it.
- Search: Ctrl K opened the dialog with focus in its input. Searching Forge opened its agent profile; Hire opened the job form with Forge selected. A valid QA draft saved and appeared in the Draft pipeline. Clicking that pipeline stage navigated to `/app?view=jobs&filter=Draft`; the filter and draft remained after reload.
- All mutating browser checks used the separate development origin on port 5173; these QA drafts are not in the delivered seed data or package.
- Production build and all five domain tests passed. Updated compiled-preview checks passed for 94 routes/assets, 18 docs topics, byte-for-byte assets and required private-file 404s. Browser console inspection showed no application error; a pre-existing wallet-extension injection error was present.

The original backend handoff PDF remains the integration handoff. Current visual changes and new component locations are documented here and in START-HERE.md; they supersede its earlier UI/asset descriptions.

## Latest follow-up verification — 26 September

- Automated suite: 17 pass (5 domain + 12 wallet/network/mobile-link tests).
- Official Robinhood RPC read: `eth_chainId` returned `0x1237` (4663). No financial RPC method was sent.
- Chrome: both Phantom and MetaMask detected separately. Actual approval prompts were not accepted. Isolated mock-provider browser checks confirmed connection, rejection, account changes, network change/recovery, disconnect, cancelled pending requests, ignored late approvals, reconnect, and revoked accounts.
- Marketplace: category + text filtering reduced the catalogue to Sentinel; saving persisted through navigation to its full profile; its Create job action opened a draft with Sentinel and 75 USDG preselected. This did not save or fund a new job.
- Hero: natural height shows the bottom activity/permissions panels and footer link without clipping. Dashboard extends beyond the 1088px marketing container as requested.
- 390px iframe viewport (375px content with scrollbar): homepage, marketplace, and Atlas profile had body scrollWidth = clientWidth = 375px. Mobile and desktop screenshots inspected, including light-theme Atlas and enlarged footer/nav branding. This is responsive browser verification, not a physical-phone test.
- X and Telegram controls open and close the correct Coming soon notices.
- Public HTTPS deployment and real iOS/Android wallet handoff remain unverified because no public URL/device session is available. The UI disables a misleading localhost QR and explains the hosting dependency.

See `WALLET-INTEGRATION.md` for the current wallet integration boundary; earlier notes and the original backend PDF predate this implementation.

- Latest production build: 106 routes/assets passed HTTP status, byte integrity, and private-file exclusion checks. Marketplace sorting placed Sentinel, Relay, Atlas, Prism, Vector, Forge in ascending sample-budget order; list mode rendered the same results. Mobile wallet selector also fits the 375px content area.

- The new mobile workspace wallet button exposed a 2px header overflow. The redundant topbar export icon is now hidden at phone widths; Export workspace remains available in settings. The corrected mobile workspace measures 375px scroll/client width.

## Hero proportion correction — 26 September

- Removed the extra preview activity/permissions row and reduced vertical spacing. Desktop dashboard frame measures 1380 × 818.77px, down from 1380 × 1381.06px, without fixed-height clipping.
- At a 2560px browser viewport, the hero and ribbon canvas both measure 2544.67px wide (excluding the scrollbar), with x = 0. The background now spans the entire section. Screenshot: `evidence/hero-width-correction.png`.
- At 1440px, the preview measures 1368.67 × 818.77px. Main content, panel grid, job card, and escrow card have no internal horizontal overflow. Page client/scroll widths both equal 1425px.
- At 390px, page client/scroll widths both equal 375px. Cards remain readable in the existing stacked phone layout; no document-level horizontal overflow.
- Production build passes. Only the Liege hero component and its stylesheet changed; marketplace, wallet, actual workspace, and original-copy baseline are unchanged.

## Roadmap and whitepaper pages — 29 September 2026

- Chrome (headless, driven by Playwright) against the dev server: `/roadmap` and `/whitepaper` at 1440px and 390px, in Dark and Light themes. Document client and scroll widths were equal in all eight cases. The app logged no console errors; the only errors came from the wallet SDK's remote configuration requests (HTTP 403/400 without a WalletConnect project ID), which also occur on existing pages.
- Whitepaper: sidebar links, in-page links and deep links such as `/whitepaper#evaluation` place the section 88px from the top, below the sticky header, and the active sidebar entry follows scrolling. At 390px the sidebar gives way to inline contents, and wide tables scroll within their frame. The print layout produced an eight-page A4 PDF on white, without site chrome.
- The header Resources menu lists Whitepaper and Roadmap, the footer's Liege column links both, and in-content links resolve to `/docs/status`, `/docs/eligibility`, `/docs/notice` and `#strategies`.
- A case-insensitive filename collision (`roadmap.js` beside `Roadmap.jsx`) made the lazy page import resolve to the content module on macOS; the content modules are now `roadmapContent.js` and `whitepaperContent.js`.
- `bun run build` passes, with each page in its own chunk. ESLint reports nothing in the new route files and content modules; it does not cover `.jsx` files.
- Not tested: Safari, Firefox, physical devices, or assistive technology.
