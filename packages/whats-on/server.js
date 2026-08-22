const express = require('express');
// This page no longer uses the shared default Strety connection at all --
// by request, every fetch here (Helpdesk team scorecards, Personal
// scorecards, and Today & Tomorrow's Strety Tasks column) goes through the
// signed-in user's OWN connection instead (see getPersonalClient() below,
// and @dashboard/strety-client's README, "Per-signed-in-user connections",
// for why). The shared connection/its own /auth/strety/connect route still
// exist (used by nothing in this file anymore, but kept -- see that
// README) rather than removed outright.
const { getPersonalClient } = require('@dashboard/strety-client');
const { readLastRunStatus } = require('@dashboard/strety-autotask-sync/status.js');
const {
  mondayOf,
  weekDatesFrom,
  todayAestKey,
  getClient,
  listAll,
  fetchByFieldIn,
  resolveCompanyName,
  resolveResourceName,
  mapWithConcurrency,
  aestToUtcIso,
  isoDateAest,
  matchesWildcard,
  getTicketUrl,
} = require('@dashboard/autotask-client');
const { getTeams, getShiftsByDay } = require('@dashboard/teams-shifts/lib.js');
// Aliased -- @dashboard/ingram-client's own fetchAllPages/getToken would
// otherwise collide with @dashboard/strety-client's identically-named
// exports already imported above (two wholly separate systems that happen
// to share the same function names).
const { getToken: getIngramToken, fetchAllPages: fetchIngramPages } = require('@dashboard/ingram-client');

// Reports on the Autotask -> Strety automation's last sync.js run, purely
// from the status file it writes (see status.js) -- no live API call, so
// checking this costs nothing extra against Strety's rate limit. Two
// distinct failure modes, not just one: the run itself failed (a real
// error, e.g. its own connection needs reconnecting), OR nothing has run
// in far longer than the hourly schedule implies (the scheduled task
// itself may have stopped firing entirely, which a pure success/failure
// check on the last run wouldn't catch since there'd BE no last run to
// check).
const AUTOMATION_STALE_THRESHOLD_MS = 3 * 60 * 60 * 1000; // 3 hours -- hourly schedule, generous buffer before alarming
function formatAge(ms) {
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours >= 1) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const minutes = Math.max(1, Math.round(ms / (60 * 1000)));
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}
// Same isLocalhostRequest() convention as packages/shell/server.js's own
// (nav-layout editability) -- checked against the Host header a request
// actually arrived with, not the TCP peer address, since Caddy reverse-
// proxies every real production request to this same box, making every
// request look locally-sourced at the socket level regardless of who's
// really on the other end. By request: the automation is only ever
// SCHEDULED on the production server (see DEPLOYMENT.md's Windows Task
// Scheduler setup, a production-only step) -- a local dev copy has no
// scheduled task at all, so this banner would otherwise always show a
// stale/never-run warning locally that isn't actually meaningful there.
function isLocalhostRequest(req) {
  return req.hostname === 'localhost' || req.hostname === '127.0.0.1';
}

function evaluateAutomationStatus() {
  const lastRun = readLastRunStatus();
  if (!lastRun) {
    return { ok: false, message: 'The automated Autotask sync has never run yet.' };
  }
  const ageMs = Date.now() - new Date(lastRun.ranAt).getTime();
  if (!lastRun.success) {
    const detail = lastRun.fatalError || lastRun.results.find((r) => !r.ok)?.detail || 'unknown error';
    return { ok: false, message: `The automated Autotask sync last ran ${formatAge(ageMs)} ago and failed: ${detail}` };
  }
  if (ageMs > AUTOMATION_STALE_THRESHOLD_MS) {
    return {
      ok: false,
      message: `The automated Autotask sync hasn't run in ${formatAge(ageMs)} (expected hourly) -- these EOD numbers may be stale.`,
    };
  }
  return { ok: true };
}

// The "Team Shifts" excerpt below the scorecards -- a completely separate
// data source (Microsoft Graph, via @dashboard/teams-shifts/lib.js) from
// everything else on this page (Strety). Resolved by NAME, not a hardcoded
// team id, same convention as HELPDESK_TEAM_NAME above -- if "General" is
// ever renamed in Teams, this says so explicitly rather than silently
// showing nothing.
const SHIFTS_TEAM_NAME = 'General';

const HELPDESK_TEAM_NAME = 'Helpdesk Task Tracker';
// By request: only these three cadences -- Strety's real `checkin_frequency`
// values also include "annual" (confirmed against real data, 2 of the 74
// metrics on this account), deliberately left out here. Order here is the
// order groups render in.
const FREQUENCIES = ['daily', 'weekly', 'monthly'];
const HISTORY_LIMIT = 8;
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Same email-match convention as My Strety Tasks -- see that package's
// README for why this is safe (every real Ambient iT person's Strety email
// matches their Microsoft 365 one exactly). Takes an explicit client (the
// signed-in user's own personal connection, see getPersonalClient()) rather
// than always using the shared module-level `get` -- the /people directory
// itself does appear visible either way (confirmed real data), but this
// keeps every personal-space lookup consistently going through the same
// per-user connection rather than mixing the two for no reason.
async function findPersonByEmail(email, client) {
  const res = await client.get('/people', { 'filter[email]': email });
  return res.data[0] || null;
}

