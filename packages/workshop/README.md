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
- **Status** (`workflow_stage`) -- `new` / `free_text` / `in_car` / `take_onsite` / `ready_to_ship` / `ready_for_pickup` / `sent` / `delivered` / `collected`. Purely informational workflow tracking -- reaching `collected` does **not** complete/archive the job on its own, that's the separate Mark Complete tick. `free_text`, `in_car`, and `take_onsite` all pair with a companion `workflow_stage_text` column (type anything / whose car it's in / who took it onsite), shown as an inline text field once picked. `ready_for_pickup`/`sent`/`delivered`/`collected` render in green in the list (reads as "done and on its way out/gone"); `new`/`ready_to_ship`/`in_car`/`take_onsite` render in red (reads as "not yet actioned/still waiting on the workshop") -- for `in_car`/`take_onsite` specifically, once there's real WHO text, only the stage name itself stays red and the person's name renders in the default colour, by request.

## Priority and Status are both click-to-edit inline

Clicking the priority dot or the Status text in the list swaps it for a `<select>` (Status also reveals a text input for the two text-enabled stages) and saves immediately on change -- no trip to the Edit form required, though both are in that form too for editing everything else at once.

## Completing a job vs deleting it -- three genuinely different actions

**Complete** (the checkmark icon) sets `status = 'completed'` and moves the job into the "Show Completed" archive -- full history preserved, reversible via **Reopen**. This is what "finished" means here, mirroring TC Elite Rollout's audit-trail philosophy rather than the whiteboard's "erase it" behaviour.

**Delete, from the open-jobs view** (the trash icon there) is a **soft** delete, by request -- `PATCH /jobs/:id/soft-delete` atomically sets `workflow_stage = 'free_text'` with `workflow_stage_text = 'Deleted'` and completes the job in one call, so it lands in the archive with an honest reason rather than disappearing. Reversible via Reopen, same as any other completed job.

**Delete, from the completed/archive view** (its own trash icon) is a genuine **hard** delete -- for cleaning up a real mistake already sitting in the archive (a duplicate/test entry). Purges that job's own `audit_log` rows too. `DELETE /jobs/:id` also still exists as a route for direct API/admin use.

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

The printer icon on each row (available in both the open and completed views) opens a new browser tab containing a single self-contained, **A5**-sized HTML document for that one job, and immediately triggers the browser's own print dialog -- deliberately not a custom print pipeline, since the browser dialog already lets you pick a real printer or "Save as PDF" as the destination. The card shows Ticket (+ its Autotask status), Due date (red/bold if overdue), Client (ticket's resolved name, with anything manually typed into the Client field afterward in brackets), Status, Priority, Location, Job description, and Current/required action (coloured per its Note colour).

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

Any future CHECK-widening migration should follow the same pattern: back up `data.db` first (WAL checkpoint + file copy), inspect real live data before writing the migration, and verify against that data afterward.
