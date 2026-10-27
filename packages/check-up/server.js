const express = require('express');
const fs = require('fs');
const path = require('path');
const {
  getClient,
  listAll,
  fetchByFieldIn,
  fetchServiceDeskAndProfessionalServicesMembership,
  fetchRoleHourlyRates,
  mondayOf,
  todayAestKey,
  weekDatesFrom,
  aestDayBoundsIso,
  aestToUtcIso,
  excludeMonitoringAlerts,
} = require('@dashboard/autotask-client');
// In-process call into Time Summaries' own report, not a duplicated
// computation -- see that package's own computeOverallTotals() for the
// full "why" (reused for its exact Total Tech Hours (at work)/Total Tech
// Client Hours/Total Tech Hours Billable definitions). Moved here from
// @dashboard/tickets-dashboard, by request ("Move the 2 Client Hours and
// Billable hours over to the new page from Tickets Dashboard").
const timesRouter = require('@dashboard/times/server.js');

const router = express.Router();
router.use(express.json());

// Resources.licenseType 7 is "API User" -- same confirmed real fact
// @dashboard/times/@dashboard/about-me's own copies of this constant
// document (integration service accounts, not real people).
const API_USER_LICENSE_TYPE = 7;

// Surfaces Autotask's own real validation message (err.response.data, e.g.
// Surfaces Autotask's own real validation message straight into the
// response -- by request, after a production 400 came back to the
// browser as nothing but axios's generic "Request failed with status
// code 400". First attempt at this checked `err.response` directly (the
// plain-axios shape @dashboard/saas-protection's own dattoGet() callers
// use for Datto's API), which turned out to be the WRONG shape here --
// confirmed against autotask-node's own dist/utils/errors.js:
// createAutotaskError() never lets a raw axios error reach this file at
// all. It re-classifies every failed call into its own AutotaskError
// subclass first (ValidationError for a 400/422), whose constructor
// keeps the real per-field detail on `.validationErrors` (pulled from
// `response.data.errors`/`.validationErrors`) and only re-attaches the
// original raw axios error as `.originalError` (NOT `.response` --
// that's why the first attempt silently fell through to the generic
// message every time). `.validationErrors` is checked first since it's
// already the specific, pre-extracted detail; `.originalError.response`
// is the fallback for anything that detail didn't cover.
function errorDetail(err) {
  if (err.validationErrors) return `Autotask validation error (${err.statusCode || '?'}): ${JSON.stringify(err.validationErrors)}`;
  const response = err.response || err.originalError?.response;
  if (response) return `Autotask API returned HTTP ${response.status}: ${JSON.stringify(response.data)}`;
  return err.message;
}

// Current AEST week (Monday..Sunday), Support Desk team -- moved verbatim
// from @dashboard/tickets-dashboard's own server.js (see that package's
// git history for the fuller original comment on why this pulls in Time
// Summaries' own computeOverallTotals() rather than recomputing from
// scratch, and why the denominator is capped at today).
async function fetchWeeklyHoursPct(client) {
  try {
    const monday = mondayOf(todayAestKey());
    const weekDays = weekDatesFrom(monday, 7);
    const from = weekDays[0];
    const today = todayAestKey();
    const to = today < weekDays[weekDays.length - 1] ? today : weekDays[weekDays.length - 1];
    const { totalTechHours, totalClientHours, totalClientHoursBillable } = await timesRouter.computeOverallTotals(client, from, to, timesRouter.TEAM_SERVICE_DESK);
    const pct = (n) => (totalTechHours > 0 ? (n / totalTechHours) * 100 : 0);
    return {
      weekFrom: from,
      weekTo: to,
      clientHoursPct: pct(totalClientHours),
      billableHoursPct: pct(totalClientHoursBillable),
    };
  } catch (err) {
    console.error('check-up: weekly hours %% failed:', err);
    return null;
  }
}

