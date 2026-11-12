// A real, if tiny, log of every quick-SMS attempt (success or failure)
// made from this page -- same node:sqlite + PRAGMA journal_mode=WAL
// convention every other page's own data.db uses on this dashboard. Not an
// audit requirement here (there's no compliance ask behind it), just the
// obvious "who sent what, and did it actually go through" record for a
// facility that sends real texts to real numbers through a shared company
// sending number.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS sent_messages (
    id INTEGER PRIMARY KEY,
    to_mobile TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT NOT NULL,
    access4_sms_id TEXT,
    error TEXT,
    sent_at TEXT NOT NULL,
    sent_by_email TEXT NOT NULL,
    sent_by_name TEXT NOT NULL
  );
`);

function recordSend({ toMobile, message, status, access4SmsId, error, actor }) {
  db.prepare(
    `INSERT INTO sent_messages (to_mobile, message, status, access4_sms_id, error, sent_at, sent_by_email, sent_by_name)
     VALUES ($toMobile, $message, $status, $access4SmsId, $error, $sentAt, $email, $name)`
  ).run({
    $toMobile: toMobile,
    $message: message,
    $status: status,
    $access4SmsId: access4SmsId || null,
    $error: error || null,
    $sentAt: new Date().toISOString(),
    $email: actor.email,
    $name: actor.name,
  });
}

function listRecent(limit) {
  return db.prepare('SELECT * FROM sent_messages ORDER BY id DESC LIMIT ?').all(limit);
}

module.exports = { recordSend, listRecent };
