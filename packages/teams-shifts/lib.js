const axios = require('axios');
const { aestToUtcIso, isoDateAest } = require('@dashboard/autotask-client');

// Shared Microsoft Graph Shifts plumbing -- factored out of server.js so a
// SECOND page (What's On's own "Team Shifts" excerpt, see
// packages/whats-on/server.js) can fetch real shift data without either
// duplicating this whole Graph client or importing the OTHER page's Express
// router just to reach its internals. server.js (this dedicated Teams
// Shifts page's own router) requires this same file -- there is exactly one
// copy of the token/fetch/resolve logic, not two.
const {
  TEAMS_SHIFTS_CLIENT_ID: CLIENT_ID,
  TEAMS_SHIFTS_CLIENT_SECRET: CLIENT_SECRET,
  TEAMS_SHIFTS_TENANT_ID: TENANT_ID,
} = process.env;

// App-only Graph token, cached in-process -- same pattern (and same 60s
// refresh-ahead reasoning) as csp-customers' own getToken(). Shared across
// BOTH consumers of this file (this page and What's On) -- they're the same
// Entra app/tenant, so there's no reason for each to hold its own token.
let tokenCache = null; // { token, expiresAt }
async function getToken() {
  if (tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  const res = await axios.post(
    `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
    new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default',
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  tokenCache = { token: res.data.access_token, expiresAt: Date.now() + (res.data.expires_in - 60) * 1000 };
  return tokenCache.token;
}

async function graphGet(token, url) {
  const res = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
  return res.data;
}

// There is no plain "/teams" list endpoint for app-only calls (that shape --
// GET /me/joinedTeams -- only works for a delegated, signed-in user). The
// app-only way to enumerate every Team in the tenant is via /groups,
// filtered down to the ones that are Team-enabled -- confirmed against the
// real tenant, 10 teams came back this way. Needs the Group.Read.All
// application permission. Same @odata.nextLink pagination as CSP Customers.
async function fetchAllTeams(token) {
  let url =
    'https://graph.microsoft.com/v1.0/groups' +
    "?$filter=resourceProvisioningOptions/Any(x:x eq 'Team')&$select=id,displayName&$top=999";
  const all = [];
  while (url) {
    const data = await graphGet(token, url);
    all.push(...data.value);
    url = data['@odata.nextLink'] || null;
  }
  return all.map((g) => ({ id: g.id, name: g.displayName })).sort((a, b) => a.name.localeCompare(b.name));
}

const TEAMS_CACHE_TTL_MS = 20 * 60 * 1000; // 20 min -- same convention as CSP Customers; the team list barely changes
let teamsCache = null; // { data, expiresAt }
async function getTeams(force) {
  if (!force && teamsCache && Date.now() < teamsCache.expiresAt) return teamsCache.data;
  const token = await getToken();
  const data = await fetchAllTeams(token);
  teamsCache = { data, expiresAt: Date.now() + TEAMS_CACHE_TTL_MS };
  return data;
}

// Shifts for one team's schedule, scoped to a date range. Needs the
// Schedule.Read.All application permission. A team whose Shifts app has
// never been opened has no provisioned schedule at all -- Graph returns a
// 404 for that case, not an empty list, so getResolvedShifts() below turns
// that specific case into an empty result rather than a hard error.
//
// The date range is NOT optional -- confirmed against real data that an
// unfiltered call returns the entire shift history since the schedule was
// first provisioned (the real team tested against came back with shifts
// from 2020). $filter needs startDateTime and endDateTime as two DISTINCT
// properties (`ge <start>` on startDateTime, `le <end>` on endDateTime) --
// confirmed against the real API that using the same property twice (e.g.
// startDateTime ge X and startDateTime le Y) is rejected outright: 400
// BadRequest, "A property is allowed to appear at most once in the $filter
// query." Values are bare ISO datetimes without milliseconds
// (`2026-08-01T00:00:00Z`), not quoted strings -- also confirmed against the
// real API, so aestToUtcIso()'s millisecond-bearing output is trimmed here
// rather than assuming the extra precision is equally accepted.
async function fetchAllShifts(token, teamId, startISO, endISO) {
  const strip = (iso) => iso.replace(/\.\d+Z$/, 'Z');
  const filter = `sharedShift/startDateTime ge ${strip(startISO)} and sharedShift/endDateTime le ${strip(endISO)}`;
  let url = `https://graph.microsoft.com/v1.0/teams/${teamId}/schedule/shifts?$top=200&$filter=${encodeURIComponent(filter)}`;
  const all = [];
  while (url) {
    const data = await graphGet(token, url);
    all.push(...data.value);
    url = data['@odata.nextLink'] || null;
  }
  return all;
}

// Time-off entries (Vacation, Sick/Other Leave, RDO/Time in Lieu, Unpaid,
// etc.) are a SEPARATE Graph resource from /shifts entirely -- confirmed
// necessary against real data: a real Vacation entry a person had booked
// was completely invisible via /shifts (that team's /shifts for that day
// only had a real, unrelated On Call shift for someone else -- nothing was
// miscategorized, /timesOff just was never queried at all). Same
// contained-window $filter shape and same distinct-startDateTime/
// endDateTime-property rule as fetchAllShifts() above, just against
// `sharedTimeOff` instead of `sharedShift`. Needs the same Schedule.Read.All
// permission as shifts.
//
// Confirmed against the real API: Graph will NOT accept an "overlaps the
// window" filter here (`startDateTime le X and endDateTime ge Y`) --
// `400 BadRequest`, "Only the 'GreaterThanOrEqual' operator is allowed on
// entity property 'sharedTimeOff/startDateTime'" (and, symmetrically, only
// LessThanOrEqual is accepted on endDateTime). So a "contained in the
// window" filter is the ONLY shape the API allows, not a choice made here --
// see getShiftsByDay()'s own note on what that means for a multi-day entry
// that straddles a query window's edge.
async function fetchAllTimesOff(token, teamId, startISO, endISO) {
  const strip = (iso) => iso.replace(/\.\d+Z$/, 'Z');
  const filter = `sharedTimeOff/startDateTime ge ${strip(startISO)} and sharedTimeOff/endDateTime le ${strip(endISO)}`;
  let url = `https://graph.microsoft.com/v1.0/teams/${teamId}/schedule/timesOff?$top=200&$filter=${encodeURIComponent(filter)}`;
  const all = [];
  while (url) {
    const data = await graphGet(token, url);
    all.push(...data.value);
    url = data['@odata.nextLink'] || null;
  }
  return all;
}

// A time-off entry's timeOffReasonId resolves to a real, human-set-up
// reason -- confirmed against real data: 11 real reasons on the General
// team, several with the intended legend color literally spelled out in the
// name itself (e.g. "Vacation (green)", "Sick/Other Leave (purple)",
// "RDO / Time in Lieu (grey)", "Helpdesk Handler (blue)", "ON CALL
// (yellow)") -- strong confirmation that What's On's own category-matching
// legend (see that page's client.js) is matching real intent, not a
// guessed taxonomy. Whole list is small (11, confirmed) so fetched in full,
// same shape as fetchSchedulingGroupNames() above. Needs the same
// Schedule.Read.All permission.
async function fetchTimeOffReasonNames(token, teamId) {
  const data = await graphGet(token, `https://graph.microsoft.com/v1.0/teams/${teamId}/schedule/timeOffReasons`);
  const names = new Map();
  for (const r of data.value) names.set(r.id, r.displayName || null);
  return names;
}

// A shift's schedulingGroupId (confirmed against real data: e.g. "On Call",
// "On Call Roster", plus several with a blank displayName) groups shifts by
// role/rotation, independent of and in addition to who's individually
// assigned. Whole list is small (10 groups, confirmed against real data) so
// fetched in full rather than resolved id-by-id. Needs the same
// Schedule.Read.All permission as the shifts themselves.
async function fetchSchedulingGroupNames(token, teamId) {
  const data = await graphGet(token, `https://graph.microsoft.com/v1.0/teams/${teamId}/schedule/schedulingGroups`);
  const names = new Map();
  for (const g of data.value) names.set(g.id, g.displayName || null);
  return names;
}

// Shifts only carry the assignee's raw userId, not a display name -- resolve
// each unique id once (not once-per-shift) via a per-request cache. Needs
// the User.Read.All application permission. `userId` is confirmed null on
// real data for an open/unassigned shift slot (the shift belongs to a
// schedulingGroupId instead of a person) -- not a broken record, so those
// are skipped here rather than fired at /users/null.
async function resolveUserNames(token, userIds) {
  const names = new Map();
  const unique = [...new Set(userIds)].filter(Boolean);
  for (const id of unique) {
    try {
      const user = await graphGet(token, `https://graph.microsoft.com/v1.0/users/${id}?$select=displayName`);
      names.set(id, user.displayName);
    } catch {
      names.set(id, null); // a deleted/inaccessible user -- fall back to the raw id client-side rather than fail the whole page
    }
  }
  return names;
}

// Fully-resolved rows -- both real shifts AND time-off entries (names,
// group/reason names, every field Graph returns), tagged `kind: 'shift'` or
// `kind: 'timeOff'` -- for one team within [startISO, endISO). The one
// shared "get real schedule data" entry point both this page's own month
// view and What's On's 2-week excerpt build on top of.
async function getResolvedShifts(teamId, startISO, endISO) {
  const token = await getToken();
  let rawShifts;
  let rawTimesOff;
  try {
    [rawShifts, rawTimesOff] = await Promise.all([
      fetchAllShifts(token, teamId, startISO, endISO),
      fetchAllTimesOff(token, teamId, startISO, endISO),
    ]);
  } catch (err) {
    if (err.response?.status === 404) return []; // schedule never provisioned for this team -- see fetchAllShifts() above
    throw err;
  }
  if (rawShifts.length === 0 && rawTimesOff.length === 0) return [];

  const [userNames, groupNames, reasonNames] = await Promise.all([
    resolveUserNames(token, [...rawShifts.map((s) => s.userId), ...rawTimesOff.map((t) => t.userId)]),
    fetchSchedulingGroupNames(token, teamId),
    fetchTimeOffReasonNames(token, teamId),
  ]);

  // Prefer the published entry (sharedShift/sharedTimeOff); one that's
  // still only a draft (manager-only, not yet published) has no shared*
  // field at all -- surfaced with a `published: false` flag rather than
  // silently dropped. Every field Graph returns is carried through here --
  // by request (this dedicated page's own README), callers get the full
  // entry, not a trimmed summary; a caller that only needs a few fields
  // (e.g. What's On) just reads fewer of them.
  const shiftRows = rawShifts.map((s) => {
    const body = s.sharedShift || s.draftShift || {};
    return {
      id: s.id,
      kind: 'shift',
      userId: s.userId,
      // null userId (confirmed against real data -- see resolveUserNames()
      // above) means an open/unassigned shift slot, not a lookup failure --
      // labelled distinctly rather than showing a blank name.
      userName: s.userId ? userNames.get(s.userId) || s.userId : null,
      published: Boolean(s.sharedShift),
      startDateTime: body.startDateTime || null,
      endDateTime: body.endDateTime || null,
      dayKey: body.startDateTime ? isoDateAest(body.startDateTime) : null,
      displayName: body.displayName || null,
      theme: body.theme || null,
      notes: body.notes || null,
      activities: body.activities || [],
      schedulingGroupId: s.schedulingGroupId || null,
      schedulingGroupName: (s.schedulingGroupId && groupNames.get(s.schedulingGroupId)) || null,
      createdDateTime: s.createdDateTime || null,
      lastModifiedDateTime: s.lastModifiedDateTime || null,
    };
  });

  const timeOffRows = rawTimesOff.map((t) => {
    const body = t.sharedTimeOff || t.draftTimeOff || {};
    return {
      id: t.id,
      kind: 'timeOff',
      userId: t.userId,
      userName: t.userId ? userNames.get(t.userId) || t.userId : null,
      published: Boolean(t.sharedTimeOff),
      startDateTime: body.startDateTime || null,
      endDateTime: body.endDateTime || null,
      // dayKey is the FIRST AEST day only -- a time-off entry can span
      // multiple real days (confirmed against real data: real Vacation/
      // Unpaid entries covering 2+ consecutive AEST days), so getShiftsByDay()
      // below expands this into every day it covers rather than trusting
      // this single field the way a same-day shift's dayKey can be trusted.
      dayKey: body.startDateTime ? isoDateAest(body.startDateTime) : null,
      // The reason's own name -- confirmed against real data these often
      // spell out their intended legend color directly (see
      // fetchTimeOffReasonNames() above), e.g. "Vacation (green)".
      displayName: (body.timeOffReasonId && reasonNames.get(body.timeOffReasonId)) || null,
      theme: body.theme || null,
      notes: null, // timesOff carries no notes field -- confirmed absent on every real entry, unlike shifts' own notes
      activities: [], // activities are a /shifts-only concept -- not applicable to time off
      schedulingGroupId: null, // scheduling groups are a /shifts-only concept -- a time-off entry isn't in one
      schedulingGroupName: null,
      createdDateTime: t.createdDateTime || null,
      lastModifiedDateTime: t.lastModifiedDateTime || null,
    };
  });

  return [...shiftRows, ...timeOffRows];
}

function nextDayKey(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

// getResolvedShifts() above, grouped into AEST calendar days -- the shape
// both this page's month view and What's On's week view actually want to
// render from. `aestStartKey`/`aestEndKeyExclusive` are "YYYY-MM-DD" AEST
// calendar dates (end exclusive), converted to the real UTC instants Graph's
// $filter needs via the same aestToUtcIso() helper Service Calls' own
// month query uses.
//
// A multi-day time-off entry (kind: 'timeOff') is placed on EVERY real AEST
// day it covers, not just its first -- confirmed necessary against real
// data (a 2-day Vacation entry only showing on its first day would silently
// make the second day look unbooked). A regular shift (kind: 'shift') stays
// single-day -- confirmed against real data every shift on this team is
// same-AEST-day, so its own precomputed dayKey is trusted directly.
//
// KNOWN GAP, not fixable from this side: Graph's $filter only accepts a
// "fully contained in the window" comparison here (confirmed against the
// real API -- see fetchAllTimesOff()'s own note; an "overlaps the window"
// filter is rejected outright). A multi-day entry that starts before OR
// ends after whichever window is queried (a month, or What's On's 2-week
// slice) is invisible in that fetch, on either side of the boundary it
// crosses -- there is no filter shape the API accepts that would catch it.
async function getShiftsByDay(teamId, aestStartKey, aestEndKeyExclusive) {
  const [sy, sm, sd] = aestStartKey.split('-').map(Number);
  const [ey, em, ed] = aestEndKeyExclusive.split('-').map(Number);
  const startISO = aestToUtcIso(sy, sm, sd);
  const endISO = aestToUtcIso(ey, em, ed);
  const rows = await getResolvedShifts(teamId, startISO, endISO);

  const byDay = {};
  let totalCount = 0;
  const place = (dayKey, row) => {
    if (!byDay[dayKey]) byDay[dayKey] = [];
    byDay[dayKey].push(row);
    totalCount++;
  };
  for (const r of rows) {
    if (!r.startDateTime) continue; // no start time on either the shared or draft body -- nothing to place on a calendar
    if (r.kind === 'timeOff' && r.endDateTime) {
      const spanStart = isoDateAest(r.startDateTime);
      const spanEndExclusive = isoDateAest(r.endDateTime);
      for (let dk = spanStart; dk < spanEndExclusive; dk = nextDayKey(dk)) place(dk, r);
    } else if (r.dayKey) {
      place(r.dayKey, r);
    }
  }
  for (const day of Object.values(byDay)) {
    day.sort((a, b) => (a.startDateTime || '').localeCompare(b.startDateTime || ''));
  }
  return { byDay, totalCount };
}

module.exports = {
  getToken,
  getTeams,
  fetchAllTeams,
  fetchAllShifts,
  fetchAllTimesOff,
  fetchSchedulingGroupNames,
  fetchTimeOffReasonNames,
  resolveUserNames,
  getResolvedShifts,
  getShiftsByDay,
};
