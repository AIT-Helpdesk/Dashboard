// Invoice Intake Log -- read-only summary/log page over db.js's own
// data.db (written exclusively by ingest.js, the actual Task Scheduler
// job -- see its own header comment). By request: a page showing what the
// automation has processed, worked and failed, since there was previously
// no durable record of individual attachment outcomes (just a log file
// overwritten every run, per DEPLOYMENT.md).
const express = require('express');
const db = require('./db.js');

const router = express.Router();

const VALID_STATUSES = new Set(['ok', 'fail', 'skipped']);

router.get('/summary', (req, res) => {
  try {
    const now = new Date();
    const todaySinceIso = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const weekSinceIso = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    res.json({
      lastRun: db.getLastRun(),
      last24h: db.countsByStatus(todaySinceIso),
      last7days: db.countsByStatus(weekSinceIso),
      allTime: db.countsByStatus(null),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// `status` ('ok'/'fail'/'skipped') is optional -- omitted means all three.
// Rejected (not silently ignored) when present but not one of the three
// real values, same "never trust request input, validate against the
// real list" rule db-schema/server.js's own :table param follows.
router.get('/records', (req, res) => {
  try {
    const status = req.query.status || undefined;
    if (status && !VALID_STATUSES.has(status)) {
      return res.status(400).json({ error: `Unknown status "${status}". Must be one of: ok, fail, skipped.` });
    }
    const limit = Math.min(Number(req.query.limit) || 300, 1000);
    res.json({ records: db.listRecords({ status, limit }) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
