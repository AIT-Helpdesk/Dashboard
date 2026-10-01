const express = require('express');
const fs = require('fs');
const path = require('path');
const {
  getClient,
  fetchByFieldIn,
  fetchServiceDeskAndProfessionalServicesMembership,
  mondayOf,
  todayAestKey,
  weekDatesFrom,
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
async function fetchHandlerOptions(client) {
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
  return {
    serviceDesk: groupOf(membership.serviceDesk),
    professionalServices: groupOf(membership.professionalServices),
    leadership: groupOf(membership.leadership),
  };
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
