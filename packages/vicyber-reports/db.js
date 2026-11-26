// ViCyber Reports' own persistent data -- one row per uploaded scan
// spreadsheet (`reports`) and one row per individual finding inside it
// (`findings`), so a later upload for the same Client can be compared
// against an earlier one (Fixed/New/Still Open, see compare.js). Same
// `node:sqlite` DatabaseSync + WAL shape every other page's db.js on this
// dashboard already uses (see @dashboard/announcements/db.js for the house
// style this follows).
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY,
    -- The Autotask Client this upload was NOMINATED for, by request -- never
    -- trusted from the spreadsheet's own "Asset Owner" column, which is
    -- ViCyber's own internal account name and can genuinely disagree with
    -- the real Autotask Client (confirmed live against a real sample file:
    -- "Asset Owner" read "Fairway Capital" throughout a report that was
    -- actually for "Flow Financial").
    client_id INTEGER NOT NULL,
    client_name TEXT NOT NULL,
    filename TEXT NOT NULL,
    uploaded_at TEXT NOT NULL,
    uploaded_by_email TEXT,
    uploaded_by_name TEXT,
    -- Denormalized per-category counts, by request-adjacent convenience --
    -- lets the "past reports for this Client" list show at a glance without
    -- a second query/join against findings for every row in that list.
    endpoint_count INTEGER NOT NULL DEFAULT 0,
    webapp_count INTEGER NOT NULL DEFAULT 0,
    network_count INTEGER NOT NULL DEFAULT 0,
    darkweb_count INTEGER NOT NULL DEFAULT 0
  );
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_reports_client ON reports(client_id, uploaded_at)');

db.exec(`
  CREATE TABLE IF NOT EXISTS findings (
    id INTEGER PRIMARY KEY,
    report_id INTEGER NOT NULL REFERENCES reports(id),
    category TEXT NOT NULL CHECK (category IN ('endpoint', 'webapp', 'network', 'darkweb')),
    -- One normalized "what this finding is about" column across all 4 of
    -- ViCyber's own very different sheet shapes -- Endpoint's own
    -- "Asset/IP", WebApp's own "URL", Network's own "Host:Port", DarkWeb's
    -- own "Account" (see parse.js). This (plus category + title) is the
    -- whole comparison key compare.js diffs two reports on.
    device TEXT NOT NULL,
    severity TEXT,
    -- "Vulnerability" on Endpoint/WebApp/Network; a fixed "Exposed
    -- Credential" label on DarkWeb (its own "Password Exposed" column is
    -- the finding's VALUE, not a finding TYPE -- kept in details instead,
    -- see parse.js's own comment).
    title TEXT NOT NULL,
    detected_date TEXT,
    -- Every category's own "Recommendation" column is pulled out to its own
    -- column (present on all 4 sheets, confirmed live) rather than buried in
    -- details below, since it's the one field genuinely worth showing
    -- consistently across every category.
    recommendation TEXT,
    -- Whatever's left that's genuinely category-specific (CVE ID/Threat/Ref
    -- for Endpoint, Threat/Impact for WebApp, Port/Description/Ref for
    -- Network, Found Location/Date Of Leak for DarkWeb) -- one flexible JSON
    -- column rather than a sparse table of 10+ mostly-NULL columns, same
    -- '<col>_json'-style convention @dashboard/contract-checks/db.js already
    -- uses for its own variable-shape data.
    details_json TEXT NOT NULL DEFAULT '{}'
  );
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_findings_report ON findings(report_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_findings_report_category ON findings(report_id, category)');

function nowIso() {
  return new Date().toISOString();
}

// Inserts one report + all its findings as a single transaction -- either
// the whole upload lands, or none of it does, never a half-written report
// if something throws partway through a long findings list.
function createReport({ clientId, clientName, filename, uploadedByEmail, uploadedByName, categories }) {
  const counts = {
    endpoint: (categories.endpoint || []).length,
    webapp: (categories.webapp || []).length,
    network: (categories.network || []).length,
    darkweb: (categories.darkweb || []).length,
  };
  db.exec('BEGIN');
  try {
    const insertReport = db.prepare(`
      INSERT INTO reports (client_id, client_name, filename, uploaded_at, uploaded_by_email, uploaded_by_name, endpoint_count, webapp_count, network_count, darkweb_count)
      VALUES ($clientId, $clientName, $filename, $uploadedAt, $uploadedByEmail, $uploadedByName, $endpointCount, $webappCount, $networkCount, $darkwebCount)
    `);
    const result = insertReport.run({
      $clientId: clientId,
      $clientName: clientName,
      $filename: filename,
      $uploadedAt: nowIso(),
      $uploadedByEmail: uploadedByEmail || null,
      $uploadedByName: uploadedByName || null,
      $endpointCount: counts.endpoint,
      $webappCount: counts.webapp,
      $networkCount: counts.network,
      $darkwebCount: counts.darkweb,
    });
    const reportId = Number(result.lastInsertRowid);

    const insertFinding = db.prepare(`
      INSERT INTO findings (report_id, category, device, severity, title, detected_date, recommendation, details_json)
      VALUES ($reportId, $category, $device, $severity, $title, $detectedDate, $recommendation, $detailsJson)
    `);
    for (const category of ['endpoint', 'webapp', 'network', 'darkweb']) {
      for (const f of categories[category] || []) {
        insertFinding.run({
          $reportId: reportId,
          $category: category,
          $device: f.device,
          $severity: f.severity || null,
          $title: f.title,
          $detectedDate: f.detectedDate || null,
          $recommendation: f.recommendation || null,
          $detailsJson: JSON.stringify(f.details || {}),
        });
      }
    }
    db.exec('COMMIT');
    return reportId;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function listReportsForClient(clientId) {
  return db
    .prepare('SELECT * FROM reports WHERE client_id = ? ORDER BY uploaded_at DESC')
    .all(clientId);
}

function getReport(reportId) {
  return db.prepare('SELECT * FROM reports WHERE id = ?').get(reportId);
}

// Maps the raw snake_case SQLite columns to the camelCase shape every
// caller (compare.js, server.js's own JSON responses, client.js) actually
// reads -- `detected_date` -> `detectedDate` in particular; left as the raw
// column name here, this silently read back as `undefined` everywhere
// downstream (the Detected column's own real bug, found live).
function rowToFinding(r) {
  return {
    id: r.id,
    reportId: r.report_id,
    category: r.category,
    device: r.device,
    severity: r.severity,
    title: r.title,
    detectedDate: r.detected_date,
    recommendation: r.recommendation,
    details: JSON.parse(r.details_json || '{}'),
  };
}

function listFindingsForReport(reportId) {
  return db.prepare('SELECT * FROM findings WHERE report_id = ?').all(reportId).map(rowToFinding);
}

// Permanently removes a report and every one of its findings -- by request
// ("an option to delete a report"), a single transaction so a crash
// mid-delete never leaves orphaned findings with no parent report.
function deleteReport(reportId) {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM findings WHERE report_id = ?').run(reportId);
    const result = db.prepare('DELETE FROM reports WHERE id = ?').run(reportId);
    db.exec('COMMIT');
    return result.changes > 0;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { createReport, listReportsForClient, getReport, listFindingsForReport, deleteReport };
