// SMS page's own data -- every conversation (by phone number), every
// message in it (inbound or outbound), per-conversation notes, and saved
// reply templates. Same node:sqlite DatabaseSync + PRAGMA journal_mode=WAL
// convention every other page's own data.db uses on this dashboard.
//
// This replaces the earlier flat `sent_messages` table outright (not
// alongside it) -- that table only ever held a handful of real test sends
// from this page's first build, so there's nothing worth migrating.
//
// By design (see README.md's own "Why our own database" section): Access4
// is used ONLY for the actual act of sending/receiving an SMS -- every
// conversation, message, status, client/ticket association, and template
// lives here, not re-derived from Access4's own history API on every
// load.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY,
    phone_number TEXT NOT NULL UNIQUE,
    company_id INTEGER,
    company_name TEXT,
    contact_id INTEGER,
    contact_name TEXT,
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN (
      'new', 'awaiting_reply', 'replied_sms', 'replied_email', 'replied_phone',
      'ticket_logged', 'escalated', 'no_action_needed', 'closed'
    )),
    has_unread INTEGER NOT NULL DEFAULT 0,
    do_not_contact INTEGER NOT NULL DEFAULT 0,
    assigned_to_email TEXT,
    assigned_to_name TEXT,
    last_message_at TEXT,
    last_message_preview TEXT,
    last_message_failed INTEGER NOT NULL DEFAULT 0,
    last_message_direction TEXT,
    last_message_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id),
    direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    send_status TEXT,
    access4_sms_id TEXT,
    error TEXT,
    ticket_number TEXT,
    is_logged_manually INTEGER NOT NULL DEFAULT 0,
    sent_by_email TEXT,
    sent_by_name TEXT,
    status TEXT NOT NULL DEFAULT 'new'
  );
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at)');

db.exec(`
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    created_by_email TEXT,
    created_by_name TEXT
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS templates (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    created_by_email TEXT,
    created_by_name TEXT
  );
`);

// Migration: last_message_failed -- added after this table's first real
// build/testing, so an existing data.db from before that needs it added
// by hand. Same idempotent "check sqlite_master's own stored SQL text,
// ALTER TABLE if missing" pattern packages/shell/rollout-tracker-db.js
// already uses.
function migrateAddLastMessageFailed() {
  const current = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'conversations'`).get();
  if (!current || current.sql.includes('last_message_failed')) return;
  db.exec('ALTER TABLE conversations ADD COLUMN last_message_failed INTEGER NOT NULL DEFAULT 0');
}
migrateAddLastMessageFailed();

// Migration: last_message_direction -- same reasoning/pattern as
// last_message_failed above. Lets the list row show whether the most
// recent message was Sent (outbound) or Received (inbound), by request.
function migrateAddLastMessageDirection() {
  const current = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'conversations'`).get();
  if (!current || current.sql.includes('last_message_direction')) return;
  db.exec('ALTER TABLE conversations ADD COLUMN last_message_direction TEXT');
}
migrateAddLastMessageDirection();

// Migration: last_message_error -- same reasoning/pattern as the two
// above. The real Access4 error text, cached here so the list row's own
// hover tooltip can show it without a join back to messages.
function migrateAddLastMessageError() {
  const current = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'conversations'`).get();
  if (!current || current.sql.includes('last_message_error')) return;
  db.exec('ALTER TABLE conversations ADD COLUMN last_message_error TEXT');
}
migrateAddLastMessageError();

// Migration: messages.status -- status belongs to EACH MESSAGE, by direct
// correction ("I did not ask you to change this... I want the status kept
// for EACH MESSAGE") -- it was wrongly moved onto conversations earlier
// this session (editing one log row's status updated every row for that
// same number, which was never asked for). No CHECK constraint here
// (SQLite's ALTER TABLE ADD COLUMN can't add one to an existing table
// cleanly) -- validated at the JS layer instead, same as
// updateConversation()'s own status handling already was.
function migrateAddMessageStatus() {
  const current = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'`).get();
  // A plain substring check here would wrongly match inside the existing
  // "send_status" column, which already contains the text "status" --
  // \b ignores that (an underscore is a "word" character, so there's no
  // boundary between "send" and "status" in "send_status") and only
  // matches a real standalone "status" column.
  if (!current || /\bstatus\b/.test(current.sql)) return;
  db.exec(`ALTER TABLE messages ADD COLUMN status TEXT NOT NULL DEFAULT 'new'`);
}
migrateAddMessageStatus();

