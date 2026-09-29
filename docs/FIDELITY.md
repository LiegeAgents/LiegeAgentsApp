# Fidelity record

## Source and phase order

Reference: https://www.mintlify.com/, inspected 26 September 2026. The Mintlify collection in the supplied Inspo Studio library was opened. The supplied 19.13-second OBS recording was inspected at 2-second intervals: hero 0s; company grid/stat bar 2–4s; feature cards 6s; enterprise 8–10s; scale/startup cards 12–14s; testimonials/updates 14–16s; footer 18s.

Phase 1 checkpoint: the homepage is retained in `src/reference/*.html`, `ReferencePage.jsx`, and the original local assets. These are editable HTML elements parsed into React, not an image or iframe facade. Original typography, SVG logos, imagery, complete section markup and CSS were recovered from the publicly served source. Ribbon geometry/settings and dither rendering were isolated from the public presentation code. Tracking, original application scripts and third-party account flows are not embedded.

## Measured desktop comparison

Browser viewport: 2560 CSS px wide, DPR 1.5. Original and local page height: 8493 CSS px. The following document coordinates match the source (rounding shown to 2 decimals):

| Heading | Original y | Copy y |
|---|---:|---:|
| Company grid | 1124.69 | 1124.69 |
| Feature bento | 1743.54 | 1743.54 |
| Enterprise | 3403.54 | 3403.54 |
| Scale | 4267.54 | 4267.54 |
| Startups | 5120.21 | 5120.21 |
| Testimonials | 6026.29 | 6026.29 |
| Updates | 6908.29 | 6908.29 |
| Bottom CTA | 7682.84 | 7682.84 |

Original CSS preserves the 1088px container, 24-column grid, font metrics, responsive breakpoints, card proportions, gutters, borders, crops and section rhythm. All referenced image elements were checked for completed loads: zero broken images. Horizontal page overflow: none. Original six Rive feature animations load with their dark-mode binding. Header stays sticky; carousels scroll; original link destinations are retained for inspection.

`evidence/original-desktop.png`, `evidence/baseline-hero.png` and `evidence/baseline-full.png` record the source and source-copy pass. The first full-page baseline capture predates the repair of six image filenames; their repaired loads were separately verified. Some subsequent full-page screenshot attempts timed out. The source was visually inspected in the browser and against the video, with geometry recorded above. Animated screenshots are not synchronized frame comparisons.

## Boundaries of the reference checkpoint

The source’s changing telemetry is a captured value. Its logo pool and testimonial feed use captured initial content; the baseline does not connect to Mintlify telemetry. Original signup, search assistant and commercial flows link to their original destinations. Dropdown behavior is locally reconstructed. The original responsive CSS is retained; device verification is documented separately for the final app. This record does not assert pixel identity for every time-dependent state or untested device.

## Adaptation checkpoints

Phase 1 is recoverable at commit `d3bed22`. Phase 2 is recoverable at `0341dee`: Liege copy was mapped into the saved source sections before new product UI was introduced. Original customer results and endorsements were removed from the Liege surface rather than claimed as Liege results.

Phase 3 is complete: the docs preview became an editable Liege workspace illustration within the source preview frame; the six feature-art layers and customer/product card art became Liege job, escrow, runtime, wallet and evaluator illustrations. Original surrounding containers, heading hierarchy, column proportions, typography and section order remain. Testimonials became six product principles; updates became three protocol guides; customer logos became protocol roles. The changing source telemetry became five job-stage labels. Long standard names are separated into `8004` / `8183` display numbers with ERC labels to retain the source number width.

`/app` adds the requested agent, job, evaluator, wallet and draft workflows, inheriting the source fonts, small-radius controls, green palette, fine borders, card surfaces and restrained motion. Its functional sidebar and data table are necessary application structure. `/docs` supplies purposeful CTA/footer destinations. These new layouts are additions, not claimed original Mintlify pages.

The earlier folded identity was replaced only after the user selected the latest graphics-v5 loop logo. Final public brand files are unchanged copies of that logo PNG and matching 3:1 banner. The original baseline retains Mintlify identity.

Phase 4 frontend checks and packaging are complete as recorded in VERIFICATION.md. New functionality remains explicitly local/sample: no financial or backend integration is claimed. Original-copy comparison and adaptation routes remain separate so later work cannot silently erase the baseline.

## Explicit follow-up changes — 26 September 2026

