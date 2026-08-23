// One-time migration: TC-Elite Rollout Tracking - Claude.xlsx -> data.db.
// Usage: node scripts/import-from-xlsx.js <path-to-xlsx>
//
// Column mapping and the "everything vague -> na + reason" value rule were
// both confirmed directly against the real workbook before writing this
// (see the plan/README for the full reasoning). NOT idempotent by design --
// running it twice would create duplicate clients/columns; it's meant to
// run exactly once against a fresh data.db. getOrCreateClient() below is
// the one exception (safe to re-run just the client-metadata part), kept
// defensive rather than because a second full run is expected.
const path = require('path');
const XLSX = require('xlsx');
const { db, nowIso, recordAudit, recomputeRollup } = require('../db.js');

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: node scripts/import-from-xlsx.js <path-to-xlsx>');
  process.exit(1);
}

// Not a real staff member -- keeps the audit log honest about what came
// from this one-time migration versus a real person's later edit.
const IMPORT_ACTOR = { email: 'import@ambientit.com.au', name: 'Spreadsheet Import' };

const wb = XLSX.readFile(path.resolve(filePath));

function sheetRows(sheetName) {
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error(`Sheet "${sheetName}" not found. Available: ${wb.SheetNames.join(', ')}`);
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
}

// YES -> done, NO -> not_done, Started -> started, everything else
// (Skip/Too Old/Too Small/Too Diverse/SaaS Only/Email Only/No DNS
// Access/Maybe/blank) -> na, with the original text kept as the reason
// (blank stays na with no reason -- nothing was ever recorded there).
function mapValue(raw) {
  const v = String(raw ?? '').trim();
  if (v === '') return { status: 'na', reason: null };
  if (/^yes$/i.test(v)) return { status: 'done', reason: null };
  if (/^no$/i.test(v)) return { status: 'not_done', reason: null };
  if (/^started$/i.test(v)) return { status: 'started', reason: null };
  return { status: 'na', reason: v };
}

let columnSortOrder = 0;
function insertColumn(key, label, kind) {
  db.prepare(
    `INSERT INTO columns (key, label, kind, sort_order, created_at, created_by_email, created_by_name)
     VALUES ($key, $label, $kind, $sortOrder, $createdAt, $email, $name)`
  ).run({ $key: key, $label: label, $kind: kind, $sortOrder: columnSortOrder++, $createdAt: nowIso(), $email: IMPORT_ACTOR.email, $name: IMPORT_ACTOR.name });
  const id = db.prepare('SELECT id FROM columns WHERE key = ?').get(key).id;
  recordAudit({ entityType: 'column', columnId: id, actor: IMPORT_ACTOR });
  return id;
}

function insertStage(columnId, key, label, type, sortOrder) {
  db.prepare(
    `INSERT INTO stages (column_id, key, label, type, sort_order, created_at, created_by_email, created_by_name)
     VALUES ($columnId, $key, $label, $type, $sortOrder, $createdAt, $email, $name)`
  ).run({ $columnId: columnId, $key: key, $label: label, $type: type, $sortOrder: sortOrder, $createdAt: nowIso(), $email: IMPORT_ACTOR.email, $name: IMPORT_ACTOR.name });
  const id = db.prepare('SELECT id FROM stages WHERE column_id = ? AND key = ?').get(columnId, key).id;
  recordAudit({ entityType: 'stage', columnId, stageId: id, actor: IMPORT_ACTOR });
  return id;
}

// Two confirmed real inconsistencies in the source data itself (not an
// import bug) -- found by dumping the raw sheets and comparing: the
// AutoElevate Specifics sheet spells one client "Queensland Greyound
// Racing Club" (missing the "h") where the master sheet AND EasyDMarc
// Specifics both agree on "Queensland Greyhound Racing Club", and it also
// has a client as bare "PacGold" where the master sheet AND EasyDMarc
// Specifics both agree on "PacGold #2". 2-of-3 sheets agreeing on each
// real spelling is why these are treated as the same client rather than
// two separate ones -- normalized here so all three sheets' data lands on
// one client record instead of splitting into near-duplicates.
const NAME_FIXES = new Map([
  ['Queensland Greyound Racing Club', 'Queensland Greyhound Racing Club'],
  ['PacGold', 'PacGold #2'],
]);
function normalizeClientName(rawName) {
  const trimmed = String(rawName || '').trim();
  return NAME_FIXES.get(trimmed) || trimmed;
}