// -- Helpdesk Handler -------------------------------------------------------
// By request: a dropdown of real Autotask resources, grouped Support Desk
// (the intended, selectable choice) / Professional Services / Leadership
// Team (shown but greyed out client-side -- "to discourage selection" --
// since those two groups aren't who should actually be fielding the
// helpdesk). Same real department membership @dashboard/times' own Team
// selector and @dashboard/about-me's own resource picker already use
// (fetchServiceDeskAndProfessionalServicesMembership(), shared via
// @dashboard/autotask-client) -- not a new, separately-maintained
// definition of these 3 groups.
// Cached for 10 minutes -- by request ("429 errors everywhere"), tracked
// down to THIS call firing fresh (2+ live Autotask calls of its own)
// from several separate places on every Check-Up page load (the
// dedicated /handler-options route, plus /today-figures,
// /this-week-figures, and a cache-cold /resource-trends each calling it
// again internally) -- real
// department membership that "rarely changes" (same reasoning the
// client's own lastHandlerOptions cache already uses) has no business
// being re-fetched 3-4x on one page load. Short TTL, not the trends'
// own 1-hour one -- this is cheap enough to refresh often, the point is
// just not paying for it multiple times within the same few seconds.
const HANDLER_OPTIONS_CACHE_TTL_MS = 10 * 60 * 1000;
let handlerOptionsCache = null; // { data, expiresAt }

// Each resource's own current Autotask Role -- used below
// (computeResourceFiguresForRange) as a simple, no-extra-fetch-per-entry
// stand-in for the real per-TimeEntry roleID, to turn a resource's
// billable hours into an estimated $ figure for the Billable Daily/This
// Week/Last Week squares. Not the full chargeable-$ formula
// (@dashboard/autotask-client's own resolveChargeableValue(), used by
// Times/Ticket Times/Completed Tickets) -- that needs a real per-
// TimeEntry roleID/billingCodeID fetch plus BillingItems/WorkTypeModifiers
// lookups, real extra Autotask traffic this already-rate-limit-sensitive
// page's lightweight auto-loading sections don't need (by request,
// "simple rate estimate" over "fully accurate chargeable value").
//
// `Resources.defaultServiceDeskRoleID` looked like the obvious field for
// this, but confirmed live it's genuinely `null` for 2 of 5 real Support
// Desk resources (Hamza Mahmood, Romulo Roquim Jr) despite both logging
// real billable hours -- not usable. `ResourceRoles` (resourceID -> roleID,
// one row per department a resource belongs to) is populated for all 5,
// and in every real case checked here every row for a given resource
// shares the same roleID regardless of which department it's filed
// under, so picking any one active row's roleID is a safe, consistent
// per-resource rate.
async function fetchResourceRoleIds(client, resourceIds) {
  if (resourceIds.length === 0) return new Map();
  const rows = await fetchByFieldIn(client.resourceRoles, 'resourceID', resourceIds);
  const byResource = new Map();
  for (const row of rows) {
    if (row.isActive === false) continue;
    if (!byResource.has(row.resourceID)) byResource.set(row.resourceID, row.roleID);
  }
  return byResource;
}

async function fetchHandlerOptions(client) {
  if (handlerOptionsCache && Date.now() < handlerOptionsCache.expiresAt) return handlerOptionsCache.data;
  const membership = await fetchServiceDeskAndProfessionalServicesMembership(client);
  const allIds = [...new Set([...membership.serviceDesk, ...membership.professionalServices, ...membership.leadership])];
  if (allIds.length === 0) return { serviceDesk: [], professionalServices: [], leadership: [] };
  const [resources, roleIdByResource] = await Promise.all([fetchByFieldIn(client.resources, 'id', allIds), fetchResourceRoleIds(client, allIds)]);
  const byId = new Map(
    resources
      .filter((r) => r.licenseType !== API_USER_LICENSE_TYPE)
      .map((r) => [
        r.id,
        {
          id: r.id,
          name: [r.firstName, r.lastName].filter(Boolean).join(' ').trim() || `Resource #${r.id}`,
          roleId: roleIdByResource.get(r.id) ?? null,
        },
      ])
  );
  const groupOf = (ids) =>
    [...ids]
      .map((id) => byId.get(id))
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name));
  const data = {
    serviceDesk: groupOf(membership.serviceDesk),
    professionalServices: groupOf(membership.professionalServices),
    leadership: groupOf(membership.leadership),
  };
  handlerOptionsCache = { data, expiresAt: Date.now() + HANDLER_OPTIONS_CACHE_TTL_MS };
  return data;
}

