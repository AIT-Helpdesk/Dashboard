// Report Ingest -- pulls new report files from SharePoint's Incoming/<Source>/
// folders (a bare report PDF for every Datto/Dark Web ID source; INKY's own
// report .msg EMAILS instead, whose real report is a PDF attachment --
// see extractMsgPdfAttachment() below), parses each into this package's own
// data/<client-slug>/<date>/<kind>.json shape, and moves the original to
// Processed/<Client Name>/<date>/ once written -- see this package's
// README.md ("Not yet built") and data/README.md (the SharePoint layout
// this was always meant to plug into) for the plan this implements. Same
// runSync()-shaped job contract Contract Checks' own sync.js already
// establishes: POST /ingest (server.js) for the manual button, `node
// packages\meeting-prep\ingest.js` standalone for a later Task Scheduler
// entry.
const fs = require('fs');
const path = require('path');
const { getClient, listAll } = require('@dashboard/autotask-client');
const { PDFParse } = require('pdf-parse');
const CFB = require('cfb');

const sp = require('./sharepoint-client.js');
const { resolveTitleAndClient } = require('./ingest-title-map.js');
const { slugify } = require('./slug.js');

const DATA_DIR = path.join(__dirname, 'data');
const STATE_PATH = path.join(__dirname, 'ingest-state.json');

// -- Parser registry --------------------------------------------------------
// One file per report kind under ./parsers, each exporting a
// `parse(pdfText) -> { createDate, ...restOfShape }` matching exactly what
// server.js's buildReportComponent() already expects for that kind -- see
// data/fairway-capital/2026-09-25/*.json for the real, hand-verified
// reference shapes. A kind with no file here yet is simply not processed --
// every matching PDF for it is left in Incoming/ and reported in
// needsAttention as "no parser yet", never guessed at or skipped silently.
const PARSERS_DIR = path.join(__dirname, 'parsers');
function loadParser(kind) {
  const file = path.join(PARSERS_DIR, `${kind}.js`);
  if (!fs.existsSync(file)) return null;
  delete require.cache[require.resolve(file)]; // picks up a parser edited between runs without a process restart, same reasoning templates/etc. read fresh elsewhere on this dashboard
  return require(file);
}

// -- Client-name resolution --------------------------------------------------
// Same normalize+cascade shape packages/check-client/server.js's own
// normalizeClientName()/matchRewstCustomerByName() already establishes,
// matched against Autotask's own company list instead of Rewst customers --
// Autotask is this MSP's real system of record for client identity. A
// filename whose client half doesn't resolve to exactly one active company
// is left unprocessed and flagged, never guessed.
function normalizeClientName(s) {
  return (s || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/\b(pty ltd|pty|ltd|inc|llc|co)\b/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    // Site-tier/location qualifiers Datto RMM's own naming doesn't always
    // carry the same way Autotask's company name does -- confirmed against
    // real company records: a franchise's head-office site is named
    // "<Name> (HO)" in Autotask but just "<Name>" in RMM, and an
    // unmonitored site is "<Name> - On Demand" in RMM with nothing on the
    // Autotask side. Left unstripped, neither side's name matches the
    // other EXACTLY, so matching fell through to the substring stage below
    // -- where the bare parent/holding company (e.g. "Sleepy's" itself,
    // with no site name at all) is a substring of every one of its own
    // sites' names, and either won a wrong single match silently or
    // created a false "ambiguous" rejection next to the real site. Real
    // bug, confirmed: stripping these here lets both sides land on an
    // exact match instead, so the substring stage's "Sleepy's"-vs-everyone
    // problem never gets a chance to come up for these.
    .replace(/\bho\b/g, '')
    .replace(/\bon demand\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchCompanyByName(rawName, companies) {
  const norm = normalizeClientName(rawName);
  if (!norm) return null;
  const stages = [
    (c) => normalizeClientName(c.companyName) === norm,
    (c) => {
      const cn = normalizeClientName(c.companyName);
      return cn && (cn.includes(norm) || norm.includes(cn));
    },
  ];
  for (const stage of stages) {
    const candidates = companies.filter(stage);
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) return null; // ambiguous -- don't guess
  }
  return null;
}

// -- Fuzzy fallback, by request -- tried only once matchCompanyByName's own
// exact/substring cascade has already failed, as a last attempt before
// filing the report away for a human to look at (see NOT_PROCESSED_NO_MATCH
// below). Classic Levenshtein edit distance, scored as a 0..1 similarity (1
// - distance / the longer of the two normalized names) against every
// company; only ever returns a single company, and only when it's both
// close enough on its own (>= FUZZY_MIN_SIMILARITY) AND clearly closer than
// the runner-up (>= FUZZY_MIN_MARGIN ahead) -- never guesses between two
// companies that are both nearly as close a fit.
const FUZZY_MIN_SIMILARITY = 0.9;
const FUZZY_MIN_MARGIN = 0.03;

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
    }
    prev = curr;
  }
  return prev[n];
}