function getOrCreateClient(name, activeContract, comment, contractSigned) {
  const trimmed = normalizeClientName(name);
  const existing = db.prepare('SELECT id FROM clients WHERE name = ?').get(trimmed);
  if (existing) return existing.id;
  db.prepare(
    `INSERT INTO clients (name, active_contract, comment, contract_signed, created_at, created_by_email, created_by_name)
     VALUES ($name, $activeContract, $comment, $contractSigned, $createdAt, $email, $createdByName)`
  ).run({
    $name: trimmed,
    $activeContract: activeContract || null,
    $comment: comment || null,
    $contractSigned: contractSigned || null,
    $createdAt: nowIso(),
    $email: IMPORT_ACTOR.email,
    $createdByName: IMPORT_ACTOR.name,
  });
  const id = db.prepare('SELECT id FROM clients WHERE name = ?').get(trimmed).id;
  recordAudit({ entityType: 'client', clientId: id, actor: IMPORT_ACTOR });
  return id;
}

function setCellStatus(clientId, columnId, mapped) {
  db.prepare(
    `INSERT INTO cell_status (client_id, column_id, status, reason, updated_at, updated_by_email, updated_by_name)
     VALUES ($clientId, $columnId, $status, $reason, $updatedAt, $email, $name)`
  ).run({ $clientId: clientId, $columnId: columnId, $status: mapped.status, $reason: mapped.reason, $updatedAt: nowIso(), $email: IMPORT_ACTOR.email, $name: IMPORT_ACTOR.name });
  recordAudit({ entityType: 'cell', clientId, columnId, newStatus: mapped.status, newReason: mapped.reason, actor: IMPORT_ACTOR });
}

function setStageStatus(clientId, stageId, mapped) {
  db.prepare(
    `INSERT INTO stage_status (client_id, stage_id, status, reason, updated_at, updated_by_email, updated_by_name)
     VALUES ($clientId, $stageId, $status, $reason, $updatedAt, $email, $name)`
  ).run({ $clientId: clientId, $stageId: stageId, $status: mapped.status, $reason: mapped.reason, $updatedAt: nowIso(), $email: IMPORT_ACTOR.email, $name: IMPORT_ACTOR.name });
  recordAudit({ entityType: 'stage_cell', clientId, stageId, newStatus: mapped.status, newReason: mapped.reason, actor: IMPORT_ACTOR });
}

function setStageText(clientId, stageId, text) {
  db.prepare(
    `INSERT INTO stage_status (client_id, stage_id, status, reason, updated_at, updated_by_email, updated_by_name)
     VALUES ($clientId, $stageId, NULL, $reason, $updatedAt, $email, $name)`
  ).run({ $clientId: clientId, $stageId: stageId, $reason: text || null, $updatedAt: nowIso(), $email: IMPORT_ACTOR.email, $name: IMPORT_ACTOR.name });
  recordAudit({ entityType: 'stage_cell', clientId, stageId, newReason: text || null, actor: IMPORT_ACTOR });
}

