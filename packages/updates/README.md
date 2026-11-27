# @dashboard/updates

Dashboard page: a simple, admin-authored changelog of what's changed about the dashboard itself -- a running list of dated entries, each with rich text and an optional pasted screenshot. Anyone signed in can read it; adding, editing, or deleting an entry is restricted to the dashboard admin, the same gate the tabbed pages' own Help notes editor uses.

- `client.js` -- frontend module. Exports `id`, `label`, and `mount(container)`. Renders the entry list, and (for the admin) an inline Add/Edit row with a rich-text toolbar (Bold/Underline/Bulleted list/Link via `contenteditable` + `document.execCommand`) and a paste-to-attach screenshot slot.
- `server.js` -- Express router mounted by the shell at `/api/updates`, with `GET /`, `GET /recent`, and admin-only `POST /entries`, `PATCH /entries/:id`, `DELETE /entries/:id`.
- `db.js` -- this page's own persistent data, a `node:sqlite` (`DatabaseSync`) file at `data.db` with a single flat `entries` table (no history/audit trail beyond `updated_by_*` -- by request, this is meant to stay simple, an edit just overwrites the row). Needs Node >=22.5.

## Sort order is insertion order, not the entry's own date

Entries are always listed newest-added-first (`ORDER BY id DESC`) -- `entry_date` is purely informational text about when the described change actually happened (the admin can be logging something from a few days ago) and is deliberately **not** the sort key. So an entry backdated to last week still appears at the top of the list if it was the most recently *added* one.

## `GET /recent` is a separate, lighter route

Used by the Start Here page's own excerpt column. It returns only `id`, `entryDate`, and `contentHtml` -- never `imageDataUrl`, which can be tens of KB and isn't shown there anyway -- capped to a small `limit` (default 5, max 20), so that page's payload never grows with the full Updates image history.

## Screenshots

One optional pasted screenshot per entry, stored as a `data:` URL directly in the `image_data_url` column -- resized/recompressed client-side first (capped to 1400px on its longest side, JPEG at quality 0.82, whichever of the original or resized version comes out smaller actually wins) before it's ever sent to the server. This router raises Express's JSON body limit to `10mb` specifically because a pasted screenshot as a base64 `data:` URL routinely exceeds the framework's 100kb default.

## Deep-linking to one entry

Start Here's excerpt links can jump straight to one specific entry via a real `?entry=<id>` query-string parameter (not a hash) -- deliberately not another use of `window.location.hash`, since that already means "which dashboard page" everywhere else on this dashboard (`app.js`'s `currentPageId()`). A query-string link forces a real full page load rather than an in-app route change, the same "real navigation, not a SPA hop" choice used elsewhere on this dashboard for a similar cross-page deep link. On load, the matching row is scrolled into view and briefly highlighted, and the `entry` param is stripped from the URL immediately via `history.replaceState` so a later plain reload doesn't re-trigger it.
