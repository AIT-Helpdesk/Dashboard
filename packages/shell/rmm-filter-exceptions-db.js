// RMM Filter Checks' own "Allowed Exceptions" list -- a client genuinely
// missing from a filter, or a site genuinely wrongly included, that's a
// known/accepted state (not something anyone's going to action) can be
// marked an exception so it stops cluttering the main list on every future
// check, while staying visible in its own "Allowed Exceptions" list below.
//
// Same packages/shell/data.db file favorites-db.js/udf-system-matches-db.js
// already use (this dashboard's own "central shell database"), by request
// -- kept here rather than in packages/rmm-filters itself even though only
// that one page reads/writes it today, same reasoning udf-system-matches-db.js
// already documents for keeping shell-hosted reference/exception-style data
// in one central file rather than scattered per page. A separate
// node:sqlite DatabaseSync connection to that same file is safe (WAL mode,
// same as every other db.js here) -- this module just owns its own table.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');

// sub_tab is 'missing' or 'wrongly_included' -- Correctly Present has no
// exceptions concept (nothing there needs allowing), by request. subject_key
// is what uniquely identifies WHAT this exception is about within one
// (filter_name, sub_tab): "company:<id>" for every Missing row (always a
// real Autotask company) and every Wrongly Included row that resolved to
// one, or "site:<raw site name>" for a Wrongly Included row that never
// resolved to any company at all (nothing else to key it by -- see
// rmm-filters/server.js's own subjectKey construction). client_name is
// purely for display/audit (the company name, or the raw site name in that
// unresolved case) -- never used to look anything up, so a company rename
// later doesn't orphan an existing exception the way keying on the name
// itself would have.
db.exec(`
  CREATE TABLE IF NOT EXISTS rmm_filter_exceptions (
    id INTEGER PRIMARY KEY,
    filter_name TEXT NOT NULL,
    sub_tab TEXT NOT NULL CHECK (sub_tab IN ('missing', 'wrongly_included')),
    subject_key TEXT NOT NULL,
    client_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    created_by_email TEXT NOT NULL,
    created_by_name TEXT NOT NULL,
    UNIQUE (filter_name, sub_tab, subject_key)
  );
`);

// Keyed by (filter_name, sub_tab) -- what rmm-filters/server.js's own
// splitByExceptions() needs to split one tab's own missing/wrongly-included
// rows into "still showing" vs "excepted". Returns a Map<subject_key,
// exception row> so the caller gets an O(1) lookup per row rather than
// re-scanning the exceptions list once per row. Oldest-first -- the order
// the Allowed Exceptions list itself renders in.
function getExceptionsMap(filterName, subTab) {
  const rows = db
    .prepare('SELECT * FROM rmm_filter_exceptions WHERE filter_name = ? AND sub_tab = ? ORDER BY created_at ASC')
    .all(filterName, subTab);
  return new Map(rows.map((r) => [r.subject_key, r]));
}

// INSERT OR IGNORE -- marking something already marked (a double-click, or
// a second tab/device racing the same request) is a harmless no-op thanks
// to the UNIQUE constraint above, same idempotent-write reasoning
// favorites-db.js's own addFavorite() uses.
function addException({ filterName, subTab, subjectKey, clientName, email, name }) {
  db.prepare(
    `INSERT OR IGNORE INTO rmm_filter_exceptions (filter_name, sub_tab, subject_key, client_name, created_at, created_by_email, created_by_name)
     VALUES ($filterName, $subTab, $subjectKey, $clientName, $now, $email, $name)`
  ).run({
    $filterName: filterName,
    $subTab: subTab,
    $subjectKey: subjectKey,
    $clientName: clientName,
    $now: new Date().toISOString(),
    $email: email,
    $name: name,
  });
}

function removeException(id) {
  db.prepare('DELETE FROM rmm_filter_exceptions WHERE id = ?').run(id);
}

module.exports = { getExceptionsMap, addException, removeException };
