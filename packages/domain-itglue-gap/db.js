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
    category TEXT NOT NULL CHECK (category IN ('missing_from_itglue', 'unmatched_client', 'wrong_client', 'email_domain_mismatch')),
    expiry_date TEXT,
    autotask_client_name TEXT,     -- the CORRECT resolved Client, for every category except unmatched_client (null there)
    itglue_org_url TEXT,           -- the resolved Client's own IT Glue org page, null if no exact name match
    wrong_itglue_org_name TEXT,    -- wrong_client rows only: the org this domain is ACTUALLY filed under in IT Glue
    wrong_itglue_org_url TEXT,     -- wrong_client rows only: that wrong org's own IT Glue page
    autotask_client_url TEXT,      -- wrong_client rows only: the real Autotask Company record (not IT Glue)
    contact_email_domain TEXT,     -- email_domain_mismatch rows only: the Client's own Primary Contact email domain
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

// A CHECK constraint can't be altered in place in SQLite -- the table has
// to be rebuilt to widen it to allow 'wrong_client', by request ("If a
// domain appears on an IT Glue Client but that Client is not the same
// client as the Autotask Client..."). Detected the same way
// migrateAddCreatedBy()-style migrations elsewhere on this dashboard check
// "has this already run" -- reading the table's own stored CREATE
// statement back out of sqlite_master and looking for the new value.
function migrateAddWrongClientCategory() {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'domain_gaps'`).get();
  if (!row || row.sql.includes('wrong_client')) return;
  const columns = db.prepare(`SELECT name FROM pragma_table_info('domain_gaps')`).all().map((c) => c.name);
  const hasWrongOrgColumns = columns.includes('wrong_itglue_org_name');
  db.exec('ALTER TABLE domain_gaps RENAME TO domain_gaps_old');
  db.exec(`
    CREATE TABLE domain_gaps (
      domain_name TEXT PRIMARY KEY,
      category TEXT NOT NULL CHECK (category IN ('missing_from_itglue', 'unmatched_client', 'wrong_client')),
      expiry_date TEXT,
      autotask_client_name TEXT,
      itglue_org_url TEXT,
      wrong_itglue_org_name TEXT,
      wrong_itglue_org_url TEXT,
      tpp_account_reference TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      ticked INTEGER NOT NULL DEFAULT 0,
      ticked_at TEXT,
      ticked_by_email TEXT,
      ticked_by_name TEXT
    );
  `);
  db.exec(`
    INSERT INTO domain_gaps (domain_name, category, expiry_date, autotask_client_name, itglue_org_url, ${hasWrongOrgColumns ? 'wrong_itglue_org_name, wrong_itglue_org_url,' : ''} tpp_account_reference, first_seen_at, last_seen_at, ticked, ticked_at, ticked_by_email, ticked_by_name)
    SELECT domain_name, category, expiry_date, autotask_client_name, itglue_org_url, ${hasWrongOrgColumns ? 'wrong_itglue_org_name, wrong_itglue_org_url,' : ''} tpp_account_reference, first_seen_at, last_seen_at, ticked, ticked_at, ticked_by_email, ticked_by_name
    FROM domain_gaps_old
  `);
  db.exec('DROP TABLE domain_gaps_old');
}
migrateAddWrongClientCategory();

// Same table-rebuild pattern as migrateAddWrongClientCategory() above,
// widening the CHECK a second time for 'email_domain_mismatch', by
// request ("List where Domain is different from the domain of the
// Primary Contact's email address in Autotask").
function migrateAddEmailDomainMismatchCategory() {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'domain_gaps'`).get();
  if (!row || row.sql.includes('email_domain_mismatch')) return;
  const columns = db.prepare(`SELECT name FROM pragma_table_info('domain_gaps')`).all().map((c) => c.name);
  const hasWrongOrgColumns = columns.includes('wrong_itglue_org_name');
  const hasContactEmailDomain = columns.includes('contact_email_domain');
  db.exec('ALTER TABLE domain_gaps RENAME TO domain_gaps_old');
  db.exec(`
    CREATE TABLE domain_gaps (
      domain_name TEXT PRIMARY KEY,
      category TEXT NOT NULL CHECK (category IN ('missing_from_itglue', 'unmatched_client', 'wrong_client', 'email_domain_mismatch')),
      expiry_date TEXT,
      autotask_client_name TEXT,
      itglue_org_url TEXT,
      wrong_itglue_org_name TEXT,
      wrong_itglue_org_url TEXT,
      contact_email_domain TEXT,
      tpp_account_reference TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      ticked INTEGER NOT NULL DEFAULT 0,
      ticked_at TEXT,
      ticked_by_email TEXT,
      ticked_by_name TEXT
    );
  `);
  db.exec(`
    INSERT INTO domain_gaps (domain_name, category, expiry_date, autotask_client_name, itglue_org_url, ${hasWrongOrgColumns ? 'wrong_itglue_org_name, wrong_itglue_org_url,' : ''} ${hasContactEmailDomain ? 'contact_email_domain,' : ''} tpp_account_reference, first_seen_at, last_seen_at, ticked, ticked_at, ticked_by_email, ticked_by_name)
    SELECT domain_name, category, expiry_date, autotask_client_name, itglue_org_url, ${hasWrongOrgColumns ? 'wrong_itglue_org_name, wrong_itglue_org_url,' : ''} ${hasContactEmailDomain ? 'contact_email_domain,' : ''} tpp_account_reference, first_seen_at, last_seen_at, ticked, ticked_at, ticked_by_email, ticked_by_name
    FROM domain_gaps_old
  `);
  db.exec('DROP TABLE domain_gaps_old');
}
migrateAddEmailDomainMismatchCategory();