// 'opted_out' removed, by request -- the separate do_not_contact flag
// already covers that, a redundant second way to say the same thing.
const STATUS_VALUES = new Set([
  'new', 'awaiting_reply', 'replied_sms', 'replied_email', 'replied_phone',
  'ticket_logged', 'escalated', 'no_action_needed', 'closed',
]);

function nowIso() {
  return new Date().toISOString();
}

// --- Conversations ---------------------------------------------------

function getConversation(id) {
  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
}

function getConversationByPhone(phoneNumber) {
  return db.prepare('SELECT * FROM conversations WHERE phone_number = ?').get(phoneNumber);
}

// `q` matches against company name, contact name, phone number, or the
// most recent ticket number logged against any of that conversation's own
// messages -- one query covers "search by Client, Person, Ticket, Phone
// Number" in a single pass, by request. `days` bounds the working set to
// a recent window (by last_message_at) -- a conversation that's gone
// quiet beyond that window simply doesn't show in the list; the data
// itself is never deleted.
function listConversations({ days, q } = {}) {
  const params = {};
  const where = [];
  if (days) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    where.push('c.last_message_at >= $cutoff');
    params.$cutoff = cutoff;
  }
  if (q && q.trim()) {
    const like = `%${q.trim()}%`;
    where.push(`(
      c.company_name LIKE $like OR
      c.contact_name LIKE $like OR
      c.phone_number LIKE $like OR
      EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.ticket_number LIKE $like)
    )`);
    params.$like = like;
  }
  const sql = `
    SELECT c.* FROM conversations c
    ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY c.last_message_at DESC
  `;
  return db.prepare(sql).all(params);
}

// A genuine LOG -- one row per real message (sent or received) OR note,
// newest first, regardless of direction -- not a conversation inbox
// summarizing each phone number down to its single latest message. Each
// row joins in its OWN conversation's current company/contact/phone, and
// carries ITS OWN direction/body/send outcome/ticket number/status (for a
// message) directly, so the left list reflects real history, not a
// rolled-up summary. Notes are unioned in alongside messages, by request
// ("Include the Note data in the log view") -- `log_type` ('message' or
// 'note') tells the caller which kind of row it's looking at; a note has
// no direction/send outcome/ticket/status of its own, so those columns
// come back NULL for it.
function listMessageLog({ days, q } = {}) {
  const params = {};
  const where = [];
  if (days) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    where.push('log.created_at >= $cutoff');
    params.$cutoff = cutoff;
  }
  if (q && q.trim()) {
    const like = `%${q.trim()}%`;
    where.push(`(
      log.company_name LIKE $like OR
      log.contact_name LIKE $like OR
      log.phone_number LIKE $like OR
      log.ticket_number LIKE $like
    )`);
    params.$like = like;
  }
  const sql = `
    SELECT * FROM (
      SELECT
        'message' AS log_type,
        m.id AS item_id,
        m.conversation_id,
        m.direction,
        m.body,
        m.created_at,
        m.send_status,
        m.error,
        m.ticket_number,
        m.is_logged_manually,
        m.sent_by_name,
        m.status,
        c.phone_number,
        c.company_name,
        c.contact_name,
        c.has_unread,
        c.do_not_contact
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id

      UNION ALL

      SELECT
        'note' AS log_type,
        n.id AS item_id,
        n.conversation_id,
        NULL AS direction,
        n.body,
        n.created_at,
        NULL AS send_status,
        NULL AS error,
        NULL AS ticket_number,
        0 AS is_logged_manually,
        n.created_by_name AS sent_by_name,
        NULL AS status,
        c.phone_number,
        c.company_name,
        c.contact_name,
        c.has_unread,
        c.do_not_contact
      FROM notes n
      JOIN conversations c ON c.id = n.conversation_id
    ) AS log
    ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY log.created_at DESC, log.item_id DESC
  `;
  return db.prepare(sql).all(params);
}

