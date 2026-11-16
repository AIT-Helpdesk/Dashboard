const express = require('express');
const { listGaps, setTicked, getSummaryCounts } = require('./db');
const { readLastRunStatus } = require('./status');
const { refreshLive } = require('./job');

function getActor(req) {
  return { email: req.session.user.email, name: req.session.user.name };
}

function rowToJson(row) {
  return {
    domainName: row.domain_name,
    category: row.category,
    expiryDate: row.expiry_date,
    autotaskClientName: row.autotask_client_name,
    itglueOrgUrl: row.itglue_org_url,
    tppAccountReference: row.tpp_account_reference,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    ticked: !!row.ticked,
    tickedAt: row.ticked_at,
    tickedByName: row.ticked_by_name,
  };
}

const router = express.Router();
router.use(express.json());

// Plain load (no ?force=true) just serves the last stored state (db.js),
// same as before -- instant, whether that state came from the
// scheduled/manual job or an earlier live refresh. ?force=true -- sent only
// by the page's own Refresh button click (same "force" query-param
// convention @dashboard/tc-elite-services's own GET / already uses) -- does
// a real LIVE pull via job.js's own refreshLive() first: TPP, IT Glue,
// Autotask, same computeGaps() the scheduled job itself uses, but never
// creating or fully rewriting the ticket (see refreshLive()'s own comment),
// by request ("update the ticket with what's been fixed... Only provide a
// whole new list if the scheduled job... runs").
router.get('/', async (req, res) => {
  try {
    if (req.query.force === 'true') {
      await refreshLive();
    }
    res.json({
      rows: listGaps().map(rowToJson),
      summary: getSummaryCounts(),
      lastRun: readLastRunStatus(),
    });
  } catch (err) {
    console.error('domain-itglue-gap: failed to list gaps:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Ticking is per-domain, not per-ticket -- a domain that's STILL a gap on a
// later run KEEPS its tick (by request, "keep it ticked, but flag it" --
// see db.js's own comment), so this never auto-clears; only a person can
// untick (ticked: false).
router.post('/:domainName/tick', (req, res) => {
  const { domainName } = req.params;
  const ticked = req.body?.ticked !== false; // default true -- the button is "mark done"
  try {
    const row = setTicked(domainName, ticked, getActor(req));
    if (!row) return res.status(404).json({ error: `"${domainName}" is not a currently-open gap.` });
    res.json(rowToJson(row));
  } catch (err) {
    console.error('domain-itglue-gap: failed to update tick state:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