// Same simple pattern as migrateAddItglueOrgUrl() above -- a plain
// nullable column add, no CHECK constraint involved, by request ("The
// links in the 'Autotask Client UDF' column should go to Autotask, not
// IT Glue"). Runs AFTER the table-rebuild migrations above, not before
// -- those rebuilds have their own fixed column lists (predating this
// one) and would otherwise silently drop this column again right after
// adding it.
function migrateAddAutotaskClientUrl() {
  const columns = db.prepare(`SELECT name FROM pragma_table_info('domain_gaps')`).all();
  if (columns.some((c) => c.name === 'autotask_client_url')) return;
  db.exec('ALTER TABLE domain_gaps ADD COLUMN autotask_client_url TEXT');
}
migrateAddAutotaskClientUrl();

function nowIso() {
  return new Date().toISOString();
}

// `gaps`/`unmatched`/`wrongClient` are this run's FRESH computed lists
// (job.js's own computeGaps() shape: {domainName, expiryDate,
// autotaskClientName, accountReference}, wrongClient rows also carrying
// wrongOrgName/wrongOrgUrl). Upserts each as a row, preserving
// ticked/ticked_at/ticked_by/first_seen_at for anything already in the
// table, then deletes every row NOT in this run's fresh set -- those are
// resolved.
function replaceCurrentGaps(gaps, unmatched, wrongClient, emailDomainMismatch) {
  const now = nowIso();
  const upsert = db.prepare(`
    INSERT INTO domain_gaps (domain_name, category, expiry_date, autotask_client_name, itglue_org_url, wrong_itglue_org_name, wrong_itglue_org_url, autotask_client_url, contact_email_domain, tpp_account_reference, first_seen_at, last_seen_at)
    VALUES ($domainName, $category, $expiryDate, $autotaskClientName, $itglueOrgUrl, $wrongItglueOrgName, $wrongItglueOrgUrl, $autotaskClientUrl, $contactEmailDomain, $tppAccountReference, $now, $now)
    ON CONFLICT (domain_name) DO UPDATE SET
      category = excluded.category,
      expiry_date = excluded.expiry_date,
      autotask_client_name = excluded.autotask_client_name,
      itglue_org_url = excluded.itglue_org_url,
      wrong_itglue_org_name = excluded.wrong_itglue_org_name,
      wrong_itglue_org_url = excluded.wrong_itglue_org_url,
      autotask_client_url = excluded.autotask_client_url,
      contact_email_domain = excluded.contact_email_domain,
      tpp_account_reference = excluded.tpp_account_reference,
      last_seen_at = excluded.last_seen_at
  `);
  const currentNames = new Set();
  for (const d of gaps) {
    currentNames.add(d.domainName);
    upsert.run({
      $domainName: d.domainName,
      $category: 'missing_from_itglue',
      $expiryDate: d.expiryDate,
      $autotaskClientName: d.autotaskClientName,
      $itglueOrgUrl: d.itGlueOrgUrl || null,
      $wrongItglueOrgName: null,
      $wrongItglueOrgUrl: null,
      $autotaskClientUrl: null,
      $contactEmailDomain: null,
      $tppAccountReference: d.accountReference || null,
      $now: now,
    });
  }
  for (const d of unmatched) {
    currentNames.add(d.domainName);
    upsert.run({
      $domainName: d.domainName,
      $category: 'unmatched_client',
      $expiryDate: d.expiryDate,
      $autotaskClientName: null,
      $itglueOrgUrl: null,
      $wrongItglueOrgName: null,
      $wrongItglueOrgUrl: null,
      $autotaskClientUrl: null,
      $contactEmailDomain: null,
      $tppAccountReference: d.accountReference || null,
      $now: now,
    });
  }
  for (const d of wrongClient) {
    currentNames.add(d.domainName);
    upsert.run({
      $domainName: d.domainName,
      $category: 'wrong_client',
      $expiryDate: d.expiryDate,
      $autotaskClientName: d.autotaskClientName,
      $itglueOrgUrl: d.itGlueOrgUrl || null,
      $wrongItglueOrgName: d.wrongOrgName || null,
      $wrongItglueOrgUrl: d.wrongOrgUrl || null,
      $autotaskClientUrl: d.autotaskClientUrl || null,
      $contactEmailDomain: null,
      $tppAccountReference: d.accountReference || null,
      $now: now,
    });
  }
  for (const d of emailDomainMismatch) {
    currentNames.add(d.domainName);
    upsert.run({
      $domainName: d.domainName,
      $category: 'email_domain_mismatch',
      $expiryDate: d.expiryDate,
      $autotaskClientName: d.autotaskClientName,
      $itglueOrgUrl: d.itGlueOrgUrl || null,
      $wrongItglueOrgName: null,
      $wrongItglueOrgUrl: null,
      $autotaskClientUrl: null,
      $contactEmailDomain: d.contactEmailDomain || null,
      $tppAccountReference: d.accountReference || null,
      $now: now,
    });
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
  const wrongClientRows = rows.filter((r) => r.category === 'wrong_client');
  const emailDomainMismatchRows = rows.filter((r) => r.category === 'email_domain_mismatch');
  return {
    gapCount: gapRows.length,
    gapTickedCount: gapRows.filter((r) => r.ticked).length,
    unmatchedCount: unmatchedRows.length,
    unmatchedTickedCount: unmatchedRows.filter((r) => r.ticked).length,
    wrongClientCount: wrongClientRows.length,
    wrongClientTickedCount: wrongClientRows.filter((r) => r.ticked).length,
    emailDomainMismatchCount: emailDomainMismatchRows.length,
    emailDomainMismatchTickedCount: emailDomainMismatchRows.filter((r) => r.ticked).length,
  };
}

module.exports = { replaceCurrentGaps, listGaps, setTicked, getSummaryCounts };
