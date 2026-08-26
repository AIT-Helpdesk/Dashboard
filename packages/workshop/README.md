# @dashboard/workshop

Dashboard page: replaces the workshop's physical whiteboard -- one row per job/device, mirroring the whiteboard's own "priority magnets" and "pen colours" conventions, with every change attributed to a real signed-in user and a full history instead of "gone once it's wiped".

- `client.js` -- frontend module. Exports `id`, `label`, and `mount(container)`, picked up automatically by the shell.
- `server.js` -- Express router mounted by the shell at `/api/workshop`.
- `db.js` -- schema, migrations, and the write helpers (`createJob`, `updateJob`, `completeJob`, `reopenJob`, `deleteJob`, `recordAudit`). Everything that touches the database goes through this file.

## Fields

- **Ticket** (`ticket_number`) -- free text as typed (e.g. `T20260730.0020`). See "Ticket resolution" below.
- **Client** (`customer`) -- free text, not tied to a real Autotask company. Once a ticket resolves, the board *displays* that ticket's real client name instead (see below) -- the typed value is never overwritten, just outranked on screen.
- **Job description** / **Current / required action** (`job_description`/`action_text`) -- two separate fields, shown stacked in one cell (description bold, above the action text).
- **Note colour** (`action_color`, the "pen") -- `general` (Black, default) / `notewell` (Red) / `blue` (Blue) / `done` (Green). Colours the action text specifically, independent of priority.
- **Location** (`location`) -- free text.
- **Priority** (`priority`, the "magnet", labelled "Workshop Status" in the legend under the table) -- `urgent` (red) / `complete` (green) / `nearly_complete` (blue) / `in_progress` (orange) / `next_up` (purple) / `coming` (yellow) / `not_started` (grey). Defaults to `not_started`. Shown as a dot leading the Status cell (its own click target -- see below) plus a full label in the legend under the table. The dot's colour is always carried by the row's left/right bars; Client/Action also get a light background tint, but only for `urgent`/`complete`/`nearly_complete`/`in_progress`/`next_up` -- `coming` and `not_started` stay unshaded, by request. Deliberately a manually-chosen field, not computed from a ticket's due date -- plenty of jobs have no linked ticket at all. Originally a time-urgency scale (Today/Tomorrow/2-4 days/Over 4 days); retiered to this completion-progress scale by request -- see `migrateRetierPriorityToStatusStyle`/`migrateAddComingPriority` in `db.js`.
- **Status** (`workflow_stage`) -- `new` / `free_text` / `in_car` / `take_onsite` / `ready_to_ship` / `ready_for_pickup` / `sent` / `delivered` / `collected` / `dispose`. Purely informational workflow tracking -- reaching `collected` does **not** complete/archive the job on its own, that's the separate Mark Complete tick. `free_text`, `in_car`, and `take_onsite` all pair with a companion `workflow_stage_text` column (type anything / whose car it's in / who took it onsite), shown as an inline text field once picked. `ready_for_pickup`/`sent`/`delivered`/`collected` render in green in the list (reads as "done and on its way out/gone"); `new`/`ready_to_ship`/`in_car`/`take_onsite` render in red (reads as "not yet actioned/still waiting on the workshop") -- for `in_car`/`take_onsite` specifically, once there's real WHO text, only the stage name itself stays red and the person's name renders in the default colour, by request. `dispose` has no companion text and no colour -- jobs in this stage are pulled out into their own separate table below the priority legend instead (see `renderResults()` in `client.js`), by request.
- **Question** (`flag_note`, the "stamp") -- an optional free-text question anyone can leave on a job, by request. Shown as a ❓ icon right-justified in the Status column -- dim and small while blank, big/bold once a question is set (there's no separate "add" affordance; the icon itself is always the click target, in either state, so there's a way to leave the first question at all). Hovering a set question shows its text via a plain native tooltip. Clicking it (blank or set) swaps it for a small text input + save button, same "quick inline update, no form trip" pattern as Priority/Status -- saving with the field empty clears it. Also shown on the print card (only when set) and included in the "WORKSHOP BOARD UPDATE" ticket note snapshot, same as every other field.
- **Equipment** (its own `equipment` table, not a column on `jobs`) -- see its own section below.

## Equipment

A per-job list of equipment items, by request -- each with a count, a description, two checkboxes (**In Workshop**, **Configured**), a **Delivered** checkbox, and a short **Location Note** (60 characters max -- "which shelf/bench" rather than a full description). A genuinely separate table (`equipment`, one row per item, `job_id` foreign key), not a column on `jobs` -- a job can have any number of items, from zero up.

