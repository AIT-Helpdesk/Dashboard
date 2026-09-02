// Contract Checks' own persistent data -- the third page on this dashboard
// with real, writable application data of its own (after TC Elite Rollout
// and Workshop Board, whose db.js this closely follows). Turns Ingram order
// data into a real, trackable checklist -- see this package's own README
// for the full plan-to-schema mapping.
//
// Uses node's own built-in `node:sqlite` (DatabaseSync), same reasoning as
// TC Elite Rollout/Workshop: zero new runtime dependencies, no native-
// binary-on-Windows risk. Needs Node >=22.5 (confirmed working on this
// machine, Node v24.18.0).
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.db');
const db = new DatabaseSync(DB_PATH);

// WAL, same reasoning as TC Elite Rollout/Workshop -- multiple staff
// checking contracts around the same time is the whole point of this page.
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// The six checkbox-style fields every item row carries, each backed by its
// own <field>_at/_by_email/_by_name trio (see CREATE TABLE below) -- driving
// setToggle()/getToggleHistories() generically rather than one function per
// checkbox. Adding a 7th checkbox later means adding one entry here plus 3
// columns, not a new code path.
const TOGGLE_FIELDS = ['checked_contract', 'm365_ok', 'tc_elite', 'tc_ess', 'others', 'all_done'];

