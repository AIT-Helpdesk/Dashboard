// Persistent "currently open gaps" table -- by request, the full domain
// list moved OFF the ticket (which was about to exceed Autotask's 8000-
// character description limit at 155 items) and onto its own dashboard
// page instead, where each domain can be ticked off as handled. Same
// `node:sqlite` DatabaseSync + WAL shape every other page's db.js on this
// dashboard already uses (see @dashboard/announcements/db.js for the house
// style this follows).
//
// One row per (domain, category) currently open -- NOT one row per domain.
// A domain can genuinely belong to more than one category at once (e.g.
// filed under the wrong Client in IT Glue AND also have an Expiry
// Mismatch -- these checks are independent, see job.js's own comment), so
// the primary key is the (domain_name, category) PAIR, not domain_name
// alone. A real incident, found live, is exactly why this matters: with
// domain_name alone as the key, adding the Expiry Mismatch category
// silently collapsed 14 of 15 real "Wrong Client in IT Glue" rows down to
// 1 -- each one's own expiry-mismatch write, for the SAME domain, simply
// overwrote its wrong-client row in place (same primary key, different
// category value). Presence in this table IS the "still a gap" signal for
// that domain IN THAT CATEGORY -- replaceCurrentGaps() deletes a
// (domain, category) pair once that category's own run no longer computes
// it, rather than tracking a separate "resolved" flag; a different
// category's row for that same domain is untouched either way. `ticked` is
// preserved across runs for any (domain, category) pair that's STILL
// present -- by request ("keep it ticked, but flag it"): one ticked off
// last week that's STILL a gap this week stays ticked (no lost progress),
// and the client.js UI flags that combination visibly rather than hiding
// it.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS domain_gaps (
    domain_name TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('missing_from_itglue', 'unmatched_client', 'wrong_client', 'expiry_mismatch', 'expiry_close_mismatch', 'email_domain_mismatch')),
    expiry_date TEXT,
    autotask_client_name TEXT,     -- the CORRECT resolved Client, for every category except unmatched_client (null there)
    itglue_org_url TEXT,           -- the resolved Client's own IT Glue org page, null if no exact name match
    wrong_itglue_org_name TEXT,    -- wrong_client rows only: the org this domain is ACTUALLY filed under in IT Glue
    wrong_itglue_org_url TEXT,     -- wrong_client rows only: that wrong org's own IT Glue page
    autotask_client_url TEXT,      -- wrong_client rows only: the real Autotask Company record (not IT Glue)
    itglue_expires_on TEXT,        -- expiry_mismatch/expiry_close_mismatch rows only: IT Glue's own tracked Expires date, null if it has none/a non-date placeholder
    contact_email_domain TEXT,     -- email_domain_mismatch rows only: the Client's own Primary Contact email domain
    tpp_account_reference TEXT,
    first_seen_at TEXT NOT NULL,   -- when this domain first appeared as a gap, preserved across runs
    last_seen_at TEXT NOT NULL,    -- updated every run it's still present
    ticked INTEGER NOT NULL DEFAULT 0,
    ticked_at TEXT,
    ticked_by_email TEXT,
    ticked_by_name TEXT,
    PRIMARY KEY (domain_name, category)
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