// A DELIBERATE exception to this dashboard's usual "no caching, always
// live" stance (see My Strety Tasks' README) -- confirmed against the real
// API this page was drawing real 429 "Too Many Requests" responses under
// normal use, and /metrics alone (74 rows, 4 pages) was the single biggest
// chunk of every request just to filter down to the ~5 rows one team
// actually needs (`filter[space_id]` is NOT a supported filter on /metrics,
// confirmed against the real API -- a 400 "not a supported filter for this
// resource"). Teams and metric DEFINITIONS (titles, targets, cadence) change
// on the order of "someone edited Strety," not minute to minute, so a short
// shared cache here doesn't cost meaningful freshness -- unlike the actual
// check-in HISTORY (the real data this page exists to show), which stays a
// fully live fetch every request, uncached, below.
const CATALOG_CACHE_TTL_MS = 60_000;
let catalogCache = null; // { teams, metrics, fetchedAt }

// `client` is whichever signed-in user's own personal connection happens to
// trigger the refresh -- by request, this page now uses ONE personal
// connection for both groups (Helpdesk team AND Personal), not a separate
// shared connection for the team one (see the '/' route below for why).
// The cached VALUE is still shared globally across every user, same as
// before -- team/metric DEFINITIONS aren't user-specific, only the
// connection used to fetch them changed.
async function getCatalog(client) {
  if (catalogCache && Date.now() - catalogCache.fetchedAt < CATALOG_CACHE_TTL_MS) {
    return catalogCache;
  }
  // Sequential, not Promise.all -- confirmed against real use, a request
  // that gets a genuine 200 back can still come back with an empty/short
  // result under concurrent load (this page returned "no scorecards" with
  // no error at all, right after this used to fire /teams and /metrics at
  // the same time). @dashboard/strety-client's own get() now retries a real
  // 429 with backoff, but that can't help a request that came back 200 with
  // a suspiciously empty body -- avoiding concurrent Strety requests
  // entirely, here and in fetchScorecardsFor's per-metric loop below, is
  // the more defensive fix.
  const teams = await client.fetchAllPages('/teams', {});
  const metrics = await client.fetchAllPages('/metrics', {});
  catalogCache = { teams, metrics, fetchedAt: Date.now() };
  return catalogCache;
}

// Confirmed against real data: target_type is one of gte/gt/eq/lte/lt.
function checkinPasses(value, targetType, targetValue) {
  if (value === null || value === undefined || targetValue === null || targetValue === undefined) return null;
  switch (targetType) {
    case 'gte':
      return value >= targetValue;
    case 'gt':
      return value > targetValue;
    case 'eq':
      return value === targetValue;
    case 'lte':
      return value <= targetValue;
    case 'lt':
      return value < targetValue;
    default:
      return null;
  }
}

function targetLabel(targetType, targetValue) {
  const symbols = { gte: '≥', gt: '>', eq: '=', lte: '≤', lt: '<' };
  if (targetValue === null || targetValue === undefined) return '';
  return `${symbols[targetType] || targetType || ''} ${targetValue}`.trim();
}