// Role hourly rates (Roles.hourlyRate) for the $ estimate in
// computeResourceFiguresForRange() below -- same 10-minute cache tier as
// fetchHandlerOptions() above (real rates, changes rarely, no business
// being re-fetched on every one of /today-figures, /this-week-figures,
// /last-week-figures within the same few seconds).
const ROLE_RATES_CACHE_TTL_MS = 10 * 60 * 1000;
let roleRatesCache = null; // { data, expiresAt }

async function getRoleHourlyRates(client) {
  if (roleRatesCache && Date.now() < roleRatesCache.expiresAt) return roleRatesCache.data;
  const data = await fetchRoleHourlyRates(client);
  roleRatesCache = { data, expiresAt: Date.now() + ROLE_RATES_CACHE_TTL_MS };
  return data;
}

// Persisted to a plain JSON file, same "survive a restart, seen by every
// browser that (re)loads the page" convention nav-layout.json/page-help-
// text.json already use -- by request ("If any user changes the Helpdesk
// Handler, this should be seen by all people who open the page until
// someone changes it. The selection should also survive a server
// restart."). No push/live-update to an already-open tab -- same as every
// other file-backed shared setting on this dashboard, a change shows up
// the next time a tab loads or reloads this page, not instantly on every
// OTHER already-open tab. Deliberately NOT committed to git (see
// .gitignore's own comment on this exact file, and page-help-text.json's
// real incident earlier this session) -- this is live operational state,
// not source.
const HANDLER_PATH = path.join(__dirname, 'helpdesk-handler.json');

function readHandler() {
  try {
    const data = JSON.parse(fs.readFileSync(HANDLER_PATH, 'utf8'));
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null; // never set yet, or unreadable
  }
}

function writeHandler(state) {
  fs.writeFileSync(HANDLER_PATH, JSON.stringify(state, null, 2));
}

// -- 13-Week Resource Trends -------------------------------------------------
// By request: per-Service-Desk-resource trend charts, last 13 weeks, two
// metrics -- Client Billable Hours % (same formula fetchWeeklyHoursPct()
// above uses for the team-wide figure, just per resource -- see Time
// Summaries' own computePerResourceWeeklyTotals()) and Tickets Closed
// (status 5 "Complete" OR status 20 "Billing - Contract", same dashboard-
// wide "Billing - Contract always counts as complete" rule Completed
// Tickets' own fetchTicketsCompletedInRange() established -- mirrored here,
// not re-invented). A genuinely heavy computation (13 weeks' worth of
// TimeEntries fetches), so this is its own on-demand route, loaded via a
// Show button client-side -- same "don't slow down the default page load"
// convention Time Summaries' own Work-Type Reconciliation section uses.

// Right-hand (Tickets Closed) axis scale on each trend chart, by request
// -- configurable via .env's 13_WEEK_TREND_TICKET_COUNT_SCALE rather than
// a hardcoded constant, so it can be raised/lowered as real ticket volume
// changes without a code change. 30 is the original hardcoded value,
// kept as the default when the env var is unset, blank, or not a valid
// positive number -- client.js (dualLineChartSvg()) draws to whatever
// value this resolves to, read once here and sent down with every
// /resource-trends response rather than trusted directly from the
// browser.
const DEFAULT_TICKET_COUNT_SCALE = 30;
function resolveTicketCountScale() {
  const n = Number(process.env['13_WEEK_TREND_TICKET_COUNT_SCALE']);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TICKET_COUNT_SCALE;
}