db.exec(`
  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY,
    -- The extensibility point, by request -- "multiple selectable Contract
    -- Process Types". Only 'ingram_subscription' exists today; see this
    -- package's README ("Process Types") for how a second type slots in.
    process_type TEXT NOT NULL DEFAULT 'ingram_subscription',
    source_order_id TEXT NOT NULL,        -- Ingram's own order id
    order_number TEXT,
    order_type TEXT,                      -- change / sales / renewal / cancellation
    customer_id TEXT,
    client_name TEXT,
    status TEXT,                          -- processing / completed / cancelled
    creation_date TEXT,                   -- ISO timestamp, from Ingram
    provisioning_date TEXT,               -- Ingram's own real field, set once actually provisioned
    -- The Ingram Orders "Provisioned column for pending orders" fix
    -- (packages/ingram-orders/server.js's fetchOrderDetailWithRetry ->
    -- effectiveDate), computed at sync time -- deliberately its OWN field,
    -- never written into provisioning_date, by request.
    pending_date TEXT,
    po_number TEXT,
    -- Set to 1 whenever a human enters a PO # via the edit-pencil PATCH
    -- route (updateItemFields() below), by request -- Ingram can (and
    -- does -- confirmed live: a subscription's own PONumber attribute can
    -- sit stale for months) keep returning a stale PO # on a still-
    -- processing order's own detail response, so a human correction needs
    -- protecting from being silently reverted by the next sync
    -- (upsertOrder() below checks this before ever overwriting po_number/
    -- ticket_autotask_id). Also drives the green "manually entered" icon
    -- and suppresses the "?" date-mismatch icon (both in client.js) --
    -- see updateItemFields()'s own comment for exactly when this flips
    -- back to 0.
    po_number_manual INTEGER NOT NULL DEFAULT 0,
    -- Resolved from po_number, same pattern as Workshop's
    -- resolveTicketAutotaskId() -- lets PO # link straight to the Autotask
    -- ticket that requested the change.
    ticket_autotask_id INTEGER,
    products_json TEXT,                   -- JSON [{name, quantity}], same shape Ingram Orders already uses
    current_total INTEGER,                -- change orders' subscription-level current seat total

    -- "Checked Contract"
    checked_contract_at TEXT, checked_contract_by_email TEXT, checked_contract_by_name TEXT,

    -- Info Q&A stamp -- same two-field shape as Workshop's flag_note/flag_answer
    info_question TEXT,
    info_answer TEXT,

    -- Per-order checkboxes
    m365_ok_at TEXT, m365_ok_by_email TEXT, m365_ok_by_name TEXT,
    tc_elite_at TEXT, tc_elite_by_email TEXT, tc_elite_by_name TEXT,
    tc_ess_at TEXT, tc_ess_by_email TEXT, tc_ess_by_name TEXT,
    others_at TEXT, others_by_email TEXT, others_by_name TEXT,

    ticket_note TEXT,                     -- free text, no behaviour tied to it yet

    -- "ALL DONE"
    all_done_at TEXT, all_done_by_email TEXT, all_done_by_name TEXT,

    created_at TEXT NOT NULL,             -- when this row was first synced in
    updated_at TEXT NOT NULL,
    UNIQUE (process_type, source_order_id)
  );
  CREATE INDEX IF NOT EXISTS idx_items_creation ON items(creation_date);
  CREATE INDEX IF NOT EXISTS idx_items_client ON items(client_name);
  CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);

  -- Every checkbox toggle (ON *and* OFF) and every text-field edit writes a
  -- row here, same "why this beats a spreadsheet" reasoning as TC Elite/
  -- Workshop's own audit_log. Sync-driven field updates (status/
  -- pending_date/etc, written by upsertOrder() below) do NOT write here --
  -- only human actions do, same convention Ingram Orders/Subscriptions
  -- already draw between "external data refresh" and "a tracked edit".
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY,
    item_id INTEGER NOT NULL REFERENCES items(id),
    changed_at TEXT NOT NULL,
    changed_by_email TEXT NOT NULL,
    changed_by_name TEXT NOT NULL,
    field TEXT NOT NULL,
    old_value TEXT,
    -- For a toggle: the new timestamp when turning ON, NULL when turning
    -- OFF -- lets the per-toggle mini-history (hover tooltip) and the full
    -- History modal both derive "ON at <new_value>" / "OFF at <changed_at>"
    -- from the same rows without a separate on/off flag column.
    new_value TEXT,
    -- Whether THIS toggle actually wrote to Autotask -- only ever set for
    -- an all_done row (the one checkbox with a real Autotask side effect),
    -- via recordTicketActionOutcome() below, called AFTER setToggle()
    -- itself already wrote this row (the Autotask call only happens once
    -- the toggle is already known to have succeeded locally, and its own
    -- outcome isn't known until after that call resolves -- see PATCH
    -- /items/:id/toggle and POST /items/bulk-close in server.js). NULL on
    -- every other field, and on an all_done row where there was nothing to
    -- send at all (no linked ticket). 'sent' (succeeded), 'failed'
    -- (attempted, see ticket_action_error), 'skipped' (a real, deliberate
    -- non-send -- "Leave as COMPLETE" on an untick, by request -- not a
    -- failure). By request: "whether it was written to Autotask" needed
    -- to survive as a real report answer, not just the one-time toggle
    -- response alert() already showed and forgot.
    ticket_action_result TEXT,
    ticket_action_error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_audit_item ON audit_log(item_id, changed_at);

  -- One row per process type -- the sync cursor and last-run bookkeeping.
  -- Mirrors strety-autotask-sync's last-run.json in spirit, but as a DB row
  -- since this package already has a real database (no separate file needed).
  CREATE TABLE IF NOT EXISTS sync_state (
    process_type TEXT PRIMARY KEY,
    bootstrap_done INTEGER NOT NULL DEFAULT 0 CHECK (bootstrap_done IN (0, 1)),
    last_creation_date_seen TEXT,
    last_run_at TEXT,
    last_run_ok INTEGER,
    last_run_message TEXT,
    last_run_new_count INTEGER,
    last_run_refreshed_count INTEGER
  );

  -- Editable canned text, by request -- e.g. the Ticket Note popup's
  -- "Get Note Template" button (client.js). A real Autotask feature this
  -- came from (Admin > Automation "speed codes"/note templates) has no
  -- REST API to read live, so this is a DB-backed copy someone here can
  -- update whenever the wording changes, without a code change. One row
  -- per named template -- only 'ticket_note' exists today, but key (a
  -- stable internal id) is deliberately separate from name (the
  -- human-facing display name, editable same as content) specifically so
  -- more templates can be added later -- listTemplates() below already
  -- returns every row, ready for a future picker UI -- without a schema
  -- change or renaming anything already in use.
  CREATE TABLE IF NOT EXISTS templates (
    key TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by_email TEXT,
    updated_by_name TEXT
  );
`);