// number_format confirmed against real data: "number" (plain), "currency"
// (a real decimal dollar value, e.g. 9027.26 -- not cents), and "percentage"
// (already a whole percentage, e.g. 12 means 12%, not 0.12) all confirmed
// from real check-ins. "time" has ZERO real check-ins anywhere on this
// account as of writing -- its unit (seconds? minutes?) is NOT confirmed, so
// rather than guess a conversion that might be wrong, it falls back to the
// plain-number branch like anything else unrecognized.
function formatValue(value, numberFormat) {
  if (value === null || value === undefined) return '';
  if (numberFormat === 'currency') {
    return `$${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  if (numberFormat === 'percentage') return `${value}%`;
  return String(value);
}

// A single shared "period" identity per cadence, so every metric in a group
// lines up against the SAME real columns instead of each row showing its
// own independent "last 8" (which, confirmed against real data, don't land
// on the same actual dates row to row -- e.g. three "Daily Backup Checks"
// check-ins landed on the very same calendar day while a sibling metric's
// check-ins didn't). Weekly/monthly use the check-in's own `iso_week`/
// `iso_week_year`/`month`/`year` attributes directly (confirmed present on
// every real check-in) rather than computed date math this package could get
// wrong; daily has no such attribute, so it's derived from `created_at`'s
// AEST calendar day -- same AEST-anchoring convention every other
// date-scoped page on this dashboard follows.
function periodKeyFor(attrs, frequency) {
  if (frequency === 'daily') {
    const aest = new Date(new Date(attrs.created_at).getTime() + 10 * 60 * 60 * 1000);
    return aest.toISOString().slice(0, 10); // YYYY-MM-DD, lexically sortable
  }
  if (frequency === 'weekly') {
    return `${attrs.iso_week_year}-W${String(attrs.iso_week).padStart(2, '0')}`;
  }
  if (frequency === 'monthly') {
    return `${attrs.year}-${String(attrs.month).padStart(2, '0')}`;
  }
  return null;
}

// AEST "today" (same AEST-anchoring convention as periodKeyFor()'s daily
// branch and every other date-scoped page on this dashboard), as a real
// UTC-midnight Date -- the anchor Daily/Weekly's fixed column windows below
// count back from, regardless of whether anyone's checked in yet.
function todayAestDate() {
  const aest = new Date(Date.now() + 10 * 60 * 60 * 1000);
  return new Date(Date.UTC(aest.getUTCFullYear(), aest.getUTCMonth(), aest.getUTCDate()));
}

function dailyKeyForDate(d) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function dailyLabelForDate(d) {
  const [, m, day] = dailyKeyForDate(d).split('-');
  return `${day}/${m}`;
}

// Standard ISO 8601 week algorithm -- the week containing a date's nearest
// Thursday is that date's ISO week. This has to MATCH Strety's own
// iso_week/iso_week_year check-in attributes exactly (see periodKeyFor()),
// since the fixed 8-week column list below and each metric's real
// check-ins both need to land on the same period keys to line up.
function isoWeekInfo(d) {
  const target = new Date(d.getTime());
  const dayNum = target.getUTCDay() || 7; // Mon=1..Sun=7
  target.setUTCDate(target.getUTCDate() + 4 - dayNum); // Thursday of this ISO week
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const isoWeek = Math.ceil((((target - yearStart) / 86400000) + 1) / 7);
  return { isoWeek, isoWeekYear: target.getUTCFullYear() };
}

function weeklyKeyForDate(d) {
  const { isoWeek, isoWeekYear } = isoWeekInfo(d);
  return `${isoWeekYear}-W${String(isoWeek).padStart(2, '0')}`;
}

// The Monday of the ISO week containing d -- by request, Weekly's column
// header shows this instead of the week number. getUTCDay() is Sun=0..
// Sat=6; days-since-Monday is (day + 6) % 7 (Monday itself -> 0).
function weeklyLabelForDate(d) {
  const daysSinceMonday = (d.getUTCDay() + 6) % 7;
  const monday = new Date(d.getTime());
  monday.setUTCDate(d.getUTCDate() - daysSinceMonday);
  const dd = String(monday.getUTCDate()).padStart(2, '0');
  const mm = String(monday.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}`;
}

// Monthly is still purely data-driven (see fetchScorecardsFor) -- this only
// needs to turn a "YYYY-MM" key into a label, unlike daily/weekly which now
// generate their (key, label) pairs directly from real dates.
function periodLabelFor(key) {
  const [y, m] = key.split('-');
  return `${MONTH_NAMES[Number(m) - 1]} ${y}`;
}

// Walks every page of this metric's check-ins (order is NOT reliable --
// confirmed against real data neither created_at nor updated_at, ascending
// or descending, explains the order the API actually returns -- same
// "don't trust the API's own ordering" situation already confirmed for
// /todos), then collapses them to one check-in per real period, keeping
// whichever is most recently created if a period somehow has more than one
// (confirmed against real data this happens -- multiple same-day check-ins
// on one daily metric -- the latest logged one wins as "the" value for that
// period).
async function fetchMetricPeriodMap(metric, client) {
  const checkins = await client.fetchAllPages(`/metrics/${metric.id}/check_ins`, {});
  const byPeriod = new Map();
  for (const c of checkins) {
    const key = periodKeyFor(c.attributes, metric.attributes.checkin_frequency);
    if (!key) continue;
    const existing = byPeriod.get(key);
    if (!existing || c.attributes.created_at > existing.attributes.created_at) {
      byPeriod.set(key, c);
    }
  }
  return byPeriod;
}

// Strety has no "category" concept on a metric via the API at all --
// confirmed against real data, every attribute/relationship key on every
// real metric was dumped and there's nothing resembling one (a category
// list only exists in Strety's own Scorecard UI, not exposed here). By
// request, a metric that shouldn't show on this page is instead marked by
// prefixing its own title with "NOT READY:" directly in Strety -- a manual
// workaround, not a real API field, so this just filters on that prefix
// (case-insensitive, tolerant of leading whitespace) before a metric's
// check-in history is even fetched, saving the API call entirely for a
// metric that's about to be hidden anyway.
const NOT_READY_PREFIX = /^not ready\s*:/i;
function isNotReady(metric) {
  return NOT_READY_PREFIX.test(metric.attributes.title.trim());
}

// One space (a team or a person) -> its metrics grouped by cadence, each
// group sharing one set of period columns per cadence. Daily/Weekly use a
// FIXED calendar window (today/this week back HISTORY_LIMIT periods, by
// request); Monthly is still data-driven (the most recent periods that ANY
// metric in the group actually has a check-in for) -- see the column-
// computation branch below for why.
async function fetchScorecardsFor(spaceType, spaceId, allMetrics, client) {
  const metrics = allMetrics.filter(
    (m) => m.relationships?.space?.data?.type === spaceType && m.relationships.space.data.id === spaceId
  );

  const byFrequency = {};
  for (const freq of FREQUENCIES) {
    const freqMetrics = metrics.filter((m) => m.attributes.checkin_frequency === freq && !isNotReady(m));
    if (freqMetrics.length === 0) continue;

    // Sequential, not Promise.all -- each metric's history is its own
    // fetchAllPages() walk (its own burst of requests already), and Strety
    // does enforce a real rate limit (confirmed against the real API: a
    // burst of requests -- admittedly from repeated manual testing, not a
    // single normal page load -- drew a real 429 "Too Many Requests").
    // Firing every metric in a cadence group at once multiplies that burst
    // by however many metrics are in the group; one at a time keeps this
    // page's own footprint modest regardless of how many metrics a space
    // ends up with.
    const periodMaps = [];
    for (const m of freqMetrics) {
      periodMaps.push(await fetchMetricPeriodMap(m, client));
    }

    let columnKeys;
    let columnLabels;
    if (freq === 'daily' || freq === 'weekly') {
      // Fixed window, by request -- always the most recent HISTORY_LIMIT
      // real calendar days/ISO weeks counting back from today/this week,
      // regardless of whether any metric has a check-in in a given one
      // (unlike Monthly below, which only shows periods that actually have
      // data). i=0 is today/this week; i=HISTORY_LIMIT-1 is the oldest.
      const today = todayAestDate();
      columnKeys = [];
      columnLabels = [];
      for (let i = 0; i < HISTORY_LIMIT; i++) {
        const d = new Date(today.getTime());
        d.setUTCDate(today.getUTCDate() - i * (freq === 'weekly' ? 7 : 1));
        columnKeys.push(freq === 'weekly' ? weeklyKeyForDate(d) : dailyKeyForDate(d));
        columnLabels.push(freq === 'weekly' ? weeklyLabelForDate(d) : dailyLabelForDate(d));
      }
    } else {
      // Monthly -- unchanged: the most recent periods that ANY metric in
      // this cadence group actually has a check-in for (a union across the
      // group, not a fixed calendar window), so the columns reflect real
      // activity rather than mostly-empty calendar slots if check-ins lag.
      const allKeys = new Set();
      periodMaps.forEach((map) => {
        for (const key of map.keys()) allKeys.add(key);
      });
      // Period keys are zero-padded and lexically sortable ("YYYY-MM") --
      // plain string sort gives correct chronological order, most recent
      // first after reversing.
      columnKeys = [...allKeys].sort().reverse().slice(0, HISTORY_LIMIT);
      columnLabels = columnKeys.map(periodLabelFor);
    }

    const rows = freqMetrics
      .map((m, i) => {
        const map = periodMaps[i];
        const cells = columnKeys.map((key) => {
          const c = map.get(key);
          // A check-in record can exist for a period with its own value
          // cleared to null (confirmed against real data -- editing a
          // check-in in Strety can leave the record in place with no
          // value, rather than deleting it outright). Treated the same as
          // no check-in at all for that period -- a blank cell, not a
          // "populated" cell with an empty display string, which would
          // otherwise still count as truthy (`Boolean(cell)`) client-side
          // for the title's green/red "has recent data" highlight.
          if (!c || c.attributes.value === null || c.attributes.value === undefined) return null;
          return {
            displayValue: formatValue(c.attributes.value, m.attributes.number_format),
            context: c.attributes.context || '',
            pass: checkinPasses(c.attributes.value, m.attributes.target_type, m.attributes.target_value),
          };
        });
        return {
          id: m.id,
          title: m.attributes.title,
          target: targetLabel(m.attributes.target_type, m.attributes.target_value),
          cells,
        };
      })
      // No inherent order from the API -- alphabetical by title within a cadence.
      .sort((a, b) => a.title.localeCompare(b.title));

    byFrequency[freq] = {
      columns: columnLabels,
      rows,
    };
  }
  return byFrequency;
}

// A rolling TWO-WEEK window (14 real calendar days, Monday-start), not a
// paginated fortnight -- by request, "forward"/"back" move exactly one week
// at a time (the window becomes [week+1, week+2] or [week-1, week]), not
// jumping in non-overlapping 2-week chunks. `mondayWeekKey` is the AEST
// Monday key of the FIRST of the two weeks shown; defaults to the Monday of
// the current AEST week when not supplied (client's own "This Week" reset).
async function buildShiftsWeek(mondayWeekKey) {
  const [y, m, d] = mondayWeekKey.split('-').map(Number);
  const days = weekDatesFrom({ year: y, month: m, day: d }, 14);
  // The day right after the 14-day window -- getShiftsByDay's range end is
  // exclusive. Plain UTC-instant math (not weekDatesFrom again just to
  // throw 14 of its 15 results away) since this is pure calendar arithmetic,
  // same "Date.UTC as a neutral calculator" reasoning as mondayOf() itself.
  const endKeyExclusive = new Date(Date.UTC(y, m - 1, d) + 14 * 86400000).toISOString().slice(0, 10);

  const teams = await getTeams();
  const team = teams.find((t) => t.name === SHIFTS_TEAM_NAME) || null;
  const todayKey = todayAestKey();

  if (!team) {
    // Surfaced rather than silently dropped -- same convention as
    // HELPDESK_TEAM_NAME's own notFound handling below.
    return { weekStart: mondayWeekKey, days, todayKey, totalCount: 0, byDay: {}, teamName: SHIFTS_TEAM_NAME, notFound: true };
  }

  const { byDay, totalCount } = await getShiftsByDay(team.id, mondayWeekKey, endKeyExclusive);
  return { weekStart: mondayWeekKey, days, todayKey, totalCount, byDay, teamName: team.name, notFound: false };
}

// Same reasoning as service-calls'/teams-shifts' own report caches -- a
// roster fix should show up within the hour, not stay stale. Cached
// separately from the Strety catalog/scorecard caches above (this is a
// wholly separate data source), keyed by the window's own start Monday so
// paging forward/back a week doesn't share (or collide with) another
// window's cache entry.
const SHIFTS_CACHE_TTL_MS = 10 * 60 * 1000;
const shiftsCacheByKey = new Map(); // mondayWeekKey -> { data, expiresAt }
const shiftsInFlightByKey = new Map();

async function getShiftsWeek(mondayWeekKey, force) {
  const cached = shiftsCacheByKey.get(mondayWeekKey);
  if (!force && cached && Date.now() < cached.expiresAt) return cached.data;
  if (!shiftsInFlightByKey.has(mondayWeekKey)) {
    const build = buildShiftsWeek(mondayWeekKey)
      .then((data) => {
        shiftsCacheByKey.set(mondayWeekKey, { data, expiresAt: Date.now() + SHIFTS_CACHE_TTL_MS });
        return data;
      })
      .finally(() => {
        shiftsInFlightByKey.delete(mondayWeekKey);
      });
    shiftsInFlightByKey.set(mondayWeekKey, build);
  }
  return shiftsInFlightByKey.get(mondayWeekKey);
}

function currentWeekMondayKey() {
  const { year, month, day } = mondayOf(todayAestKey());
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// "TODAY & TOMORROW" section -- three independent columns, by request, each
// its own separate external system (Autotask, Ingram, Strety). Plain
// calendar-key arithmetic, same "Date.UTC as a neutral calculator"
// reasoning as mondayOf()/endKeyExclusive above -- not exported from
// @dashboard/autotask-client, which has no generic "add N days to a key"
// helper, just the more specific mondayOf()/weekDatesFrom().
function addDaysToKey(dateKey, delta) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

// Turns whatever error a column's own fetch threw into a short, real
// message -- same shape every other page's own catch block already
// produces, just captured per-column here instead of failing the whole
// section. A Strety-specific error still gets its own distinct wording
// (not-connected/reauth-required), since a technician reading this column
// should be pointed at reconnecting, not a raw stack trace -- though the
// PAGE-level scorecards section above already shows the real reconnect
// banner for those same two cases, so this is just a short pointer back to it.
function describeColumnError(err) {
  if (err.strety_not_connected) return 'Strety is not connected -- see above.';
  if (err.strety_reauth_required) return 'Strety needs reconnecting -- see above.';
  return err.response ? `API returned HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
}

// Ticket status IDs that count as "closed" -- same [5, 20] convention as
// client-summary/server.js and strety-autotask-sync/metrics.js (5 =
// "Complete", 20 = "Billing - Contract", which per completed-tickets'
// README never transitions back out once reached). Used below to decide
// whether a stale, still-incomplete service call is "on an open ticket"
// (worth surfacing) or just linked to a ticket that's since been closed
// (the call record itself was simply never marked complete -- noise, not
// something anyone still needs to act on).
const CLOSED_TICKET_STATUSES = [5, 20];

// Shared join/resolution logic behind both service call groups below --
// same Autotask entity spanning as Service Calls' own buildReport()
// (packages/service-calls/server.js: ServiceCalls has no resource field of
// its own, so ServiceCallTickets/ServiceCallTicketResources have to be
// joined to find who's allocated -- see that page's README for the full
// story), just trimmed to what a compact list needs.
//
// `requireOpenTicket`, when true, additionally drops any call with no
// linked ticket at all (can't judge "open" with nothing to check) or whose
// linked ticket has since closed -- only used for the past-incomplete group
// below; the today/tomorrow group shows every scheduled call regardless of
// ticket linkage/status, same as it always has.
async function buildServiceCallRows(client, serviceCalls, { requireOpenTicket } = {}) {
  if (serviceCalls.length === 0) return [];

  const scTickets = await fetchByFieldIn(client.serviceCallTickets, 'serviceCallID', serviceCalls.map((sc) => sc.id));
  const scTicketIdsByServiceCallId = new Map();
  // The linked ticket is "the first one" -- same convention as Service
  // Calls' own README documents for this exact join (a call can in
  // principle have more than one ticket linked; real data confirmed there
  // this is rare enough that picking the first is the accepted tradeoff
  // rather than showing every one of them in a compact list).
  const ticketIdByServiceCallId = new Map();
  for (const t of scTickets) {
    if (!scTicketIdsByServiceCallId.has(t.serviceCallID)) scTicketIdsByServiceCallId.set(t.serviceCallID, []);
    scTicketIdsByServiceCallId.get(t.serviceCallID).push(t.id);
    if (!ticketIdByServiceCallId.has(t.serviceCallID)) ticketIdByServiceCallId.set(t.serviceCallID, t.ticketID);
  }

  let eligibleServiceCalls = serviceCalls;
  if (requireOpenTicket) {
    const ticketIds = [...new Set([...ticketIdByServiceCallId.values()].filter((id) => id !== null && id !== undefined))];
    const tickets = ticketIds.length > 0 ? await fetchByFieldIn(client.tickets, 'id', ticketIds) : [];
    const statusByTicketId = new Map(tickets.map((t) => [t.id, t.status]));
    eligibleServiceCalls = serviceCalls.filter((sc) => {
      const ticketId = ticketIdByServiceCallId.get(sc.id);
      if (ticketId === undefined || ticketId === null) return false;
      const status = statusByTicketId.get(ticketId);
      return status !== undefined && !CLOSED_TICKET_STATUSES.includes(status);
    });
  }
  if (eligibleServiceCalls.length === 0) return [];

  const allScTicketIds = scTickets.map((t) => t.id);
  const resources = allScTicketIds.length > 0 ? await fetchByFieldIn(client.serviceCallTicketResources, 'serviceCallTicketID', allScTicketIds) : [];
  const resourceIdsByScTicketId = new Map();
  for (const r of resources) {
    if (!resourceIdsByScTicketId.has(r.serviceCallTicketID)) resourceIdsByScTicketId.set(r.serviceCallTicketID, new Set());
    resourceIdsByScTicketId.get(r.serviceCallTicketID).add(r.resourceID);
  }
  function resourceIdsFor(serviceCallId) {
    const scTicketIds = scTicketIdsByServiceCallId.get(serviceCallId) || [];
    const ids = new Set();
    for (const scTicketId of scTicketIds) {
      for (const rid of resourceIdsByScTicketId.get(scTicketId) || []) ids.add(rid);
    }
    return [...ids];
  }

  const uniqueCompanyIds = [...new Set(eligibleServiceCalls.map((sc) => sc.companyID).filter((id) => id !== null && id !== undefined))];
  const uniqueResourceIds = [...new Set(resources.map((r) => r.resourceID))];
  await Promise.all([
    mapWithConcurrency(uniqueCompanyIds, 3, (id) => resolveCompanyName(client, id)),
    mapWithConcurrency(uniqueResourceIds, 3, (id) => resolveResourceName(client, id)),
  ]);

  const rows = [];
  for (const sc of eligibleServiceCalls) {
    const resourceIds = resourceIdsFor(sc.id);
    const resourceNames = [];
    for (const rid of resourceIds) resourceNames.push(await resolveResourceName(client, rid));
    resourceNames.sort((a, b) => a.localeCompare(b));
    const ticketId = ticketIdByServiceCallId.get(sc.id) || null;
    rows.push({
      id: sc.id,
      companyName: await resolveCompanyName(client, sc.companyID),
      description: sc.description || null,
      startDateTime: sc.startDateTime,
      dayKey: isoDateAest(sc.startDateTime),
      allocated: resourceNames.length > 0,
      resourceNames,
      // null when this call has no linked ticket at all -- client.js
      // renders the day tag as plain (non-link) text in that case, same
      // "no ticket, no link" convention Service Calls' own client.js uses.
      ticketUrl: ticketId ? await getTicketUrl(ticketId) : null,
    });
  }
  return rows;
}

// Service Calls due today or tomorrow (AEST), plus -- by request -- still-
// incomplete calls scheduled in the past 2 weeks whose linked ticket is
// still open (the "fell through the cracks" case: an appointment that was
// never marked complete and the work item behind it is still live).
// Confirmed against real data before picking the 2-week window: an
// unbounded "isComplete = false, any date" query returned 1574 rows going
// back to 2007 (old calls simply never marked complete on tickets that
// closed ages ago -- noise, not anything actionable), while requiring the
// linked ticket to still be open cuts that to a small, genuinely actionable
// handful. 2 weeks keeps that "actionable, not noise" property without
// hardcoding a totally arbitrary cutoff.
//
// Placed AFTER the today/tomorrow rows in the returned list, latest first
// within that trailing group (by request) -- same ordering My Strety
// Tasks' own overdue rows use below. client.js's ttDayTag() already
// renders any dayKey that isn't today/tomorrow as an overdue tag with no
// further server-side flag needed -- a past dayKey naturally falls into
// that branch.
async function fetchServiceCallsTodayTomorrow() {
  const client = await getClient();
  const today = todayAestKey();
  const [ty, tm, td] = today.split('-').map(Number);
  const startISO = aestToUtcIso(ty, tm, td);
  const endISO = aestToUtcIso(ty, tm, td + 2); // exclusive -- covers today + tomorrow, day-after-tomorrow excluded
  const pastStartISO = aestToUtcIso(ty, tm, td - 14);

  const [todayTomorrowCalls, pastIncompleteCalls] = await Promise.all([
    listAll(client.serviceCalls, [
      { op: 'gte', field: 'startDateTime', value: startISO },
      { op: 'lt', field: 'startDateTime', value: endISO },
    ]),
    listAll(client.serviceCalls, [
      { op: 'gte', field: 'startDateTime', value: pastStartISO },
      { op: 'lt', field: 'startDateTime', value: startISO },
      { op: 'eq', field: 'isComplete', value: false },
    ]),
  ]);

  const [todayTomorrowRows, pastIncompleteRows] = await Promise.all([
    buildServiceCallRows(client, todayTomorrowCalls),
    buildServiceCallRows(client, pastIncompleteCalls, { requireOpenTicket: true }),
  ]);

  const rows = [...todayTomorrowRows, ...pastIncompleteRows];
  rows.sort((a, b) => {
    const aOverdue = a.dayKey < today;
    const bOverdue = b.dayKey < today;
    if (aOverdue !== bOverdue) return aOverdue ? 1 : -1; // today/tomorrow group first, overdue group after
    // Within the overdue group: latest first, oldest last, by request --
    // reversed from the today/tomorrow group's own ascending order (kept
    // as-is below), which stays chronological since those are naturally
    // read "today, then tomorrow."
    if (aOverdue) return new Date(b.startDateTime) - new Date(a.startDateTime);
    return new Date(a.startDateTime) - new Date(b.startDateTime);
  });
  return rows;
}

// Subscriptions expiring today or tomorrow -- same data/exclusion/AEST-
// calendar-date reasoning as Subscriptions Expiring's own "Next 2 days"
// window (packages/subscriptions-expiring/server.js), just tightened to
// EXACTLY today (0) and tomorrow (1), not today+1+2 the way that page's own
// "2" preset means. `expirationDate` is a plain YYYY-MM-DD with no time
// component (confirmed against real data -- see that page's README), so
// this is pure calendar-day arithmetic, no AEST offset conversion needed
// for the comparison itself (only for what "today" means).
const EXCLUDED_SUBSCRIPTION_NAME_PATTERNS = ['Windows 11 Home to Pro Upgrade *']; // same as Subscriptions Expiring
function daysBetweenKeys(fromDateStr, toDateStr) {
  const [fy, fm, fd] = fromDateStr.split('-').map(Number);
  const [ty, tm, td] = toDateStr.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
}
async function fetchSubscriptionsExpiringTodayTomorrow() {
  const token = await getIngramToken();
  const [subscriptions, customers] = await Promise.all([
    fetchIngramPages('/subscriptions', token, {}),
    fetchIngramPages('/customers', token),
  ]);
  const customerNameById = new Map(customers.map((c) => [c.id, c.name]));
  const today = todayAestKey();

  const rows = [];
  for (const s of subscriptions) {
    if (!s.expirationDate) continue;
    if (EXCLUDED_SUBSCRIPTION_NAME_PATTERNS.some((pattern) => matchesWildcard(s.name, pattern))) continue;
    const daysUntilExpiry = daysBetweenKeys(today, s.expirationDate);
    if (daysUntilExpiry < 0 || daysUntilExpiry > 1) continue; // today or tomorrow only
    rows.push({
      clientName: customerNameById.get(s.customerId) || `Customer #${s.customerId}`,
      name: s.name,
      autoRenews: !!s.renewalStatus,
      expirationDate: s.expirationDate,
      daysUntilExpiry,
    });
  }
  rows.sort((a, b) => a.expirationDate.localeCompare(b.expirationDate) || a.clientName.localeCompare(b.clientName));
  return rows;
}

