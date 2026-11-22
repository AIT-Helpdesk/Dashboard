const express = require('express');
const { listGaps, setTicked, getSummaryCounts } = require('./db');
const { readLastRunStatus } = require('./status');
const { refreshLive, findOpenTicketInfo } = require('./job');
const { computeClientsMissingPrimaryDomain } = require('./primary-domain-gaps');
const { setPrimaryDomain } = require('@dashboard/itglue-client');

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
    wrongItglueOrgName: row.wrong_itglue_org_name,
    wrongItglueOrgUrl: row.wrong_itglue_org_url,
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
    // Live ticket lookup (cached briefly, see findOpenTicketInfo()'s own
    // comment), not last-run.json -- by request, "put the Ticket Number
    // (with link)" next to "Missing from IT Glue". A failure here is
    // non-fatal -- the page itself still works without it.
    let ticket = null;
    try {
      ticket = await findOpenTicketInfo();
    } catch (err) {
      console.error('domain-itglue-gap: failed to look up the open ticket:', err.message);
    }
    res.json({
      rows: listGaps().map(rowToJson),
      summary: getSummaryCounts(),
      lastRun: readLastRunStatus(),
      ticket,
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

// "Clients missing a Primary Domain" section, by request -- loaded
// independently by client.js (its own fetch, own loading state), same
// "don't slow down the fast stuff waiting on a slower one" split
// @dashboard/live-reports already uses for its own Email Domain
// Protection card. Computed fresh on every call (not persisted in db.js --
// this isn't tied to the TPP/ticket workflow at all, just a live IT Glue
// data-quality check), so this route alone carries that cost, never the
// main gap list's own plain GET /.
router.get('/no-primary-domain', async (req, res) => {
  try {
    res.json({ clients: await computeClientsMissingPrimaryDomain() });
  } catch (err) {
    console.error('domain-itglue-gap: no-primary-domain fetch failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Tags `domainId` as `organizationId`'s own Primary Domain in IT Glue,
// from the "clients missing a Primary Domain" section's own dropdown +
// "Set as Primary" button -- same shared setPrimaryDomain() helper
// @dashboard/live-reports' own "Set this Domain as Primary" checkbox uses.
router.post('/set-primary-domain', async (req, res) => {
  const { organizationId, domainId } = req.body || {};
  if (!organizationId || !domainId) return res.status(400).json({ error: 'organizationId and domainId are required.' });
  try {
    await setPrimaryDomain(organizationId, domainId);
    res.json({ ok: true });
  } catch (err) {
    console.error('domain-itglue-gap: set-primary-domain failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
