const express = require('express');
const multer = require('multer');
const { getClient, listAll, parseWildcard } = require('@dashboard/autotask-client');
const { parseViCyberWorkbook } = require('./parse');
const { createReport, listReportsForClient, getReport, listFindingsForReport, deleteReport } = require('./db');
const { diffFindings } = require('./compare');

// In-memory only -- a scan spreadsheet is parsed once, right here, never
// written to disk itself (only the rows it produces are, into data.db).
// 15MB cap matches @dashboard/voice-scheduler's own multer config, the one
// other real file-upload page on this dashboard -- plenty for a text-heavy
// xlsx like this one (the real sample file checked during design was well
// under 1MB).
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const router = express.Router();

// Same shape as @dashboard/check-client's own GET /resolve-client -- a
// free-text (wildcard by default, exact when ticked) Autotask Company name
// search, used here so a report can be filed against a REAL Autotask
// Client chosen explicitly, never guessed from the spreadsheet's own
// "Asset Owner" column (see parse.js's own comment for why that column
// isn't trusted).
router.get('/resolve-client', async (req, res) => {
  const clientSearch = (req.query.client || '').trim();
  const exactClient = req.query.exactClient === 'true';
  if (!clientSearch) return res.json({ matches: [] });
  try {
    const client = await getClient();
    const clientWildcard = exactClient ? { op: 'eq', value: clientSearch } : parseWildcard(clientSearch);
    const matchFilter = clientWildcard
      ? [{ op: clientWildcard.op, field: 'companyName', value: clientWildcard.value }]
      : [{ op: 'eq', field: 'companyName', value: clientSearch }];
    const matches = await listAll(client.companies, matchFilter);
    res.json({
      matches: matches
        .map((c) => ({ id: c.id, companyName: c.companyName }))
        .sort((a, b) => a.companyName.localeCompare(b.companyName)),
    });
  } catch (err) {
    console.error('ViCyber Reports: resolve-client failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/reports', (req, res) => {
  const clientId = Number(req.query.clientId);
  if (!clientId) return res.status(400).json({ error: 'Query param "clientId" is required.' });
  try {
    const reports = listReportsForClient(clientId);
    res.json({
      reports: reports.map((r) => ({
        id: r.id,
        filename: r.filename,
        uploadedAt: r.uploaded_at,
        uploadedByName: r.uploaded_by_name,
        counts: { endpoint: r.endpoint_count, webapp: r.webapp_count, network: r.network_count, darkweb: r.darkweb_count },
      })),
    });
  } catch (err) {
    console.error('ViCyber Reports: list reports failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/reports/:id', (req, res) => {
  const reportId = Number(req.params.id);
  try {
    const report = getReport(reportId);
    if (!report) return res.status(404).json({ error: 'Report not found.' });
    const findings = listFindingsForReport(reportId);
    const categories = { endpoint: [], webapp: [], network: [], darkweb: [] };
    for (const f of findings) categories[f.category].push(f);
    res.json({
      report: { id: report.id, clientId: report.client_id, clientName: report.client_name, filename: report.filename, uploadedAt: report.uploaded_at, uploadedByName: report.uploaded_by_name },
      categories,
    });
  } catch (err) {
    console.error('ViCyber Reports: get report failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Permanently deletes an uploaded report and all of its findings, by
// request -- no soft-delete/undo, same "a real DELETE, confirmed client-side
// first" convention this dashboard already uses elsewhere (see client.js's
// own confirm() before calling this).
router.delete('/reports/:id', (req, res) => {
  const reportId = Number(req.params.id);
  try {
    const report = getReport(reportId);
    if (!report) return res.status(404).json({ error: 'Report not found.' });
    deleteReport(reportId);
    res.json({ ok: true });
  } catch (err) {
    console.error('ViCyber Reports: delete report failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/upload', upload.single('file'), async (req, res) => {
  const clientId = Number(req.body.clientId);
  const clientName = (req.body.clientName || '').trim();
  if (!clientId || !clientName) return res.status(400).json({ error: 'A nominated Autotask Client is required.' });
  if (!req.file) return res.status(400).json({ error: 'A spreadsheet file is required.' });

  try {
    const categories = parseViCyberWorkbook(req.file.buffer);
    const totalFindings = Object.values(categories).reduce((sum, rows) => sum + rows.length, 0);
    if (totalFindings === 0) {
      return res.status(400).json({ error: 'No findings were recognized in this file -- is it a real ViCyber "scan_consolidated" export?' });
    }
    const reportId = createReport({
      clientId,
      clientName,
      filename: req.file.originalname,
      uploadedByEmail: req.session.user.email,
      uploadedByName: req.session.user.name,
      categories,
    });
    res.json({ reportId });
  } catch (err) {
    console.error('ViCyber Reports: upload failed:', err.message);
    res.status(500).json({ error: `Could not read this file: ${err.message}` });
  }
});

// `from`/`to` -- the two chosen reports, EITHER order (by request, this
// page doesn't make the user figure out which upload came first) -- always
// resolved to older/newer here by their own `uploaded_at`, never trusted
// from whichever order the two ids arrived in.
router.get('/compare', (req, res) => {
  const fromId = Number(req.query.from);
  const toId = Number(req.query.to);
  if (!fromId || !toId) return res.status(400).json({ error: 'Query params "from" and "to" (report ids) are required.' });
  if (fromId === toId) return res.status(400).json({ error: 'Pick two different reports to compare.' });
  try {
    const reportA = getReport(fromId);
    const reportB = getReport(toId);
    if (!reportA || !reportB) return res.status(404).json({ error: 'One or both reports were not found.' });
    const [earlierReport, laterReport] = reportA.uploaded_at <= reportB.uploaded_at ? [reportA, reportB] : [reportB, reportA];

    const earlierFindings = listFindingsForReport(earlierReport.id);
    const laterFindings = listFindingsForReport(laterReport.id);

    const categories = { endpoint: {}, webapp: {}, network: {}, darkweb: {} };
    for (const category of Object.keys(categories)) {
      const diff = diffFindings(
        earlierFindings.filter((f) => f.category === category),
        laterFindings.filter((f) => f.category === category)
      );
      categories[category] = diff;
    }

    res.json({
      earlierReport: { id: earlierReport.id, filename: earlierReport.filename, uploadedAt: earlierReport.uploaded_at },
      laterReport: { id: laterReport.id, filename: laterReport.filename, uploadedAt: laterReport.uploaded_at },
      categories,
    });
  } catch (err) {
    console.error('ViCyber Reports: compare failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
