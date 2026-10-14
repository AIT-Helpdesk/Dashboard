// Accepted-failure records -- "I know this client's backup for this
// application type is failing, I've looked at it, don't count it against
// the All Backups widget until this date". Uses node's own built-in
// `node:sqlite` (DatabaseSync), same reasoning Contract Checks/TC Elite
// Rollout/Workshop already use it for: zero new runtime dependencies, no
// native-binary-on-Windows risk.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.db');
const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL');

// UNIQUE(customer_id, app_type) is the whole mechanism behind "re-accepting
// changes only the end date" -- the upsert below never touches start_date
// on a conflict, so the commencement date set the first time this exact
// (client, application type) pair was accepted survives every later
// re-accept untouched, by request ("leave the commencement date of the
// failures as is").
db.exec(`
  CREATE TABLE IF NOT EXISTS accepted_failures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id TEXT NOT NULL,
    app_type TEXT NOT NULL,
    client_name TEXT,
    domain TEXT,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    accepted_by_name TEXT,
    accepted_at TEXT NOT NULL,
    UNIQUE(customer_id, app_type)
  )
`);

// `startDate` is only ever used on the FIRST insert (a brand-new pair) --
// the ON CONFLICT branch deliberately omits start_date from its SET list,
// so re-accepting an already-accepted (or lapsed) pair only moves end_date
// (plus who/when did the re-accepting) forward.
function upsertAcceptedFailure({ customerId, appType, clientName, domain, startDate, endDate, acceptedByName, acceptedAt }) {
  db.prepare(
    `INSERT INTO accepted_failures (customer_id, app_type, client_name, domain, start_date, end_date, accepted_by_name, accepted_at)
     VALUES ($customerId, $appType, $clientName, $domain, $startDate, $endDate, $acceptedByName, $acceptedAt)
     ON CONFLICT(customer_id, app_type) DO UPDATE SET
       end_date = $endDate,
       accepted_by_name = $acceptedByName,
       accepted_at = $acceptedAt,
       client_name = $clientName,
       domain = $domain`
  ).run({
    $customerId: String(customerId),
    $appType: appType,
    $clientName: clientName || null,
    $domain: domain || null,
    $startDate: startDate,
    $endDate: endDate,
    $acceptedByName: acceptedByName || null,
    $acceptedAt: acceptedAt,
  });
  return getAcceptedFailure(customerId, appType);
}

function getAcceptedFailure(customerId, appType) {
  return db.prepare(`SELECT * FROM accepted_failures WHERE customer_id = ? AND app_type = ?`).get(String(customerId), appType);
}

// Everything, active or lapsed -- used by computeServiceAggregate() in
// server.js to build the full per-(client, app type) lookup map in one
// query rather than one SELECT per failing app.
function listAllAcceptedFailures() {
  return db.prepare(`SELECT * FROM accepted_failures`).all();
}

// Active only (end_date >= today) -- the 5th widget's own count/list.
// Soonest-expiring first, since that's the most actionable ordering (the
// ones about to lapse and need a decision are more useful up top than
// whatever was accepted most recently).
function listActiveAcceptedFailures(today) {
  return db.prepare(`SELECT * FROM accepted_failures WHERE end_date >= ? ORDER BY end_date ASC`).all(today);
}

module.exports = { upsertAcceptedFailure, getAcceptedFailure, listAllAcceptedFailures, listActiveAcceptedFailures };