function fuzzyMatchCompany(rawName, companies) {
  const norm = normalizeClientName(rawName);
  if (!norm) return null;
  const scored = companies
    .map((c) => {
      const cn = normalizeClientName(c.companyName);
      if (!cn) return null;
      const similarity = 1 - levenshtein(norm, cn) / Math.max(norm.length, cn.length);
      return { company: c, similarity };
    })
    .filter(Boolean)
    .sort((a, b) => b.similarity - a.similarity);

  const best = scored[0];
  if (!best || best.similarity < FUZZY_MIN_SIMILARITY) return null;
  const runnerUp = scored[1];
  if (runnerUp && best.similarity - runnerUp.similarity < FUZZY_MIN_MARGIN) return null; // too close to guess
  return best.company;
}

const COMPANIES_CACHE_TTL_MS = 20 * 60 * 1000; // 20 min -- same convention as this dashboard's other short-lived external-list caches
let companiesCache = null; // { data, expiresAt }
async function fetchActiveCompanies(force) {
  if (!force && companiesCache && Date.now() < companiesCache.expiresAt) return companiesCache.data;
  const client = await getClient();
  const data = await listAll(client.companies, [{ op: 'eq', field: 'isActive', value: 1 }]);
  companiesCache = { data, expiresAt: Date.now() + COMPANIES_CACHE_TTL_MS };
  return data;
}

// -- Datto's own createDate string -> the date-folder's ISO date -----------
// Every Datto RMM report's own createDate reads like "25 SEP 2026 07:49
// (AEST)" (confirmed against every real data/*.json file already in this
// package) -- the date-folder itself uses the report's OWN date, not
// "today" (data/README.md's own documented convention), so this is the one
// central place that conversion happens, rather than each parser
// duplicating it.
const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
function isoDateFromCreateDate(createDate) {
  const m = /^(\d{1,2})\s+([A-Z]{3})\s+(\d{4})/.exec((createDate || '').trim());
  if (!m) return null;
  const [, day, monAbbr, year] = m;
  const month = MONTHS[monAbbr.toUpperCase()];
  if (!month) return null;
  return `${year}-${String(month).padStart(2, '0')}-${day.padStart(2, '0')}`;
}

// -- ingest-state.json --------------------------------------------------
// Idempotency + last-run visibility, proportionate to this job's low volume
// (a handful of files per run) -- keyed on the SharePoint item's own
// unchanging id, not filename (a file can be renamed/replaced in Incoming
// without this losing track of it). Mirrors contract-checks' sync_state in
// spirit (last-run bookkeeping) without needing a whole new SQLite db for a
// job with no per-item human editing workflow.
function loadState() {
  if (!fs.existsSync(STATE_PATH)) return { processedItemIds: {}, lastRun: null };
  return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
}
function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

async function extractPdfText(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText({ cellSeparator: ' | ', lineThreshold: 4.6, cellThreshold: 7 });
    return result.text;
  } finally {
    await parser.destroy();
  }
}