function createConversation({ phoneNumber, companyId, companyName, contactId, contactName }) {
  const existing = getConversationByPhone(phoneNumber);
  if (existing) return existing;
  const now = nowIso();
  const info = db
    .prepare(
      `INSERT INTO conversations (phone_number, company_id, company_name, contact_id, contact_name, created_at, updated_at)
       VALUES ($phoneNumber, $companyId, $companyName, $contactId, $contactName, $now, $now)`
    )
    .run({
      $phoneNumber: phoneNumber,
      $companyId: companyId || null,
      $companyName: companyName || null,
      $contactId: contactId || null,
      $contactName: contactName || null,
      $now: now,
    });
  return getConversation(Number(info.lastInsertRowid));
}

function touchConversation(id, { lastMessagePreview, statusIfDefault, lastMessageFailed, lastMessageDirection, lastMessageError }) {
  const row = getConversation(id);
  if (!row) return;
  const nextStatus = statusIfDefault && row.status === 'new' ? statusIfDefault : row.status;
  db.prepare(
    `UPDATE conversations SET last_message_at = $now, last_message_preview = $preview, last_message_failed = $failed, last_message_direction = $direction, last_message_error = $error, status = $status, updated_at = $now WHERE id = $id`
  ).run({
    $id: id,
    $now: nowIso(),
    $preview: lastMessagePreview,
    $failed: lastMessageFailed ? 1 : 0,
    $direction: lastMessageDirection,
    $error: lastMessageError || null,
    $status: nextStatus,
  });
}

function markRead(id) {
  db.prepare('UPDATE conversations SET has_unread = 0, updated_at = $now WHERE id = $id').run({ $id: id, $now: nowIso() });
}

// Status is NOT handled here -- it lives on each message, not the
// conversation as a whole (see updateMessageStatus() below).
function updateConversation(id, fields) {
  const existing = getConversation(id);
  if (!existing) return null;
  db.prepare(
    `UPDATE conversations SET
       do_not_contact = $doNotContact,
       assigned_to_email = $assignedToEmail,
       assigned_to_name = $assignedToName,
       updated_at = $now
     WHERE id = $id`
  ).run({
    $id: id,
    $doNotContact: fields.doNotContact !== undefined ? (fields.doNotContact ? 1 : 0) : existing.do_not_contact,
    $assignedToEmail: fields.assignedToEmail !== undefined ? fields.assignedToEmail || null : existing.assigned_to_email,
    $assignedToName: fields.assignedToName !== undefined ? fields.assignedToName || null : existing.assigned_to_name,
    $now: nowIso(),
  });
  return getConversation(id);
}

// The real per-message status -- editing one message's status never
// affects any other message, even another one on the same conversation.
function updateMessageStatus(messageId, status) {
  if (!STATUS_VALUES.has(status)) throw new Error(`Invalid status "${status}".`);
  const existing = db.prepare('SELECT id FROM messages WHERE id = ?').get(messageId);
  if (!existing) return null;
  db.prepare('UPDATE messages SET status = $status WHERE id = $id').run({ $status: status, $id: messageId });
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
}

function linkClient(id, { companyId, companyName, contactId, contactName }) {
  db.prepare(
    `UPDATE conversations SET company_id = $companyId, company_name = $companyName, contact_id = $contactId, contact_name = $contactName, updated_at = $now WHERE id = $id`
  ).run({
    $id: id,
    $companyId: companyId || null,
    $companyName: companyName || null,
    $contactId: contactId || null,
    $contactName: contactName || null,
    $now: nowIso(),
  });
  return getConversation(id);
}

function unlinkClient(id) {
  return linkClient(id, { companyId: null, companyName: null, contactId: null, contactName: null });
}

// --- Messages ----------------------------------------------------------

function listMessages(conversationId) {
  return db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC').all(conversationId);
}

function previewOf(body) {
  const trimmed = (body || '').trim();
  return trimmed.length > 80 ? `${trimmed.slice(0, 80)}...` : trimmed;
}

// Every real outbound send attempt is logged regardless of Access4's own
// success/failure (status 'sent'/'failed', Access4's own error message on
// failure) -- same "log the attempt either way" resilience the original
// page's own recordSend() already had, kept deliberately unchanged here.
function recordOutboundMessage(conversationId, { body, status, access4SmsId, error, ticketNumber, actor }) {
  const now = nowIso();
  db.prepare(
    `INSERT INTO messages (conversation_id, direction, body, created_at, send_status, access4_sms_id, error, ticket_number, sent_by_email, sent_by_name)
     VALUES ($conversationId, 'out', $body, $now, $status, $access4SmsId, $error, $ticketNumber, $email, $name)`
  ).run({
    $conversationId: conversationId,
    $body: body,
    $now: now,
    $status: status,
    $access4SmsId: access4SmsId || null,
    $error: error || null,
    $ticketNumber: ticketNumber || null,
    $email: actor.email,
    $name: actor.name,
  });
  touchConversation(conversationId, {
    lastMessagePreview: previewOf(body),
    statusIfDefault: 'awaiting_reply',
    lastMessageFailed: status === 'failed',
    lastMessageDirection: 'out',
    lastMessageError: status === 'failed' ? error : null,
  });
}