db.exec('BEGIN');
try {
  // ---- 1. Simple + inline-compound columns, from the master sheet ----
  const simpleColumns = [
    { idx: 13, key: 'autotask_classification', label: 'Autotask Classification' },
    { idx: 14, key: 'autotask_tm_contract', label: 'Autotask -- T&M Contract' },
    { idx: 17, key: 'entra_id_backup', label: 'Entra ID Backup' },
    { idx: 18, key: 'tpp_category', label: 'TPP Category' },
    { idx: 22, key: 'huntress', label: 'Huntress' },
    { idx: 25, key: 'bullphish', label: 'Bullphish' },
    { idx: 26, key: 'schedule_site_visits', label: 'Schedule Site Visits' },
    { idx: 32, key: 'sentinel_pc', label: 'Sentinel PC' },
    { idx: 33, key: 'network_glue', label: 'Network Glue' },
  ];
  for (const col of simpleColumns) col.columnId = insertColumn(col.key, col.label, 'simple');

  const bseColId = insertColumn('bse_tc_essentials', 'BSE - TC Essentials', 'compound');
  const bseSaasStageId = insertStage(bseColId, 'saas', 'SaaS', 'status', 0);
  const bseEndpointStageId = insertStage(bseColId, 'endpoint', 'Endpoint', 'status', 1);

  const rmmColId = insertColumn('rmm_policies', 'RMM Policies', 'compound');
  const rmmInRmmStageId = insertStage(rmmColId, 'in_rmm', 'In RMM', 'status', 0);
  const rmmPoliciesStageId = insertStage(rmmColId, 'policies', 'Policies', 'status', 1);
  const rmmReportingStageId = insertStage(rmmColId, 'reporting', 'Reporting', 'status', 2);

  // ---- 2. Compound columns with a real linked detail sheet ----
  // Master columns X (EasyDMARC, idx 23) and Y (AutoElevate, idx 24) are
  // deliberately NOT read here -- their master-sheet value was the OLD
  // manually-kept rollup; this system computes that rollup itself from
  // the real per-stage data below (recomputeRollup(), called once all
  // clients/stages are in place, at the very end of this script).
  const easyDmarcColId = insertColumn('easydmarc', 'EasyDMARC', 'compound');
  const easyDmarcStages = {
    who: insertStage(easyDmarcColId, 'who', 'WHO', 'text', 0),
    domain: insertStage(easyDmarcColId, 'domain', 'Domain', 'text', 1),
    comment: insertStage(easyDmarcColId, 'comment', 'Comment', 'text', 2),
    added: insertStage(easyDmarcColId, 'added', 'Added', 'status', 3),
    verified: insertStage(easyDmarcColId, 'verified', 'Verified', 'status', 4),
    spf: insertStage(easyDmarcColId, 'spf', 'SPF', 'status', 5),
    reputation: insertStage(easyDmarcColId, 'reputation', 'Reputation', 'status', 6),
    dmarc: insertStage(easyDmarcColId, 'dmarc', 'DMARC', 'status', 7),
    dkim: insertStage(easyDmarcColId, 'dkim', 'DKIM', 'status', 8),
    mtaSts: insertStage(easyDmarcColId, 'mta_sts', 'MTA-STS', 'status', 9),
    bimi: insertStage(easyDmarcColId, 'bimi', 'BIMI', 'status', 10),
  };

  const autoElevateColId = insertColumn('autoelevate', 'AutoElevate', 'compound');
  const autoElevateStages = {
    who: insertStage(autoElevateColId, 'who', 'WHO', 'text', 0),
    commenced: insertStage(autoElevateColId, 'commenced', 'Commenced', 'text', 1),
    comment: insertStage(autoElevateColId, 'comment', 'Comment', 'text', 2),
    clientNotice: insertStage(autoElevateColId, 'client_notice', 'Client Notice', 'status', 3),
    installed: insertStage(autoElevateColId, 'installed', 'Installed', 'status', 4),
    uacStatus: insertStage(autoElevateColId, 'uac_status', 'UAC Status', 'status', 5),
    adminRightsUac: insertStage(autoElevateColId, 'admin_rights_uac', 'Admin Rights (UAC Status 3 or 4)', 'status', 6),
    adminRightsRemoved: insertStage(autoElevateColId, 'admin_rights_removed', 'Admin Rights (Removed?)', 'status', 7),
    elevationMode: insertStage(autoElevateColId, 'elevation_mode', 'Elevation Mode', 'status', 8),
    blockingMode: insertStage(autoElevateColId, 'blocking_mode', 'Blocking Mode', 'status', 9),
    anythingElse: insertStage(autoElevateColId, 'anything_else', 'Anything Else?', 'text', 10),
  };

  // ---- 3. Master sheet -- clients + their simple/inline-compound cells ----
  // Real client data is confirmed (by dumping the raw sheet and reading
  // every row) to be exactly array indices 5-31 (Excel rows 6-32,
  // "Abrasive Blasting" through "Wheelchair Vehicle Sales") -- indices 0-4
  // above that are the section title, two header rows, a per-column cost/
  // figure row, and an SLA-by-response-time row; indices 32-33 below it
  // are a COUNT/SUM footer (real values "25"/"444" in the Company column,
  // which would otherwise silently import as two fake clients -- caught
  // by inspecting the actual output the first time this ran). Hard-coded
  // to the confirmed range rather than "read until blank", since this
  // script is a one-time migration against one specific real file, not a
  // general-purpose importer.
  const masterRows = sheetRows('TC ELITE EXTRAS');
  const clientIdByName = new Map();
  let importedClientCount = 0;
  for (let i = 5; i <= 31; i++) {
    const row = masterRows[i];
    const name = normalizeClientName(row[2]); // C = Company
    if (!name) continue;

    const clientId = getOrCreateClient(name, row[1], row[10], row[11]); // B, K, L
    clientIdByName.set(name, clientId);
    importedClientCount++;

    for (const col of simpleColumns) setCellStatus(clientId, col.columnId, mapValue(row[col.idx]));
    setStageStatus(clientId, bseSaasStageId, mapValue(row[15]));
    setStageStatus(clientId, bseEndpointStageId, mapValue(row[16]));
    setStageStatus(clientId, rmmInRmmStageId, mapValue(row[19]));
    setStageStatus(clientId, rmmPoliciesStageId, mapValue(row[20]));
    setStageStatus(clientId, rmmReportingStageId, mapValue(row[21]));
  }
  console.log(`Imported ${importedClientCount} clients from the master sheet.`);

  // ---- 4. AutoElevate Specifics sheet ----
  // Real data is confirmed to be exactly array indices 4-28 (Excel rows
  // 5-29). Below that, rows 29-35 are blank and rows 36+ are a notes/
  // legend section ("Instructions:", "Thoughts:", "Elevation Mode: /
  // Stage #1: / Optimised: / Stage #2: Live Mode") that an open-ended
  // "read until the sheet ends" loop would otherwise import as three fake
  // clients -- caught the same way as the master sheet's footer above.
  const autoElevateRows = sheetRows('Autoelevate Specifics');
  let autoElevateRowCount = 0;
  for (let i = 4; i <= 28; i++) {
    const row = autoElevateRows[i];
    const name = normalizeClientName(row[1]); // Company
    if (!name) continue;
    const clientId = clientIdByName.get(name) || getOrCreateClient(name);
    clientIdByName.set(name, clientId);
    autoElevateRowCount++;

    setStageText(clientId, autoElevateStages.who, row[0]);
    setStageText(clientId, autoElevateStages.commenced, row[2]);
    setStageText(clientId, autoElevateStages.comment, row[3]);
    setStageStatus(clientId, autoElevateStages.clientNotice, mapValue(row[4]));
    setStageStatus(clientId, autoElevateStages.installed, mapValue(row[5]));
    setStageStatus(clientId, autoElevateStages.uacStatus, mapValue(row[6]));
    setStageStatus(clientId, autoElevateStages.adminRightsUac, mapValue(row[7]));
    setStageStatus(clientId, autoElevateStages.adminRightsRemoved, mapValue(row[8]));
    setStageStatus(clientId, autoElevateStages.elevationMode, mapValue(row[9]));
    setStageStatus(clientId, autoElevateStages.blockingMode, mapValue(row[10]));
    setStageText(clientId, autoElevateStages.anythingElse, row[11]);
  }
  console.log(`Imported ${autoElevateRowCount} rows from Autoelevate Specifics.`);

  // ---- 5. EasyDMarc Specifics sheet ----
  // Real data is confirmed to be exactly array indices 5-29 (Excel rows
  // 6-30) -- indices 0-4 above that are the title, a blank row, two
  // header rows, and one blank spacer row; everything from index 30
  // onward is genuinely blank on this sheet (no trailing notes section
  // the way AutoElevate Specifics has), but bounded the same way as the
  // other two sheets anyway for consistency and to fail loudly (import a
  // visibly wrong client) rather than silently if that ever changes.
  const easyDmarcRows = sheetRows('EasyDMarc Specifics');
  let easyDmarcRowCount = 0;
  for (let i = 5; i <= 29; i++) {
    const row = easyDmarcRows[i];
    const name = normalizeClientName(row[1]); // Company
    if (!name) continue;
    const clientId = clientIdByName.get(name) || getOrCreateClient(name);
    clientIdByName.set(name, clientId);
    easyDmarcRowCount++;

    setStageText(clientId, easyDmarcStages.who, row[0]);
    setStageText(clientId, easyDmarcStages.domain, row[2]);
    setStageText(clientId, easyDmarcStages.comment, row[3]);
    setStageStatus(clientId, easyDmarcStages.added, mapValue(row[4]));
    setStageStatus(clientId, easyDmarcStages.verified, mapValue(row[5]));
    setStageStatus(clientId, easyDmarcStages.spf, mapValue(row[6]));
    setStageStatus(clientId, easyDmarcStages.reputation, mapValue(row[7]));
    setStageStatus(clientId, easyDmarcStages.dmarc, mapValue(row[8]));
    setStageStatus(clientId, easyDmarcStages.dkim, mapValue(row[9]));
    setStageStatus(clientId, easyDmarcStages.mtaSts, mapValue(row[10]));
    setStageStatus(clientId, easyDmarcStages.bimi, mapValue(row[11]));
  }
  console.log(`Imported ${easyDmarcRowCount} rows from EasyDMarc Specifics.`);

  // ---- 6. Every client needs a cell_status for EVERY column, including
  // clients found only on a detail sheet (not the master) and compound
  // columns for clients that never had any of their stages touched above
  // (e.g. a master-sheet client with no matching AutoElevate Specifics
  // row at all) -- seed those missing ones to na/not_done-derived state
  // the same way a normal new-client/new-column seed would, THEN
  // recompute every compound column's rollup for every client.
  const allColumns = db.prepare('SELECT id, kind FROM columns').all();
  const allClientIds = [...clientIdByName.values()];
  for (const clientId of allClientIds) {
    for (const col of allColumns) {
      const already = db.prepare('SELECT 1 FROM cell_status WHERE client_id = ? AND column_id = ?').get(clientId, col.id);
      if (already) continue;
      if (col.kind === 'simple') {
        setCellStatus(clientId, col.id, { status: 'not_done', reason: null });
        continue;
      }
      const stages = db.prepare('SELECT id, type FROM stages WHERE column_id = ?').all(col.id);
      for (const stage of stages) {
        const alreadyStage = db.prepare('SELECT 1 FROM stage_status WHERE client_id = ? AND stage_id = ?').get(clientId, stage.id);
        if (alreadyStage) continue;
        if (stage.type === 'status') setStageStatus(clientId, stage.id, { status: 'not_done', reason: null });
        else setStageText(clientId, stage.id, null);
      }
    }
  }

  for (const clientId of allClientIds) {
    for (const col of allColumns.filter((c) => c.kind === 'compound')) {
      recomputeRollup(clientId, col.id, IMPORT_ACTOR);
    }
  }

  db.exec('COMMIT');
  console.log(`\nImport complete. ${allClientIds.length} total clients, ${allColumns.length} total columns.`);
} catch (err) {
  db.exec('ROLLBACK');
  console.error('Import failed, rolled back:', err);
  process.exit(1);
}
