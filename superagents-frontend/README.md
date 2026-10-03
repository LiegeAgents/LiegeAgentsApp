# Super Agents frontend

Standalone React/Vite application for `superagents.liegeagents.com`.

```sh
cd superagents-frontend
npm ci
npm run dev
```

Open `http://localhost:5174`. Production verification:

```sh
npm run build
npm run test:e2e
```

## Routes

- `/`: flagship lineup, agent details, how it works, builders, and Liege footer.
- `/auth`: four-step preview of X identity, Liege wallet, permissions, and completion.
- `/app`: sample dashboard. `?view=requests`, `agents`, `activity`, and `settings` deep-link to sections.

This release is a frontend preview. It makes no X, wallet, or Liege API calls.
Onboarding explicitly uses sample identities. Approvals and agent drafts only change
demo data in session storage (`liege-superagents-preview-v1`), isolated from real
Liege authentication. Reset it from Settings or exit the preview. No credentials
or wallet addresses are collected. All requests are labeled as examples.

## Deployment

Create a separate Vercel project with root directory `superagents-frontend`,
framework Vite, install command `npm ci`, build command `npm run build`, output
directory `dist`, and domain `superagents.liegeagents.com`. `vercel.json` provides
SPA route fallback. No backend secrets belong in this frontend.

For another static host, serve existing assets normally and rewrite application
routes to `index.html`. The existing main Liege app remains a separate project.

## Backend integration next

Replace the explicitly named preview transitions with OAuth PKCE, wallet challenge
verification, and a server-side, revocable consent grant. Bind ownership to X user
IDs, not display handles. Replace sample requests and drafts with authenticated API
results; enforce access on the server. Connect approvals to proposed jobs, and
require a separate wallet confirmation for funding. A preview approval must never
be imported as real consent or transaction authority.

The flagship agents are preview service profiles, not a claim of live execution.
Their original artwork lives in `public/`. Fonts and the logo are copied from the
main Liege branding assets. The footer preserves the main landing's link groups
with absolute links back to Liege.
