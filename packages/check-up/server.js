const express = require('express');
const fs = require('fs');
const path = require('path');
const {
  getClient,
  listAll,
  fetchByFieldIn,
  fetchServiceDeskAndProfessionalServicesMembership,
  mondayOf,
  todayAestKey,
  weekDatesFrom,
  aestDayBoundsIso,
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
// from four separate places on every Check-Up page load (the dedicated
// /handler-options route, plus /daily-figures, /this-week-figures, and a
// cache-cold /resource-trends each calling it again internally) -- real
// department membership that "rarely changes" (same reasoning the
// client's own lastHandlerOptions cache already uses) has no business
// being re-fetched 3-4x on one page load. Short TTL, not the trends'
// own 1-hour one -- this is cheap enough to refresh often, the point is
// just not paying for it multiple times within the same few seconds.
const HANDLER_OPTIONS_CACHE_TTL_MS = 10 * 60 * 1000;
let handlerOptionsCache = null; // { data, expiresAt }

async function fetchHandlerOptions(client) {
  if (handlerOptionsCache && Date.now() < handlerOptionsCache.expiresAt) return handlerOptionsCache.data;
  const membership = await fetchServiceDeskAndProfessionalServicesMembership(client);
  const allIds = [...new Set([...membership.serviceDesk, ...membership.professionalServices, ...membership.leadership])];
  if (allIds.length === 0) return { serviceDesk: [], professionalServices: [], leadership: [] };
  const resources = await fetchByFieldIn(client.resources, 'id', allIds);
  const byId = new Map(
    resources
      .filter((r) => r.licenseType !== API_USER_LICENSE_TYPE)
      .map((r) => [r.id, { id: r.id, name: [r.firstName, r.lastName].filter(Boolean).join(' ').trim() || `Resource #${r.id}` }])
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
// progress week: a partial, still-accumulating day isn't a real "daily
// figure" yet. Date.UTC() normalizes day 0 into the previous month on
// its own, same trick last13Weeks() already relies on.
function yesterdayAestKey() {
  const [y, m, d] = todayAestKey().split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

// Shared by /daily-figures and /this-week-figures below -- same metrics
// (Billable Hours %, the actual Billable Hours behind that %, Tickets
// Closed), same Support Desk resource list/order (handlerOptions.
// serviceDesk, name-sorted), for ONE arbitrary date range. Reuses
// computePerResourceWeeklyTotals()/fetchWeeklyTicketsClosedByResource()
// unchanged -- both already take an arbitrary array of {from, to} date-
// key pairs, not hardcoded to Monday..Sunday weeks, so a single-range
// "week" works without any change to either function. `billableHours` is
// sent as a plain decimal -- by request, the client renders it as HH:MM
// (same convention Time Summaries' own formatHours() uses), not this
// route's job.
async function computeResourceFiguresForRange(client, from, to) {
  const ranges = [{ from, to }];
  const [handlerOptions, hoursByRange, ticketsByRange] = await Promise.all([
    fetchHandlerOptions(client),
    timesRouter.computePerResourceWeeklyTotals(client, ranges, timesRouter.TEAM_SERVICE_DESK),
    fetchWeeklyTicketsClosedByResource(client, ranges),
  ]);

  const resources = handlerOptions.serviceDesk;
  const hoursRange = hoursByRange[0];
  const ticketsRange = ticketsByRange[0];
  return resources.map((r) => {
    const hours = hoursRange.byResource.get(r.id);
    const billablePct = hours && hours.totalTechHours > 0 ? (hours.totalClientHoursBillable / hours.totalTechHours) * 100 : 0;
    const billableHours = hours?.totalClientHoursBillable || 0;
    const ticketsClosed = ticketsRange.countByResource.get(r.id) || 0;
    return { id: r.id, name: r.name, billablePct, billableHours, ticketsClosed };
  });
}

// Daily counterpart to /resource-trends below, by request ("Daily figures
// for each Resource... lined up with the Resources... in the 13 week
// view") -- just for ONE day instead of 13 weeks. A single day is cheap
// next to 13 weeks of it, so this loads on page mount rather than behind
// its own Show button (same "auto-load" tier the team-wide weekly-hours-
// pct grid is already in, not the heavy-fetch Show-button tier
// /resource-trends needs).
router.get('/daily-figures', async (req, res) => {
  try {
    const client = await getClient();
    const dayKey = yesterdayAestKey();
    const resources = await computeResourceFiguresForRange(client, dayKey, dayKey);
    res.json({ date: dayKey, resources });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Current AEST week (Monday..today) -- by request ("this Week figures
// under the Dailys"). Capped at today, never the week's own Sunday if
// that hasn't happened yet -- same "current, still-in-progress period"
// shape fetchWeeklyHoursPct() above already uses for the team-wide
// figure, just per resource. Always reloads live (never cached) -- it
// changes as the week goes on, same "Today does need to reload"
// reasoning /daily-figures above follows, not the 1-hour-cached
// /resource-trends tier below (that one covers 13 already-COMPLETED
// weeks, which is a fundamentally different, much more stable kind of
// data).
router.get('/this-week-figures', async (req, res) => {
  try {
    const client = await getClient();
    const monday = mondayOf(todayAestKey());
    const weekDays = weekDatesFrom(monday, 7);
    const from = weekDays[0];
    const todayKey = todayAestKey();
    const to = todayKey < weekDays[weekDays.length - 1] ? todayKey : weekDays[weekDays.length - 1];
    const resources = await computeResourceFiguresForRange(client, from, to);
    res.json({ from, to, resources });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
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

  return { weeks, resources: series };
}

// 1-hour cache, by request ("the 13 week view data doesn't change much...
// only refresh hourly") -- unlike /daily-figures above, which always
// reloads live ("Today does need to reload"). Just one cached value, no
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
    res.status(500).json({ error: err.message });
  }
});

router.get('/weekly-hours-pct', async (req, res) => {
  try {
    const client = await getClient();
    res.json({ weeklyHoursPct: await fetchWeeklyHoursPct(client) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/handler-options', async (req, res) => {
  try {
    const client = await getClient();
    res.json(await fetchHandlerOptions(client));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
