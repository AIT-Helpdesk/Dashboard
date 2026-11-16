// Persistent "currently open gaps" table -- by request, the full domain
// list moved OFF the ticket (which was about to exceed Autotask's 8000-
// character description limit at 155 items) and onto its own dashboard
// page instead, where each domain can be ticked off as handled. Same
// `node:sqlite` DatabaseSync + WAL shape every other page's db.js on this
// dashboard already uses (see @dashboard/announcements/db.js for the house
// style this follows).
//
// One row per domain currently in either gap list. Presence in this table
// IS the "still a gap" signal -- a domain that's now found in IT Glue (or
// now resolves to an Autotask Client and is in IT Glue) simply isn't in the
// fresh set the next run computes, so replaceCurrentGaps() deletes it
// rather than tracking a separate "resolved" flag. `ticked` is preserved
// across runs for any domain that's STILL present -- by request ("keep it
// ticked, but flag it"): a domain ticked off last week that's STILL a gap
// this week stays ticked (no lost progress), and the client.js UI flags
// that combination visibly rather than hiding it.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS domain_gaps (
    domain_name TEXT PRIMARY KEY,
    category TEXT NOT NULL CHECK (category IN ('missing_from_itglue', 'unmatched_client')),
    expiry_date TEXT,
    autotask_client_name TEXT,     -- null for unmatched_client rows
    itglue_org_url TEXT,           -- the resolved Client's own IT Glue org page, null if no exact name match
    tpp_account_reference TEXT,
    first_seen_at TEXT NOT NULL,   -- when this domain first appeared as a gap, preserved across runs
    last_seen_at TEXT NOT NULL,    -- updated every run it's still present
    ticked INTEGER NOT NULL DEFAULT 0,
    ticked_at TEXT,
    ticked_by_email TEXT,
    ticked_by_name TEXT
  );
`);

// Idempotent migration, same "check pragma_table_info, ALTER TABLE ADD
// COLUMN if missing" convention @dashboard/contract-checks/db.js and
// @dashboard/shell/rollout-tracker-db.js already use -- added after this
// table first shipped, so an existing production data.db needs it added
// rather than relying on the CREATE TABLE above (which only runs once).
function migrateAddItglueOrgUrl() {
  const columns = db.prepare(`SELECT name FROM pragma_table_info('domain_gaps')`).all();
  if (columns.some((c) => c.name === 'itglue_org_url')) return;
  db.exec('ALTER TABLE domain_gaps ADD COLUMN itglue_org_url TEXT');
}
migrateAddItglueOrgUrl();

function nowIso() {
  return new Date().toISOString();
}

// `gaps`/`unmatched` are this run's FRESH computed lists (job.js's own
// computeGaps() shape: {domainName, expiryDate, autotaskClientName,
// accountReference}). Upserts each as a row, preserving ticked/ticked_at/
// ticked_by/first_seen_at for anything already in the table, then deletes
// every row NOT in this run's fresh set -- those are resolved.
function replaceCurrentGaps(gaps, unmatched) {
  const now = nowIso();
  const upsert = db.prepare(`
    INSERT INTO domain_gaps (domain_name, category, expiry_date, autotask_client_name, itglue_org_url, tpp_account_reference, first_seen_at, last_seen_at)
    VALUES ($domainName, $category, $expiryDate, $autotaskClientName, $itglueOrgUrl, $tppAccountReference, $now, $now)
    ON CONFLICT (domain_name) DO UPDATE SET
      category = excluded.category,
      expiry_date = excluded.expiry_date,
      autotask_client_name = excluded.autotask_client_name,
      itglue_org_url = excluded.itglue_org_url,
      tpp_account_reference = excluded.tpp_account_reference,
      last_seen_at = excluded.last_seen_at
  `);
  const currentNames = new Set();
  for (const d of gaps) {
    currentNames.add(d.domainName);
    upsert.run({ $domainName: d.domainName, $category: 'missing_from_itglue', $expiryDate: d.expiryDate, $autotaskClientName: d.autotaskClientName, $itglueOrgUrl: d.itGlueOrgUrl || null, $tppAccountReference: d.accountReference || null, $now: now });
  }
  for (const d of unmatched) {
    currentNames.add(d.domainName);
    upsert.run({ $domainName: d.domainName, $category: 'unmatched_client', $expiryDate: d.expiryDate, $autotaskClientName: null, $itglueOrgUrl: null, $tppAccountReference: d.accountReference || null, $now: now });
  }

  // Full rows, not just names, for anything about to be deleted -- the
  // live-refresh path (job.js's own refreshLive()) needs the actual
  // domain/client details to name what got fixed in its Autotask note, not
  // just a count.
  const allRows = db.prepare('SELECT * FROM domain_gaps').all();
  const resolvedRows = allRows.filter((r) => !currentNames.has(r.domain_name));
  if (resolvedRows.length > 0) {
    const del = db.prepare('DELETE FROM domain_gaps WHERE domain_name = ?');
    for (const r of resolvedRows) del.run(r.domain_name);
  }
  return { upserted: currentNames.size, resolved: resolvedRows.length, resolvedRows };
}

function listGaps() {
  return db.prepare('SELECT * FROM domain_gaps ORDER BY category, expiry_date').all();
}

function setTicked(domainName, ticked, actor) {
  const row = db.prepare('SELECT * FROM domain_gaps WHERE domain_name = ?').get(domainName);
  if (!row) return null;
  db.prepare(
    `UPDATE domain_gaps SET ticked = $ticked, ticked_at = $tickedAt, ticked_by_email = $email, ticked_by_name = $name WHERE domain_name = $domainName`
  ).run({
    $domainName: domainName,
    $ticked: ticked ? 1 : 0,
    $tickedAt: ticked ? nowIso() : null,
    $email: ticked ? actor.email : null,
    $name: ticked ? actor.name : null,
  });
  return db.prepare('SELECT * FROM domain_gaps WHERE domain_name = ?').get(domainName);
}

function getSummaryCounts() {
  const rows = listGaps();
  const gapRows = rows.filter((r) => r.category === 'missing_from_itglue');
  const unmatchedRows = rows.filter((r) => r.category === 'unmatched_client');
  return {
    gapCount: gapRows.length,
    gapTickedCount: gapRows.filter((r) => r.ticked).length,
    unmatchedCount: unmatchedRows.length,
    unmatchedTickedCount: unmatchedRows.filter((r) => r.ticked).length,
  };
}

module.exports = { replaceCurrentGaps, listGaps, setTicked, getSummaryCounts };