// My Strety Tasks due today or tomorrow -- same /todos query as My Strety
// Tasks' own fetchOpenTasksFor() (packages/my-strety-tasks/server.js), just
// filtered down to a due_date of exactly today or tomorrow (that page shows
// every open to-do regardless of due date; this is specifically the
// "what's due right now" subset). findPersonByEmail() above is reused, not
// re-resolved a second way.
// By request: also includes OVERDUE to-dos (due_date before today), not
// just today/tomorrow -- but ordered with today's and tomorrow's own tasks
// FIRST (in that natural chronological order), overdue ones AFTER (latest
// due date first within that group, by request -- the most recently-missed
// task surfaces at the top of its own group rather than the bottom). A
// plain string comparison against "today"/"tomorrow" is enough to tell
// overdue apart from due-soon here, since due_date and today/tomorrow are
// all the same "YYYY-MM-DD" lexically-sortable shape.
// Tasks with no due_date at all are excluded either way -- there's no date
// to judge "overdue" against, and that's a deliberate, different concept
// from My Strety Tasks' own page (which shows every open to-do regardless
// of due date, no-due-date included).
function isOverdue(dueDate, today) {
  return Boolean(dueDate) && dueDate < today;
}
// `client` is the signed-in user's own personal Strety connection (see
// getPersonalClient()), not the shared one -- confirmed against real
// production data the shared connection has zero visibility into anyone's
// personal todos.
async function fetchStretyTasksDueTodayTomorrow(client, personId, today, tomorrow) {
  const todos = await client.fetchAllPages('/todos', {
    'filter[completed]': 'false',
    'filter[assignee_id]': personId,
  });
  const rows = todos
    .filter((t) => t.attributes.due_date === today || t.attributes.due_date === tomorrow || isOverdue(t.attributes.due_date, today))
    .map((t) => ({
      id: t.id,
      title: t.attributes.title,
      dueDate: t.attributes.due_date,
      priority: t.attributes.priority || null,
      overdue: isOverdue(t.attributes.due_date, today),
    }));
  rows.sort((a, b) => {
    if (a.overdue !== b.overdue) return a.overdue ? 1 : -1; // today/tomorrow group first, overdue group after
    // Within the overdue group: latest first, oldest last, by request --
    // reversed from the today/tomorrow group's own ascending order (kept
    // as-is below).
    if (a.overdue) return b.dueDate.localeCompare(a.dueDate);
    return a.dueDate.localeCompare(b.dueDate);
  });
  return rows;
}