The user requested a premium dashboard overhaul, then explicitly requested that the hero place centered text above a centered dashboard. Those requests authorize the new overview layout and hero composition. The retained `/baseline` keeps the original Mintlify composition. Source fonts, mint colors, original surrounding marketing section widths and rhythm remain.

- Transparent identity: exact graphics-v5 loop/dotted-ring geometry, with the white matte removed by pixel unmatting after the user expressly approved that method. The unused noisy image-generation attempts were not integrated. The matching banner remains unchanged.
- Eight role tiles: original tile grid and dimensions, now containing custom animated SVG glyphs and links. USDG uses its unchanged official token mark. Motion is viewport-gated and reduced-motion preferences disable animation.
- Capability cards: restored original ribbon/color-field assets, source proportions, captions, white icon plates and hover scaling. New Liege capability glyphs cover the original customer marks. The plates are 35% of the card width to fully cover those marks. These are composition/subject replacements inside the original artwork layer.
- Drag: Blossom 1.1.8 is the actual library used by the source. Pointer drag momentum, native touch scroll, click suppression, arrow end states and keyboard movement are wired to all copied carousels.
- Protocol Escrow: the cramped miniature Kanban was replaced with an illustration sized specifically for the existing 341:324 card: secured job fee, evaluation status and three clear stages.
- Workspace: layered fine borders, cursor-reactive lighting, denser job rows, lifecycle pipeline, review queue, state-derived escrow ring, policy shortcuts, activity filters and keyboard search. All still use local sample data.
- Hero: centered headline, supporting copy and CTAs above a fully centered premium workspace preview; the preview is editable DOM and opens the working app. Mobile hides only the preview’s tiny sidebar and fits the entire preview frame within the page width.

Research: [USDG official brand](https://globaldollar.com/brand), [ERC-8004 identity/reputation/validation registries](https://eips.ethereum.org/EIPS/eip-8004), [ERC-8183 job lifecycle](https://eips.ethereum.org/EIPS/eip-8183), and [Blossom documentation](https://github.com/jespervos/blossom-carousel). These informed glyph meanings and interaction fidelity, not claims of live protocol integration.

## Subsequent explicit requests — 26 September

The user requested a longer, fully visible hero dashboard independent of the section below; top-right Phantom/MetaMask connection on Robinhood Chain; a larger nav/footer logo; X and Telegram Coming soon controls; and a descriptive marketplace with real detail-page navigation. These authorize the following changes to the Liege adaptation only:

- Hero maximum width increases from 1088px to 1380px. The preview uses natural content height, full borders, an additional activity/permission row, and a permanent workspace link below. No crop/fade remains. The mobile layout stacks readable cards.
- The original central half-solid/wireframe mark is displayed larger using a CSS crop of the decorative outer orbit. The underlying transparent PNG and original supplied files are unchanged.
- Marketplace catalogue and detail pages reuse Arizona Flare, Inter, PaperMono, theme variables, 4–8px controls, fine borders, and emerald accents. They add editable SVG capability covers and sample editorial detail content.
- Shared header wallet picker and footer social controls fit the existing header/footer positions. Social URLs remain unset and no accounts were guessed.
- The preserved `/baseline` source fragments and original source stylesheet remain unchanged.

## Hero proportion correction — 26 September

The user clarified that extending the dashboard meant widening it, not making it taller. This correction supersedes the extra activity/permissions row described above. Removed that row from the hero preview and tightened its vertical spacing while retaining the 1380px maximum width and all primary overview panels. The desktop frame is now approximately 819px high instead of 1381px. There is no fixed-height crop or fade. The actual workspace remains unchanged. The hero ribbon uses a width of at least 100% of its section instead of a fixed 1920px canvas, eliminating the hard side cutoff on wide monitors.

## Roadmap and whitepaper pages — 29 September 2026

The user requested roadmap and whitepaper pages. These are new Liege layouts, not claimed Mintlify pages:

- `/whitepaper` reuses the documentation layout (1088px frame, sidebar, Arizona Flare headings, PaperMono labels, fine borders, mint accents) with a numbered, scroll-tracked table of contents, definition lists, tables, and a print layout. Content comes from the supplied Liege specification and the current codebase. Each mechanism is marked Built (in this codebase) or Designed (specified, not built), and the page states where the current build differs from the design, including that job escrow wallets are held by the Liege service. At the user's direction it names $LIEGE and its utility; supply, distribution, launch details and internal launch tactics are omitted.
- `/roadmap` presents the README roadmap phases (Current, Next, Later) in the same frame, jobs protocol first and without dates, as the user chose.
- Both pages are linked from the header Resources menu and the footer's Liege column.