// Same table-rebuild pattern as migrateAddWrongClientCategory()/
// migrateAddEmailDomainMismatchCategory() above, widening the CHECK a
// third time for 'expiry_mismatch', by request ("checks the 'Expires'
// date in the IT Glue Domain Tracker against the 'Expiry Date' in TPP
// Wholesale"). `itglue_expires_on` doesn't exist on any pre-migration
// table yet (added by migrateAddItglueExpiresOn() below, which runs
// AFTER this), so there's nothing to copy forward for it here -- a
// freshly-computed row always supplies it on its very next
// replaceCurrentGaps() anyway.
function migrateAddExpiryMismatchCategory() {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'domain_gaps'`).get();
  if (!row || row.sql.includes('expiry_mismatch')) return;
  const columns = db.prepare(`SELECT name FROM pragma_table_info('domain_gaps')`).all().map((c) => c.name);
  const hasWrongOrgColumns = columns.includes('wrong_itglue_org_name');
  const hasAutotaskClientUrl = columns.includes('autotask_client_url');
  const hasContactEmailDomain = columns.includes('contact_email_domain');
  db.exec('ALTER TABLE domain_gaps RENAME TO domain_gaps_old');
  db.exec(`
    CREATE TABLE domain_gaps (
      domain_name TEXT PRIMARY KEY,
      category TEXT NOT NULL CHECK (category IN ('missing_from_itglue', 'unmatched_client', 'wrong_client', 'expiry_mismatch', 'email_domain_mismatch')),
      expiry_date TEXT,
      autotask_client_name TEXT,
      itglue_org_url TEXT,
      wrong_itglue_org_name TEXT,
      wrong_itglue_org_url TEXT,
      autotask_client_url TEXT,
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
    INSERT INTO domain_gaps (domain_name, category, expiry_date, autotask_client_name, itglue_org_url, ${hasWrongOrgColumns ? 'wrong_itglue_org_name, wrong_itglue_org_url,' : ''} ${hasAutotaskClientUrl ? 'autotask_client_url,' : ''} ${hasContactEmailDomain ? 'contact_email_domain,' : ''} tpp_account_reference, first_seen_at, last_seen_at, ticked, ticked_at, ticked_by_email, ticked_by_name)
    SELECT domain_name, category, expiry_date, autotask_client_name, itglue_org_url, ${hasWrongOrgColumns ? 'wrong_itglue_org_name, wrong_itglue_org_url,' : ''} ${hasAutotaskClientUrl ? 'autotask_client_url,' : ''} ${hasContactEmailDomain ? 'contact_email_domain,' : ''} tpp_account_reference, first_seen_at, last_seen_at, ticked, ticked_at, ticked_by_email, ticked_by_name
    FROM domain_gaps_old
  `);
  db.exec('DROP TABLE domain_gaps_old');
}
migrateAddExpiryMismatchCategory();

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

// Same simple pattern as migrateAddAutotaskClientUrl() above -- a plain
// nullable column add, for the Expiry Mismatch category's own IT Glue
// Expires value (see migrateAddExpiryMismatchCategory() above for why
// this is a separate, later migration rather than part of that one).
function migrateAddItglueExpiresOn() {
  const columns = db.prepare(`SELECT name FROM pragma_table_info('domain_gaps')`).all();
  if (columns.some((c) => c.name === 'itglue_expires_on')) return;
  db.exec('ALTER TABLE domain_gaps ADD COLUMN itglue_expires_on TEXT');
}
migrateAddItglueExpiresOn();

// Same table-rebuild pattern as the CHECK-widening migrations above,
// widening it a fourth time for 'expiry_close_mismatch' -- the Expiry
// Mismatch check's own "off by exactly 1 day" bucket, hidden by default on
// the dashboard page (client.js's own "View ... (N)" button, same
// convention Email Domain Mismatch already established), by request. Runs
// AFTER migrateAddItglueExpiresOn() above (unlike the earlier CHECK
// migrations, which all ran BEFORE their own later column additions) --
// this is the first CHECK-widening migration written after
// itglue_expires_on existed, so it's the first one that actually needs to
// preserve it through its own rebuild.
// Also fixes the primary key to (domain_name, category), not domain_name
// alone -- found live, the hard way: a domain genuinely CAN belong to more
// than one category at once (wrong-client AND expiry-mismatched, say), but
// domain_name alone as the key meant each new category's write for a
// domain silently overwrote any OTHER category's row already stored for
// that same domain (same primary key). Confirmed live: adding Expiry
// Mismatch collapsed 14 of 15 real "Wrong Client in IT Glue" rows down to
// 1 this way. The guard below re-runs this migration even on a database
// that already has 'expiry_close_mismatch' (i.e. already ran an earlier,
// single-column-PK version of this exact migration, written and fixed
// within the same uncommitted change) -- requires BOTH conditions, not
// just the category string, specifically to catch and correct that case.
function migrateAddExpiryCloseMismatchCategory() {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'domain_gaps'`).get();
  if (!row || (row.sql.includes('expiry_close_mismatch') && row.sql.includes('PRIMARY KEY (domain_name, category)'))) return;
  const columns = db.prepare(`SELECT name FROM pragma_table_info('domain_gaps')`).all().map((c) => c.name);
  const hasWrongOrgColumns = columns.includes('wrong_itglue_org_name');
  const hasAutotaskClientUrl = columns.includes('autotask_client_url');
  const hasItglueExpiresOn = columns.includes('itglue_expires_on');
  const hasContactEmailDomain = columns.includes('contact_email_domain');
  db.exec('ALTER TABLE domain_gaps RENAME TO domain_gaps_old');
  db.exec(`
    CREATE TABLE domain_gaps (
      domain_name TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('missing_from_itglue', 'unmatched_client', 'wrong_client', 'expiry_mismatch', 'expiry_close_mismatch', 'email_domain_mismatch')),
      expiry_date TEXT,
      autotask_client_name TEXT,
      itglue_org_url TEXT,
      wrong_itglue_org_name TEXT,
      wrong_itglue_org_url TEXT,
      autotask_client_url TEXT,
      itglue_expires_on TEXT,
      contact_email_domain TEXT,
      tpp_account_reference TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      ticked INTEGER NOT NULL DEFAULT 0,
      ticked_at TEXT,
      ticked_by_email TEXT,
      ticked_by_name TEXT,
      PRIMARY KEY (domain_name, category)
    );
  `);
  db.exec(`
    INSERT INTO domain_gaps (domain_name, category, expiry_date, autotask_client_name, itglue_org_url, ${hasWrongOrgColumns ? 'wrong_itglue_org_name, wrong_itglue_org_url,' : ''} ${hasAutotaskClientUrl ? 'autotask_client_url,' : ''} ${hasItglueExpiresOn ? 'itglue_expires_on,' : ''} ${hasContactEmailDomain ? 'contact_email_domain,' : ''} tpp_account_reference, first_seen_at, last_seen_at, ticked, ticked_at, ticked_by_email, ticked_by_name)
    SELECT domain_name, category, expiry_date, autotask_client_name, itglue_org_url, ${hasWrongOrgColumns ? 'wrong_itglue_org_name, wrong_itglue_org_url,' : ''} ${hasAutotaskClientUrl ? 'autotask_client_url,' : ''} ${hasItglueExpiresOn ? 'itglue_expires_on,' : ''} ${hasContactEmailDomain ? 'contact_email_domain,' : ''} tpp_account_reference, first_seen_at, last_seen_at, ticked, ticked_at, ticked_by_email, ticked_by_name
    FROM domain_gaps_old
  `);
  db.exec('DROP TABLE domain_gaps_old');
}
migrateAddExpiryCloseMismatchCategory();

