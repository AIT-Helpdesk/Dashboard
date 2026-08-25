# @dashboard/packages-received

Dashboard page, shown in the sidebar as **"Goods Received"** (the package/directory name itself stays `packages-received` -- only the on-page/nav label was renamed, by request, so nothing else -- routes, table names, the `pgr-` CSS prefix -- needed to change): a goods-received register that replaces a paper/whiteboard log of packages arriving at reception with a real, shared, audited record. Third page on this dashboard with its own persistent, writable data (after TC Elite Rollout and Workshop Board), and deliberately the simplest of the three: **no priority/status colour-coding and no complete/archive concept** -- by request, this is a straightforward running log staff add to and correct via Edit, not a workflow board.

- `client.js` -- frontend module. Exports `id`, `label`, and `mount(container)`, picked up automatically by the shell.
- `server.js` -- Express router mounted by the shell at `/api/packages-received`.
- `db.js` -- schema, and the write helpers (`createDelivery`, `updateDelivery`, `recordAudit`). Everything that touches the database goes through this file.

## Fields

- **Date & Time** (`received_at`) -- staff-entered, so a delivery can be logged after the fact rather than only at the exact moment it's typed in. Drives the list's own sort (newest first).
- **Receiver Name** (`receiver_name`) -- who received/logged it, free text.
- **Sender/Supplier** (`sender`) / **Freight Company** (`freight_company`) -- both free text.
- **Client** (`customer`) -- free text, not tied to a real Autotask company -- who the goods are for. Kept under the column name `customer` for consistency with Workshop Board's own identically-purposed field, but unlike that page, this one is never overridden by a linked ticket's resolved company -- it's its own independently-typed field.
- **Ticket** (`ticket_number`) -- free text as typed (e.g. `T20260730.0020`). Resolved to a real Autotask ticket for a clickable link using the same graceful, never-blocking lookup Workshop Board's own `resolveTicketAutotaskId()` uses -- a blank value, zero matches, more than one match (ambiguous), or the lookup itself failing all just leave it as plain typed text with a "Ticket not found in Autotask" tooltip instead of a link, never a hard error blocking the save. Unlike Workshop Board, this page does NOT also pull a live due date/status/client name from the ticket -- nothing here depends on those, so it's kept to just the link.
- **Contents (if known)** (`contents`) -- free text.
- **How Many Cartons** (`carton_count`) -- a whole number, or blank/unknown.
- **Contents/Packing Slip Checked** (`slip_checked`) / **Matched with Order** (`matched_with_order`) -- real checkboxes, by request. Both are also directly clickable in the table itself (not just the Edit form) and save immediately on click -- ticking these off as goods are processed is the whole point of having them as checkboxes.
- **Notes/Action/Given To** (`notes`) -- free text.

## No delete capability, by request

Unlike Workshop Board (soft delete + a separate hard delete) or TC Elite Rollout (hard delete), this page has **no delete route or button at all**. A genuine mistake (wrong client typed, double-logged, etc.) gets fixed via Edit -- which is itself an audited change (see below), so the correction and the original entry both stay visible in the history, rather than the row being erased outright.

## Every field change is its own audit_log row

Same convention as Workshop Board/TC Elite Rollout -- not one lumped "delivery updated" entry, `updateDelivery()` in `db.js` diffs the incoming fields against the existing row and writes an `audit_log` row per column that actually changed. `created` is its own whole-delivery event. The per-row "History" button opens a modal listing all of it, most recent first -- reusing the shared `.history-modal-*` overlay/panel classes TC Elite Rollout's own per-cell history window first established (`packages/shell/public/styles.css`).

`updated_at`/`updated_by` are always re-touched on a save even when nothing actually changed (re-saving the form with identical values, or toggling a checkbox back to its original state) -- so "who last touched this" stays accurate without polluting the history list with no-op entries.

## Sort order

Newest received first (`received_at DESC`, `created_at DESC` as a tiebreak) -- this is a running log, not a priority-ordered board. There is currently no separate archive/completed view and no built-in search/filter -- the whole table renders at once, scrollable horizontally on a narrow screen (`.pgr-table-wrap`). Worth revisiting (e.g. a date-range filter, or paging) once the register has enough real history that a single always-rendered table gets unwieldy.

## Workshop Board's own "Deliveries" preview

By request, Workshop Board's bottom-right panel (`.wsp-deliveries-box` in `packages/workshop/client.js`) shows the 5 most recent deliveries logged here -- Date & Time, Sender + Freight Company (combined into one cell), and Receiver Name only. It's a genuine cross-page read: Workshop Board's client.js fetches this page's own `GET /api/packages-received/` directly (already sorted newest-first, just sliced to 5) rather than duplicating any data or logic. The panel's "Deliveries" heading is a real link (`#packages-received`, the page id, unaffected by the display-label rename above) straight to this full page.