// The ONE function any inbound message goes through -- today only called
// by the manual "log inbound message" stand-in (isLoggedManually: true);
// once a real capture mechanism (Access4 webhook, etc.) exists, that's
// just a new caller of this same function, no UI/data-model change
// needed. Always sets has_unread -- a real client reply is exactly the
// "something needs your attention" signal this flag exists for.
function recordInboundMessage(conversationId, { body, ticketNumber, isLoggedManually }) {
  const now = nowIso();
  db.prepare(
    `INSERT INTO messages (conversation_id, direction, body, created_at, ticket_number, is_logged_manually)
     VALUES ($conversationId, 'in', $body, $now, $ticketNumber, $isLoggedManually)`
  ).run({
    $conversationId: conversationId,
    $body: body,
    $now: now,
    $ticketNumber: ticketNumber || null,
    $isLoggedManually: isLoggedManually ? 1 : 0,
  });
  db.prepare('UPDATE conversations SET has_unread = 1 WHERE id = ?').run(conversationId);
  touchConversation(conversationId, { lastMessagePreview: previewOf(body), lastMessageFailed: false, lastMessageDirection: 'in', lastMessageError: null });
}

// Most recent ticket_number among this conversation's own messages (most
// recent BY CREATED_AT, not by id -- same ordering listMessages() uses),
// for the "copy from previous message" button. Looks at every message,
// not just the last one, since the most recent message might not itself
// carry a ticket number yet.
function previousTicketNumber(conversationId) {
  const row = db
    .prepare(`SELECT ticket_number FROM messages WHERE conversation_id = ? AND ticket_number IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 1`)
    .get(conversationId);
  return row ? row.ticket_number : null;
}

// --- Notes ---------------------------------------------------------------

function listNotes(conversationId) {
  return db.prepare('SELECT * FROM notes WHERE conversation_id = ? ORDER BY created_at ASC, id ASC').all(conversationId);
}

function addNote(conversationId, { body, actor }) {
  db.prepare(
    `INSERT INTO notes (conversation_id, body, created_at, created_by_email, created_by_name)
     VALUES ($conversationId, $body, $now, $email, $name)`
  ).run({ $conversationId: conversationId, $body: body, $now: nowIso(), $email: actor.email, $name: actor.name });
  return listNotes(conversationId);
}

// --- Templates -----------------------------------------------------------

function listTemplates() {
  return db.prepare('SELECT * FROM templates ORDER BY name ASC').all();
}

function getTemplate(id) {
  return db.prepare('SELECT * FROM templates WHERE id = ?').get(id);
}

function createTemplate({ name, body, actor }) {
  const now = nowIso();
  const info = db
    .prepare(
      `INSERT INTO templates (name, body, created_at, updated_at, created_by_email, created_by_name)
       VALUES ($name, $body, $now, $now, $email, $actorName)`
    )
    .run({ $name: name, $body: body, $now: now, $email: actor.email, $actorName: actor.name });
  return getTemplate(Number(info.lastInsertRowid));
}

function updateTemplate(id, { name, body }) {
  const existing = getTemplate(id);
  if (!existing) return null;
  db.prepare('UPDATE templates SET name = $name, body = $body, updated_at = $now WHERE id = $id').run({
    $id: id,
    $name: name,
    $body: body,
    $now: nowIso(),
  });
  return getTemplate(id);
}

function deleteTemplate(id) {
  db.prepare('DELETE FROM templates WHERE id = ?').run(id);
}

module.exports = {
  getConversation,
  getConversationByPhone,
  listConversations,
  listMessageLog,
  createConversation,
  markRead,
  updateConversation,
  updateMessageStatus,
  linkClient,
  unlinkClient,
  listMessages,
  recordOutboundMessage,
  recordInboundMessage,
  previousTicketNumber,
  listNotes,
  addNote,
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  STATUS_VALUES,
};