// The three columns run concurrently (Promise.all) -- three wholly separate
// external systems (Autotask/Ingram/Strety), not three requests hitting the
// SAME rate-limited API the way multiple Strety calls at once would be
// (see @dashboard/strety-client's own README, "Rate limiting" -- that
// caution is specifically about concurrent requests to Strety itself, not
// about running unrelated systems' own calls in parallel). Each column is
// independently try/caught -- confirmed the right shape given how many
// independent systems are involved here: one column's real failure (say,
// Ingram briefly down) shouldn't blank out the other two, which have
// nothing to do with it.
async function buildTodayTomorrow(email) {
  const today = todayAestKey();
  const tomorrow = addDaysToKey(today, 1);

  const [serviceCalls, subscriptionsExpiring, stretyTasks] = await Promise.all([
    fetchServiceCallsTodayTomorrow()
      .then((rows) => ({ ok: true, rows }))
      .catch((err) => ({ ok: false, error: describeColumnError(err) })),
    fetchSubscriptionsExpiringTodayTomorrow()
      .then((rows) => ({ ok: true, rows }))
      .catch((err) => ({ ok: false, error: describeColumnError(err) })),
    (async () => {
      // The signed-in user's OWN Strety connection, not the shared one --
      // see @dashboard/strety-client's getPersonalClient() for why. Checked
      // explicitly (not just letting a stretyTasks_not_connected-shaped
      // error fall through to describeColumnError()) so this column can
      // show its own real "Connect your Strety" link rather than the
      // generic "see above" wording that error message uses for the
      // SHARED connection's own not-connected state (there's no "above" to
      // point to here -- the shared connection can be perfectly healthy
      // while this signed-in user just hasn't connected their own yet).
      const personalClient = getPersonalClient(email);
      if (!personalClient.isConnected()) return { ok: true, personalNotConnected: true, rows: [] };
      const person = await findPersonByEmail(email, personalClient);
      if (!person) return { ok: true, personFound: false, rows: [] };
      const rows = await fetchStretyTasksDueTodayTomorrow(personalClient, person.id, today, tomorrow);
      return { ok: true, personFound: true, rows };
    })().catch((err) => {
      if (err.strety_reauth_required) {
        return { ok: true, personalReauthRequired: true, personalConnectedAs: getPersonalClient(email).connectedIdentity(), rows: [] };
      }
      return { ok: false, personFound: true, error: describeColumnError(err) };
    }),
  ]);

  return { asOf: new Date().toISOString(), today, tomorrow, serviceCalls, subscriptionsExpiring, stretyTasks };
}

