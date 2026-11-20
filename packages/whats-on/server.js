const express = require('express');
const { isDashboardAdmin } = require('@dashboard/shell/registry.js');
// This page no longer uses the shared default Strety connection at all --
// by request, every fetch here (Helpdesk team scorecards, Personal
// scorecards, and Today & Tomorrow's Strety Tasks column) goes through the
// signed-in user's OWN connection instead (see getPersonalClient() below,
// and @dashboard/strety-client's README, "Per-signed-in-user connections",
// for why). The shared connection/its own /auth/strety/connect route still
// exist (used by nothing in this file anymore, but kept -- see that
// README) rather than removed outright.
const { getPersonalClient, getMetricUrl } = require('@dashboard/strety-client');
const { readLastRunStatus } = require('@dashboard/strety-autotask-sync/status.js');
const { METRICS: AUTOTASK_SYNC_METRICS } = require('@dashboard/strety-autotask-sync/metrics.js');
// Only for its connectedIdentity() below (a plain file read, no live API
// call) -- confirmed nothing here needs the rest of this client (that's
// sync.js's own job).
const stretyAutomationClient = require('@dashboard/strety-autotask-sync/client.js');
const {
  mondayOf,
  weekDatesFrom,
  todayAestKey,
  getClient,
  listAll,
  fetchByFieldIn,
  resolveCompanyName,
  resolveResourceName,
  resolveResourceIdByEmail,
  mapWithConcurrency,
  aestToUtcIso,
  isoDateAest,
  matchesWildcard,
  getTicketUrl,
  getPicklistLabels,
  toAest,
  fetchLeaveTimeOffRequests,
  excludeMonitoringAlerts,
} = require('@dashboard/autotask-client');
const { getTeams, getShiftsByDay } = require('@dashboard/teams-shifts/lib.js');
// For the "Today's Brief (Kaseya-MCP Morning Pulse)" box's Datto RMM half,
// by request -- same lib every other Datto RMM-backed page on this
// dashboard already uses (RMM Filter Checks, Live Reports, Check Client).
const dattoRmm = require('@dashboard/datto-rmm/lib.js');
// Reuses RMM Filter Checks' own already-cached Missing-client counts, by
// request ("Found N Clients Missing from DRMM Filters" line) -- see that
// package's own server.js for why getRmmFilters is exported alongside its
// router.
const { getRmmFilters } = require('@dashboard/rmm-filters/server.js');
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
// in far longer than the schedule implies (the scheduled task itself may
// have stopped firing entirely, which a pure success/failure check on
// the last run wouldn't catch since there'd BE no last run to check).
//
// 1.5 hours -- same "~3x the real scheduled interval" generosity the
// original hourly schedule's own 3-hour threshold had, scaled down for
// the real schedule now being every 30 minutes (see DEPLOYMENT.md's
// Windows Task Scheduler setup), not a fresh guess.
const AUTOMATION_STALE_THRESHOLD_MS = 1.5 * 60 * 60 * 1000;
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

// Temporary, by request (2026-08-28): the automation's shared Strety
// connection must run as Helpdesk, and a "Reconnect" link shown to every
// signed-in user turned out to be exactly how it stopped -- see the
// matching gate on the route itself in packages/shell/server.js for the
// real story. Until there's a permanent design, only ADMIN_FULL_ACCESS
// (.env, packages/shell/registry.js) gets any visibility into
// automationStatus at all (including the harmless "last synced" line
// below) -- everyone else gets null, same as localhost, which client.js's
// banner render already treats as "nothing to show".
function canSeeAutomationStatus(req) {
  return isDashboardAdmin(req);
}

// The staleness banner ("hasn't run in X hours") is only meaningful while
// the automation is actually expected to be running -- it's scheduled
// every 30 minutes, 4pm-9pm only (originally hourly 8am-6pm; see
// DEPLOYMENT.md's Windows Task Scheduler setup for the real current
// schedule), so outside that window the last run is ALWAYS going to look
// stale by the threshold above (e.g. every single day before the first
// 4pm run fires) even though nothing is actually wrong. By request, that
// specific message+button is only shown 4:15pm-9:00pm -- 4:15, not 4:00,
// as a small grace period for the first scheduled run to actually fire
// and complete. Doesn't apply to the "never run yet" or "last run
// failed" messages below -- those are real problems worth surfacing any
// time of day, not an artifact of the schedule itself.
function isWithinAutomationBannerWindow() {
  const aestNow = toAest(new Date());
  const minutesSinceMidnight = aestNow.getUTCHours() * 60 + aestNow.getUTCMinutes();
  return minutesSinceMidnight >= 16 * 60 + 15 && minutesSinceMidnight < 21 * 60;
}

function evaluateAutomationStatus() {
  const lastRun = readLastRunStatus();
  // A run completing successfully only means SOME valid token was used --
  // it says nothing about whether that token belongs to helpdesk@ or, as
  // has actually happened, some other real employee's account. So
  // connectedAs is included on every branch below (healthy or not, exactly
  // like ranAt already was), not just the failure ones -- a "healthy" run
  // under the wrong identity would otherwise stay invisible until someone
  // happened to check Strety directly. connectedIdentity() is a plain file
  // read (works even mid-outage), not a live API call.
  const connectedAs = stretyAutomationClient.connectedIdentity();
  if (!lastRun) {
    return { ok: false, message: 'The automated Autotask sync has never run yet.', connectedAs };
  }
  const ageMs = Date.now() - new Date(lastRun.ranAt).getTime();
  // ranAt included on every branch (not just the healthy one) -- by
  // request, client.js shows it as a small "last synced" line under the
  // Helpdesk Scorecards heading regardless of whether the automation is
  // currently healthy; the banner above already covers the unhealthy case
  // in more detail.
  if (!lastRun.success) {
    const detail = lastRun.fatalError || lastRun.results.find((r) => !r.ok)?.detail || 'unknown error';
    return { ok: false, message: `The automated Autotask sync last ran ${formatAge(ageMs)} ago and failed: ${detail}`, ranAt: lastRun.ranAt, connectedAs };
  }
  if (ageMs > AUTOMATION_STALE_THRESHOLD_MS) {
    if (!isWithinAutomationBannerWindow()) {
      return { ok: true, ranAt: lastRun.ranAt, connectedAs };
    }
    return {
      ok: false,
      message: `The automated Autotask sync hasn't run in ${formatAge(ageMs)} (expected every 30 min) -- these EOD numbers may be stale.`,
      ranAt: lastRun.ranAt,
      connectedAs,
    };
  }
  return { ok: true, ranAt: lastRun.ranAt, connectedAs };
}

// The "Team Shifts" excerpt below the scorecards -- a completely separate
// data source (Microsoft Graph, via @dashboard/teams-shifts/lib.js) from
// everything else on this page (Strety). Resolved by NAME, not a hardcoded
// team id, same convention as HELPDESK_TEAM_NAME above -- if "General" is
// ever renamed in Teams, this says so explicitly rather than silently
// showing nothing.
const SHIFTS_TEAM_NAME = 'General';