// Adds `name` to an already-existing templates table (the 'ticket_note' row
// created before this concept existed) -- a plain nullable ADD COLUMN, same
// direct approach Workshop's migrateAddJobDescription() uses (no CHECK
// constraint involved, so no recreate-table dance needed), then backfills
// the one real row so it's never left blank. New templates from here on
// always get a real name via seedDefaultTemplates()/setTemplate() below.
function migrateAddTemplateName() {
  const columns = db.prepare(`SELECT name FROM pragma_table_info('templates')`).all();
  if (columns.some((c) => c.name === 'name')) return;
  db.exec(`ALTER TABLE templates ADD COLUMN name TEXT`);
  db.prepare(`UPDATE templates SET name = 'Ticket Note' WHERE key = 'ticket_note' AND name IS NULL`).run();
}
migrateAddTemplateName();

// Renames the "ALL COMPLETE" checkbox columns to "ALL DONE" -- a plain
// column rename, no CHECK constraint involved, so this is directly
// supported (unlike TC Elite Rollout's own CHECK-widening migrations,
// which need the full recreate-table-and-copy dance). Idempotent: does
// nothing on a brand-new table (CREATE TABLE above already used the new
// names) or once already run. Also updates any audit_log rows already
// written under the old field name, so history/tooltips stay correct for
// rows toggled before this rename.
function migrateRenameAllCompleteToAllDone() {
  const columns = db.prepare(`SELECT name FROM pragma_table_info('items')`).all();
  if (columns.some((c) => c.name === 'all_done_at')) return;
  if (!columns.some((c) => c.name === 'all_complete_at')) return;
  db.exec(`
    ALTER TABLE items RENAME COLUMN all_complete_at TO all_done_at;
    ALTER TABLE items RENAME COLUMN all_complete_by_email TO all_done_by_email;
    ALTER TABLE items RENAME COLUMN all_complete_by_name TO all_done_by_name;
    UPDATE audit_log SET field = 'all_done' WHERE field = 'all_complete';
  `);
}
migrateRenameAllCompleteToAllDone();

// Adds po_number_manual to an already-existing items table -- a plain
// NOT NULL ADD COLUMN with a DEFAULT, so it's directly supported (no
// CHECK constraint involved, no recreate-table dance needed) and every
// pre-existing row correctly starts at 0 (not manually entered) without a
// separate backfill step.
function migrateAddPoNumberManual() {
  const columns = db.prepare(`SELECT name FROM pragma_table_info('items')`).all();
  if (columns.some((c) => c.name === 'po_number_manual')) return;
  db.exec(`ALTER TABLE items ADD COLUMN po_number_manual INTEGER NOT NULL DEFAULT 0`);
}
migrateAddPoNumberManual();

// One-time correction: terminations first synced into their own
// 'ingram_termination' process_type, before being merged into the main
// 'ingram_subscription' list by request, so they show up alongside
// regular orders instead of behind a separate Process Type selection.
// Moves any row still under the old process_type into the new shape --
// process_type 'ingram_subscription', source_order_id prefixed 'sub-'
// (sync.js's own TERMINATION_ID_PREFIX, which all NEW termination rows
// already write under, kept distinct from real Ingram order ids since
// those two id spaces aren't confirmed disjoint). Idempotent: once run,
// no row is left under 'ingram_termination' for a second call to find.
// order_type stays 'termination' throughout, untouched -- already the
// real marker (alongside status 'terminated') that tells these apart from
// actual orders within the now-shared list.
function migrateMergeTerminationsIntoSubscriptionType() {
  const rows = db.prepare(`SELECT id, source_order_id FROM items WHERE process_type = 'ingram_termination'`).all();
  for (const row of rows) {
    db.prepare(`UPDATE items SET process_type = 'ingram_subscription', source_order_id = 'sub-' || source_order_id WHERE id = ?`).run(row.id);
  }
}
migrateMergeTerminationsIntoSubscriptionType();

// One-time correction: PO #/ticket link on a termination row used to be
// resolved from Ingram's own attributes.PONumber (same as an order), before
// catching that it's stale leftover data from whenever the subscription was
// last actually ordered/changed, never anything meaningful about the
// termination itself (by request: "The PO number will never be correct on
// the removed and terminated entries, please leave them blank"). sync.js
// no longer writes one going forward, and its own per-run refresh already
// clears it for any row still in TERMINATION_CUTOFF_DATE's scope -- this
// migration is only for rows that predate that cutoff and so never get
// touched by a sync run again, otherwise permanently stuck with the old
// value. `po_number_manual = 0` guard is the same protection upsertOrder()
// itself always respects -- never clears a PO # a human has actually typed
// in via the edit pencil.
function migrateBlankAutoTerminationPoNumbers() {
  db.prepare(`UPDATE items SET po_number = NULL, ticket_autotask_id = NULL WHERE order_type = 'termination' AND po_number_manual = 0 AND (po_number IS NOT NULL OR ticket_autotask_id IS NOT NULL)`).run();
}
migrateBlankAutoTerminationPoNumbers();