// 13 full Monday..Sunday weeks, oldest first, ending with the most
// recently COMPLETED Sunday -- "EOW = Sundays", by request. Never
// includes the current, still-in-progress week -- that used to cap at
// today and show a partial, still-accumulating figure as the most recent
// data point, which isn't a real "week by week" reading.
function last13Weeks() {
  const todayKey = todayAestKey();
  const currentMonday = mondayOf(todayKey);
  // The Sunday right before this week's own Monday -- the most recently
  // completed week's end. Date.UTC() normalizes a day value of 0 (or
  // negative) into the previous month on its own, so this is correct even
  // when today IS a Monday.
  const lastSundayDate = new Date(Date.UTC(currentMonday.year, currentMonday.month - 1, currentMonday.day - 1));
  const weeks = [];
  for (let i = 12; i >= 0; i--) {
    const sundayDate = new Date(Date.UTC(lastSundayDate.getUTCFullYear(), lastSundayDate.getUTCMonth(), lastSundayDate.getUTCDate() - i * 7));
    const mondayDate = new Date(Date.UTC(sundayDate.getUTCFullYear(), sundayDate.getUTCMonth(), sundayDate.getUTCDate() - 6));
    weeks.push({ from: mondayDate.toISOString().slice(0, 10), to: sundayDate.toISOString().slice(0, 10) });
  }
  return weeks;
}

// One bulk fetch across the WHOLE 13-week span (not one per week -- unlike
// the hours side, a ticket's own completedDate/resolvedDateTime is already
// a real, queryable field, so there's no need to re-fetch per week), then
// bucketed client-side by week and by completedByResourceID. Monitoring
// Alerts excluded client-side, same noteq-null-semantics reasoning
// excludeMonitoringAlerts()'s own comment documents (@dashboard/autotask-
// client) -- never via a query filter.
async function fetchWeeklyTicketsClosedByResource(client, weeks) {
  const fromKey = weeks[0].from;
  const toKey = weeks[weeks.length - 1].to;
  const { startISO: spanStartISO } = aestDayBoundsIso(fromKey);
  const { endISO: spanEndISO } = aestDayBoundsIso(toKey);

  const completed = await listAll(client.tickets, [
    { op: 'eq', field: 'status', value: 5 },
    { op: 'gte', field: 'completedDate', value: spanStartISO },
    { op: 'lt', field: 'completedDate', value: spanEndISO },
  ]);
  const billing = await listAll(client.tickets, [
    { op: 'eq', field: 'status', value: 20 },
    { op: 'gte', field: 'resolvedDateTime', value: spanStartISO },
    { op: 'lt', field: 'resolvedDateTime', value: spanEndISO },
  ]);
  const tickets = excludeMonitoringAlerts([...completed, ...billing]);

  return weeks.map(({ from, to }) => {
    const { startISO } = aestDayBoundsIso(from);
    const { endISO } = aestDayBoundsIso(to);
    const countByResource = new Map();
    for (const t of tickets) {
      const closedAt = t.status === 20 ? t.resolvedDateTime : t.completedDate;
      if (!closedAt || closedAt < startISO || closedAt >= endISO) continue;
      if (!t.completedByResourceID) continue;
      countByResource.set(t.completedByResourceID, (countByResource.get(t.completedByResourceID) || 0) + 1);
    }
    return { from, to, countByResource };
  });
}

