# @dashboard/start-here

Dashboard page (first page the dashboard opens to, above the Daily Dashboards section in the sidebar), titled "About your Dashboards" on the page itself (the sidebar entry stays "Start Here", styled like a section label -- see below): a landing page -- a short description of what this dashboard is for followed by a list of every other page on it with a one-line description (grouped the same way the sidebar groups them, in the wider left column), and a narrower right column of quick-link buttons out to other systems Ambient iT uses that this dashboard doesn't cover.

- `client.js` -- frontend module. Exports `id`, `label`, and `mount(container)`, picked up automatically by the shell.
- No `server.js` -- this page needs no API of its own (same as Automation Forms/`technician-forms`, the other client-only page on this dashboard). `dashboardPage` in `package.json` simply omits the `server` key, which `packages/shell/server.js`'s page loader already treats as optional (`if (!page.server) continue;`).

## First page the dashboard opens to

`packages/shell/nav-layout.json` lists this page first at the top level, above the "Daily Dashboards" category -- the shell's `currentPageId()` (see `packages/shell/public/app.js`) falls back to the very first page in the flattened tree order whenever there's no `#pageId` in the URL, which is how a fresh visit to the dashboard lands here.

## Sidebar entry styled like a section label

By request, the "Start Here" sidebar link itself is bold/uppercase/green, matching the look of `.nav-category-header` (the "DAILY DASHBOARDS"-style category headings) instead of a plain page link -- `a.nav-link[href="#start-here"]` in `styles.css`, targeted by its href rather than a new class since `app.js` builds every nav-link the same way regardless of page and this is the least invasive hook onto just this one entry. Split into two rules: `:not(.active)` keeps the green-text-no-fill category-heading look while it's not the current page, and a separate `.active` rule swaps in a solid green fill with white text when it IS the current page (by request) -- overriding the default blue `.nav-link.active` fill for just this one entry. The `.active` rule is written specific enough (an extra attribute selector) to win without needing `!important`.

The page-group headings inside this page itself ("DAILY DASHBOARDS", "CLIENT INFO", ...) get the matching treatment via a new `.section-heading--nav` modifier (same green, same bold weight/letter-spacing as `.nav-category-header`, no background fill) so the page visually echoes the sidebar it's summarizing.

## The internal page list is pulled live, not hardcoded

`loadPageList()` fetches the same two sources the sidebar itself uses -- `/pages-registry.js` (id -> label, generated server-side from every page's own `dashboardPage`) and `/api/nav-layout` (the shared category grouping/order) -- and walks them the same way `app.js`'s own `reconcileTree()` does: a tree entry pointing at a page id that's no longer registered is skipped, and a registered page missing from the tree (freshly added, never dragged into a category) still shows up, bucketed under "Other". This means the list here can't silently drift out of sync with the real sidebar -- add a page package, and (once it's placed in `nav-layout.json`, or even before that via the "Other" bucket) it appears here automatically.

Each page name links straight to it (`href="#pageId"`, the same in-app hash navigation the sidebar itself uses), so this page doubles as a jumping-off point, not just a table of contents.

The intro paragraph (what this dashboard is for) lives inside this same left column, above the fetched groups -- by request, so it reads as the lead-in to the page list rather than a separate page-wide banner. It's static (in `mount()`'s initial render, not inside `loadPageList()`'s fetch-replaced region), so it's never lost or flashed away by a slow load or a fetch error.

**What's not automatic:** the one-line description under each page name. That's a separate hardcoded lookup (`PAGE_DESCRIPTIONS`, keyed by page id) inside this package's own `client.js` -- deliberately not stored in each page's own `package.json`, since adding this page shouldn't require touching all ~23 others. A page id missing from that lookup just shows with no description rather than being dropped from the list, so a newly added page never silently disappears here even if nobody's gotten around to writing its blurb yet.

## External system buttons

The right column is a fixed list of buttons (`EXTERNAL_LINKS` in `client.js`) to systems this dashboard itself doesn't integrate with, opened in a new tab (`target="_blank"`) rather than navigating away from the dashboard entirely. By request, the list is: Kaseya One, Ambient iT's SharePoint, Ingram Micro, Backup Radar, AutoElevate, Huntress, EasyDMARC, Access4, Aussie Broadband, TPP, CloudFlare, WP Engine. No column heading above the buttons, by request.

Every URL was supplied directly, not guessed -- including the account-/tenant-specific ones (Kaseya One's `companyName` query param, Ambient iT's own SharePoint tenant, the specific regional/account subdomains for Backup Radar, Huntress, Access4, etc.). An entry with `url: null` renders as a greyed-out, inert placeholder instead (`.button-link--pending`, a plain `<span>`, not a clickable `<a>`) rather than ever shipping a guessed link that might point at the wrong account -- unused right now (every current entry has a real URL), but stays in place for a future entry added before its URL is confirmed. Fill in the real URL in `EXTERNAL_LINKS` and it becomes a real button automatically.
