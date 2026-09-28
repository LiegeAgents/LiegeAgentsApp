## Architecture
- The Liege app is a ported client-side React SPA living in src/liege-app/ (JSX, own CSS, `?raw` HTML imports); TanStack routes in src/routes/ render it via ClientOnly wrappers from src/liege-app/LiegePage.jsx — it uses location.pathname/localStorage directly, so it must stay client-only.
