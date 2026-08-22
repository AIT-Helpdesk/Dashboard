const express = require('express');
const { mapWithConcurrency } = require('@dashboard/autotask-client');
const { hasDattoCredentials, getOverview, getDevicesForFilter, getDeviceDetails, getOpenAlerts } = require('./lib.js');

// A live snapshot -- Total Devices, Open Alerts, and one card per real
// Datto RMM filter -- not date-scoped, same convention as CSP Customers/
// Ingram Subscriptions. Cached briefly since a full run costs one request
// per filter (see lib.js's getOverview()); Refresh bypasses it.
const CACHE_TTL_MS = 20 * 60 * 1000; // 20 min -- same convention as CSP Customers
let cache = null; // { data, expiresAt }
let inFlight = null;

async function getCachedOverview(force) {
  if (!force && cache && Date.now() < cache.expiresAt) return cache.data;
  if (!inFlight) {
    inFlight = getOverview(mapWithConcurrency)
      .then((data) => {
        cache = { data, expiresAt: Date.now() + CACHE_TTL_MS };
        return data;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

const router = express.Router();

router.get('/', async (req, res) => {
  if (!hasDattoCredentials()) {
    return res.json({ status: 'not-connected' });
  }
  try {
    const data = await getCachedOverview(req.query.force === 'true');
    res.json({ status: 'ok', ...data });
  } catch (err) {
    console.error(err);
    const detail = err.response ? `Datto API returned HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
    res.status(500).json({ error: detail });
  }
});

// Device drill-down -- NOT cached (a filter's own count above is, but the
// actual device list/detail underneath is exactly the kind of thing worth
// re-checking live each time someone drills in, not the 20-minute-stale
// view the overview cards are fine showing). filterId is optional -- the
// Total Devices card's own drill-down omits it to list every device.
router.get('/devices', async (req, res) => {
  if (!hasDattoCredentials()) return res.status(503).json({ error: 'Datto RMM is not configured.' });
  try {
    const data = await getDevicesForFilter(req.query.filterId || undefined);
    res.json(data);
  } catch (err) {
    console.error(err);
    const detail = err.response ? `Datto API returned HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
    res.status(500).json({ error: detail });
  }
});

router.get('/alerts', async (req, res) => {
  if (!hasDattoCredentials()) return res.status(503).json({ error: 'Datto RMM is not configured.' });
  try {
    const data = await getOpenAlerts();
    res.json(data);
  } catch (err) {
    console.error(err);
    const detail = err.response ? `Datto API returned HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
    res.status(500).json({ error: detail });
  }
});

router.get('/device/:deviceUid', async (req, res) => {
  if (!hasDattoCredentials()) return res.status(503).json({ error: 'Datto RMM is not configured.' });
  try {
    const device = await getDeviceDetails(req.params.deviceUid);
    if (!device) return res.status(404).json({ error: 'Device not found or Datto unavailable.' });
    res.json({ device });
  } catch (err) {
    console.error(err);
    const detail = err.response ? `Datto API returned HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
    res.status(500).json({ error: detail });
  }
});

module.exports = router;