// Adds ticket_action_result/ticket_action_error to an already-existing
// audit_log table -- plain nullable ADD COLUMNs, no CHECK constraint
// involved, so directly supported (no recreate-table dance needed). Every
// pre-existing row correctly starts NULL on both -- an honest "not
// tracked" for history that predates this, not a guess at what actually
// happened.
function migrateAddTicketActionColumns() {
  const columns = db.prepare(`SELECT name FROM pragma_table_info('audit_log')`).all();
  if (columns.some((c) => c.name === 'ticket_action_result')) return;
  db.exec(`ALTER TABLE audit_log ADD COLUMN ticket_action_result TEXT`);
  db.exec(`ALTER TABLE audit_log ADD COLUMN ticket_action_error TEXT`);
}
migrateAddTicketActionColumns();

function nowIso() {
  return new Date().toISOString();
}

// Seeds the 'ticket_note' template once, the first time this ever runs, so
// existing behavior (the hardcoded text this replaced, supplied by request)
// keeps working immediately with no manual re-entry -- INSERT OR IGNORE
// means every later startup is a no-op once the row exists, even after
// someone's since edited it via setTemplate() below.
const DEFAULT_TICKET_NOTE_TEMPLATE = `Contract Term: ANNUAL.MONTHLY

Contract updated with IM-AUTOSync
Contract updated with IM-Sync
Contract updated manually.

-------------------------
Other Updates:
-------------------------
TCELITE
TCESSENTIALS
Usernames
Backup
Exclaimer
KeeperBusiness
-------------------------

License counts audited:
TICKETS M365 CONTRACT INGRAM

-------------------------`;

function seedDefaultTemplates() {
  db.prepare('INSERT OR IGNORE INTO templates (key, name, content, updated_at) VALUES ($key, $name, $content, $updatedAt)').run({
    $key: 'ticket_note',
    $name: 'Ticket Note',
    $content: DEFAULT_TICKET_NOTE_TEMPLATE,
    $updatedAt: nowIso(),
  });
}
seedDefaultTemplates();

// Every template's key/name/last-updated -- not the content itself (kept
// out deliberately, same "list view stays light" reasoning most list
// endpoints on this dashboard already follow), for a future picker UI once
// a second template actually exists. Only 'ticket_note' today.
function listTemplates() {
  return db.prepare('SELECT key, name, updated_at, updated_by_name FROM templates ORDER BY name').all();
}

function getTemplate(key) {
  return db.prepare('SELECT * FROM templates WHERE key = ?').get(key);
}

// Upsert, by request ("easily updated if required") -- a template with no
// row yet (in principle; seedDefaultTemplates() above means 'ticket_note'
// always has one) is created rather than rejected with a 404. `name` and
// `content` are both required together (not a partial-field diff like
// updateItemFields() below) -- the one small edit form in client.js always
// shows and saves both at once, so there's no real "only one changed" case
// to preserve here.
function setTemplate(key, { name, content }, actor) {
  db.prepare(
    `INSERT INTO templates (key, name, content, updated_at, updated_by_email, updated_by_name)
     VALUES ($key, $templateName, $content, $updatedAt, $email, $byName)
     ON CONFLICT(key) DO UPDATE SET
       name = excluded.name, content = excluded.content, updated_at = excluded.updated_at,
       updated_by_email = excluded.updated_by_email, updated_by_name = excluded.updated_by_name`
  ).run({ $key: key, $templateName: name, $content: content, $updatedAt: nowIso(), $email: actor.email, $byName: actor.name });
  return getTemplate(key);
}

