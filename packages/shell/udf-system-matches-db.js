// A small, code-maintained REFERENCE table -- every real Companies UDF on
// this dashboard's Autotask account whose name starts with "Name:", and
// which real external system each one disambiguates. Confirmed live
// against the real account (queried directly, 2096 companies scanned) --
// these 5 are the complete current list; a 6th showing up live that isn't
// in this table yet means a new one was created in Autotask by hand and
// this file needs a new seed row added.
//
// Same packages/shell/data.db file favorites-db.js already uses (this
// dashboard's own "central shell database" for shell-level/cross-page
// reference data, not a single page's own feature data) -- a separate
// node:sqlite DatabaseSync connection to that same file/table space is
// safe (WAL mode, same as every other db.js here), each module just owns
// its own table(s).
//
// Purely a reference lookup, re-seeded (INSERT OR REPLACE) every time this
// module loads -- there's no UI to edit this from; the source of truth is
// this file, not the database. Keeps it in sync automatically whenever a
// label/note here gets updated, rather than only seeding an empty table
// once and then drifting from code.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS udf_system_matches (
    udf_name TEXT PRIMARY KEY,       -- e.g. "Name:Datto RMM"
    system_label TEXT NOT NULL,      -- the real external system, e.g. "Datto RMM"
    matches_field TEXT NOT NULL,     -- what real-world identity the UDF's VALUE holds
    data_matching_concept TEXT,      -- Data Matching's own report/route key for this UDF, if it has one
    notes TEXT,
    updated_at TEXT NOT NULL
  );
`);

// Keep this list in sync with data-matching/server.js's own Concepts 1-5
// (the authoritative write path for each of these UDFs) and whichever
// page(s) each one's own UDF-first-then-name-match lookup lives in
// (check-client/client.js for Ingram Micro/Datto RMM; live-reports/
// server.js for Datto RMM/SaaS Backups; csp-customers/server.js's own
// matching functions for Microsoft 365, not yet wired into a page).
const SEED_ROWS = [
  {
    udfName: 'Name:TPP',
    systemLabel: 'TPP Wholesale',
    matchesField: "TPP's own domain accountReference code (e.g. \"SHE-696\") -- never a real company name",
    dataMatchingConcept: 'tpp-domains-unmatched',
    notes: 'Written via data-matching/server.js Concept 1. Read by packages/coming-soon.',
  },
  {
    udfName: 'Name:Ingram Micro',
    systemLabel: 'Ingram Micro',
    matchesField: "Ingram Micro's own client/company name",
    dataMatchingConcept: 'ingram-clients-unmatched',
    notes:
      'Written via data-matching/server.js Concept 2. Read by check-client/server.js\'s "Ingram Client" resolved field (falls back to the plain Autotask company name when blank).',
  },
  {
    udfName: 'Name:Datto RMM',
    systemLabel: 'Datto RMM',
    matchesField: "Datto RMM's own exact site name",
    dataMatchingConcept: 'datto-sites-unmatched',
    notes:
      'Written via data-matching/server.js Concept 3. Read by check-client/server.js\'s "Datto Site" resolved field and live-reports/server.js\'s Autotask Client lookup (both fall back to the plain Autotask company name when blank).',
  },
  {
    udfName: 'Name:SaaS Backups',
    systemLabel: 'Datto SaaS Protection',
    matchesField: "SaaS Protection's own customer name",
    dataMatchingConcept: 'saas-protection-clients-unmatched',
    notes:
      'Written via data-matching/server.js Concept 4. Read by live-reports/server.js\'s buildSaasProtectionSummary() via saas-protection/server.js\'s findDomainMatchExact() (tried before the fuzzy name-match fallback).',
  },
  {
    udfName: 'Name:Microsoft 365',
    systemLabel: 'Microsoft CSP / Partner Center',
    matchesField: 'The CSP tenant\'s own display name (csp-customers/server.js, Microsoft Graph /contracts)',
    dataMatchingConcept: 'microsoft365-clients-unmatched',
    notes:
      'Written via data-matching/server.js Concept 5 (added ' +
      new Date().toISOString().slice(0, 10) +
      '). Matching function ready in csp-customers/server.js (findCustomerMatchWithUdf()) -- not yet wired into a page UI.',
  },
];

const upsert = db.prepare(
  `INSERT INTO udf_system_matches (udf_name, system_label, matches_field, data_matching_concept, notes, updated_at)
   VALUES ($udfName, $systemLabel, $matchesField, $dataMatchingConcept, $notes, $updatedAt)
   ON CONFLICT (udf_name) DO UPDATE SET
     system_label = excluded.system_label,
     matches_field = excluded.matches_field,
     data_matching_concept = excluded.data_matching_concept,
     notes = excluded.notes,
     updated_at = excluded.updated_at`
);
const nowIso = new Date().toISOString();
for (const row of SEED_ROWS) {
  upsert.run({
    $udfName: row.udfName,
    $systemLabel: row.systemLabel,
    $matchesField: row.matchesField,
    $dataMatchingConcept: row.dataMatchingConcept,
    $notes: row.notes,
    $updatedAt: nowIso,
  });
}

function listUdfSystemMatches() {
  return db.prepare('SELECT udf_name, system_label, matches_field, data_matching_concept, notes, updated_at FROM udf_system_matches ORDER BY udf_name ASC').all();
}

function getUdfSystemMatch(udfName) {
  return db.prepare('SELECT udf_name, system_label, matches_field, data_matching_concept, notes, updated_at FROM udf_system_matches WHERE udf_name = ?').get(udfName);
}

// The reverse lookup -- "which UDF does system X use" -- for a consumer
// (e.g. live-reports/server.js's own UDF-first matching) that knows the
// real external system it's matching, not the UDF name by heart. Reads
// this table's own system_label column, so the UDF name never needs to
// be hardcoded as a literal string a second time in a consumer -- this
// table is the one place that mapping lives.
function getUdfSystemMatchBySystem(systemLabel) {
  return db.prepare('SELECT udf_name, system_label, matches_field, data_matching_concept, notes, updated_at FROM udf_system_matches WHERE system_label = ?').get(systemLabel);
}

module.exports = { listUdfSystemMatches, getUdfSystemMatch, getUdfSystemMatchBySystem };