**Two entry points, one shared editor.** The exact same editable table (`buildEquipmentEditor()`/`equipmentRowEditHtml()` in `client.js` -- add/remove rows freely, no per-row identity to track across an edit, see below) appears in two places:
- Embedded at the bottom of the Add/Edit job form, saved together with every other field on that form's own Save button.
- A standalone modal, opened by clicking the row's own equipment icon (📦, shown inline with the Location text) -- same dim-while-empty/bold-once-set pattern as the ❓ Question stamp, always the click target in either state so there's a way to add the *first* item. Hovering a set icon shows the full list (count/description/flags/location note) via a plain native tooltip. This path has its own independent save (`PUT /jobs/:id/equipment`) so the list can be updated without opening the full Edit form.

**Whole-list replace, not per-row diffing.** Saving either editor sends the CURRENT set of rows as a plain array; `replaceEquipmentForJob()` in `db.js` deletes the job's existing equipment and inserts the new set fresh, in a transaction. A repeatable sub-table like this has no stable row identity worth tracking client-side across an edit (rows can be added/removed/reordered all in the same save) -- this is simpler and just as correct as diffing would be.

**One audit_log summary entry per save, not one per row/field.** Recording a real per-cell audit trail for a repeatable table would be noise, not signal -- instead, `server.js` builds one readable summary line per item (e.g. `"2x Laptop (In Workshop) -- Bench 3; 1x Monitor (Configured, Delivered)"`, `equipmentSummaryText()`) and writes a single `field: 'equipment'` audit_log row comparing the before/after summary text, only when it actually changed. Same summary format is used in the History modal, the row icon's own hover tooltip, and the "WORKSHOP BOARD UPDATE" ticket note snapshot. An equipment-only save via the standalone modal triggers that same ticket note (if a ticket is linked) as any other change would.

## Mobile View

An optional checkbox (default off), by request -- a pure CSS class toggle (`.wsp-mobile-view` on the page wrapper), no re-render involved, so it applies instantly to every currently-rendered table at once (main list, both halves in 2-column mode, and the separate Dispose table). Hides Location/Ticket/Due Date (as one set), the Client column, the top intro box, the whole bottom row (Usage instructions + Deliveries), and the "Show in 2 columns" checkbox -- pure screen real estate on a small screen. Completion (the row action buttons) always stays visible. Losing the Client column doesn't lose the client's name, though -- it reappears as the Current/Required Action cell's own first line instead, in yellow/bold (`.wsp-mobile-client-line`) -- that line is always in the DOM (same "resolved ticket client, or the typed Field" value the Client column itself shows), just hidden via CSS outside Mobile View.

The checkbox itself carries a `data-auto-mobile-view` attribute, by request -- a generic, dashboard-wide hook (`applyAutoMobileView()` in `packages/shell/public/app.js`) that auto-checks it and turns on Full Screen mode whenever this page is opened on a narrow screen (`matchMedia('(max-width: 720px)')`, not user-agent sniffing). Not Workshop-specific plumbing -- any future page's own Mobile View checkbox gets the same behavior for free just by carrying that same attribute, no shell code changes needed.

## Priority and Status are both click-to-edit inline

Clicking the priority dot or the Status text in the list swaps it for a `<select>` (Status also reveals a text input for the two text-enabled stages) and saves immediately on change -- no trip to the Edit form required, though both are in that form too for editing everything else at once.

## Completing a job vs deleting it -- three genuinely different actions

**Complete** (the checkmark icon) sets `status = 'completed'` and moves the job into the "Show Completed" archive -- full history preserved, reversible via **Reopen**. This is what "finished" means here, mirroring TC Elite Rollout's audit-trail philosophy rather than the whiteboard's "erase it" behaviour.

**Delete, from the open-jobs view** -- there's no delete button here at all, by request. `PATCH /jobs/:id/soft-delete` (atomically sets `workflow_stage = 'free_text'` with `workflow_stage_text = 'Deleted'` and completes the job in one call) still exists in `server.js`/`db.js` as a dormant capability for direct API/admin use, just not wired to any button in the UI.

**Delete, from the completed/archive view** (its own X icon -- was a rubbish bin icon, changed by request) is a genuine **hard** delete -- for cleaning up a real mistake already sitting in the archive (a duplicate/test entry). Purges that job's own `audit_log` rows too. `DELETE /jobs/:id` also still exists as a route for direct API/admin use.

The default board view (`GET /`) shows only `status='open'` jobs, sorted by the linked ticket's **due date**, soonest first -- jobs with no known due date (no ticket, an unresolved/free-text ticket number, or a resolved ticket with none set) sort **first**, by request. This sort never looks at `ticket_number` itself (which can be blank or hold arbitrary free text, not a real ticket) -- only the resolved due date. `?status=completed` shows the archive instead, most recently completed first.

An optional "Show in 2 columns" checkbox (default off) splits the list into two side-by-side tables for very large screens -- a pure client-side re-layout of the same data, not a second fetch.

## Ticket resolution -- graceful, never blocking

On every create/update where `ticket_number` is present, `server.js` looks it up against real Autotask tickets (`listAll(client.tickets, [{ op: 'eq', field: 'ticketNumber', value: trimmed }])`, the same `listAll` every other page already uses) and stores the resolved internal id in `ticket_autotask_id` if there's exactly one match.