// `actor` is always { email, name } -- req.session.user, same shape every
// other page on this dashboard already reads it (requireAuth guarantees a
// signed-in session before any route runs).
// Returns the new row's own id -- lets a caller (setToggle() below, for an
// all_done toggle) come back LATER and stamp ticket_action_result/
// ticket_action_error onto this exact row once the real Autotask call
// resolves (which only happens after this row is already written, and
// whose outcome isn't known yet at the time it's written).
function recordAudit({ itemId, field, oldValue = null, newValue = null, actor }) {
  const info = db
    .prepare(
      `INSERT INTO audit_log (item_id, changed_at, changed_by_email, changed_by_name, field, old_value, new_value)
       VALUES ($itemId, $changedAt, $email, $name, $field, $oldValue, $newValue)`
    )
    .run({
      $itemId: itemId,
      $changedAt: nowIso(),
      $email: actor.email,
      $name: actor.name,
      $field: field,
      $oldValue: oldValue,
      $newValue: newValue,
    });
  return Number(info.lastInsertRowid);
}

// Stamps the real Autotask outcome onto an audit_log row already written
// by setToggle() (via recordAudit() above) -- called from server.js once
// the actual Autotask call (postTicketNoteAndClose()/reopenTicketWithNote())
// resolves, which is always AFTER the row itself was written (see that
// row's own comment in the CREATE TABLE above for why). No-ops silently on
// a null/falsy auditLogId -- callers pass one through even for a toggle
// that had nothing to send (e.g. no linked ticket), where there's simply
// nothing to stamp.
function recordTicketActionOutcome(auditLogId, result, error = null) {
  if (!auditLogId) return;
  db.prepare(`UPDATE audit_log SET ticket_action_result = ?, ticket_action_error = ? WHERE id = ?`).run(result, error, auditLogId);
}

function getItem(itemId) {
  return db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
}

// Generic toggle read/write over TOGGLE_FIELDS -- turning on stamps NOW;
// turning off clears all three columns back to NULL. ALWAYS audits (unlike
// Workshop's equipment checklist, which deliberately skips it) -- the
// ON/OFF history is the whole point of these checkboxes here, by request.
// Returns { item, auditLogId } -- auditLogId is null whenever no audit_log
// row was actually written this call (item not found, or "no real
// change"), and the one real id otherwise, so a caller doing an all_done
// toggle (the one with a real Autotask side effect, resolved AFTER this
// function returns) can come back later via recordTicketActionOutcome()
// and stamp that exact row with the real outcome. `item` is null only when
// itemId doesn't exist at all -- every other case (including "no real
// change") still returns the current item row, same as this function's
// return value always did before.
function setToggle(itemId, field, on, actor) {
  if (!TOGGLE_FIELDS.includes(field)) throw { status: 400, message: `Unknown toggle field: ${field}` };
  const existing = getItem(itemId);
  if (!existing) return { item: null, auditLogId: null };

  const atCol = `${field}_at`;
  const emailCol = `${field}_by_email`;
  const nameCol = `${field}_by_name`;
  const oldValue = existing[atCol];
  const now = nowIso();
  const newValue = on ? now : null;
  if ((oldValue || null) === newValue) return { item: existing, auditLogId: null }; // no real change -- don't pollute the audit log

  db.prepare(`UPDATE items SET ${atCol} = $at, ${emailCol} = $email, ${nameCol} = $name, updated_at = $updatedAt WHERE id = $id`).run({
    $at: newValue,
    $email: on ? actor.email : null,
    $name: on ? actor.name : null,
    $updatedAt: now,
    $id: itemId,
  });
  const auditLogId = recordAudit({ itemId, field, oldValue, newValue, actor });
  return { item: getItem(itemId), auditLogId };
}

// camelCase API field name -> real column name, for the plain-text fields
// (Info Q&A + Ticket Note). Same diffed-update pattern as Workshop's
// updateJob()/FIELD_TO_COLUMN.
const FIELD_TO_COLUMN = {
  infoQuestion: 'info_question',
  infoAnswer: 'info_answer',
  ticketNote: 'ticket_note',
  poNumber: 'po_number',
};

