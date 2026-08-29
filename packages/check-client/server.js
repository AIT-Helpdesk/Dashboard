// Check Client -- a read-only, single-client rollup of three other pages'
// own data: Contract Checks (Ingram order review), Ingram Subscriptions
// (live Ingram license list), and Contract Services (Autotask billed
// contract lines). No new data of its own, no database -- every route here
// is a thin wrapper calling straight into the source page's own already-
// extracted report-building function (see each sibling package's server.js
// for the `router.<fn> = <fn>` lines this depends on), so results and
// caching behavior are always identical to visiting that page directly.
const express = require('express');
const { aestDayBoundsIso } = require('@dashboard/autotask-client');

const contractChecks = require('@dashboard/contract-checks/server.js');
const ingramSubscriptions = require('@dashboard/ingram-subscriptions/server.js');
const contractServices = require('@dashboard/contract-services/server.js');

// The only Contract Process Type that exists today -- same constant value
// Contract Checks' own sync.js exports as PROCESS_TYPE, kept as a plain
// literal here rather than requiring sync.js (which loads its own .env and
// has sync-job side effects this page has no reason to pull in).
const PROCESS_TYPE = 'ingram_subscription';

const router = express.Router();

// Section 1 -- Orders, via Contract Checks' own loadEnrichedItems +
// buildResponse. "Show everything for this client" (by request -- this is
// a full-picture lookup, not a working checklist) is expressed entirely
// through the includeAllRenewals/includeCancelled/showAllDone options
// below, same functions Contract Checks itself uses for its own "Show ALL
// Renewals" + "Show Cancelled" + "Show All Done" checkboxes all ticked at
// once, plus hideRenewalOrProcessingOnly left off.
router.get('/orders', async (req, res) => {
  const sinceDate = req.query.since;
  if (!sinceDate || !/^\d{4}-\d{2}-\d{2}$/.test(sinceDate)) {
    return res.status(400).json({ error: 'Query param "since" is required in YYYY-MM-DD format.' });
  }
  try {
    const startISO = aestDayBoundsIso(sinceDate).startISO;
    const filterTerm = (req.query.client || '').trim();
    const items = await contractChecks.loadEnrichedItems(PROCESS_TYPE, startISO);
    const { totalCount, statusCounts, byClient } = contractChecks.buildResponse(items, {
      filterTerm,
      includeAllRenewals: true,
      includeCancelled: true,
      showAllDone: true,
      hideRenewalOrProcessingOnly: false,
    });
    res.json({ sinceDate, filterTerm: filterTerm || null, totalCount, statusCounts, byClient });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Section 2 -- Subscriptions, via Ingram Subscriptions' own getReport().
// No subscription-name filter, "All Statuses" hardcoded off (active +
// pending only) -- both by request ("No other search criteria" /
// "'All Statuses' off").
router.get('/subscriptions', async (req, res) => {
  try {
    const filterTerm = (req.query.client || '').trim();
    const data = await ingramSubscriptions.getReport(filterTerm, '', false, false);
    res.json(data);
  } catch (err) {
    console.error(err);
    const detail = err.response ? `Ingram API returned HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
    res.status(500).json({ error: detail });
  }
});

// Section 3 -- Contract Services, via Contract Services' own buildReport().
// No service-name search -- just the client + month, by request.
router.get('/services', async (req, res) => {
  const month = req.query.month;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'Query param "month" is required in YYYY-MM format.' });
  }
  try {
    const filterTerm = (req.query.client || '').trim();
    const data = await contractServices.buildReport(month, '', filterTerm);
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