// The most recently COMPLETED AEST day -- never "today", for the same
// reason last13Weeks() above never includes the current, still-in-
// progress week: a partial, still-accumulating day isn't a real
// completed-period figure yet. Date.UTC() normalizes day 0 into the
// previous month on its own, same trick last13Weeks() already relies on.
// Used below by thisWeekRange() as This Week's own end date before the
// 4pm cutoff.
function yesterdayAestKey() {
  const [y, m, d] = todayAestKey().split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

// Shared by /today-figures, /this-week-figures, and /last-week-figures
// below -- same metrics (Billable Hours %, the actual Billable Hours
// behind that %, Tickets Closed), same Support Desk resource list/order
// (handlerOptions.serviceDesk, name-sorted), for ONE arbitrary date
// range. Reuses
// computePerResourceWeeklyTotals()/fetchWeeklyTicketsClosedByResource()
// unchanged -- both already take an arbitrary array of {from, to} date-
// key pairs, not hardcoded to Monday..Sunday weeks, so a single-range
// "week" works without any change to either function. `billableHours` is
// sent as a plain decimal -- by request, the client renders it as HH:MM
// (same convention Time Summaries' own formatHours() uses), not this
// route's job.
// `options.pctDenominatorHours`, when given, replaces each resource's own
// totalTechHours as the Billable % denominator -- used by /today-figures
// below, where totalTechHours is near-meaningless for a still-in-progress
// day (see hoursSince830AmAest()'s own comment for why).
async function computeResourceFiguresForRange(client, from, to, options = {}) {
  const ranges = [{ from, to }];
  const [handlerOptions, roleRatesById, hoursByRange, ticketsByRange] = await Promise.all([
    fetchHandlerOptions(client),
    getRoleHourlyRates(client),
    timesRouter.computePerResourceWeeklyTotals(client, ranges, timesRouter.TEAM_SERVICE_DESK),
    fetchWeeklyTicketsClosedByResource(client, ranges),
  ]);

  const resources = handlerOptions.serviceDesk;
  const hoursRange = hoursByRange[0];
  const ticketsRange = ticketsByRange[0];
  return resources.map((r) => {
    const hours = hoursRange.byResource.get(r.id);
    const billableHours = hours?.totalClientHoursBillable || 0;
    const denominator = options.pctDenominatorHours ?? hours?.totalTechHours ?? 0;
    const billablePct = denominator > 0 ? (billableHours / denominator) * 100 : 0;
    const ticketsClosed = ticketsRange.countByResource.get(r.id) || 0;
    const rate = roleRatesById.get(r.roleId) || 0;
    const billableDollars = billableHours * rate;
    return { id: r.id, name: r.name, billablePct, billableHours, billableDollars, ticketsClosed };
  });
}

// Live, uncached -- Today's own Billable % below has no stable
// denominator to cache against anyway (it keeps moving all day), so unlike
// Daily/This Week/Last Week there's nothing to gain from caching this one.
//
// Why 8:30am: the real Support Desk start time, used as the % denominator
// instead of each resource's own totalTechHours (what every other section
// here uses) -- by request. Early in a still-in-progress day totalTechHours
// is near zero, so the normal "billable / tech hours worked" formula swings
// wildly (one 6-minute ticket at 8:35am would read as 100%) rather than
// reading as "pace against a typical day so far".
//
// Shared 4:00pm AEST cutoff -- used both by hoursSince830AmAest() below
// (Today's own denominator freezes at this point) and by
// thisWeekRange() further down (This Week folds today's own figures in
// at this same point, by request: "show only up to yesterday until 4pm
// and then include today"). One shared definition of "4pm has passed
// today" rather than two separately-computed cutoff times that could
// drift apart.
function isPastAestCutoff(hour, minute) {
  const [y, m, d] = todayAestKey().split('-').map(Number);
  const cutoffMs = new Date(aestToUtcIso(y, m, d, hour, minute)).getTime();
  return Date.now() >= cutoffMs;
}

// Capped at 4:00pm AEST, by request ("once the now time hits 4:00pm just
// treat time as hours, not 8:30 to now") -- past that point the denominator
// freezes at the fixed 8:30am-4:00pm business-day length (7.5h) instead of
// continuing to grow with real elapsed time into the evening, which would
// otherwise keep dragging the % down for logged work that's already done.
// Returns `cutoffReached` too, so the client can drop its own "(up to
// HH:MM, N elapsed)" sub-label entirely once it's showing a frozen number
// (by request: "19 Oct (just put this after 4PM)... until then say...
// 19 Oct (up to hh:mm, {elapsed})") -- and `nowLabel`, the real AEST clock
// time "now" actually resolved to, computed server-side (not left to the
// browser's own local clock/timezone, same reasoning every other AEST
// calculation on this page already follows) for that sub-label's own
// "up to hh:mm" part.
const AEST_OFFSET_MS = 10 * 60 * 60 * 1000;
function hoursSince830AmAest() {
  const [y, m, d] = todayAestKey().split('-').map(Number);
  const startOfDayMs = new Date(aestToUtcIso(y, m, d, 8, 30)).getTime();
  const cutoffMs = new Date(aestToUtcIso(y, m, d, 16, 0)).getTime();
  const nowMs = Date.now();
  const cutoffReached = nowMs >= cutoffMs;
  const effectiveNowMs = Math.min(nowMs, cutoffMs);
  const elapsedHours = Math.max(0, (effectiveNowMs - startOfDayMs) / (60 * 60 * 1000));
  const aestNow = new Date(nowMs + AEST_OFFSET_MS);
  const nowLabel = `${String(aestNow.getUTCHours()).padStart(2, '0')}:${String(aestNow.getUTCMinutes()).padStart(2, '0')}`;
  return { elapsedHours, cutoffReached, nowLabel };
}

router.get('/today-figures', async (req, res) => {
  try {
    const client = await getClient();
    const todayKey = todayAestKey();
    const { elapsedHours, cutoffReached, nowLabel } = hoursSince830AmAest();
    const resources = await computeResourceFiguresForRange(client, todayKey, todayKey, { pctDenominatorHours: elapsedHours });
    res.json({ date: todayKey, elapsedHours, cutoffReached, nowLabel, resources });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: errorDetail(err) });
  }
});