function updateItemFields(itemId, fields, actor) {
  const existing = getItem(itemId);
  if (!existing) return null;

  const sets = ['updated_at = $updatedAt'];
  const params = { $id: itemId, $updatedAt: nowIso() };

  for (const [field, column] of Object.entries(FIELD_TO_COLUMN)) {
    if (!(field in fields)) continue;
    const newValue = fields[field] || null;
    const oldValue = existing[column];
    if (newValue === oldValue) continue;
    sets.push(`${column} = $${field}`);
    params[`$${field}`] = newValue;
    recordAudit({ itemId, field: column, oldValue, newValue, actor });
  }
  // Handled outside the generic loop above, same reasoning Workshop's
  // updateJob() uses for its own ticketNumber/ticket_autotask_id split --
  // the resolved Autotask ticket id is a DERIVED value (server.js already
  // looked it up before calling this), not itself a human edit worth its
  // own audit row, and only ever set alongside a poNumber change.
  //
  // po_number_manual flips to 1 whenever a real value is entered here (by
  // request -- drives the green "manually entered" icon and protects this
  // row's po_number/ticket_autotask_id from being overwritten by a later
  // sync, see upsertOrder() below), and back to 0 when it's cleared to
  // blank -- an empty PO # isn't "manually confirmed", it's "nothing set",
  // and should go back to letting sync populate it normally. Set
  // unconditionally whenever 'poNumber' is present in the request (even if
  // the text itself didn't change, same as the ticket_autotask_id re-set
  // above) -- opening the editor and hitting Save is itself a real
  // confirmation.
  if ('poNumber' in fields) {
    sets.push('ticket_autotask_id = $ticketAutotaskId');
    params.$ticketAutotaskId = fields.ticketAutotaskId ?? null;
    sets.push('po_number_manual = $poNumberManual');
    params.$poNumberManual = fields.poNumber ? 1 : 0;
  }
  if (sets.length === 1) return existing; // nothing actually changed

  db.prepare(`UPDATE items SET ${sets.join(', ')} WHERE id = $id`).run(params);
  return getItem(itemId);
}

// Whether a row already exists for a given (process_type, source_order_id)
// -- exported for sync.js's termination sync (see its own comment), which
// needs to know NEW-ness *before* deciding whether it's worth an extra
// per-subscription detail fetch, not just after the fact like upsertOrder's
// own internal check below (which upsertOrder now reuses, rather than
// keeping its own separate inline query).
function getItemBySource(processType, sourceOrderId) {
  return db.prepare('SELECT * FROM items WHERE process_type = ? AND source_order_id = ?').get(processType, sourceOrderId);
}

// Insert-or-update one synced order, keyed on (process_type,
// source_order_id). The UPDATE path ONLY EVER touches the Ingram-sourced
// columns -- it never touches checked_contract/info/the 4 checkboxes/
// ticket_note/all_done, so a re-sync can never clobber work already
// done on a row. No audit entries -- this is sync-driven, not a human edit,
// same convention Ingram Orders/Subscriptions already draw between
// "external data refresh" and "a tracked edit" (see audit_log's own
// comment above). Returns the local row id.
function upsertOrder(order) {
  const now = nowIso();
  const existing = getItemBySource(order.processType, order.sourceOrderId);

  // A manually-corrected PO #/ticket link (po_number_manual, set by
  // updateItemFields() above) is protected from being silently overwritten
  // by a routine sync, by request -- confirmed live that Ingram can keep
  // returning a stale PO # on a still-processing order's own detail
  // response (the subscription's own PONumber attribute not refreshing
  // between orders), so once a human has corrected it, "Check for more
  // Orders in IM" must not revert that correction back to the same stale
  // value. Every OTHER field on the row still refreshes normally either
  // way -- this only protects these two columns. Never applies on the
  // INSERT path below (existing is null there -- a brand-new row can't
  // already have been manually protected).
  const preserveManualPo = !!(existing && existing.po_number_manual);

  const shared = {
    $orderNumber: order.orderNumber || null,
    $orderType: order.orderType || null,
    $customerId: order.customerId || null,
    $clientName: order.clientName || null,
    $status: order.status || null,
    $creationDate: order.creationDate || null,
    $provisioningDate: order.provisioningDate || null,
    $pendingDate: order.pendingDate || null,
    $poNumber: preserveManualPo ? existing.po_number : order.poNumber || null,
    $ticketAutotaskId: preserveManualPo ? existing.ticket_autotask_id : order.ticketAutotaskId ?? null,
    $productsJson: JSON.stringify(order.products || []),
    $currentTotal: order.currentTotal ?? null,
  };

  if (existing) {
    db.prepare(
      `UPDATE items SET
         order_number = $orderNumber, order_type = $orderType, customer_id = $customerId,
         client_name = $clientName, status = $status, creation_date = $creationDate,
         provisioning_date = $provisioningDate, pending_date = $pendingDate, po_number = $poNumber,
         ticket_autotask_id = $ticketAutotaskId, products_json = $productsJson, current_total = $currentTotal,
         updated_at = $updatedAt
       WHERE id = $id`
    ).run({ ...shared, $updatedAt: now, $id: existing.id });
    return existing.id;
  }

  const info = db
    .prepare(
      `INSERT INTO items (
         process_type, source_order_id, order_number, order_type, customer_id, client_name, status,
         creation_date, provisioning_date, pending_date, po_number, ticket_autotask_id, products_json, current_total,
         created_at, updated_at
       ) VALUES (
         $processType, $sourceOrderId, $orderNumber, $orderType, $customerId, $clientName, $status,
         $creationDate, $provisioningDate, $pendingDate, $poNumber, $ticketAutotaskId, $productsJson, $currentTotal,
         $createdAt, $updatedAt
       )`
    )
    .run({ ...shared, $processType: order.processType, $sourceOrderId: order.sourceOrderId, $createdAt: now, $updatedAt: now });
  return Number(info.lastInsertRowid);
}

