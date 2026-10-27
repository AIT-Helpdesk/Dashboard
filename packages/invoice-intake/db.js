// Invoice Intake's own persistent run history -- added so the new
// dashboard log page (client.js/server.js) has something real to read.
// Before this, the only record of what a run did was invoice-intake.log
// (overwritten every run, per DEPLOYMENT.md's own "> not >>" note) and
// invoice-intake-state.json (just a cursor + retry counts, not a
// human-readable history). This gives every attachment outcome -- worked
// or failed -- a permanent row, independent of the log file.
//
// Same node:sqlite (DatabaseSync) + WAL pattern as every other
// page-with-real-data on this dashboard (TC Elite Rollout, Workshop,
// Contract Checks) -- zero new runtime dependencies, no native-binary-on-
// Windows risk, and WAL means the long-running shell server (reading, for
// the log page) and the Task Scheduler-launched ingest.js (writing, every
// 15 min, as a separate process) can both touch data.db at once. As a
// bonus, this file now matches scripts/backup-databases.js's own
// `packages/*/data.db` auto-discovery pattern, so it starts getting
// nightly-backed-up for free, same as every other page's database.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
  -- One row per ingest.js invocation (one Task Scheduler firing).
  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    ok INTEGER,                    -- NULL while in progress; 1/0 once finished
    message TEXT,                  -- the same one-line summary ingest.js already logs to console
    processed_count INTEGER,
    files_written_count INTEGER,
    skipped_count INTEGER,
    failed_count INTEGER
  );

  -- One row per attachment outcome (status='ok'/'fail'), plus one row per
  -- message skipped outright for having no qualifying attachment
  -- (status='skipped', attachment_name NULL). This is the actual "log of
  -- processed records" the summary page reads -- supplier/customer/
  -- description/documentDate are only ever populated on an 'ok' row (the
  -- extracted fields from extract.js); 'fail' rows instead carry reason.
  CREATE TABLE IF NOT EXISTS records (
    id INTEGER PRIMARY KEY,
    run_id INTEGER NOT NULL REFERENCES runs(id),
    created_at TEXT NOT NULL,
    message_id TEXT,
    email_subject TEXT,
    attachment_name TEXT,
    status TEXT NOT NULL,          -- 'ok' | 'fail' | 'skipped'
    final_filename TEXT,
    supplier TEXT,
    customer TEXT,
    description TEXT,
    document_date TEXT,
    reason TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_records_created ON records(created_at);
  CREATE INDEX IF NOT EXISTS idx_records_status ON records(status);
  CREATE INDEX IF NOT EXISTS idx_records_run ON records(run_id);
`);

function nowIso() {
  return new Date().toISOString();
}

function startRun() {
  const info = db.prepare(`INSERT INTO runs (started_at) VALUES (?)`).run(nowIso());
  return Number(info.lastInsertRowid);
}

function finishRun(runId, { ok, message, processedCount, filesWrittenCount, skippedCount, failedCount }) {
  db.prepare(
    `UPDATE runs SET finished_at = $finishedAt, ok = $ok, message = $message, processed_count = $processedCount,
       files_written_count = $filesWrittenCount, skipped_count = $skippedCount, failed_count = $failedCount
     WHERE id = $id`
  ).run({
    $finishedAt: nowIso(),
    $ok: ok ? 1 : 0,
    $message: message,
    $processedCount: processedCount,
    $filesWrittenCount: filesWrittenCount,
    $skippedCount: skippedCount,
    $failedCount: failedCount,
    $id: runId,
  });
}

function recordOutcome(runId, rec) {
  db.prepare(
    `INSERT INTO records
       (run_id, created_at, message_id, email_subject, attachment_name, status, final_filename, supplier, customer, description, document_date, reason)
     VALUES
       ($runId, $createdAt, $messageId, $emailSubject, $attachmentName, $status, $finalFilename, $supplier, $customer, $description, $documentDate, $reason)`
  ).run({
    $runId: runId,
    $createdAt: nowIso(),
    $messageId: rec.messageId || null,
    $emailSubject: rec.emailSubject || null,
    $attachmentName: rec.attachmentName || null,
    $status: rec.status,
    $finalFilename: rec.finalFilename || null,
    $supplier: rec.supplier || null,
    $customer: rec.customer || null,
    $description: rec.description || null,
    $documentDate: rec.documentDate || null,
    $reason: rec.reason || null,
  });
}

// Keeps the log from growing forever on a job that fires every 15 minutes,
// all day, indefinitely -- 180 days comfortably covers anything anyone
// would realistically want to look back at (the brief never asked for
// long-term retention; the SharePoint uploads themselves are the real
// permanent record). Runs are deleted alongside once nothing in `records`
// still references them -- never partially: a run with ANY surviving
// record stays, so its summary line keeps making sense against the rows
// still shown under it.
const RETENTION_DAYS = 180;
function pruneOldRecords() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`DELETE FROM records WHERE created_at < ?`).run(cutoff);
  db.prepare(`DELETE FROM runs WHERE started_at < ? AND id NOT IN (SELECT DISTINCT run_id FROM records)`).run(cutoff);
}

// The log page's main list -- newest first, optionally narrowed to one
// status ('ok'/'fail'/'skipped'); `status` omitted/falsy means all three.
// `limit` is a hard cap (the page always asks for one), not a page size
// with a separate total -- by request this is a recent-activity log, not
// a paginated archive.
function listRecords({ status, limit = 300 } = {}) {
  if (status) {
    return db.prepare(`SELECT * FROM records WHERE status = ? ORDER BY created_at DESC LIMIT ?`).all(status, limit);
  }
  return db.prepare(`SELECT * FROM records ORDER BY created_at DESC LIMIT ?`).all(limit);
}

// Counts per status, for the summary stat tiles -- `sinceIso` null means
// all-time.
function countsByStatus(sinceIso) {
  const rows = sinceIso
    ? db.prepare(`SELECT status, COUNT(*) as n FROM records WHERE created_at >= ? GROUP BY status`).all(sinceIso)
    : db.prepare(`SELECT status, COUNT(*) as n FROM records GROUP BY status`).all();
  const result = { ok: 0, fail: 0, skipped: 0 };
  for (const row of rows) result[row.status] = row.n;
  return result;
}

function getLastRun() {
  return db.prepare(`SELECT * FROM runs ORDER BY started_at DESC LIMIT 1`).get() || null;
}

module.exports = { startRun, finishRun, recordOutcome, pruneOldRecords, listRecords, countsByStatus, getLastRun };
