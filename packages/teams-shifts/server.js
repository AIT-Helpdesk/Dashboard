const express = require('express');
const { mondayOf, weekDatesFrom, todayAestKey, getClient, listAll, fetchByFieldIn } = require('@dashboard/autotask-client');
const { getTeams, getShiftsByDay } = require('./lib.js');

// TimeEntries.timeEntryType picklist values that mean "this hour was
// leave, not work" -- same 4 real confirmed values @dashboard/times' own
// README documents (15 PersonalTime, 16 VacationTime, 17 SickTime, 18
// PaidTimeOff), duplicated here rather than imported, same "separate page
// package" convention every other small shared piece on this dashboard
// already follows. By request ("can you get Leave from Autotask and add
// it to the Shifts data and calendars where it appears").
const LEAVE_TIME_ENTRY_TYPES = [15, 16, 17, 18];
const LEAVE_TYPE_FALLBACK_LABEL = { 15: 'Personal Time', 16: 'Vacation', 17: 'Sick Time', 18: 'Paid Time Off' };

// Every real Autotask resource's Leave in the given range, unscoped by
// Teams team -- Autotask resources aren't organised into a "General"
// Teams-Shifts roster the way real shifts are, and this tenant's whole
// staff is small enough that showing every real leave entry on this
// month calendar (rather than guessing which resources "belong" to
// whichever Teams team is selected) is the honest default; documented as
// a deliberate scoping choice in this package's own README, not an
// oversight. Shaped to merge straight into the same byDay rows real
// shifts/timesOff already use -- entryHtml() in client.js renders all
// three kinds (kind: 'shift' | 'timeOff' | 'leave') through one shared
// path, by request ("having it look just like the Shifts entries").
async function fetchLeaveEntries(client, startISO, endISO) {
  const entries = await listAll(client.timeEntries, [
    { op: 'gte', field: 'dateWorked', value: startISO },
    { op: 'lt', field: 'dateWorked', value: endISO },
    { op: 'in', field: 'timeEntryType', value: LEAVE_TIME_ENTRY_TYPES },
    { op: 'notExist', field: 'ticketID' },
    { op: 'notExist', field: 'taskID' },
  ]);
  if (entries.length === 0) return [];
  const [billingCodes, resources] = await Promise.all([
    fetchByFieldIn(client.billingCodes, 'id', [...new Set(entries.map((e) => e.billingCodeID).filter((id) => id !== null && id !== undefined))]),
    fetchByFieldIn(client.resources, 'id', [...new Set(entries.map((e) => e.resourceID).filter((id) => id !== null && id !== undefined))]),
  ]);
  const billingCodeNameById = new Map(billingCodes.map((c) => [c.id, c.name]));
  const resourceNameById = new Map(resources.map((r) => [r.id, [r.firstName, r.lastName].filter(Boolean).join(' ').trim() || `Resource #${r.id}`]));
  return entries.map((e) => ({
    id: `leave-${e.id}`,
    kind: 'leave',
    userId: null,
    userName: resourceNameById.get(e.resourceID) || null,
    published: true,
    startDateTime: null,
    endDateTime: null,
    dayKey: (e.dateWorked || '').slice(0, 10),
    displayName: billingCodeNameById.get(e.billingCodeID) || LEAVE_TYPE_FALLBACK_LABEL[e.timeEntryType] || 'Leave',
    hoursWorked: e.hoursWorked,
    theme: null,
    notes: null,
    activities: [],
    schedulingGroupId: null,
    schedulingGroupName: null,
  }));
}

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
  // Bare dateWorked-shaped ISO strings, NOT aestToUtcIso() -- TimeEntries.
  // dateWorked is a date-only field that needs no real AEST offset
  // conversion, same established convention @dashboard/times' own Leave
  // query already follows.
  const [{ byDay, totalCount }, leaveEntries] = await Promise.all([
    getShiftsByDay(teamId, monthStartKey, monthEndKeyExclusive),
    getClient().then((client) => fetchLeaveEntries(client, `${monthStartKey}T00:00:00.000Z`, `${monthEndKeyExclusive}T00:00:00.000Z`)),
  ]);

  let leaveCount = 0;
  for (const row of leaveEntries) {
    if (!byDay[row.dayKey]) byDay[row.dayKey] = [];
    byDay[row.dayKey].push(row);
    leaveCount++;
  }
  for (const day of Object.values(byDay)) {
    day.sort((a, b) => (a.startDateTime || '').localeCompare(b.startDateTime || ''));
  }

  return { month: monthKey, todayKey, gridDates, totalCount: totalCount + leaveCount, byDay };
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