// Shared by /this-week-figures and /last-week-figures below -- one hourly
// cache + in-flight de-duplication shape, computed ONCE server-side and
// served to every browser that asks (by request: "cache results... to be
// used across all people's browsers so that... [these] are not reselected
// more than hourly and only once at that"). Last Week already had its own
// hand-written copy of this exact pattern (same as /resource-trends' own
// getResourceTrends() further below), now generalized here instead of
// staying duplicated a second time.
const HOURLY_CACHE_TTL_MS = 60 * 60 * 1000;
function createHourlyCache(computeFn) {
  let cache = null; // { data, expiresAt }
  let inFlight = null;
  return async function get(force) {
    if (!force && cache && Date.now() < cache.expiresAt) return cache.data;
    if (!force && inFlight) return inFlight;
    inFlight = computeFn()
      .then((data) => {
        cache = { data, expiresAt: Date.now() + HOURLY_CACHE_TTL_MS };
        return data;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}

// Current AEST week, Monday..YESTERDAY before 4pm, Monday..TODAY from
// 4pm onward -- by request ("show only up to yesterday until 4pm and
// then include today"): before 4pm, today's own figures are still too
// partial to fold into the week (same "a still-in-progress today isn't
// a real completed-day figure" reasoning Today's own section above
// used to need its own live denominator), but by 4pm the business day
// is far enough along that it's treated as done -- same shared cutoff
// isPastAestCutoff() above uses for Today's own denominator freeze. On
// a Monday before 4pm there's no completed day in the current week yet,
// so `to` comes back null and the route returns an explicit all-zero
// row per resource rather than querying a backwards (to < from) range.
function thisWeekRange() {
  const monday = mondayOf(todayAestKey());
  const weekDays = weekDatesFrom(monday, 7);
  const from = weekDays[0];
  const endKey = isPastAestCutoff(16, 0) ? todayAestKey() : yesterdayAestKey();
  if (endKey < from) return { from, to: null };
  const to = endKey < weekDays[weekDays.length - 1] ? endKey : weekDays[weekDays.length - 1];
  return { from, to };
}

const getThisWeekFigures = createHourlyCache(async () => {
  const client = await getClient();
  const { from, to } = thisWeekRange();
  if (!to) {
    const handlerOptions = await fetchHandlerOptions(client);
    const resources = handlerOptions.serviceDesk.map((r) => ({ id: r.id, name: r.name, billablePct: 0, billableHours: 0, billableDollars: 0, ticketsClosed: 0 }));
    return { from, to: from, resources };
  }
  const resources = await computeResourceFiguresForRange(client, from, to);
  return { from, to, resources };
});

router.get('/this-week-figures', async (req, res) => {
  try {
    res.json(await getThisWeekFigures(req.query.force === 'true'));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: errorDetail(err) });
  }
});

// The most recently COMPLETED Monday..Sunday week -- same real range as
// last13Weeks() above's own final week, just surfaced as its own section
// (by request, "Last week (Support Desk)") rather than only buried as the
// last point on the 13-week chart.
function lastCompletedWeekRange() {
  const currentMonday = mondayOf(todayAestKey());
  const sundayDate = new Date(Date.UTC(currentMonday.year, currentMonday.month - 1, currentMonday.day - 1));
  const mondayDate = new Date(Date.UTC(sundayDate.getUTCFullYear(), sundayDate.getUTCMonth(), sundayDate.getUTCDate() - 6));
  return { from: mondayDate.toISOString().slice(0, 10), to: sundayDate.toISOString().slice(0, 10) };
}

const getLastWeekFigures = createHourlyCache(async () => {
  const client = await getClient();
  const { from, to } = lastCompletedWeekRange();
  const resources = await computeResourceFiguresForRange(client, from, to);
  return { from, to, resources };
});

router.get('/last-week-figures', async (req, res) => {
  try {
    res.json(await getLastWeekFigures(req.query.force === 'true'));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: errorDetail(err) });
  }
});