// INKY delivers its own report as an EMAIL (a .msg file, not a bare PDF
// dropped straight in Incoming/ the way every Datto/Dark Web ID report
// is) -- the actual report is a PDF attachment on that email (confirmed
// against 4 real samples: each one carries exactly one .pdf attachment,
// named "report_<yyyy>_<mm>_<dd>.pdf", alongside 1-2 small .png logo
// images INKY inlines into the email body itself, never the report). A
// .msg file is an OLE Compound File (the same container format .xls
// used before .xlsx) -- `cfb` (SheetJS's CFB reader, already a real
// dependency of this workspace via @dashboard/tc-elite-rollout's own
// xlsx dependency, added here explicitly rather than relied on as a
// phantom transitive one -- see package.json) parses that container
// without needing a dedicated .msg-parsing library at all. Each MAPI
// attachment lives under its own `__attach_version1.0_#<index>` storage;
// `__substg1.0_3707001F` is that attachment's own long filename (PT_UNICODE,
// hence the utf16le decode), `__substg1.0_37010102` is its raw binary
// content (PT_BINARY). Throws if no .pdf attachment is found, rather than
// returning null -- ingest.js's own needsAttention handling below turns
// that into a per-file "Parse failed" entry, same as any other parser
// error.
function extractMsgPdfAttachment(buffer) {
  const container = CFB.parse(buffer);
  const findByPath = (pred) => {
    const idx = container.FileIndex.findIndex((entry, i) => entry.type === 2 && pred(container.FullPaths[i]));
    return idx === -1 ? null : container.FileIndex[idx];
  };
  const utf16 = (entry) => (entry && entry.content ? Buffer.from(entry.content).toString('utf16le') : null);

  for (let i = 0; i < 20; i++) {
    const attachPrefix = `__attach_version1.0_#${String(i).padStart(8, '0')}`;
    const nameEntry = findByPath((p) => p.includes(attachPrefix) && p.endsWith('__substg1.0_3707001F'));
    if (!nameEntry) break; // no more attachments at this index -- stop scanning
    const filename = utf16(nameEntry);
    if (!filename || !/\.pdf$/i.test(filename)) continue;
    const dataEntry = findByPath((p) => p.includes(attachPrefix) && p.endsWith('__substg1.0_37010102'));
    if (!dataEntry || !dataEntry.content) continue;
    return Buffer.from(dataEntry.content);
  }
  throw new Error('No .pdf attachment found inside this .msg file');
}