function getSyncState(processType) {
  const existing = db.prepare('SELECT * FROM sync_state WHERE process_type = ?').get(processType);
  if (existing) return existing;
  db.prepare('INSERT INTO sync_state (process_type, bootstrap_done) VALUES ($processType, 0)').run({ $processType: processType });
  return db.prepare('SELECT * FROM sync_state WHERE process_type = ?').get(processType);
}

function saveSyncState(processType, fields) {
  const sets = [];
  const params = { $processType: processType };
  for (const [key, value] of Object.entries(fields)) {
    sets.push(`${key} = $${key}`);
    params[`$${key}`] = value;
  }
  db.prepare(`UPDATE sync_state SET ${sets.join(', ')} WHERE process_type = $processType`).run(params);
}

// Bounded SQL layer for the page's list view -- process_type plus a
// since/still-processing gate (see the README's "design note": a row still
// status='processing' is always included regardless of the Since cutoff,
// so an old still-outstanding Annual change never silently vanishes just
// for being older than whatever Since date is selected). Client/status/
// product wildcard filtering, the renewals/cancelled/all-complete gates,
// and the byClient grouping all happen in server.js, same split Ingram
// Orders' own buildReport() uses (SQL/API narrows first, wildcard matching
// happens in JS since it isn't SQL-LIKE shaped).
// sinceIso === null means "All" -- no date restriction at all (the "All"
// checkbox in the filter bar, by request), not just a very early date --
// skips the WHERE clause's date condition entirely rather than relying on
// a sentinel date string comparing less than everything.
function listItemsRaw(processType, sinceIso) {
  if (sinceIso === null) {
    return db.prepare(`SELECT * FROM items WHERE process_type = ? ORDER BY creation_date DESC`).all(processType);
  }
  return db
    .prepare(`SELECT * FROM items WHERE process_type = ? AND (creation_date >= ? OR status = 'processing') ORDER BY creation_date DESC`)
    .all(processType, sinceIso);
}