const HELPDESK_TEAM_NAME = 'Helpdesk Task Tracker';
// The exact set of metric titles the Autotask -> Strety automation keeps
// updated (see @dashboard/strety-autotask-sync/metrics.js -- the single
// source of truth for which metrics are automated, not duplicated here).
// Used to flag each row with isAutoManaged below, so client.js can show
// an "AUTO: " label -- matched by team + title, same identification
// sync.js itself uses to find the real Strety metric to write to.
const AUTO_MANAGED_METRIC_TITLES = new Set(
  AUTOTASK_SYNC_METRICS.filter((m) => m.team === HELPDESK_TEAM_NAME).map((m) => m.title)
);
// By request: only these three cadences -- Strety's real `checkin_frequency`
// values also include "annual" (confirmed against real data, 2 of the 74
// metrics on this account), deliberately left out here. Order here is the
// order groups render in.
const FREQUENCIES = ['daily', 'weekly', 'monthly'];
const HISTORY_LIMIT = 3; // was 8, then 3, then 7 ("add back in 4 more scorecard entries to make it 7"), now back down to 3 ("only show the last 3 days") -- the Helpdesk Scorecards box moved into the Today & Tomorrow row's third column (replacing My Strety Tasks), where it needs to be compact, by request
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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
          url: getMetricUrl(m.id),
          target: targetLabel(m.attributes.target_type, m.attributes.target_value),
          cells,
          // spaceType === 'team' -- Personal metrics are fetched with
          // spaceType 'person' instead, and the automation only ever
          // targets the Helpdesk Task Tracker TEAM, so this also
          // implicitly matches sync.js's own team+title identification.
          isAutoManaged: spaceType === 'team' && AUTO_MANAGED_METRIC_TITLES.has(m.attributes.title),
          // 'team' | 'person' -- lets the client pick which little icon
          // (Ambient iT logo vs. a person icon) goes in front of the title,
          // by request.
          spaceType,
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

