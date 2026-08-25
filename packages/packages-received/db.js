// Goods Received's own persistent data -- a goods-received
// register (deliveries arriving at reception), replacing a paper/whiteboard
// log with a real audit trail. Third page on this dashboard with its own
// writable application data, closely mirroring Workshop Board's/TC Elite
// Rollout's own db.js (same node:sqlite/WAL/audit_log shape) -- deliberately
// simpler than either, though: no priority/status colour-coding, and no
// complete/archive concept -- by request, this is a straightforward running
// log staff add to and correct via Edit, not a workflow board. There is no
// delete capability at all (not even a hard-delete route) -- a genuine
// mistake gets fixed via Edit, which is itself an audited change, rather
// than erased outright.
//
// Uses node's own built-in `node:sqlite` (DatabaseSync), not a third-party
// package -- zero new runtime dependencies, no native-binary-on-Windows
// risk. Needs Node >=22.5.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.db');
const db = new DatabaseSync(DB_PATH);

// WAL, not the default rollback journal -- more than one staff member
// logging/checking off deliveries around the same time is the whole point
// of this page, same reasoning as Workshop Board/TC Elite Rollout.
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// Idempotent -- CREATE TABLE IF NOT EXISTS, no separate migration framework
// for this first version (same convention Workshop Board/TC Elite Rollout
// both started with -- a real migration only gets added if/when the schema
// actually needs to change under already-live data).
db.exec(`
  CREATE TABLE IF NOT EXISTS deliveries (
    id INTEGER PRIMARY KEY,
    -- "Date & Time" -- staff-entered (a delivery can be logged after the
    -- fact), not necessarily the same moment as created_at below.
    received_at TEXT NOT NULL,
    receiver_name TEXT,
    -- "Sender/Supplier"
    sender TEXT,
    freight_company TEXT,
    -- "Client" -- free text, not tied to a real Autotask company, same
    -- convention as Workshop Board's own 'customer' column (kept under
    -- that same column name for consistency across the two pages).
    customer TEXT,
    ticket_number TEXT,
    ticket_autotask_id INTEGER,
    -- "Contents (if known)"
    contents TEXT,
    -- "How Many Cartons"
    carton_count INTEGER,
    -- "Contents/Packing Slip Checked" -- a real checkbox, by request.
    slip_checked INTEGER NOT NULL DEFAULT 0 CHECK (slip_checked IN (0, 1)),
    -- "Matched with Order" -- a real checkbox, by request.
    matched_with_order INTEGER NOT NULL DEFAULT 0 CHECK (matched_with_order IN (0, 1)),
    -- "Notes/Action/Given To"
    notes TEXT,
    created_at TEXT NOT NULL,
    created_by_email TEXT NOT NULL,
    created_by_name TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by_email TEXT NOT NULL,
    updated_by_name TEXT NOT NULL
  );

  -- Append-only history -- every field change writes a row here, same "this
  -- is the real reason it beats a paper log" reasoning as Workshop
  -- Board/TC Elite Rollout's own audit_log. One row per CHANGED field, not
  -- one lumped "delivery updated" entry.
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY,
    delivery_id INTEGER NOT NULL REFERENCES deliveries(id),
    changed_at TEXT NOT NULL,
    changed_by_email TEXT NOT NULL,
    changed_by_name TEXT NOT NULL,
    field TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_audit_delivery ON audit_log(delivery_id, changed_at);
`);

function nowIso() {
  return new Date().toISOString();
}

// `actor` is always { email, name } -- req.session.user, same shape every
// other page on this dashboard already reads it (requireAuth guarantees a
// signed-in session before any route runs).
function recordAudit({ deliveryId, field, oldValue = null, newValue = null, actor }) {
  db.prepare(
    `INSERT INTO audit_log (delivery_id, changed_at, changed_by_email, changed_by_name, field, old_value, new_value)
     VALUES ($deliveryId, $changedAt, $email, $name, $field, $oldValue, $newValue)`
  ).run({
    $deliveryId: deliveryId,
    $changedAt: nowIso(),
    $email: actor.email,
    $name: actor.name,
    $field: field,
    $oldValue: oldValue === null || oldValue === undefined ? null : String(oldValue),
    $newValue: newValue === null || newValue === undefined ? null : String(newValue),
  });
}

// Newest received first, by request -- this is a running log, not a
// priority-ordered board. Ties (identical received_at, e.g. bulk-logged
// same time) fall back to creation order, most recent first.
function listDeliveries() {
  return db.prepare(`SELECT * FROM deliveries ORDER BY received_at DESC, created_at DESC`).all();
}