// The "Change Report" -- every individual TOGGLE event (which tick was
// ticked, when, and whether it actually wrote to Autotask) a human has
// made on or after a given date, by request: "I want to see what was
// updated, like which ticks were ticked and when the Done was done and
// whether it was written to Autotask". An EARLIER version of this
// collapsed everything down to one summary row per item -- replaced
// entirely, by request ("put the change history in this report instead"),
// with one row per actual audit_log entry, newest first.
//
// Deliberately NOT the same "since" as listItemsRaw() above (that one
// gates on an order/termination's own creation_date -- when it happened in
// Ingram; this one gates on changed_at -- when a human here actually
// worked on it). Scoped to TOGGLE_FIELDS only (the six checkboxes), not
// every audit_log field -- info_question/ticket_note/po_number edits go
// through the exact same table but aren't "ticks", and their old_value/
// new_value hold real text rather than the ON-timestamp/NULL shape a tick
// event needs (see audit_log's own new_value comment above). Client/
// Product grouping and sorting happen in client.js, same SQL-narrows-first
// split every other list route here already follows.
function listChangeEventsSince(processType, sinceIso) {
  const fieldPlaceholders = TOGGLE_FIELDS.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT
         audit_log.id AS audit_id,
         audit_log.field,
         audit_log.new_value,
         audit_log.changed_at,
         audit_log.changed_by_name,
         audit_log.ticket_action_result,
         audit_log.ticket_action_error,
         items.id AS item_id,
         items.client_name,
         items.order_number,
         items.order_type,
         items.status,
         items.po_number,
         items.products_json
       FROM audit_log
       JOIN items ON items.id = audit_log.item_id
       WHERE items.process_type = ? AND audit_log.changed_at >= ? AND audit_log.field IN (${fieldPlaceholders})
       ORDER BY audit_log.changed_at DESC`
    )
    .all(processType, sinceIso, ...TOGGLE_FIELDS);
}

// Every currently-outstanding row for a process type -- used by sync.js's
// "refresh outstanding" step (see the README's sync design) to re-check
// status/pending_date on anything not yet resolved, regardless of how old
// it is.
function listOutstandingProcessing(processType) {
  return db.prepare(`SELECT * FROM items WHERE process_type = ? AND status = 'processing'`).all(processType);
}

// Backfill target for a real bug: sync.js's "refresh outstanding" step used
// to only refetch rows still 'processing' -- but the actual event that
// needs a refetch (a status flip processing -> completed, which is when
// Ingram's own provisioning_date first gets set) landed the row in
// 'completed' by the time this query would see it, so it was never
// refetched again and provisioning_date stayed permanently blank. sync.js
// now also refreshes any row matching THIS query alongside the outstanding
// 'processing' ones -- self-healing: once a row picks up a real
// provisioning_date, it stops matching and is never refetched for this
// reason again.
function listCompletedMissingProvisioningDate(processType) {
  return db.prepare(`SELECT * FROM items WHERE process_type = ? AND status = 'completed' AND (provisioning_date IS NULL OR provisioning_date = '')`).all(processType);
}

// One batched COUNT per item, for the History icon's "N records" hover
// tooltip -- avoids a full history fetch (or one COUNT query per row) just
// to show a number on every row of the list view.
function getHistoryCounts(itemIds) {
  if (itemIds.length === 0) return {};
  const placeholders = itemIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT item_id, COUNT(*) as count FROM audit_log WHERE item_id IN (${placeholders}) GROUP BY item_id`).all(...itemIds);
  const result = {};
  for (const row of rows) result[row.item_id] = row.count;
  return result;
}

function getItemHistory(itemId) {
  return db.prepare('SELECT * FROM audit_log WHERE item_id = ? ORDER BY changed_at DESC').all(itemId);
}

// One batched query for the hover-tooltip mini per-toggle histories --
// avoids a fetch per row on every page load. Returns
// { [itemId]: { [field]: [{action, at, byName}, ...] } }, newest first.
// 'action' is derived from new_value: non-null means this entry turned the
// toggle ON (new_value IS the timestamp it was set to); null means it was
// turned OFF (changed_at is when).
function getToggleHistories(itemIds) {
  if (itemIds.length === 0) return {};
  const idPlaceholders = itemIds.map(() => '?').join(',');
  const fieldPlaceholders = TOGGLE_FIELDS.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT item_id, field, changed_at, changed_by_name, new_value FROM audit_log
       WHERE item_id IN (${idPlaceholders}) AND field IN (${fieldPlaceholders})
       ORDER BY changed_at DESC`
    )
    .all(...itemIds, ...TOGGLE_FIELDS);

  const result = {};
  for (const row of rows) {
    result[row.item_id] = result[row.item_id] || {};
    result[row.item_id][row.field] = result[row.item_id][row.field] || [];
    result[row.item_id][row.field].push({
      action: row.new_value ? 'on' : 'off',
      at: row.new_value || row.changed_at,
      byName: row.changed_by_name,
    });
  }
  return result;
}

module.exports = {
  db,
  nowIso,
  TOGGLE_FIELDS,
  recordAudit,
  recordTicketActionOutcome,
  getItem,
  setToggle,
  updateItemFields,
  upsertOrder,
  getItemBySource,
  getSyncState,
  saveSyncState,
  listItemsRaw,
  listChangeEventsSince,
  listOutstandingProcessing,
  listCompletedMissingProvisioningDate,
  getItemHistory,
  getHistoryCounts,
  getToggleHistories,
  listTemplates,
  getTemplate,
  setTemplate,
};