// Cached PER SIGNED-IN USER (keyed by email, lowercased) -- confirmed
// necessary, not just cautious: the Strety column is entirely personal
// (the signed-in user's own due-soon to-dos), same "cache key includes the
// email" reasoning Service Calls' own isMine flag needed -- a shared,
// email-less cache key would leak one person's own Strety tasks into
// whoever else happens to load this page within the same cache window.
// Same 10-minute TTL/reasoning as Service Calls'/Teams Shifts' own report
// caches -- "what's scheduled today" is exactly the kind of thing that
// gets fixed within the hour, not something worth staying stale as long as
// a slower-moving customer list would be fine with.
const TODAY_TOMORROW_CACHE_TTL_MS = 10 * 60 * 1000;
const todayTomorrowCacheByEmail = new Map();
const todayTomorrowInFlightByEmail = new Map();

async function getTodayTomorrow(email, force) {
  const key = email.toLowerCase();
  const cached = todayTomorrowCacheByEmail.get(key);
  if (!force && cached && Date.now() < cached.expiresAt) return cached.data;
  if (!todayTomorrowInFlightByEmail.has(key)) {
    const build = buildTodayTomorrow(email)
      .then((data) => {
        todayTomorrowCacheByEmail.set(key, { data, expiresAt: Date.now() + TODAY_TOMORROW_CACHE_TTL_MS });
        return data;
      })
      .finally(() => {
        todayTomorrowInFlightByEmail.delete(key);
      });
    todayTomorrowInFlightByEmail.set(key, build);
  }
  return todayTomorrowInFlightByEmail.get(key);
}