Zero matches, more than one match (ambiguous -- treated the same as not-found rather than guessing), or the lookup itself failing (a network blip) all leave `ticket_autotask_id` as `NULL` -- the typed text still saves and displays, just as plain text with a "Ticket not found in Autotask" tooltip instead of a link. Saving a job is never blocked by Autotask being unreachable or the ticket not existing yet.

Once a ticket resolves, three more things are fetched **live** on every load (never cached on the job row, since all three can change in Autotask after the job was logged) via `withTicketDetails()` in `server.js`, batched across every job on the board in one request each regardless of job count:

- **Due date** -- drives the board's default sort (see above) and the Due Date column (red + bold if overdue).
- **Client name** -- shown in place of the typed Client field (tooltip: "From `<ticket>`"); the typed `customer` value itself is never overwritten.
- **Status** -- the ticket's own current Autotask status, shown in small print under the ticket number.

## Print job card

The printer icon on each row (available in both the open and completed views) opens a new browser tab containing a single self-contained, **A5**-sized HTML document for that one job, and immediately triggers the browser's own print dialog -- deliberately not a custom print pipeline, since the browser dialog already lets you pick a real printer or "Save as PDF" as the destination. The card shows Ticket (+ its Autotask status), Due date (red/bold if overdue), Client (ticket's resolved name, with anything manually typed into the Client field afterward in brackets), Status, Priority, Location, Job description, Current/required action (coloured per its Note colour), a Question row (only when one's set), and an Equipment row (only when the list isn't empty, one line per item via the same summary format used everywhere else).

## Every field change is its own audit_log row

Not one lumped "job updated" entry -- `updateJob()` in `db.js` diffs the incoming fields against the existing row and writes an `audit_log` row per column that actually changed (`field` = the real column name, `old_value`/`new_value` = the before/after). `created`/`completed`/`reopened` are whole-job events with their own `field` values instead of a column name. The per-job "History" button opens a modal listing all of it, most recent first -- reusing the shared `.history-modal-*` overlay/panel classes TC Elite Rollout's own per-cell history window already established (`packages/shell/public/styles.css`), generalised once a second page needed the exact same pattern.

`updated_at`/`updated_by` are always re-touched on a save even when nothing actually changed (re-saving the form with identical values) -- so "who last touched this" stays accurate without polluting the history list with no-op entries.

## Schema migrations

`db.js` runs a short chain of idempotent migrations at module load, each guarded by checking the live table's actual current state (`pragma_table_info`/`sqlite_master`) rather than a separate migrations table:

1. `migrateAddJobDescription` / `migrateAddWorkflowStage` -- plain `ALTER TABLE ADD COLUMN` (no existing CHECK to widen).
2. `migrateRetierPriorityAndFreeTextStage` -- full recreate-table-and-copy (SQLite can't widen an existing CHECK constraint in place): retiered `priority` from the original 3-tier scheme to a 4-tier time-urgency one, and renamed `workflow_stage`'s `date_reqd` to `free_text` (carrying the old label into the new `workflow_stage_text` companion column instead of losing it).
3. `migrateAddBlueColorAndNewStages` -- same recreate-table dance, widening `action_color` to add `blue` and `workflow_stage` to add `in_car`/`delivered`. No data remapping needed here -- every pre-existing value keeps its original name/meaning, only new values were added.
4. `migrateRetierPriorityToStatusStyle` -- same recreate-table dance again, replacing `priority`'s entire tier scheme (time-urgency -> completion-progress, the current one described above). Unlike the other migrations, there's no clean semantic mapping between the old and new schemes -- the remapping used is a documented best-effort default (see the function's own comment in `db.js`), not a guarantee of accuracy; staff should re-check priority on jobs that existed before this migration ran.
5. `migrateAddComingPriority` -- widens `priority`'s CHECK to add `coming` (yellow). No data remapping needed -- every pre-existing value keeps its original name/meaning, only `coming` was added.
6. `migrateAddTakeOnsiteStage` -- widens `workflow_stage`'s CHECK to add `take_onsite`. No data remapping needed, same reasoning as above.
7. `migrateAddDisposeStage` -- widens `workflow_stage`'s CHECK to add `dispose`. No data remapping needed, same reasoning as above.
8. `migrateAddFlagNote` -- plain `ALTER TABLE ADD COLUMN` (no existing CHECK to widen), same as `migrateAddJobDescription` above -- adds the nullable `flag_note` column.

The `equipment` table itself needed no migration function at all -- it's a brand-new table, not a new column on an already-live one, so the top-of-file `CREATE TABLE IF NOT EXISTS` handles it directly on an existing `data.db` the same as it would on a fresh one.

Any future CHECK-widening migration should follow the same pattern: back up `data.db` first (WAL checkpoint + file copy), inspect real live data before writing the migration, and verify against that data afterward.