function nowIso() {
  return new Date().toISOString();
}

// Composite key matching the table's own (domain_name, category) primary
// key -- see this file's own top comment for why domain_name alone isn't
// enough. '\u0000' as the separator, same convention
// @dashboard/domain-itglue-gap/compare.js... (no, wrong package -- same
// convention this dashboard's own comparison keys elsewhere use, e.g.
// @dashboard/vicyber-reports/compare.js's keyFor()) -- a real domain name
// can't contain a null character, so there's no ambiguity.
function gapKey(domainName, category) {
  return `${domainName}\u0000${category}`;
}

// `gaps`/`unmatched`/`wrongClient`/`expiryMismatch` are this run's FRESH
// computed lists (job.js's own computeGaps() shape: {domainName,
// expiryDate, autotaskClientName, accountReference}, wrongClient rows also
// carrying wrongOrgName/wrongOrgUrl, expiryMismatch rows also carrying
// itglueExpiresOn). Upserts each as a row, preserving ticked/ticked_at/
// ticked_by/first_seen_at for anything already in the table, then deletes
// every (domain, category) pair NOT in this run's fresh set -- those are
// resolved IN THAT CATEGORY (a different category's own row for the same
// domain is untouched either way, see this file's own top comment).
function replaceCurrentGaps(gaps, unmatched, wrongClient, expiryMismatch, expiryCloseMismatch, emailDomainMismatch) {
  const now = nowIso();
  const upsert = db.prepare(`
    INSERT INTO domain_gaps (domain_name, category, expiry_date, autotask_client_name, itglue_org_url, wrong_itglue_org_name, wrong_itglue_org_url, autotask_client_url, itglue_expires_on, contact_email_domain, tpp_account_reference, first_seen_at, last_seen_at)
    VALUES ($domainName, $category, $expiryDate, $autotaskClientName, $itglueOrgUrl, $wrongItglueOrgName, $wrongItglueOrgUrl, $autotaskClientUrl, $itglueExpiresOn, $contactEmailDomain, $tppAccountReference, $now, $now)
    ON CONFLICT (domain_name, category) DO UPDATE SET
      expiry_date = excluded.expiry_date,
      autotask_client_name = excluded.autotask_client_name,
      itglue_org_url = excluded.itglue_org_url,
      wrong_itglue_org_name = excluded.wrong_itglue_org_name,
      wrong_itglue_org_url = excluded.wrong_itglue_org_url,
      autotask_client_url = excluded.autotask_client_url,
      itglue_expires_on = excluded.itglue_expires_on,
      contact_email_domain = excluded.contact_email_domain,
      tpp_account_reference = excluded.tpp_account_reference,
      last_seen_at = excluded.last_seen_at
  `);
  const currentKeys = new Set();
  for (const d of gaps) {
    currentKeys.add(gapKey(d.domainName, 'missing_from_itglue'));
    upsert.run({
      $domainName: d.domainName,
      $category: 'missing_from_itglue',
      $expiryDate: d.expiryDate,
      $autotaskClientName: d.autotaskClientName,
      $itglueOrgUrl: d.itGlueOrgUrl || null,
      $wrongItglueOrgName: null,
      $wrongItglueOrgUrl: null,
      $autotaskClientUrl: null,
      $itglueExpiresOn: null,
      $contactEmailDomain: null,
      $tppAccountReference: d.accountReference || null,
      $now: now,
    });
  }
  for (const d of unmatched) {
    currentKeys.add(gapKey(d.domainName, 'unmatched_client'));
    upsert.run({
      $domainName: d.domainName,
      $category: 'unmatched_client',
      $expiryDate: d.expiryDate,
      $autotaskClientName: null,
      $itglueOrgUrl: null,
      $wrongItglueOrgName: null,
      $wrongItglueOrgUrl: null,
      $autotaskClientUrl: null,
      $itglueExpiresOn: null,
      $contactEmailDomain: null,
      $tppAccountReference: d.accountReference || null,
      $now: now,
    });
  }
  for (const d of wrongClient) {
    currentKeys.add(gapKey(d.domainName, 'wrong_client'));
    upsert.run({
      $domainName: d.domainName,
      $category: 'wrong_client',
      $expiryDate: d.expiryDate,
      $autotaskClientName: d.autotaskClientName,
      $itglueOrgUrl: d.itGlueOrgUrl || null,
      $wrongItglueOrgName: d.wrongOrgName || null,
      $wrongItglueOrgUrl: d.wrongOrgUrl || null,
      $autotaskClientUrl: d.autotaskClientUrl || null,
      $itglueExpiresOn: null,
      $contactEmailDomain: null,
      $tppAccountReference: d.accountReference || null,
      $now: now,
    });
  }
  for (const d of expiryMismatch) {
    currentKeys.add(gapKey(d.domainName, 'expiry_mismatch'));
    upsert.run({
      $domainName: d.domainName,
      $category: 'expiry_mismatch',
      $expiryDate: d.expiryDate,
      $autotaskClientName: d.autotaskClientName,
      $itglueOrgUrl: d.itGlueOrgUrl || null,
      $wrongItglueOrgName: null,
      $wrongItglueOrgUrl: null,
      $autotaskClientUrl: null,
      $itglueExpiresOn: d.itglueExpiresOn || null,
      $contactEmailDomain: null,
      $tppAccountReference: d.accountReference || null,
      $now: now,
    });
  }
  for (const d of expiryCloseMismatch) {
    currentKeys.add(gapKey(d.domainName, 'expiry_close_mismatch'));
    upsert.run({
      $domainName: d.domainName,
      $category: 'expiry_close_mismatch',
      $expiryDate: d.expiryDate,
      $autotaskClientName: d.autotaskClientName,
      $itglueOrgUrl: d.itGlueOrgUrl || null,
      $wrongItglueOrgName: null,
      $wrongItglueOrgUrl: null,
      $autotaskClientUrl: null,
      $itglueExpiresOn: d.itglueExpiresOn || null,
      $contactEmailDomain: null,
      $tppAccountReference: d.accountReference || null,
      $now: now,
    });
  }
  for (const d of emailDomainMismatch) {
    currentKeys.add(gapKey(d.domainName, 'email_domain_mismatch'));
    upsert.run({
      $domainName: d.domainName,
      $category: 'email_domain_mismatch',
      $expiryDate: d.expiryDate,
      $autotaskClientName: d.autotaskClientName,
      $itglueOrgUrl: d.itGlueOrgUrl || null,
      $wrongItglueOrgName: null,
      $wrongItglueOrgUrl: null,
      $autotaskClientUrl: null,
      $itglueExpiresOn: null,
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
  const resolvedRows = allRows.filter((r) => !currentKeys.has(gapKey(r.domain_name, r.category)));
  if (resolvedRows.length > 0) {
    // Scoped to the exact (domain, category) pair -- NOT domain_name alone,
    // which would also delete a different category's own still-current row
    // for the same domain (see this file's own top comment).
    const del = db.prepare('DELETE FROM domain_gaps WHERE domain_name = ? AND category = ?');
    for (const r of resolvedRows) del.run(r.domain_name, r.category);
  }
  return { upserted: currentKeys.size, resolved: resolvedRows.length, resolvedRows };
}

function listGaps() {
  return db.prepare('SELECT * FROM domain_gaps ORDER BY category, expiry_date').all();
}

// `category` is required now, not just `domainName` -- a domain can have
// more than one open row (different categories), so ticking has to say
// which one (see this file's own top comment).
function setTicked(domainName, category, ticked, actor) {
  const row = db.prepare('SELECT * FROM domain_gaps WHERE domain_name = ? AND category = ?').get(domainName, category);
  if (!row) return null;
  db.prepare(
    `UPDATE domain_gaps SET ticked = $ticked, ticked_at = $tickedAt, ticked_by_email = $email, ticked_by_name = $name WHERE domain_name = $domainName AND category = $category`
  ).run({
    $domainName: domainName,
    $category: category,
    $ticked: ticked ? 1 : 0,
    $tickedAt: ticked ? nowIso() : null,
    $email: ticked ? actor.email : null,
    $name: ticked ? actor.name : null,
  });
  return db.prepare('SELECT * FROM domain_gaps WHERE domain_name = ? AND category = ?').get(domainName, category);
}

function getSummaryCounts() {
  const rows = listGaps();
  const gapRows = rows.filter((r) => r.category === 'missing_from_itglue');
  const unmatchedRows = rows.filter((r) => r.category === 'unmatched_client');
  const wrongClientRows = rows.filter((r) => r.category === 'wrong_client');
  const expiryMismatchRows = rows.filter((r) => r.category === 'expiry_mismatch');
  const expiryCloseMismatchRows = rows.filter((r) => r.category === 'expiry_close_mismatch');
  const emailDomainMismatchRows = rows.filter((r) => r.category === 'email_domain_mismatch');
  return {
    gapCount: gapRows.length,
    gapTickedCount: gapRows.filter((r) => r.ticked).length,
    unmatchedCount: unmatchedRows.length,
    unmatchedTickedCount: unmatchedRows.filter((r) => r.ticked).length,
    wrongClientCount: wrongClientRows.length,
    wrongClientTickedCount: wrongClientRows.filter((r) => r.ticked).length,
    expiryMismatchCount: expiryMismatchRows.length,
    expiryMismatchTickedCount: expiryMismatchRows.filter((r) => r.ticked).length,
    expiryCloseMismatchCount: expiryCloseMismatchRows.length,
    expiryCloseMismatchTickedCount: expiryCloseMismatchRows.filter((r) => r.ticked).length,
    emailDomainMismatchCount: emailDomainMismatchRows.length,
    emailDomainMismatchTickedCount: emailDomainMismatchRows.filter((r) => r.ticked).length,
  };
}

module.exports = { replaceCurrentGaps, listGaps, setTicked, getSummaryCounts };