const router = express.Router();

// Deliberately a SEPARATE endpoint from the scorecards route below, not
// folded into the same response -- paging this section forward/back a week
// would otherwise force a full Strety re-fetch (the expensive, rate-limited
// part of this page -- see "Rate limiting" in @dashboard/strety-client's
// README) just to change which 14 days of an entirely unrelated Graph API
// are shown.
router.get('/shifts', async (req, res) => {
  const week = req.query.week || currentWeekMondayKey();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) {
    return res.status(400).json({ error: 'Query param "week" must be a YYYY-MM-DD Monday date.' });
  }
  try {
    const data = await getShiftsWeek(week, req.query.force === 'true');
    res.json(data);
  } catch (err) {
    console.error(err);
    const detail = err.response ? `Graph API returned HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
    res.status(500).json({ error: detail });
  }
});

// Deliberately a SEPARATE endpoint from the scorecards route below, same
// reasoning as /shifts above -- three real external-system calls (Autotask/
// Ingram/Strety) is expensive enough on its own without also being
// re-fetched every time the scorecards or shifts sections reload.
router.get('/today-tomorrow', async (req, res) => {
  const email = req.session?.user?.email;
  if (!email) return res.json({ status: 'no-session-email' });
  try {
    const data = await getTodayTomorrow(email, req.query.force === 'true');
    res.json({ status: 'ok', ...data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const email = req.session?.user?.email;
    if (!email) {
      return res.json({ status: 'no-session-email' });
    }

    // Both groups below -- Helpdesk Task Tracker team AND Personal -- use
    // the SIGNED-IN USER'S OWN Strety connection (see
    // @dashboard/strety-client's getPersonalClient()), not a separate
    // shared one for the team group. By request: everyone already has
    // permission to see the team's own scorecards (unlike personal-space
    // data, where visibility is deliberately per-person), so there's no
    // reason to maintain a second connection just for that -- and doing so
    // previously meant the WHOLE page (including the team group) broke
    // whenever the shared connection's own token happened to need
    // reconnecting, even though the Personal group never depended on it.
    // One connection, one gate, one real failure point to reconnect.
    const personalClient = getPersonalClient(email);
    if (!personalClient.isConnected()) {
      return res.json({ status: 'not-connected' });
    }

    const { teams, metrics: allMetrics } = await getCatalog(personalClient);
    const helpdeskTeam = teams.find((t) => t.attributes.name === HELPDESK_TEAM_NAME) || null;

    const groups = [];

    if (helpdeskTeam) {
      groups.push({
        label: HELPDESK_TEAM_NAME,
        byFrequency: await fetchScorecardsFor('team', helpdeskTeam.id, allMetrics, personalClient),
      });
    } else {
      // Surfaced to the user rather than silently dropped -- a renamed or
      // deleted team in Strety shouldn't just make this section vanish
      // without explanation.
      groups.push({ label: HELPDESK_TEAM_NAME, notFound: true, byFrequency: {} });
    }

    const person = await findPersonByEmail(email, personalClient);
    if (!person) {
      groups.push({ label: 'Personal', personNotFound: true, byFrequency: {} });
    } else {
      groups.push({
        label: `Personal -- ${person.attributes.name}`,
        byFrequency: await fetchScorecardsFor('person', person.id, allMetrics, personalClient),
      });
    }

    res.json({
      status: 'ok',
      asOf: new Date().toISOString(),
      groups,
      // null on localhost -- client.js's own banner render is already
      // gated on `data.automationStatus && !data.automationStatus.ok`, so
      // null suppresses it with no client-side change needed.
      automationStatus: isLocalhostRequest(req) ? null : evaluateAutomationStatus(),
    });
  } catch (err) {
    if (err.strety_not_connected) {
      return res.json({ status: 'not-connected' });
    }
    // Distinct from 'not-connected' -- this connection WAS working and its
    // stored refresh token has since gone stale/revoked (confirmed against
    // real data this happens periodically). Same fix either way (redo the
    // browser login), but the message should say which situation it is
    // rather than showing a raw error for something with a known, simple
    // remedy.
    if (err.strety_reauth_required) {
      return res.json({ status: 'reauth-required', connectedAs: getPersonalClient(req.session.user.email).connectedIdentity() });
    }
    console.error(err);
    const detail = err.response ? `Strety API returned HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
    res.status(500).json({ error: detail });
  }
});

module.exports = router;
