# @dashboard/contract-checks

A trackable checklist for contract changes -- right now Ingram Micro subscription orders (a seat/plan change, a new sale, a cancellation), pulled into this package's own database and checked off, one field at a time, by whoever reviews them. Ingram Orders (`packages/ingram-orders`) is a good live *view* of these orders; this page is the checklist layered on top -- nothing there tracks who's actually reviewed an order, or what was found. The third page on this dashboard with real, writable application data of its own, after TC Elite Rollout and Workshop Board -- same reasoning: a real audit trail beats a spreadsheet.

- `client.js` -- the page.
- `server.js` -- Express router mounted by the shell at `/api/contract-checks`.
- `db.js` -- schema + all read/write functions.
- `sync.js` -- the Ingram-pulling job.

## Contract Process Types -- the extensibility point

Only one exists today: `ingram_subscription`, synced by `sync.js`. `process_type` on the `items` table (plus the `sync_state` table's own primary key) is the only place this shows up in the schema -- deliberately not a bigger plugin/config system, since exactly one type exists and there's nothing yet to generalise against. Adding a second type later means: a new sync source (its own script, or a second function in `sync.js`) that writes rows the same `upsertOrder()`-shape as Ingram's does, tagged with a different `process_type` string, plus one more `<option>` in the client's Process Type `<select>`. Nothing else in `db.js`/`server.js` needs to change.

## Sync design (`sync.js`) -- reuses Ingram Orders' own method

Same `@dashboard/ingram-client` calls Ingram Orders already uses (`getToken`/`getPage`/`fetchAllPages`/`getOrderDetail`/`getSubscriptionDetail`), same early-stopping `fetchOrdersSince()` pagination (Ingram's `/orders` returns its history sorted newest-first by `creationDate`, confirmed against the real API -- walking from offset 0 and stopping the moment an order's `creationDate` falls before a threshold is correct and efficient), and the same `fetchOrderDetailWithRetry()` -- the 429-retry-with-backoff, the `getSubOnce()` memoized subscription lookup, the product-name fallback for `renewal`/`cancellation` orders, and the Pending Date computation (`packages/ingram-orders/server.js` calls this `effectiveDate`; same logic, renamed here) -- all copied and adapted to write into this package's own `db.js` instead of returning JSON to a client. No shared package was extracted for this -- Ingram Orders and Ingram Subscriptions already each keep their own copies of similar fetch/retry logic, so this follows that established per-page-independence convention rather than introducing a new shared module.

**Pending Date is a separate field from Provisioned, by request.** `provisioning_date` is Ingram's own real field (set once an order is actually provisioned). `pending_date` is computed here, at sync time, for a still-`processing` order -- never written into `provisioning_date`. See `packages/ingram-orders/README.md`'s "Provisioned column for pending orders" section for the exact two-source logic (the order's own line-item description first, the subscription's `renewalDate` as a fallback) -- unchanged here, just renamed and stored in its own column.

### Bootstrap vs incremental vs refresh-outstanding

`runSync()` (called either by the page's "Check for more Orders in IM" button, via `POST /sync`, or later by `node sync.js` directly if a scheduled task ever gets added -- not built this round, only the on-demand button was asked for, but `sync.js` is structured so that's a drop-in addition, same shape as `packages/strety-autotask-sync/sync.js`):

1. **First run only** (`sync_state.bootstrap_done = 0`): an incremental walk (see below) from a fixed cutoff, **2026-08-01**, to now, PLUS a one-time **full-history scan** -- every page of `/orders`, no early stop, reading only the cheap list fields (id/status/creationDate), no per-order detail call -- to find any order older than the cutoff that's *still* `status: processing`. These are flagged as likely incomplete Annual license changes: an annual-term change order can sit in `processing` for months until its actual renewal date, so the normal early-stopping incremental walk would never see one whose `creationDate` predates the cutoff. Only the (expected small) matching set gets a real detail fetch. `bootstrap_done` is then set to `1` -- this full scan never runs again.
2. **Every run** (including right after bootstrap): an incremental walk from `sync_state.last_creation_date_seen` to now (new orders only), THEN a **refresh-outstanding** pass -- every DB row still `status: processing` that wasn't already touched by the incremental walk gets re-fetched. This is what actually catches a status flipping from `processing` to `completed`/`cancelled` -- satisfying "created or processed since you last collected them" for orders whose *processing* changed, not just brand-new orders -- and it's what keeps the bootstrap's Annual stragglers current going forward, without ever needing another full-history scan. The cursor (`last_creation_date_seen`) only ever advances from the incremental walk's own new orders -- the refresh pass never moves it.

**Sync everything, no exclusion at the data layer** (confirmed with Amber during planning) -- every order type (`change`/`sales`/`renewal`/`cancellation`) gets synced in. The Show Renewals / Show ALL Renewals / Show Cancelled checkboxes on the page are **local display filters** over already-synced data (identical semantics to Ingram Orders' own three checkboxes -- see that package's README), not a sync-time filter.

## Schema (`db.js`)

- `items` -- one row per synced order, keyed `UNIQUE(process_type, source_order_id)`. Ingram-sourced columns (status, the three dates, PO#/products/currentTotal, the resolved `ticket_autotask_id`) are the only ones `upsertOrder()`'s UPDATE path ever touches on a re-sync -- it never touches any of the human-entered columns below, so a re-sync can never clobber work already done on a row.
- The six checkbox-style fields (`TOGGLE_FIELDS` in `db.js`): `checked_contract`, `m365_ok`, `tc_elite`, `tc_ess`, `others`, `all_done` -- each backed by its own `<field>_at`/`<field>_by_email`/`<field>_by_name` trio, same shape Workshop's equipment checklist (`checked_at`/`checked_by_email`/`checked_by_name`) already established. `setToggle()` is generic over this list -- adding a 7th checkbox later means one more entry here plus 3 columns, not a new code path.
- `info_question`/`info_answer` -- the Info field, same two-column Q&A "stamp" shape as Workshop's `flag_note`/`flag_answer`, reusing that page's exact icon+popup-form UI (`qaIconsHtml()`/`openQaModal()` in `packages/workshop/client.js`), field names swapped.
- `ticket_note` -- free text, no behaviour tied to it yet (kept simple, for later use, per request).
- `audit_log` -- every checkbox toggle (**ON and OFF, both**) and every text-field edit writes a row here. Unlike Workshop's equipment checklist (which deliberately skips its own audit log, by request, as a low-stakes high-frequency action), every toggle here is always audited -- the ON/OFF history *is* the point of these checkboxes. A toggle's `new_value` holds the timestamp it was turned on to (NULL when turned off) -- this lets both the full History modal and the per-checkbox hover tooltip derive "ON at X" / "OFF at Y" from the same rows without a separate flag column. Sync-driven field updates never write here (see `items` above) -- only human actions do.
- `sync_state` -- one row per process type: the incremental cursor, the one-time bootstrap flag, and last-run bookkeeping (mirrors `packages/strety-autotask-sync`'s `last-run.json` in spirit, as a DB row instead of a separate file, since this package already has a real database).

## The checkbox hover tooltip

Every checkbox's `title` attribute is built client-side from that row's `toggleHistory` map (`{ [field]: [{action, at, byName}, ...] }`, newest first) -- attached to every row by `GET /` via `db.js`'s `getToggleHistories()`, ONE batched query across the whole page rather than a fetch per checkbox. Renders as alternating `ON - <date> by <name>` / `OFF - <date> by <name>` lines. The full History modal (the History button per row, reusing `packages/shell/public/styles.css`'s shared `.history-modal-overlay`/`.history-modal-panel` -- the same pattern `packages/workshop/client.js`'s `openHistoryModal()` uses) shows every field's changes together, not just one checkbox's.

## Filters (`GET /`)

`since` (required, `YYYY-MM-DD`, AEST-anchored via `aestDayBoundsIso()`), `client`/`status`/`product` (wildcards with `*`, via `matchesWildcard()`), `includeRenewals`/`includeAllRenewals`/`includeCancelled` (identical three-state logic to Ingram Orders' own `buildReport()`, including the `nonRenewalClientIds` trick for the partial "Show Renewals" mode -- adapted to filter local rows instead of live orders), `showAllDone` (default off -- excludes any row with `all_done_at` set), `processType` (defaults to, and today only ever is, `ingram_subscription`).

**Design note**: the Since filter applies to `creation_date` as normal, **except** a row that's still `status = 'processing'` is always included regardless of the Since cutoff (`db.js`'s `listItemsRaw()`) -- otherwise an old still-outstanding Annual change (exactly what the bootstrap step exists to surface) could silently vanish from the default view just for being older than whatever Since date happens to be selected. Flagged here as a judgment call, not something requested outright.

## PO # links to the Autotask ticket

Unlike Ingram Orders (whose own README notes it deliberately doesn't resolve `poNumber` into a ticket link -- "no confirmed way... without a lookup query"), Contract Checks resolves it once, at sync time, via the exact `resolveTicketAutotaskId()` pattern `packages/workshop/server.js` already uses (`listAll(client.tickets, [{ op: 'eq', field: 'ticketNumber', value: trimmed }])`) -- since this page syncs once rather than per-click, the extra lookup is nearly free, and it turns PO # into a real jump-straight-to-the-ticket link.

## Not yet built

- A scheduled (Windows Task Scheduler) run of `sync.js`, mirroring `packages/strety-autotask-sync`'s own production setup -- only the manual "Check for more Orders in IM" button was asked for this round; `sync.js` is structured (`runSync()` exported, plus a `require.main` CLI entry point) so this is a drop-in addition, not a rework, whenever it's wanted.
- Any second Contract Process Type beyond Ingram subscriptions.