function getDelivery(deliveryId) {
  return db.prepare('SELECT * FROM deliveries WHERE id = ?').get(deliveryId);
}

// camelCase API field name -> real column name, for every editable field.
const FIELD_TO_COLUMN = {
  receivedAt: 'received_at',
  receiverName: 'receiver_name',
  sender: 'sender',
  freightCompany: 'freight_company',
  customer: 'customer',
  ticketNumber: 'ticket_number',
  contents: 'contents',
  cartonCount: 'carton_count',
  slipChecked: 'slip_checked',
  matchedWithOrder: 'matched_with_order',
  notes: 'notes',
};

// `fields` is the camelCase request body; `ticketAutotaskId` is already
// resolved by the caller (server.js) before this runs -- db.js itself never
// talks to Autotask. Writes one single "created" audit entry (not one per
// field) -- the row's own current state already shows what was initially
// entered, audit_log exists to track CHANGES from here on.
function createDelivery(fields, ticketAutotaskId, actor) {
  const now = nowIso();
  const info = db
    .prepare(
      `INSERT INTO deliveries (
         received_at, receiver_name, sender, freight_company, customer, ticket_number, ticket_autotask_id,
         contents, carton_count, slip_checked, matched_with_order, notes,
         created_at, created_by_email, created_by_name, updated_at, updated_by_email, updated_by_name
       )
       VALUES (
         $receivedAt, $receiverName, $sender, $freightCompany, $customer, $ticketNumber, $ticketAutotaskId,
         $contents, $cartonCount, $slipChecked, $matchedWithOrder, $notes,
         $now, $email, $name, $now, $email, $name
       )`
    )
    .run({
      $receivedAt: fields.receivedAt || now,
      $receiverName: fields.receiverName || null,
      $sender: fields.sender || null,
      $freightCompany: fields.freightCompany || null,
      $customer: fields.customer || null,
      $ticketNumber: fields.ticketNumber || null,
      $ticketAutotaskId: ticketAutotaskId,
      $contents: fields.contents || null,
      $cartonCount: fields.cartonCount === undefined || fields.cartonCount === null ? null : fields.cartonCount,
      $slipChecked: fields.slipChecked ? 1 : 0,
      $matchedWithOrder: fields.matchedWithOrder ? 1 : 0,
      $notes: fields.notes || null,
      $now: now,
      $email: actor.email,
      $name: actor.name,
    });
  const deliveryId = Number(info.lastInsertRowid);
  recordAudit({ deliveryId, field: 'created', newValue: 'Delivery logged', actor });
  return deliveryId;
}

// Diffs `fields` against the existing row -- writes only columns that
// actually changed (and only THOSE get an audit_log entry each), but always
// re-touches updated_at/by regardless, so "re-saved the form with no real
// change" still records who last touched it without polluting history with
// identical old/new values. `ticketAutotaskId` is only re-applied when
// ticketNumber is actually part of this update (server.js re-resolves it
// whenever ticketNumber changes).
function updateDelivery(deliveryId, fields, ticketAutotaskId, actor) {
  const existing = getDelivery(deliveryId);
  if (!existing) return null;

  const sets = ['updated_at = $updatedAt', 'updated_by_email = $email', 'updated_by_name = $name'];
  const params = { $id: deliveryId, $updatedAt: nowIso(), $email: actor.email, $name: actor.name };

  for (const [field, column] of Object.entries(FIELD_TO_COLUMN)) {
    if (!(field in fields)) continue;
    let newValue = fields[field];
    if (field === 'slipChecked' || field === 'matchedWithOrder') {
      newValue = newValue ? 1 : 0;
    } else if (newValue === undefined) {
      newValue = null;
    }
    const oldValue = existing[column];
    if (newValue === oldValue) continue;
    sets.push(`${column} = $${field}`);
    params[`$${field}`] = newValue;
    recordAudit({ deliveryId, field: column, oldValue, newValue, actor });
  }
  if ('ticketNumber' in fields) {
    sets.push('ticket_autotask_id = $ticketAutotaskId');
    params.$ticketAutotaskId = ticketAutotaskId;
  }

  db.prepare(`UPDATE deliveries SET ${sets.join(', ')} WHERE id = $id`).run(params);
  return getDelivery(deliveryId);
}

function getDeliveryHistory(deliveryId) {
  return db.prepare('SELECT * FROM audit_log WHERE delivery_id = ? ORDER BY changed_at DESC').all(deliveryId);
}

module.exports = {
  db,
  nowIso,
  recordAudit,
  listDeliveries,
  getDelivery,
  createDelivery,
  updateDelivery,
  getDeliveryHistory,
};
