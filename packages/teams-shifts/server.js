const express = require('express');
const { mondayOf, weekDatesFrom, todayAestKey, getClient, listAll, fetchByFieldIn, fetchLeaveTimeOffRequests } = require('@dashboard/autotask-client');
const { getTeams, getShiftsByDay } = require('./lib.js');

// Real Leave, sourced directly from Autotask's own TimeOffRequests entity
// (`fetchLeaveTimeOffRequests()`, shared with `@dashboard/whats-on`/
// `@dashboard/about-me` -- see that shared function's own comment in
// `@dashboard/autotask-client` for the full real bug story: Damon
// Kirkpatrick's real Vacation request for 19-23 Oct wasn't showing here
// at all, because it sat at real `status: 2` Submitted -- Autotask only
// mirrors an APPROVED request into a plain TimeEntries row, which is what
// this page used to query instead). By request ("can you get Leave from
// Autotask and add it to the Shifts data and calendars where it
// appears"), extended by a later request to also surface real not-yet-
// approved requests ("can we display the Unapproved data with the right
// colour but with stripes or something so that it's obviously
// different") -- see entryHtml()'s own striped-background handling in
// client.js for the `approved: false` case.
//
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
  const requests = await fetchLeaveTimeOffRequests(client, startISO, endISO);
  if (requests.length === 0) return [];
  const resources = await fetchByFieldIn(client.resources, 'id', [...new Set(requests.map((r) => r.resourceID).filter((id) => id !== null && id !== undefined))]);
  const resourceNameById = new Map(resources.map((r) => [r.id, [r.firstName, r.lastName].filter(Boolean).join(' ').trim() || `Resource #${r.id}`]));
  return requests.map((r) => ({
    id: `leave-${r.id}`,
    kind: 'leave',
    userId: null,
    userName: resourceNameById.get(r.resourceID) || null,
    published: true,
    startDateTime: null,
    endDateTime: null,
    dayKey: r.dayKey,
    displayName: r.displayName,
    hoursWorked: r.hoursWorked,
    approved: r.approved,
    theme: null,
    notes: null,
    activities: [],
    schedulingGroupId: null,
    schedulingGroupName: null,
  }));
}