function writeReportJson(clientSlug, isoDate, kind, data) {
  const dir = path.join(DATA_DIR, clientSlug, isoDate);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${kind}.json`), JSON.stringify(data, null, 2));
}

// Used by an accumulating kind (see accumulationPeriod above) to fold a new
// day into whatever's already on disk for its period -- null the first run
// of a new period, same as any other "nothing written yet" case elsewhere
// in this file.
function readReportJsonIfExists(clientSlug, folder, kind) {
  const file = path.join(DATA_DIR, clientSlug, folder, `${kind}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// -- "Not Processed" side folders, by request ------------------------------
// Datto's own "On Demand" sites aren't continuously monitored, so most of
// their reports render as a literal "No Data" placeholder instead of a real
// table -- every parser here was only ever built against a site WITH real
// data, so these always fail to parse. Rather than burn a parse attempt
// (and a needsAttention slot) on every single one of these every run,
// detected straight off the filename's own client-name half and filed away
// unparsed. A client name that still doesn't resolve to exactly one company
// (even after the fuzzy fallback above) gets the same treatment under its
// own folder -- both are terminal outcomes, moved out of Incoming/ and
// marked processed so they're never re-flagged, instead of sitting in
// Incoming/ and getting re-checked (and re-failing) on every future run.
const NOT_PROCESSED_ON_DEMAND_PATH = 'Not Processed/On Demand';
const NOT_PROCESSED_NO_MATCH_PATH = 'Not Processed/No Match';
const ON_DEMAND_RE = /\bon demand\b/i;

async function moveToNotProcessed(driveId, item, destPath) {
  const destFolderId = await sp.ensureFolderPath(driveId, destPath);
  await sp.moveItem(driveId, item.id, destFolderId);
}

async function runIngest() {
  const driveId = await sp.resolveDriveId();
  const companies = await fetchActiveCompanies();
  const state = loadState();

  const incomingRoot = await sp.listFolderChildren(driveId, 'Incoming');
  const sourceFolders = incomingRoot.filter((f) => f.folder);

  let processedCount = 0;
  let ignoredCount = 0;
  let skippedUnhandledExtCount = 0;
  let onDemandCount = 0;
  let noMatchCount = 0;
  const needsAttention = []; // { filename, source, reason }

  for (const source of sourceFolders) {
    const files = await sp.listFolderChildren(driveId, `Incoming/${source.name}`);
    for (const item of files) {
      if (!item.file) continue; // a nested folder inside a source -- not expected, but never treated as a report
      if (state.processedItemIds[item.id]) continue; // already handled in a prior run

      // Two source shapes: a bare report PDF (every Datto/Dark Web ID
      // report), resolved by filename via resolveTitleAndClient() below --
      // or INKY's own report EMAIL (.msg, the actual PDF report sitting
      // inside it as an attachment, see extractMsgPdfAttachment() above),
      // resolved from the PDF's OWN content instead of its filename (see
      // the isMsg branch below for why). Anything else (e.g. the real
      // "SiteDeviceCountExport - <Client>.csv" exports sitting alongside
      // the Datto PDFs) is a different kind of export entirely, by
      // request -- left untouched in Incoming, not even recorded in
      // state, so nothing here claims to have "handled" it.
      const isPdf = /\.pdf$/i.test(item.name);
      const isMsg = /\.msg$/i.test(item.name);
      if (!isPdf && !isMsg) {
        skippedUnhandledExtCount++;
        continue;
      }

      let kind, clientName, parser, data;

      if (isMsg) {
        // Real bug, confirmed live: INKY's own filename (and apparently its
        // email Subject, since that's normally where a saved .msg's default
        // filename comes from) does NOT reliably carry the per-client name
        // the way resolveInkyClientAndKind() used to assume -- every real
        // file here was named "Ambient IT Customers - Email Security Report
        // (N).msg", the SAME name for every client with Windows' own
        // save-a-duplicate "(N)" suffix on top, not a per-client name at
        // all. There's only one INKY report kind, so the filename was never
        // actually needed to pick a kind either -- the real, reliable
        // per-client identity was always available from the PDF's own "for
        // <Site Name> <Weekday>..." header (parse()'s own `site` field,
        // confirmed against 4 real samples), so that's read AFTER parsing
        // instead of guessed at from the filename beforehand.
        kind = 'email-security';
        parser = loadParser(kind);
        if (!parser) {
          needsAttention.push({ filename: item.name, source: source.name, reason: `No parser yet for kind "${kind}" (packages/meeting-prep/parsers/${kind}.js)` });
          continue;
        }
        try {
          const buffer = await sp.downloadFileContent(driveId, item.id);
          const pdfBuffer = extractMsgPdfAttachment(buffer);
          const text = await extractPdfText(pdfBuffer);
          data = parser.parse(text);
          if (!data || typeof data !== 'object') throw new Error('parser returned no data');
        } catch (err) {
          needsAttention.push({ filename: item.name, source: source.name, reason: `Parse failed: ${err.message}` });
          continue;
        }
        clientName = data.site;
      } else {
        const resolved = resolveTitleAndClient(item.name);
        if (!resolved) {
          needsAttention.push({ filename: item.name, source: source.name, reason: 'Unrecognized report title -- no TITLE_TO_KIND entry (ingest-title-map.js)' });
          continue;
        }
        if (resolved.ignored) {
          // Deliberately excluded (e.g. Monitoring Performance, by request) --
          // recorded as processed so it's never re-checked or re-flagged, but
          // left in place in Incoming/ (not moved) since nothing was
          // generated from it -- moving it would misleadingly claim it was
          // handled.
          state.processedItemIds[item.id] = { outcome: 'ignored', filename: item.name, at: new Date().toISOString() };
          ignoredCount++;
          continue;
        }

        ({ kind, clientName } = resolved);

        if (ON_DEMAND_RE.test(clientName)) {
          try {
            await moveToNotProcessed(driveId, item, NOT_PROCESSED_ON_DEMAND_PATH);
            state.processedItemIds[item.id] = { outcome: 'on-demand', filename: item.name, clientName, at: new Date().toISOString() };
            onDemandCount++;
          } catch (err) {
            needsAttention.push({ filename: item.name, source: source.name, reason: `On-demand site, but moving to "${NOT_PROCESSED_ON_DEMAND_PATH}" failed: ${err.message}` });
          }
          continue;
        }

        parser = loadParser(kind);
        if (!parser) {
          needsAttention.push({ filename: item.name, source: source.name, reason: `No parser yet for kind "${kind}" (packages/meeting-prep/parsers/${kind}.js)` });
          continue;
        }
      }

      const company = matchCompanyByName(clientName, companies) || fuzzyMatchCompany(clientName, companies);
      if (!company) {
        try {
          await moveToNotProcessed(driveId, item, NOT_PROCESSED_NO_MATCH_PATH);
          state.processedItemIds[item.id] = { outcome: 'no-match', filename: item.name, clientName, at: new Date().toISOString() };
          noMatchCount++;
        } catch (err) {
          needsAttention.push({ filename: item.name, source: source.name, reason: `Client name "${clientName}" did not resolve to a company, even fuzzy, but moving to "${NOT_PROCESSED_NO_MATCH_PATH}" failed: ${err.message}` });
        }
        continue;
      }

      // The PDF path's own data was deliberately left until AFTER the
      // company match above (same reasoning the on-demand/no-match checks
      // already rely on -- cheap filename checks before ever spending a
      // download+parse on a file that's about to be filed away unprocessed
      // anyway); the .msg/INKY path above already has `data`, since its
      // own clientName could only ever come FROM parsing it.
      if (!data) {
        try {
          const buffer = await sp.downloadFileContent(driveId, item.id);
          const text = await extractPdfText(buffer);
          data = parser.parse(text);
          if (!data || typeof data !== 'object') throw new Error('parser returned no data');
        } catch (err) {
          needsAttention.push({ filename: item.name, source: source.name, reason: `Parse failed: ${err.message}` });
          continue;
        }
      }

      const isoDate = isoDateFromCreateDate(data.createDate);
      if (!isoDate) {
        needsAttention.push({ filename: item.name, source: source.name, reason: `Could not derive a date folder from createDate "${data.createDate}"` });
        continue;
      }

      // Written with the PRE-move webUrl first (Incoming/...) -- a
      // SharePoint webUrl is path-based, so it'll be wrong once the file
      // actually moves, but this order still has to come first: the file
      // must only be relocated out of Incoming/ once the write is known to
      // have succeeded, since listFolderChildren() above only ever scans
      // Incoming/ -- a file moved before a failed write would vanish from
      // every future run's own view entirely, with nothing left to retry
      // against. Once the move itself succeeds, its own response carries
      // the item's real NEW webUrl (Graph's PATCH response for a
      // parentReference change returns the full updated resource), which
      // is what the written file actually gets corrected to below -- a
      // real bug this session confirmed live: every sourceUrl written by
      // this job's first run pointed at Incoming/, 404ing the moment the
      // real move happened right after.
      data.sourceUrl = item.webUrl;
      const clientSlug = slugify(company.companyName);

      // A kind that declares accumulationPeriod (currently just
      // email-security, by request -- see that parser's own comment) folds
      // this one day into the running total for its calendar month, under
      // a "YYYY-MM" folder, instead of writing a fresh date folder every
      // run. The SOURCE file in SharePoint still moves into Processed/ under
      // its own real per-day date regardless -- only the local data/*.json
      // this writes groups by month; the daily source PDFs/emails stay
      // individually archived so history isn't lost.
      const writeFolder = parser.accumulationPeriod === 'month' ? isoDate.slice(0, 7) : isoDate;
      let dataToWrite = data;
      if (parser.accumulationPeriod === 'month') {
        const existing = readReportJsonIfExists(clientSlug, writeFolder, kind);
        dataToWrite = parser.mergeDaily(existing, data);
      }

      try {
        writeReportJson(clientSlug, writeFolder, kind, dataToWrite);
        const destFolderId = await sp.ensureFolderPath(driveId, `Processed/${company.companyName}/${isoDate}`);
        const moved = await sp.moveItem(driveId, item.id, destFolderId);
        if (moved.webUrl && moved.webUrl !== item.webUrl) {
          dataToWrite.sourceUrl = moved.webUrl;
          writeReportJson(clientSlug, writeFolder, kind, dataToWrite);
        }
      } catch (err) {
        needsAttention.push({ filename: item.name, source: source.name, reason: `Written locally but SharePoint move failed: ${err.message}` });
        continue;
      }

      state.processedItemIds[item.id] = { outcome: 'processed', filename: item.name, kind, clientSlug, isoDate, at: new Date().toISOString() };
      processedCount++;
    }
  }

  const message = `Processed ${processedCount}, ignored ${ignoredCount}, moved ${onDemandCount} on-demand (${NOT_PROCESSED_ON_DEMAND_PATH}) and ${noMatchCount} unmatched (${NOT_PROCESSED_NO_MATCH_PATH}), ${needsAttention.length} needing attention.`;
  state.lastRun = { at: new Date().toISOString(), ok: true, message, processedCount, ignoredCount, onDemandCount, noMatchCount, needsAttention };
  saveState(state);
  return { ok: true, processedCount, ignoredCount, skippedUnhandledExtCount, onDemandCount, noMatchCount, needsAttention, message };
}

module.exports = { runIngest, isoDateFromCreateDate, matchCompanyByName, fuzzyMatchCompany, normalizeClientName };

if (require.main === module) {
  runIngest()
    .then((result) => {
      console.log(result.message);
      if (result.needsAttention.length > 0) {
        console.log('Needs attention:');
        for (const n of result.needsAttention) console.log(`  - [${n.source}] ${n.filename}: ${n.reason}`);
      }
      process.exit(result.ok ? 0 : 1);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
