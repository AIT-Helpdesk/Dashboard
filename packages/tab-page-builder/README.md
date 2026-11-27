# @dashboard/tab-page-builder

Dashboard page: creates a brand-new tabbed page (like Ticket Info, Client Info, Time Reporting) -- a name plus a starting set of tabs, each mounting an existing dashboard page exactly as-is, using the shared tabbed-page mechanism (`@dashboard/shell/tab-page-client.js` / `tab-page-server.js`) every other tabbed page on this dashboard already runs on.

- `client.js` -- frontend module. Exports `id`, `label`, and `mount(container)`. Lists every page currently visible to the viewer (from `/pages-registry.js`, already filtered server-side), minus this tool itself, as a checklist of possible starting tabs.
- `server.js` -- Express router mounted by the shell at `/api/tab-page-builder`, with a single `POST /publish`.

## Admin only

Creating a new tabbed page is restricted to the dashboard admin (`isDashboardAdmin()`) -- by request, the same gate used for making an existing tab permanent on an already-built tabbed page. Once a tabbed page exists, though, it's meant for everyone: anyone can drag more tabs onto it, and only *managing* it (making a tab permanent, renaming the page) stays admin-gated.

## What publishing actually does

`POST /publish` resolves each checked tab id against the live, currently-registered `pages` array -- never trusting a label the client might have sent, and silently dropping any id that no longer matches a real page (e.g. a stale selection from before that page was removed). It then writes a new sibling package under `packages/<slug>-tabs/` (the `-tabs` suffix, not just the plain slug, deliberately keeps a tabbed page's id visually distinct from the real page(s) it contains -- e.g. `client-info-tabs` next to `client-info` -- the same convention every hand-built tabbed page already follows), containing:

- `package.json` -- `dashboardPage: { id, label, client: 'client.js', server: 'server.js', tabbed: true }`.
- `client.js` -- a thin generated wrapper around `createTabbedPageMount()`, with the chosen starting tabs baked in as a JS literal (`defaultTabs`).
- `server.js` -- a one-line generated wrapper around `createTabPageRouter()`, which is what serves that one page's own permanent-tabs/removed-default-tabs/tab-order GET/PUT.
- `default-tabs.json` -- a separate, server-readable copy of the same starting-tabs list `client.js` embeds. This exists specifically so `tab-page-server.js`'s own DELETE route (removing the whole tabbed page once every tab has been removed from it) can check the *full original* set without having to parse the generated `client.js` to recover it.

It then calls `registerPage()` (live immediately, no restart needed, including mounting the new page's own `/api/<slug>-tabs` router for its permanent-tabs endpoints) and appends the new page at the root of the sidebar, same as every other hand-built tabbed page -- it's dragged into its real category afterward via the existing localhost-only nav editor.

## Collision handling

Publishing is refused with a 409 if a package directory with the same slug already exists on disk, or if a page with that id is already in the live `pages` registry, covering a same-session re-publish that hasn't restarted yet.
