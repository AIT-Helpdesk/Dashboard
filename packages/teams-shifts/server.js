const express = require('express');
const { mondayOf, weekDatesFrom, todayAestKey } = require('@dashboard/autotask-client');
const { getTeams, getShiftsByDay } = require('./lib.js');

// Microsoft Teams' Shifts app -- a schedule (shifts, open shifts, time-off
// requests) that lives per-Team under Graph's /teams/{id}/schedule surface.
// The actual Graph client (token, fetch, resolve) lives in ./lib.js, shared
// with What's On's own "Team Shifts" excerpt (packages/whats-on/server.js)
// -- this file is just this dedicated page's own month-calendar shape on
// top of that shared plumbing. See lib.js and this package's README for the
// exact permissions to grant / real-data quirks confirmed while building it.

// Full Monday-start weeks covering every day of the given month -- identical
// helper (and identical reasoning) to service-calls/server.js's own
// buildMonthGrid(), just not shared as a dependency between two otherwise-
// unrelated pages.
function buildMonthGrid(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const firstOfMonth = `${monthKey}-01`;
  const lastOfMonth = `${monthKey}-${String(daysInMonth).padStart(2, '0')}`;
  const gridStart = mondayOf(firstOfMonth);
  const gridEndMonday = mondayOf(lastOfMonth);
  const startDate = new Date(Date.UTC(gridStart.year, gridStart.month - 1, gridStart.day));
  const endDate = new Date(Date.UTC(gridEndMonday.year, gridEndMonday.month - 1, gridEndMonday.day + 6));
  const totalDays = Math.round((endDate - startDate) / 86400000) + 1;
  return weekDatesFrom(gridStart, totalDays);
}

async function buildMonthReport(teamId, monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  const monthStartKey = `${monthKey}-01`;
  const nextMonthStart = new Date(Date.UTC(y, m, 1)); // m is already 1-based monthKey's month, so Date.UTC(y, m, 1) is the 1st of the FOLLOWING month
  const monthEndKeyExclusive = nextMonthStart.toISOString().slice(0, 10);

  const todayKey = todayAestKey();
  const gridDates = buildMonthGrid(monthKey);
  const { byDay, totalCount } = await getShiftsByDay(teamId, monthStartKey, monthEndKeyExclusive);

  return { month: monthKey, todayKey, gridDates, totalCount, byDay };
}

const REPORT_CACHE_TTL_MS = 10 * 60 * 1000; // same as service-calls -- a roster fix should show up within the hour, not stay stale for the CSP-Customers-style 20 min
const reportCacheByKey = new Map(); // "teamId|monthKey" -> { data, expiresAt }
const inFlightByKey = new Map();

async function getMonthReport(teamId, monthKey, force) {
  const key = `${teamId}|${monthKey}`;
  const cached = reportCacheByKey.get(key);
  if (!force && cached && Date.now() < cached.expiresAt) return cached.data;
  if (!inFlightByKey.has(key)) {
    const build = buildMonthReport(teamId, monthKey)
      .then((data) => {
        reportCacheByKey.set(key, { data, expiresAt: Date.now() + REPORT_CACHE_TTL_MS });
        return data;
      })
      .finally(() => {
        inFlightByKey.delete(key);
      });
    inFlightByKey.set(key, build);
  }
  return inFlightByKey.get(key);
}

const router = express.Router();

router.get('/teams', async (req, res) => {
  try {
    const teams = await getTeams(req.query.force === 'true');
    res.json({ teams });
  } catch (err) {
    console.error(err);
    const detail = err.response ? `Graph API returned HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
    res.status(500).json({ error: detail });
  }
});

router.get('/:teamId/month', async (req, res) => {
  const month = req.query.month;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'Query param "month" is required in YYYY-MM format.' });
  }
  try {
    const data = await getMonthReport(req.params.teamId, month, req.query.force === 'true');
    res.json(data);
  } catch (err) {
    console.error(err);
    const detail = err.response ? `Graph API returned HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
    res.status(500).json({ error: detail });
  }
});

module.exports = router;