// Real Autotask Public Holidays, by request ("can you get the Public
// Holidays? Show on the Public Holiday which Holiday Set it's From").
// "They are called holiday sets in Autotask" (confirmed, same real chain
// @dashboard/times' own fetchPublicHolidayHoursByResource() already uses
// for a different purpose): Resources carry no holiday info directly,
// only their own `locationID` (InternalLocations); InternalLocations
// carries the real link, `holidaySetId`; HolidaySets carries the real
// set NAME (`holidaySetName` -- confirmed real names in this tenant:
// "QLD", "WA", "NSW", "Sri Lanka"); Holidays rows carry `holidaySetID`
// (different capitalization -- confirmed as two genuinely distinct real
// field names, not a typo) plus a real `holidayDate`/`holidayName`.
// Unscoped by Teams team, same deliberate reasoning fetchLeaveEntries()
// above already gives for its own identical merge -- shows every real
// public holiday across every set actually in use, not just whichever
// team happens to be selected.
//
// One real calendar entry per (holiday set, date) -- NOT per resource.
// A public holiday applies to everyone sharing that location/set at
// once; creating one entry per resource would pile up as many identical
// "Christmas Day" entries as there are staff at that location, on the
// same day, which is real noise not real information. `userName` is set
// to the real Holiday Set name (not a person) so it shows on the same
// line real shift/leave entries already use for "who this is" -- doubling
// as the answer to "which Holiday Set it's from" without a new field.
//
// Further merged when the SAME real holiday name falls on the SAME real
// day across multiple Holiday Sets -- by request ("where a specifically
// named public holiday applies to multiple Holiday Sets, Show the Public
// holiday once with all of the Set Names in the one calendar item").
// Confirmed real case: Christmas Day/Boxing Day land on the same date for
// every set. `userName`/`holidaySetName` becomes a comma-joined list of
// every real set the holiday applies to on that day (e.g. "NSW, QLD, Sri
// Lanka, WA"). Grouped by (day, holiday NAME), not day alone, so a
// same-day-but-different-name coincidence stays two entries, and a
// same-name holiday that falls on a genuinely different real date per
// set (confirmed real: "King's Birthday" is 5 Oct for QLD but 28 Sep for
// WA) still shows as two separate entries, one per its own real date.
// `displayName` is prefixed "Public Holiday - " so it matches
// SHIFT_CATEGORIES' own publicHoliday regex (below) even for a real
// holiday name that regex wouldn't otherwise catch on its own (confirmed
// real: "Ekka", "WA Day", "Bank Holiday", "Tamil Thai Pongal" -- none of
// which mention "public holiday" or any of the specific day names that
// regex already knows) -- means every Autotask-sourced holiday reaches
// the same white/bordered Public Holiday look with zero changes needed to
// categorizeShift() itself.
async function fetchPublicHolidayEntries(client, startISO, endISO) {
  const [locations, holidaySets] = await Promise.all([
    listAll(client.internalLocations, [{ op: 'gte', field: 'id', value: 0 }]),
    listAll(client.holidaySets, [{ op: 'gte', field: 'id', value: 0 }]),
  ]);
  const holidaySetIds = [...new Set(locations.map((l) => l.holidaySetId).filter(Boolean))];
  if (holidaySetIds.length === 0) return [];
  const holidaySetNameById = new Map(holidaySets.map((s) => [s.id, s.holidaySetName]));
  const holidays = await fetchByFieldIn(client.holidays, 'holidaySetID', holidaySetIds, [
    { op: 'gte', field: 'holidayDate', value: startISO },
    { op: 'lt', field: 'holidayDate', value: endISO },
  ]);
  // Group same-named holidays that fall on the same real day across
  // multiple Holiday Sets into ONE calendar entry, by request ("where a
  // specifically named public holiday applies to multiple Holiday Sets,
  // Show the Public holiday once with all of the Set Names in the one
  // calendar item"). Keyed by (dayKey, holidayName) -- NOT dayKey alone --
  // so two real, differently-named holidays landing on the same day stay
  // separate entries, and the SAME-named holiday that falls on a
  // genuinely different real date per set (confirmed real: "King's
  // Birthday" is 5 Oct for QLD but 28 Sep for WA) still shows as two
  // distinct entries, one per its own real date.
  const grouped = new Map();
  for (const h of holidays) {
    const dayKey = (h.holidayDate || '').slice(0, 10);
    const holidaySetName = holidaySetNameById.get(h.holidaySetID) || `Holiday Set #${h.holidaySetID}`;
    const key = `${dayKey}|${h.holidayName}`;
    if (!grouped.has(key)) grouped.set(key, { dayKey, holidayName: h.holidayName, holidaySetNames: [] });
    grouped.get(key).holidaySetNames.push(holidaySetName);
  }
  return [...grouped.values()].map((g) => {
    const holidaySetName = [...new Set(g.holidaySetNames)].sort().join(', ');
    return {
      id: `publicholiday-${g.dayKey}-${g.holidayName}`,
      kind: 'publicHoliday',
      userId: null,
      userName: holidaySetName,
      published: true,
      startDateTime: null,
      endDateTime: null,
      dayKey: g.dayKey,
      displayName: `Public Holiday - ${g.holidayName}`,
      holidayName: g.holidayName,
      holidaySetName,
      theme: null,
      notes: null,
      activities: [],
      schedulingGroupId: null,
      schedulingGroupName: null,
    };
  });
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
  const [{ byDay, totalCount }, leaveEntries, publicHolidayEntries] = await Promise.all([
    getShiftsByDay(teamId, monthStartKey, monthEndKeyExclusive),
    getClient().then((client) => fetchLeaveEntries(client, `${monthStartKey}T00:00:00.000Z`, `${monthEndKeyExclusive}T00:00:00.000Z`)),
    getClient().then((client) => fetchPublicHolidayEntries(client, `${monthStartKey}T00:00:00.000Z`, `${monthEndKeyExclusive}T00:00:00.000Z`)),
  ]);

  let extraCount = 0;
  for (const row of [...leaveEntries, ...publicHolidayEntries]) {
    if (!byDay[row.dayKey]) byDay[row.dayKey] = [];
    byDay[row.dayKey].push(row);
    extraCount++;
  }
  for (const day of Object.values(byDay)) {
    day.sort((a, b) => (a.startDateTime || '').localeCompare(b.startDateTime || ''));
  }

  return { month: monthKey, todayKey, gridDates, totalCount: totalCount + extraCount, byDay };
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
