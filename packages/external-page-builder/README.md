# @dashboard/external-page-builder

Dashboard page: paste a name and a URL, preview it in an iframe to confirm the target site actually allows being framed, then publish it as a brand-new dashboard page -- a plain iframe embed of that URL, nothing else. Used for wiring in an outside tool (a vendor portal, a form) as if it were a native page on this dashboard, without writing any code by hand.

- `client.js` -- frontend module. Exports `id`, `label`, and `mount(container)`. The Preview button just points a local `<iframe>` at the typed URL (if the site refuses to be framed, the preview stays blank -- that's the target site's own `X-Frame-Options`/CSP, not a bug here). Publishing POSTs the label/URL and clears the form on success.
- `server.js` -- Express router mounted by the shell at `/api/external-page-builder`, with a single `POST /publish`.

## What publishing actually does

`POST /publish` writes a genuinely new sibling package under `packages/<slug>/` (slug derived from the label, e.g. "Vendor Status Portal" → `vendor-status-portal`), containing just two files:

- `package.json` -- sets `dashboardPage: { id, label, client: 'client.js', external: true }`. The `external: true` flag is what gets the small "external" sidebar icon the same way Automation Forms/Rewst Form Test already use.
- `client.js` -- a generated, hand-written-equivalent module exporting `id`/`label`/`mount()`, where `mount()` renders nothing but a labeled `<iframe src="...">` pointed at the embed URL. No `server.js` is ever generated for a page built this way -- there's no server-side logic for a plain embed.

It then calls `@dashboard/shell/registry.js`'s `registerPage()` to add the new page to the live, in-memory registry immediately (no process restart needed -- see that file's own comment for why a simple array push is sufficient), and appends the new page into the **Testing** sidebar category in `nav-layout.json` (falling back to a bare top-level entry if "Testing" doesn't exist). The expectation, stated directly in `client.js`'s own UI copy, is that someone drags it into its real category afterward via the sidebar's drag-and-drop editor (localhost only).

## Validation and collision handling

The URL must parse as a genuine URL and start with `http://` or `https://`. Publishing is refused with a 409 if a package directory with the same slug already exists on disk, *or* if a page with that id is already in the live `pages` registry (covering the case where this process already registered it this session but hasn't restarted) -- either way, publishing again under the same name would otherwise silently overwrite the `client.js` just written.

There is no `restrictedTo` set on generated pages -- access is governed entirely by whatever category they land in (Testing, by default, gated by its own `.env` rule if one exists) and by the dashboard-wide sign-in requirement every page already has.