async function computeResourceTrends(client) {
  const weeks = last13Weeks();
  const [handlerOptions, hoursByWeek, ticketsByWeek] = await Promise.all([
    fetchHandlerOptions(client),
    timesRouter.computePerResourceWeeklyTotals(client, weeks, timesRouter.TEAM_SERVICE_DESK),
    fetchWeeklyTicketsClosedByResource(client, weeks),
  ]);

  const resources = handlerOptions.serviceDesk; // [{id, name}], already API-User-excluded, name-sorted
  const series = resources.map((r) => ({
    id: r.id,
    name: r.name,
    weeks: weeks.map(({ from, to }, i) => {
      const hoursWeek = hoursByWeek[i];
      const hours = hoursWeek.byResource.get(r.id);
      const billablePct = hours && hours.totalTechHours > 0 ? (hours.totalClientHoursBillable / hours.totalTechHours) * 100 : 0;
      const ticketsClosed = ticketsByWeek[i].countByResource.get(r.id) || 0;
      return { from, to, billablePct, ticketsClosed };
    }),
  }));

  return { weeks, resources: series, ticketCountScale: resolveTicketCountScale() };
}

// 1-hour cache, by request ("the 13 week view data doesn't change much...
// only refresh hourly") -- unlike /today-figures above, which is always
// live. Just one cached value, no
// per-filter key needed (this route takes no query params -- always the
// same fixed Support Desk/last-13-weeks computation). In-flight de-
// duplication so two concurrent cold-cache requests (e.g. two tabs both
// clicking Show within the same minute) share the one ~90s computation
// rather than each running their own.
const RESOURCE_TRENDS_CACHE_TTL_MS = 60 * 60 * 1000;
let resourceTrendsCache = null; // { data, expiresAt }
let resourceTrendsInFlight = null;

async function getResourceTrends(force) {
  if (!force && resourceTrendsCache && Date.now() < resourceTrendsCache.expiresAt) return resourceTrendsCache.data;
  if (!force && resourceTrendsInFlight) return resourceTrendsInFlight;
  const client = await getClient();
  resourceTrendsInFlight = computeResourceTrends(client)
    .then((data) => {
      resourceTrendsCache = { data, expiresAt: Date.now() + RESOURCE_TRENDS_CACHE_TTL_MS };
      return data;
    })
    .finally(() => {
      resourceTrendsInFlight = null;
    });
  return resourceTrendsInFlight;
}

router.get('/resource-trends', async (req, res) => {
  try {
    const data = await getResourceTrends(req.query.force === 'true');
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: errorDetail(err) });
  }
});

router.get('/weekly-hours-pct', async (req, res) => {
  try {
    const client = await getClient();
    res.json({ weeklyHoursPct: await fetchWeeklyHoursPct(client) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: errorDetail(err) });
  }
});

router.get('/handler-options', async (req, res) => {
  try {
    const client = await getClient();
    res.json(await fetchHandlerOptions(client));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: errorDetail(err) });
  }
});

router.get('/handler', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ handler: readHandler() });
});

router.put('/handler', async (req, res) => {
  const resourceId = Number(req.body.resourceId);
  if (!resourceId) return res.status(400).json({ error: 'resourceId is required.' });
  try {
    const client = await getClient();
    const resources = await fetchByFieldIn(client.resources, 'id', [resourceId]);
    const resource = resources[0];
    if (!resource) return res.status(400).json({ error: 'Unknown resourceId.' });
    const state = {
      resourceId,
      resourceName: [resource.firstName, resource.lastName].filter(Boolean).join(' ').trim() || `Resource #${resourceId}`,
      updatedAt: new Date().toISOString(),
      updatedByName: req.session.user?.name || null,
    };
    writeHandler(state);
    res.json({ handler: state });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: errorDetail(err) });
  }
});

module.exports = router;