// Real Leave, sourced directly from Autotask's own TimeOffRequests entity
// (`fetchLeaveTimeOffRequests()`, shared with `@dashboard/teams-shifts`/
// `@dashboard/about-me` -- see that shared function's own comment in
// `@dashboard/autotask-client` for the full real bug story: a real
// Vacation request sitting at real `status: 2` Submitted wasn't showing
// on "Shifts and Schedules" at all, because Autotask only mirrors an
// APPROVED request into a plain TimeEntries row, which is what this file
// used to query instead). By request ("can you get Leave from Autotask
// and add it to the Shifts data and calendars where it appears"),
// extended by a later request to also surface real not-yet-approved
// requests ("can we display the Unapproved data with the right colour
// but with stripes ... so it's obviously different") -- see
// shiftEntryHtml()'s own striped-background handling in client.js for
// the `approved: false` case.
//
// Every real Autotask resource's Leave in the given range, unscoped by
// Teams team -- same deliberate scoping choice @dashboard/teams-shifts'
// own fetchLeaveEntries() makes (see that package's README): Autotask
// resources aren't organised into a "General" Teams-Shifts roster, so
// this shows every real leave entry in the window rather than guessing
// who "belongs" to this excerpt's team. Shaped to merge straight into the
// same byDay rows real shifts/timesOff already use.
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
// Holidays? Show on the Public Holiday which Holiday Set it's From") --
// same real chain @dashboard/times' own fetchPublicHolidayHoursByResource()
// and @dashboard/teams-shifts' own fetchPublicHolidayEntries() already
// use (see that package's own comment for the full real-data-confirmed
// entity chain: Resources.locationID -> InternalLocations.holidaySetId ->
// HolidaySets.holidaySetName, Holidays.holidaySetID/holidayDate/
// holidayName). Unscoped by Teams team, same reasoning fetchLeaveEntries()
// above already gives. One real entry per (holiday set, date), not per
// resource -- see teams-shifts' own comment for why a per-resource entry
// would just be noisy duplication of the same real holiday.
async function fetchPublicHolidayEntries(client, startISO, endISO) {
  const [locations, holidaySets] = await Promise.all([
    listAll(client.internalLocations, [{ op: 'gte', field: 'id', value: 0 }]),
    listAll(client.holidaySets, [{ op: 'gte', field: 'id', value: 0 }]),
  ]);
  const holidaySetIds = [...new Set(locations.map((l) => l.holidaySetId).filter(Boolean))];
  if (holidaySetIds.length === 0) return { entries: [], resourceNamesBySet: {} };
  const holidaySetNameById = new Map(holidaySets.map((s) => [s.id, s.holidaySetName]));

  // Real Resources -> Holiday Set name lookup, by request ("assign the
  // public holidays to the right employees" -- the Leave Report popup,
  // openLeaveReportModal() in client.js) -- the SAME Resources.locationID
  // -> InternalLocations.holidaySetId chain this function's own header
  // comment already documents, just resolved the other direction (which
  // PEOPLE are in a set, not which DATES that set's holidays fall on).
  // Active resources only, same convention @dashboard/accrued-time's own
  // resource fetch already uses. Kept as a separate map (by set NAME, not
  // folded into each holiday entry itself) so a holiday spanning several
  // sets on the same real day (the grouping below) can still resolve each
  // individual set's own people rather than losing that split once their
  // names get joined into one combined "QLD Holidays, WA" string.
  const holidaySetByLocation = new Map(locations.map((l) => [l.id, l.holidaySetId]));
  const resources = await listAll(client.resources, [{ op: 'eq', field: 'isActive', value: true }]);
  const namesBySetId = new Map();
  for (const r of resources) {
    const setId = holidaySetByLocation.get(r.locationID);
    if (!setId) continue;
    const name = [r.firstName, r.lastName].filter(Boolean).join(' ').trim();
    if (!name) continue;
    if (!namesBySetId.has(setId)) namesBySetId.set(setId, new Set());
    namesBySetId.get(setId).add(name);
  }
  const resourceNamesBySet = {};
  for (const [setId, names] of namesBySetId) {
    const setName = holidaySetNameById.get(setId);
    if (setName) resourceNamesBySet[setName] = [...names].sort();
  }

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
  const entries = [...grouped.values()].map((g) => {
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
  return { entries, resourceNamesBySet };
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

  // Real Autotask Leave (see fetchLeaveEntries() above) and real Autotask
  // Public Holidays (see fetchPublicHolidayEntries() above) are both
  // independent of the Graph Shifts schedule, so both are fetched -- and
  // merged in below -- even in the `!team` case rather than only when the
  // Teams side of this succeeds; by request ("get Leave from Autotask and
  // add it to the Shifts data and calendars where it appears" / "can you
  // get the Public Holidays?"). Bare dateWorked/holidayDate-shaped ISO
  // strings, NOT aestToUtcIso() -- both are date-only fields that need no
  // real AEST offset conversion, same established convention
  // @dashboard/times' own Leave/Public-Holiday queries follow.
  const leaveEntriesPromise = getClient().then((client) => fetchLeaveEntries(client, `${mondayWeekKey}T00:00:00.000Z`, `${endKeyExclusive}T00:00:00.000Z`));
  const publicHolidayEntriesPromise = getClient().then((client) => fetchPublicHolidayEntries(client, `${mondayWeekKey}T00:00:00.000Z`, `${endKeyExclusive}T00:00:00.000Z`));

  if (!team) {
    // Surfaced rather than silently dropped -- same convention as
    // HELPDESK_TEAM_NAME's own notFound handling below.
    const byDay = {};
    const [leaveEntries, publicHolidayResult] = await Promise.all([leaveEntriesPromise, publicHolidayEntriesPromise]);
    const extraEntries = [...leaveEntries, ...publicHolidayResult.entries];
    for (const row of extraEntries) (byDay[row.dayKey] = byDay[row.dayKey] || []).push(row);
    return {
      weekStart: mondayWeekKey,
      days,
      todayKey,
      totalCount: extraEntries.length,
      byDay,
      teamName: SHIFTS_TEAM_NAME,
      notFound: extraEntries.length === 0,
      resourceNamesByHolidaySet: publicHolidayResult.resourceNamesBySet,
    };
  }

  const [{ byDay, totalCount }, leaveEntries, publicHolidayResult] = await Promise.all([
    getShiftsByDay(team.id, mondayWeekKey, endKeyExclusive),
    leaveEntriesPromise,
    publicHolidayEntriesPromise,
  ]);
  let extraCount = 0;
  for (const row of [...leaveEntries, ...publicHolidayResult.entries]) {
    (byDay[row.dayKey] = byDay[row.dayKey] || []).push(row);
    extraCount++;
  }
  for (const day of Object.values(byDay)) {
    day.sort((a, b) => (a.startDateTime || '').localeCompare(b.startDateTime || ''));
  }
  return {
    weekStart: mondayWeekKey,
    days,
    todayKey,
    totalCount: totalCount + extraCount,
    byDay,
    teamName: team.name,
    notFound: false,
    resourceNamesByHolidaySet: publicHolidayResult.resourceNamesBySet,
  };
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
// `currentUserResourceId`, when given, drives the row's own `isMine` flag
// (client.js's "Just Mine" filter) -- null when the signed-in email didn't
// resolve to a real Autotask resource at all, in which case every row
// simply comes back isMine: false rather than throwing.
async function buildServiceCallRows(client, serviceCalls, { requireOpenTicket, currentUserResourceId } = {}) {
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

  // Always fetched (not just when requireOpenTicket needs the status) --
  // by request, every row's day tag shows the linked ticket's number/title
  // on hover, which needs this same lookup regardless of which group is
  // being built.
  const ticketIds = [...new Set([...ticketIdByServiceCallId.values()].filter((id) => id !== null && id !== undefined))];
  const [ticketRows, ticketStatusLabels, serviceCallStatusLabels] = await Promise.all([
    ticketIds.length > 0 ? fetchByFieldIn(client.tickets, 'id', ticketIds) : [],
    // Ticket Status/Service call status on the hover tooltip, by request --
    // same two picklists Service Calls' own server.js already resolves
    // (client.tickets.status / client.serviceCalls.status), resolved live
    // rather than hardcoded since both are genuine Autotask picklists (see
    // getPicklistLabels()'s own comment). Cached per entity+field after the
    // first call, so calling this again for the past-incomplete group
    // below (this function runs twice per request) costs nothing extra.
    getPicklistLabels(client.tickets, 'status'),
    getPicklistLabels(client.serviceCalls, 'status'),
  ]);
  const ticketsById = new Map(ticketRows.map((t) => [t.id, t]));

  let eligibleServiceCalls = serviceCalls;
  if (requireOpenTicket) {
    eligibleServiceCalls = serviceCalls.filter((sc) => {
      const ticketId = ticketIdByServiceCallId.get(sc.id);
      if (ticketId === undefined || ticketId === null) return false;
      const ticket = ticketsById.get(ticketId);
      return ticket !== undefined && !CLOSED_TICKET_STATUSES.includes(ticket.status);
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
    const ticket = ticketId ? ticketsById.get(ticketId) : null;
    rows.push({
      id: sc.id,
      companyName: await resolveCompanyName(client, sc.companyID),
      description: sc.description || null,
      startDateTime: sc.startDateTime,
      // Not shown anywhere on this page's own rows -- only carried through
      // for the Open ticket/Mark Complete popup's "Change Date/Time" action
      // (client.js), so it has both ends to pre-fill without a second
      // fetch. Same field Service Calls' own server.js already returns.
      endDateTime: sc.endDateTime,
      dayKey: isoDateAest(sc.startDateTime),
      allocated: resourceNames.length > 0,
      resourceNames,
      // "Just Mine" filter, by request -- whether the signed-in user is
      // one of this call's own allocated resources, same "isMine" concept
      // Service Calls' own page/server.js already uses.
      isMine: !!currentUserResourceId && resourceIds.includes(currentUserResourceId),
      // Always false in practice now -- both queries above filter
      // isComplete=false server-side, by request (this section never
      // shows completed calls at all). Kept on the row anyway (rather
      // than assumed client-side) so client.js's Open ticket/Mark
      // Complete popup stays correct even if that ever changes, and so it
      // never has to guess.
      isComplete: !!sc.isComplete,
      // null when this call has no linked ticket at all -- client.js
      // renders the day tag as plain (non-link) text in that case, same
      // "no ticket, no link" convention Service Calls' own client.js uses.
      ticketUrl: ticketId ? await getTicketUrl(ticketId) : null,
      // By request: shown as a hover tooltip on the day tag -- null/null
      // when there's no linked ticket, same as ticketUrl above.
      ticketNumber: ticket ? ticket.ticketNumber : null,
      ticketTitle: ticket ? ticket.title : null,
      // Ticket Status / Service call status on the hover tooltip, by
      // request. ticketStatus is null/null right alongside ticketNumber/
      // ticketTitle above when there's no linked ticket at all; serviceCallStatus
      // is always present (every ServiceCall row has a real status), same
      // "always resolved, never conditional on a ticket" shape Service
      // Calls' own server.js already uses for this exact field.
      ticketStatus: ticket ? ticketStatusLabels.get(ticket.status) || `#${ticket.status}` : null,
      serviceCallStatus: serviceCallStatusLabels.get(sc.status) || `#${sc.status}`,
    });
  }
  return rows;
}

// Service Calls due today or tomorrow (AEST), plus -- by request -- still-
// incomplete calls scheduled in the past 2 weeks whose linked ticket is
// still open (the "fell through the cracks" case: an appointment that was
// never marked complete and the work item behind it is still live), plus --
// by request ("After Overdues put anything in the next 7 working days") --
// upcoming calls in the next 7 real working days (Mon-Fri, no public-
// holiday calendar tracked anywhere in this codebase, so "working day"
// here means plain weekday) counting forward from the day AFTER tomorrow.
// All three groups exclude completed calls entirely (isComplete=false in
// every query below), by request -- an already-finished call isn't useful
// in this compact summary the way it still is on Service Calls' own full
// calendar page.
// Confirmed against real data before picking the 2-week PAST window: an
// unbounded "isComplete = false, any date" query returned 1574 rows going
// back to 2007 (old calls simply never marked complete on tickets that
// closed ages ago -- noise, not anything actionable), while requiring the
// linked ticket to still be open cuts that to a small, genuinely actionable
// handful. 2 weeks keeps that "actionable, not noise" property without
// hardcoding a totally arbitrary cutoff.
//
// Sorted into 4 groups in this fixed order, by request ("keep as Today,
// then Tomorrow, then Overdues. After Overdues put anything in the next 7
// working days"): today/tomorrow (chronological), overdue (latest first,
// oldest last -- same ordering My Strety Tasks' own overdue rows use
// below), next-7-working-days (chronological, soonest first). ttDayTag()
// (client.js) derives each row's own tag purely from dayKey vs today/
// tomorrow -- dayKey < today is overdue (red), dayKey > tomorrow is
// upcoming (neutral blue, NOT the alarming overdue red), no extra
// server-side flag needed for either.
// `email` resolves the signed-in user's own Autotask resource id (for the
// "Just Mine" filter's isMine flag, see buildServiceCallRows()'s own
// comment) -- resolved ONCE here rather than per-row, cached across the
// life of the server process either way (resolveResourceIdByEmail()'s own
// cache in @dashboard/autotask-client).
function isWeekendKey(dateKey) {
  const dow = new Date(`${dateKey}T00:00:00Z`).getUTCDay(); // 0=Sun, 6=Sat
  return dow === 0 || dow === 6;
}
// The Nth real working day AFTER dateKey (dateKey itself excluded) --
// e.g. nthWorkingDayKeyAfter(tomorrow, 7) is the 7th weekday counting
// forward from (not including) tomorrow, which is what bounds the "next 7
// working days" window above.
function nthWorkingDayKeyAfter(dateKey, n) {
  let key = dateKey;
  let count = 0;
  while (count < n) {
    key = addDaysToKey(key, 1);
    if (!isWeekendKey(key)) count++;
  }
  return key;
}
function isoForKey(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return aestToUtcIso(y, m, d);
}
async function fetchServiceCallsTodayTomorrow(email) {
  const client = await getClient();
  const currentUserResourceId = await resolveResourceIdByEmail(client, email);
  const today = todayAestKey();
  const tomorrow = addDaysToKey(today, 1);
  const [ty, tm, td] = today.split('-').map(Number);
  const startISO = aestToUtcIso(ty, tm, td);
  const endISO = aestToUtcIso(ty, tm, td + 2); // exclusive -- covers today + tomorrow, day-after-tomorrow excluded
  const pastStartISO = aestToUtcIso(ty, tm, td - 14);
  // Day-after-tomorrow through the 7th working day after tomorrow,
  // inclusive -- futureEndISO is the exclusive upper bound (start of the
  // day right after that 7th working day).
  const futureStartISO = endISO; // same instant endISO already is -- reused, not recomputed
  const futureEndISO = isoForKey(addDaysToKey(nthWorkingDayKeyAfter(tomorrow, 7), 1));

  const [todayTomorrowCalls, pastIncompleteCalls, futureCalls] = await Promise.all([
    // isComplete=false, by request -- an already-finished call isn't
    // useful in a compact "what's happening today/tomorrow" summary the
    // way it still is on Service Calls' own full calendar (which shows
    // completed calls too, green-filled, behind its own opt-in "Show
    // Completed" toggle). Once a call is marked complete (via this
    // section's own Open ticket/Mark Complete popup, or in Autotask
    // directly), it simply drops off this list on the next refresh.
    listAll(client.serviceCalls, [
      { op: 'gte', field: 'startDateTime', value: startISO },
      { op: 'lt', field: 'startDateTime', value: endISO },
      { op: 'eq', field: 'isComplete', value: false },
    ]),
    listAll(client.serviceCalls, [
      { op: 'gte', field: 'startDateTime', value: pastStartISO },
      { op: 'lt', field: 'startDateTime', value: startISO },
      { op: 'eq', field: 'isComplete', value: false },
    ]),
    listAll(client.serviceCalls, [
      { op: 'gte', field: 'startDateTime', value: futureStartISO },
      { op: 'lt', field: 'startDateTime', value: futureEndISO },
      { op: 'eq', field: 'isComplete', value: false },
    ]),
  ]);

  const [todayTomorrowRows, pastIncompleteRows, futureRows] = await Promise.all([
    buildServiceCallRows(client, todayTomorrowCalls, { currentUserResourceId }),
    buildServiceCallRows(client, pastIncompleteCalls, { requireOpenTicket: true, currentUserResourceId }),
    buildServiceCallRows(client, futureCalls, { currentUserResourceId }),
  ]);

  const rows = [...todayTomorrowRows, ...pastIncompleteRows, ...futureRows];
  // 0 = today/tomorrow, 1 = overdue (past), 2 = upcoming (next 7 working
  // days) -- a plain dayKey comparison against today/tomorrow is enough
  // to place every row into its group; no per-query flag needed.
  function groupRank(row) {
    if (row.dayKey < today) return 1;
    if (row.dayKey > tomorrow) return 2;
    return 0;
  }
  rows.sort((a, b) => {
    const ra = groupRank(a);
    const rb = groupRank(b);
    if (ra !== rb) return ra - rb;
    // Within the overdue group: latest first, oldest last, by request --
    // reversed from the other two groups' own ascending order, which stay
    // chronological (today/tomorrow reads "today, then tomorrow"; upcoming
    // reads soonest-first, the natural way to plan ahead).
    if (ra === 1) return new Date(b.startDateTime) - new Date(a.startDateTime);
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
  // Auto-renewing subscriptions always sort AFTER every non-renewing one,
  // by request -- the ones that actually need someone's attention (won't
  // renew on their own) surface first. Each row's own Today/Tomorrow tag
  // is untouched either way (still driven by its own expirationDate,
  // rendered separately in client.js's subscriptionRowHtml()) -- this
  // only changes the ORDER rows appear in, not which day they're tagged.
  // Within each renewal group, still date-then-client, same as before.
  rows.sort(
    (a, b) =>
      Number(a.autoRenews) - Number(b.autoRenews) ||
      a.expirationDate.localeCompare(b.expirationDate) ||
      a.clientName.localeCompare(b.clientName)
  );
  return rows;
}

// The two columns run concurrently (Promise.all) -- two wholly separate
// external systems (Autotask/Ingram), not two requests hitting the
// SAME rate-limited API the way multiple Strety calls at once would be
// (see @dashboard/strety-client's own README, "Rate limiting" -- that
// caution is specifically about concurrent requests to Strety itself, not
// about running unrelated systems' own calls in parallel). Each column is
// independently try/caught -- confirmed the right shape given how many
// independent systems are involved here: one column's real failure (say,
// Ingram briefly down) shouldn't blank out the other, which has
// nothing to do with it.
async function buildTodayTomorrow(email) {
  const today = todayAestKey();
  const tomorrow = addDaysToKey(today, 1);

  const [serviceCalls, subscriptionsExpiring] = await Promise.all([
    fetchServiceCallsTodayTomorrow(email)
      .then((rows) => ({ ok: true, rows }))
      .catch((err) => ({ ok: false, error: describeColumnError(err) })),
    fetchSubscriptionsExpiringTodayTomorrow()
      .then((rows) => ({ ok: true, rows }))
      .catch((err) => ({ ok: false, error: describeColumnError(err) })),
  ]);

  return { asOf: new Date().toISOString(), today, tomorrow, serviceCalls, subscriptionsExpiring };
}

// Cached PER SIGNED-IN USER (keyed by email, lowercased) -- confirmed
// necessary, not just cautious: Service Calls' own "Just Mine" flag
// (isMine) is personal (resolved against the signed-in user's own Autotask
// resource id), so a shared, email-less cache key would leak one person's
// own flags into whoever else happens to load this page within the same
// cache window. (My Strety Tasks was previously a third, Strety-backed
// column here too -- removed, by request, now that the Helpdesk
// Scorecards box has taken its spot in the Today & Tomorrow row.)
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

// -- "Today's Brief (Kaseya-MCP Morning Pulse)" box -- by request.
// A deliberately LIGHTWEIGHT, cached version of the much heavier (several-
// minutes, many-tool-call) datto-rmm:drmm-morning-pulse skill run manually
// this session -- that skill's own elaborate tiering (disk/backup/AD
// replication diagnostics-text matching, overnight-window reconstruction,
// cross-site correlation) isn't reproduced here; this surfaces just its two
// highest-impact, cheapest-to-compute signals (a site fully dark, and a
// recently-dropped infrastructure device with no open alert covering it --
// a monitoring gap) from data this dashboard already pulls elsewhere
// (getAllDevices()/getOpenAlerts(), same calls RMM Filter Checks/the Datto
// RMM overview page already use), plus a matching lightweight Autotask
// ticket pull. Both halves cached together below (BRIEF_CACHE_TTL_MS) --
// this is a "first look" built from two one-off live research pulls
// (several hundred thousand tokens combined across two subagents), not a
// faithful reimplementation of either; revisit if it needs to get smarter.

// Same three confirmed-live picklist values Tickets Dashboard's own
// server.js already uses (CRITICAL_PRIORITY_VALUE/
// P1_CANNOT_BE_MOVED_PRIORITY_VALUE/CUSTOMER_NOTE_ADDED_STATUS_VALUE) --
// duplicated here rather than cross-imported, same per-page-duplicated-
// boilerplate convention this dashboard already follows elsewhere (e.g.
// this file's own formatWeekRangeShort() in client.js).
const BRIEF_CRITICAL_PRIORITY_VALUE = 4; // "P1 - CRITICAL"
const BRIEF_P1_CANNOT_BE_MOVED_PRIORITY_VALUE = 10; // "P1 - CANNOT BE MOVED"
const BRIEF_CUSTOMER_NOTE_ADDED_STATUS_VALUE = 19; // "Customer Note Added" -- waiting on us

// 2 hours -- "Breached" covers tickets already overdue AND tickets due
// imminently, by request (the Morning Priorities brief's own definition:
// "SLA breached or due within next 2 hours"). A moment-in-time comparison
// (like fetchOverdueCount() in tickets-dashboard/server.js), not a
// calendar-day one. Read fresh at call time (not a module-scope constant)
// since recheckAutotaskBriefFindings() below calls the matches* predicates
// again, potentially hours after the morning build -- the window has to
// slide with "now", not freeze at whatever moment the process happened to
// evaluate a top-level const.
const BRIEF_BREACH_WINDOW_MS = 2 * 60 * 60 * 1000;
function briefBreachCutoffIso() {
  return new Date(Date.now() + BRIEF_BREACH_WINDOW_MS).toISOString();
}
const BRIEF_TOP_N = 5; // this is a compact brief box, not a full ticket table

// Shared open/match predicates -- used BOTH for the once-a-day full build
// (as an in-process filter after each narrowed server-side query) AND for
// recheckAutotaskBriefFindings() below (re-applied to a fresh re-fetch of
// just the SAME ticket ids the morning's build already found, by request
// -- "just check the records found at the beginning of the day" rather
// than re-querying the whole open-ticket queue again on every Refresh
// click). Keeping one predicate per group means both call sites can never
// quietly drift apart on what "still qualifies" means.
function isBriefTicketOpen(t) {
  return !t.completedDate && t.status !== 20; // 20 = "Billing - Contract", always counts as done
}
function matchesBreachedTicket(t) {
  return (
    isBriefTicketOpen(t) &&
    [BRIEF_CRITICAL_PRIORITY_VALUE, BRIEF_P1_CANNOT_BE_MOVED_PRIORITY_VALUE].includes(t.priority) &&
    !!t.dueDateTime &&
    t.dueDateTime < briefBreachCutoffIso()
  );
}
function matchesUnassignedTicket(t) {
  return isBriefTicketOpen(t) && !t.assignedResourceID;
}
function matchesWaitingOnUsTicket(t) {
  return !t.completedDate && t.status === BRIEF_CUSTOMER_NOTE_ADDED_STATUS_VALUE;
}

async function fetchBriefBreachedTickets(client) {
  const tickets = await listAll(client.tickets, [
    { op: 'notExist', field: 'completedDate' },
    { op: 'in', field: 'priority', value: [BRIEF_CRITICAL_PRIORITY_VALUE, BRIEF_P1_CANNOT_BE_MOVED_PRIORITY_VALUE] },
    { op: 'lt', field: 'dueDateTime', value: briefBreachCutoffIso() },
  ]);
  return excludeMonitoringAlerts(tickets).filter(matchesBreachedTicket);
}

async function fetchBriefUnassignedTickets(client) {
  const tickets = await listAll(client.tickets, [
    { op: 'notExist', field: 'completedDate' },
    { op: 'notExist', field: 'assignedResourceID' },
  ]);
  return excludeMonitoringAlerts(tickets).filter(matchesUnassignedTicket);
}

async function fetchBriefWaitingOnUsTickets(client) {
  // Same shape as Tickets Dashboard's own "Client Updates" widget
  // (fetchOpenTicketsByStatus(), same status value) -- excludeMonitoringAlerts
  // applied, status!=20 not needed (a billed-and-closed ticket doesn't sit
  // at "Customer Note Added").
  const tickets = await listAll(client.tickets, [
    { op: 'notExist', field: 'completedDate' },
    { op: 'eq', field: 'status', value: BRIEF_CUSTOMER_NOTE_ADDED_STATUS_VALUE },
  ]);
  return excludeMonitoringAlerts(tickets).filter(matchesWaitingOnUsTicket);
}

async function shapeBriefTicket(client, t) {
  return {
    id: t.id,
    ticketNumber: t.ticketNumber,
    title: t.title,
    clientName: await resolveCompanyName(client, t.companyID),
    dueDateTime: t.dueDateTime,
    ticketUrl: await getTicketUrl(t.id),
  };
}

// Shapes one group's already-filtered ticket list into what the box
// renders (`items`, capped at BRIEF_TOP_N) PLUS `allIds` -- every matching
// ticket's id, not just the shown ones, kept specifically so
// recheckAutotaskBriefFindings() below has the FULL set of "records found
// at the beginning of the day" to re-verify later, not just whichever five
// happened to be displayed.
async function shapeBriefGroup(client, tickets) {
  const sorted = [...tickets].sort((a, b) => (a.dueDateTime || '').localeCompare(b.dueDateTime || ''));
  const items = await Promise.all(sorted.slice(0, BRIEF_TOP_N).map((t) => shapeBriefTicket(client, t)));
  return { count: sorted.length, items, allIds: sorted.map((t) => t.id) };
}

async function getAutotaskBriefFindings(client) {
  const [breachedTickets, unassignedTickets, waitingOnUsTickets] = await mapWithConcurrency(
    [
      () => fetchBriefBreachedTickets(client),
      () => fetchBriefUnassignedTickets(client),
      () => fetchBriefWaitingOnUsTickets(client),
    ],
    3,
    (fn) => fn()
  );

  // Pre-resolves each unique client name once, concurrently, across all
  // three groups combined -- same "warm the cache before the per-row loop"
  // pattern tickets-dashboard/server.js already uses.
  const allTickets = [...breachedTickets, ...unassignedTickets, ...waitingOnUsTickets];
  const uniqueCompanyIds = [...new Set(allTickets.map((t) => t.companyID).filter((cid) => cid !== null && cid !== undefined))];
  await mapWithConcurrency(uniqueCompanyIds, 3, (cid) => resolveCompanyName(client, cid));

  const [breached, unassigned, waitingOnUs] = await Promise.all([
    shapeBriefGroup(client, breachedTickets),
    shapeBriefGroup(client, unassignedTickets),
    shapeBriefGroup(client, waitingOnUsTickets),
  ]);
  return { status: 'ok', breached, unassigned, waitingOnUs };
}

// The cheap "Refresh" pass, by request -- re-fetches ONLY the exact
// ticket ids the morning's full build already found (fetchByFieldIn, a
// single batched query, same helper this dashboard uses everywhere for
// "I already have the ids, I just need fresh rows") and re-applies the
// SAME matches* predicate, rather than re-running the three account-wide
// queries above. A ticket that's since been closed/reassigned/replied-to
// quietly drops out; this can never surface a NEW ticket that started
// qualifying only after the morning build ran -- that's the explicit
// trade-off asked for ("just check the records found at the beginning of
// the day"), not an oversight. Company names resolve through
// resolveCompanyName()'s own internal cache (already warm from the
// morning build for any repeat client), so no separate pre-warm pass is
// needed for a handful of rechecked tickets.
async function recheckAutotaskBriefFindings(client, previousAutotask) {
  async function recheckGroup(prevGroup, matchesFn) {
    if (!prevGroup || prevGroup.allIds.length === 0) return { count: 0, items: [], allIds: [] };
    const tickets = await fetchByFieldIn(client.tickets, 'id', prevGroup.allIds);
    const stillMatching = excludeMonitoringAlerts(tickets).filter(matchesFn);
    return shapeBriefGroup(client, stillMatching);
  }
  const [breached, unassigned, waitingOnUs] = await Promise.all([
    recheckGroup(previousAutotask.breached, matchesBreachedTicket),
    recheckGroup(previousAutotask.unassigned, matchesUnassignedTicket),
    recheckGroup(previousAutotask.waitingOnUs, matchesWaitingOnUsTicket),
  ]);
  return { status: 'ok', breached, unassigned, waitingOnUs };
}

// Infrastructure, same definition as the drmm-morning-pulse skill's own
// (minus ESXi hosts -- confirmed against real data earlier this session,
// this account has none): a Server, or one of the confirmed real "Network
// Device (...)" category variants (see @dashboard/datto-rmm/lib.js's own
// mapDeviceSummary() comment for the confirmed real category list).
function isBriefInfraDevice(device) {
  const category = device.deviceType || '';
  return category === 'Server' || category.startsWith('Network Device');
}

// 14 days -- generous on purpose: this lightweight check has no overnight-
// window reconstruction (unlike the full morning-pulse skill), so "recent"
// here just means "not obviously ancient dead gear" rather than "dropped
// last night specifically".
const BRIEF_INFRA_RECENT_DAYS = 14;
const BRIEF_INFRA_TOP_N = 5;

async function getDattoBriefFindings() {
  if (!dattoRmm.hasDattoCredentials()) return { status: 'not-connected', items: [], truncatedCount: 0 };

  const [devices, openAlertsResult] = await Promise.all([dattoRmm.getAllDevices(), dattoRmm.getOpenAlerts()]);
  const alertDeviceUids = new Set(openAlertsResult.alerts.map((a) => a.deviceUid).filter(Boolean));

  const bySite = new Map();
  for (const d of devices) {
    const site = d.site || 'Unknown site';
    if (!bySite.has(site)) bySite.set(site, []);
    bySite.get(site).push(d);
  }

  const recentCutoffMs = Date.now() - BRIEF_INFRA_RECENT_DAYS * 24 * 60 * 60 * 1000;
  const items = [];

  for (const [site, siteDevices] of bySite) {
    const infra = siteDevices.filter(isBriefInfraDevice);
    if (infra.length === 0) continue;
    const offlineInfra = infra.filter((d) => !d.online);
    if (offlineInfra.length === 0) continue;

    const lastSeenTimes = offlineInfra.map((d) => (d.lastSeen ? new Date(d.lastSeen).getTime() : 0)).filter((t) => t > 0);
    const mostRecentLastSeen = lastSeenTimes.length > 0 ? Math.max(...lastSeenTimes) : 0;
    const isRecentEnoughToBeNews = mostRecentLastSeen >= recentCutoffMs;

    // Site down -- every infrastructure device at this site is offline,
    // and it's recent enough that this isn't just long-dead gear.
    // `deviceIds` carries every infra device at the site (not just the
    // offline ones) -- recheckDattoBriefItems() below needs to re-look at
    // all of them to find the new offline count, not just assume the same
    // ones are still down.
    if (offlineInfra.length === infra.length && isRecentEnoughToBeNews) {
      items.push({
        kind: 'site-down',
        rank: 0,
        site,
        deviceIds: infra.map((d) => d.id),
        text: `${site}: fully offline (${offlineInfra.length} of ${infra.length} infrastructure devices)`,
      });
      continue; // already covered -- no need to also list its own devices as separate monitoring gaps below
    }

    // Monitoring gap -- a recently-dropped infrastructure device with no
    // open High/Critical alert covering it, so nobody's been told.
    for (const d of offlineInfra) {
      if (!d.lastSeen) continue;
      const seenAtMs = new Date(d.lastSeen).getTime();
      if (seenAtMs < recentCutoffMs) continue; // too old to be news in this lightweight check
      if (alertDeviceUids.has(d.id)) continue; // already has an open alert -- someone's been told
      items.push({
        kind: 'monitoring-gap',
        rank: 1,
        site,
        deviceId: d.id,
        text: `${d.hostname} (${site}): offline since ${isoDateAest(d.lastSeen)}, no open alert raised`,
      });
    }
  }

  items.sort((a, b) => a.rank - b.rank);
  const kept = items.slice(0, BRIEF_INFRA_TOP_N);
  return { status: 'ok', items: kept, truncatedCount: Math.max(0, items.length - kept.length) };
}

// The cheap "Refresh" pass for the Datto RMM half, by request -- re-checks
// ONLY the specific devices the morning's full build already flagged
// (getDeviceDetails(), a per-device lookup -- a handful of calls, not the
// full account-wide getAllDevices()+getOpenAlerts() pull above) rather than
// re-scanning all ~1600 devices again. A site that's fully recovered, or a
// device that's either come back online or since had a real alert raised
// on it, quietly drops out; this can never surface a site/device that
// started looking wrong only after the morning build ran -- same explicit
// "just check the records found at the beginning of the day" trade-off
// recheckAutotaskBriefFindings() above makes.
async function recheckDattoBriefItems(items) {
  const rechecked = [];
  for (const item of items) {
    if (item.kind === 'site-down') {
      const details = await Promise.all(item.deviceIds.map((id) => dattoRmm.getDeviceDetails(id).catch(() => null)));
      const stillOffline = details.filter((d) => d && !d.online).length;
      if (stillOffline === 0) continue; // fully back online -- drop it
      rechecked.push({ ...item, text: `${item.site}: fully offline (${stillOffline} of ${item.deviceIds.length} infrastructure devices)` });
    } else if (item.kind === 'monitoring-gap') {
      const d = await dattoRmm.getDeviceDetails(item.deviceId).catch(() => null);
      if (!d || d.online) continue; // back online -- drop it
      if (d.openAlertCount > 0) continue; // an alert's since been raised -- someone's been told, drop it
      rechecked.push(item);
    }
  }
  return { status: 'ok', items: rechecked, truncatedCount: 0 };
}

// "Found N Clients Missing from DRMM Filters: TC Elite (N) TC Essentials
// (N)" line, by request -- reuses RMM Filter Checks' own already-cached
// Missing lists (see that package's own server.js for why getRmmFilters is
// exported) rather than recomputing anything here. Distinct COMPANIES, not
// a naive sum of each tab's own missing.length -- a company genuinely
// missing from BOTH TC Elite tabs (Servers and Workstations) should only
// count once toward "TC Elite (N)", same reasoning as every other
// distinct-count in this codebase.
async function getMissingFromRmmFiltersSummary() {
  try {
    const data = await getRmmFilters(false);
    if (data.status !== 'ok') return null;
    const eliteIds = new Set();
    const essentialsIds = new Set();
    const allIds = new Set();
    for (const tab of data.tabs) {
      const bucket = tab.classificationLabel === 'Tech Cover Elite' ? eliteIds : tab.classificationLabel === 'Tech Cover Essentials' ? essentialsIds : null;
      // tab.missing is now { items, exceptions } (rmm-filters' own Allowed
      // Exceptions feature) -- only .items counts here: an allowed
      // exception is explicitly NOT something needing action, so it
      // shouldn't inflate this count.
      for (const m of tab.missing.items) {
        allIds.add(m.companyId);
        if (bucket) bucket.add(m.companyId);
      }
    }
    return { total: allIds.size, elite: eliteIds.size, essentials: essentialsIds.size };
  } catch (err) {
    console.error('Whats On: RMM Filter Checks summary (for Today\'s Brief) failed:', err.message);
    return null;
  }
}

// The expensive full build -- every open ticket queue query, the whole-
// account Datto RMM device+alert pull, by request only ever runs ONCE PER
// AEST DAY (see getBrief() below), not on a short TTL. This is what runs
// the very first time anyone opens What's On on a given day.
async function buildBriefFull() {
  const client = await getClient();
  const [datto, autotask, rmmFilterSummary] = await Promise.all([
    getDattoBriefFindings(),
    getAutotaskBriefFindings(client),
    getMissingFromRmmFiltersSummary(),
  ]);
  return { asOf: new Date().toISOString(), datto, autotask, rmmFilterSummary };
}

// The cheap re-verification pass a manual "Refresh" click triggers for the
// REST of the day, by request -- re-checks just the specific tickets/
// devices the day's own buildBriefFull() already found (see
// recheckAutotaskBriefFindings()/recheckDattoBriefItems() above for how
// each half does that), rather than repeating either half's expensive
// account-wide pull. The RMM Filter Checks summary line is left exactly
// as it was this morning -- that page's own 15-minute cache/?force=true is
// a separate, already-cheap concern (see getMissingFromRmmFiltersSummary()'s
// own comment); there's nothing expensive here worth re-verifying twice.
async function recheckBriefFull(previous) {
  const client = await getClient();
  const [datto, autotask] = await Promise.all([
    previous.datto?.status === 'ok' ? recheckDattoBriefItems(previous.datto.items) : previous.datto,
    previous.autotask?.status === 'ok' ? recheckAutotaskBriefFindings(client, previous.autotask) : previous.autotask,
  ]);
  return { asOf: new Date().toISOString(), datto, autotask, rmmFilterSummary: previous.rmmFilterSummary };
}

// Keyed by AEST day (todayAestKey()), not a TTL -- by request ("definitely
// don't want to run this each time... run it just once a day"). The first
// request on a new AEST day always gets the full, expensive build
// (buildBriefFull()); every request after that on the SAME day -- a plain
// page load or a manual Refresh alike -- reuses that day's own cache,
// Refresh just triggering the cheap recheckBriefFull() pass instead of
// rebuilding from scratch. Rolls over naturally at AEST midnight: the next
// request after that sees a dayKey mismatch and triggers a fresh full
// build for the new day.
let briefCache = null; // { data, dayKey }
let briefInFlight = null;

async function getBrief(force) {
  if (briefInFlight) return briefInFlight;

  const dayKey = todayAestKey();
  if (!briefCache || briefCache.dayKey !== dayKey) {
    briefInFlight = buildBriefFull()
      .then((data) => {
        briefCache = { data, dayKey };
        return data;
      })
      .finally(() => {
        briefInFlight = null;
      });
    return briefInFlight;
  }

  if (!force) return briefCache.data;

  briefInFlight = recheckBriefFull(briefCache.data)
    .then((data) => {
      briefCache = { data, dayKey };
      return data;
    })
    .finally(() => {
      briefInFlight = null;
    });
  return briefInFlight;
}

const router = express.Router();
// Needed from here on -- this router's very first write route (the
// manual check-in one, below); every route before it was read-only (GET
// query params only), so nothing here needed a JSON body parser until now.
// Express's own default limit here is 100kb -- confirmed the hard way
// that's nowhere near enough once a pasted screenshot is in the body as
// a base64 data: URL (routine for even a modest-sized image, before
// base64's own ~33% size inflation on top). Bumped to 10mb -- generous
// for a full-screen screenshot, this is our own server's limit, not
// anything to do with whatever limit Strety's own API might separately
// enforce on the request this eventually becomes.
router.use(express.json({ limit: '10mb' }));

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

// "Today's Brief (Kaseya-MCP Morning Pulse)" box's own data -- deliberately
// a SEPARATE endpoint/cache from both routes above, same "don't force an
// expensive, unrelated re-fetch" reasoning /shifts and /today-tomorrow
// already give for staying separate from each other and from the main
// scorecards route below.
router.get('/brief', async (req, res) => {
  try {
    const data = await getBrief(req.query.force === 'true');
    res.json(data);
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

    // This used to also fetch a second, Personal group (the signed-in
    // user's own personal Strety space) -- moved out, by request: this
    // route now feeds the compact "Today's Brief (Kaseya-MCP Morning Pulse)"
    // box (the Helpdesk Scorecards box, relocated into the Today & Tomorrow row's
    // third column, replacing My Strety Tasks), which only ever wants the
    // team's own scorecards; Personal Scorecards is moving to the About Me
    // page instead (not yet done -- see that package when it is). Still
    // uses the SIGNED-IN USER'S OWN Strety connection (see
    // @dashboard/strety-client's getPersonalClient()), not a separate
    // shared one -- by request, everyone already has permission to see the
    // team's own scorecards, so there's no reason to maintain a second
    // connection just for that.
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

    res.json({
      status: 'ok',
      asOf: new Date().toISOString(),
      groups,
      // null on localhost, and (temporarily -- see canSeeAutomationStatus
      // above) for anyone but Amber. client.js's own banner render is
      // already gated on `data.automationStatus && !data.automationStatus.ok`,
      // so null suppresses it with no client-side change needed.
      automationStatus: isLocalhostRequest(req) || !canSeeAutomationStatus(req) ? null : evaluateAutomationStatus(),
      // Lets client.js show a "reconnect to enable the Update button"
      // banner ONLY for someone whose connection genuinely can't write
      // yet, by request -- a plain file read (hasWriteScope(), see
      // @dashboard/strety-client), not a live API call. Naturally stops
      // showing per-person the moment their own connection actually
      // becomes write-capable (an explicit reconnect, or their existing
      // token's next natural refresh if it was already write-scoped) --
      // no separate per-browser dismiss state needed.
      canWriteCheckIns: personalClient.hasWriteScope(),
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

// Writes a real manual check-in for one metric, by request -- the
// scorecards' own Update icon (client.js's openMetricUpdateModal(),
// shown only when a metric has no check-in yet for the current period)
// prompts for a Value and lets the rich-text notes box become the
// Context, after the user confirms via its own popup. Uses the SIGNED-IN
// USER'S OWN Strety connection (getPersonalClient(), same as the GET /
// route above) -- whatever real write access their own Strety account
// actually has applies here too; a 403 from Strety itself (not
// synthesized here) is the honest outcome if their account can't write
// to this particular metric's space.
//
// Same create-or-update-on-409 contract @dashboard/strety-autotask-sync's
// own sync.js already has confirmed working against the real API --
// Strety enforces ONE check-in per metric per period, so a second write
// for today needs a PATCH of the existing check-in (its id comes back
// directly in the 409's own error body), not a second POST. See that
// package's own createOrUpdateCheckIn() -- this mirrors it exactly, not
// a reinvented version.
//
// The check-in's PERIOD-identifying attributes are NOT the same across
// cadences, confirmed the hard way (a real 422 "iso_week_year/iso_week
// required for weekly metrics") -- sync.js's own confirmed-working `date`
// attribute only actually covers daily metrics (the only cadence it ever
// writes). Weekly/monthly need the SAME attribute names this page's own
// READ side already relies on (periodKeyFor()/isoWeekInfo() above, used
// to line up each metric's existing check-ins into shared columns) --
// reused here rather than invented separately, since they already have
// to match Strety's own real numbering exactly for the read side to work
// at all.
router.post('/metrics/:metricId/check-in', async (req, res) => {
  try {
    const email = req.session?.user?.email;
    if (!email) return res.status(401).json({ error: 'not-signed-in', message: 'Not signed in.' });

    const { metricId } = req.params;
    const value = typeof req.body?.value === 'string' ? req.body.value.trim() : '';
    if (!value) return res.status(400).json({ error: 'value-required', message: 'A value is required.' });
    // Real HTML (the notes editor's own innerHTML), sent as-is -- see
    // openMetricUpdateModal()'s own comment in client.js for why this
    // isn't stripped to plain text first, by request.
    const context = typeof req.body?.context === 'string' ? req.body.context : '';
    const frequency = typeof req.body?.frequency === 'string' ? req.body.frequency : '';

    const personalClient = getPersonalClient(email);
    if (!personalClient.isConnected()) {
      return res.status(409).json({ error: 'strety-not-connected', message: 'Connect your Strety account first.' });
    }

    let periodAttributes;
    if (frequency === 'weekly') {
      const { isoWeek, isoWeekYear } = isoWeekInfo(todayAestDate());
      periodAttributes = { iso_week_year: isoWeekYear, iso_week: isoWeek };
    } else if (frequency === 'monthly') {
      const aest = todayAestDate();
      periodAttributes = { year: aest.getUTCFullYear(), month: aest.getUTCMonth() + 1 };
    } else {
      // 'daily', or a missing/unrecognized frequency -- the one shape
      // actually confirmed working (sync.js's own writes).
      periodAttributes = { date: todayAestKey() };
    }
    const attributes = { value, context, ...periodAttributes };
    try {
      await personalClient.post(`/metrics/${metricId}/check_ins`, { data: { type: 'metric_check_in', attributes } });
    } catch (err) {
      if (err.response?.status !== 409) throw err;
      const existingId = err.response.data?.errors?.[0]?.meta?.existing_check_in?.id;
      if (!existingId) throw err; // Strety's own error shape changed/unexpected -- don't guess, surface the real error.
      await personalClient.patch(`/metrics/${metricId}/check_ins/${existingId}`, { data: { type: 'metric_check_in', attributes } });
    }

    res.json({ ok: true });
  } catch (err) {
    if (err.strety_not_connected) {
      return res.status(409).json({ error: 'strety-not-connected', message: 'Connect your Strety account first.' });
    }
    if (err.strety_reauth_required) {
      return res.status(409).json({ error: 'strety-reauth-required', message: 'Strety needs reconnecting.' });
    }
    // A real 403 INVALID_SCOPE, distinct from the two tagged cases above
    // -- the personal connection's own token is still perfectly VALID
    // (not expired, not revoked), it just predates this feature's write
    // access being added to /auth/strety-personal/connect's own scope
    // request. Confirmed the hard way (a real production error, exactly
    // this shape) that refreshing an already-issued token does NOT pick
    // up a newly-added scope -- only a fresh browser re-authorization
    // does, so this needs the same "go reconnect" treatment as the two
    // cases above, not just a raw error message.
    if (err.response?.status === 403 && err.response.data?.errors?.[0]?.code === 'INVALID_SCOPE') {
      return res.status(409).json({
        error: 'strety-reauth-required',
        message: "Your Strety connection needs reconnecting to allow writing check-ins (it was only ever authorized read-only).",
      });
    }
    console.error(err);
    const detail = err.response ? `Strety API returned HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
    res.status(500).json({ error: 'write-failed', message: detail });
  }
});

module.exports = router;
