<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Architecture
- The Liege app is a ported client-side React SPA living in src/liege-app/ (JSX, own CSS, `?raw` HTML imports); TanStack routes in src/routes/ render it via ClientOnly wrappers from src/liege-app/LiegePage.jsx — it uses location.pathname/localStorage directly, so it must stay client-only.
