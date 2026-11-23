const express = require('express');
const { readLastRunStatus } = require('./status');

const router = express.Router();

// Deliberately a plain file read, never a live Datto RMM pull from here --
// by request, the page has to stay fast and the data ready before anyone
// looks, same reasoning @dashboard/strety-autotask-sync's own status.js
// documents. The real pull only ever runs from run.js, on Task Scheduler's
// own schedule (see README).
router.get('/', (req, res) => {
  const status = readLastRunStatus();
  if (!status) return res.json({ neverRun: true });
  res.json(status);
});

module.exports = router;
