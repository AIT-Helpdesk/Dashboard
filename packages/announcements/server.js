const express = require('express');
const { getClient, resolveResourceIdByEmail, fetchServiceDeskAndProfessionalServicesMembership } = require('@dashboard/autotask-client');
// Single source of truth for "only the dashboard admin can change this
// shared, dashboard-wide setting" -- same gate sidebar layout, Ticket
// Info's permanent tabs, Contract Checks' note-template editor, What's
// On's automation banner, and Updates' own admin-only entries already
// use. Never a hardcoded email.
const { isDashboardAdmin } = require('@dashboard/shell/registry.js');
const {
  listAnnouncements,
  getAnnouncement,
  createAnnouncement,
  updateAnnouncement,
  retireAnnouncement,
  unretireAnnouncement,
  deleteAnnouncement,
  acknowledge,
  listActiveAnnouncementsForUser,
} = require('./db.js');

const router = express.Router();
router.use(express.json());

const KNOWN_TEAM_VALUES = new Set(['serviceDesk', 'professionalServices', 'leadership']);
const VALID_SEVERITIES = new Set(['info', 'warning', 'critical']);

function requireAdmin(req, res, next) {
  if (!isDashboardAdmin(req)) return res.status(403).json({ error: 'Only the dashboard admin can do that.' });
  next();
}

function actorFrom(req) {
  return { email: req.session.user.email, name: req.session.user.name };
}

function toApiAnnouncement(row) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    severity: row.severity,
    ackRequired: !!row.ack_required,
    startAt: row.start_at,
    endAt: row.end_at,
    targets: JSON.parse(row.targets_json || '[]'),
    retiredAt: row.retired_at,
    retiredByName: row.retired_by_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedByName: row.updated_by_name,
  };
}

// Validates/coerces the wire body into the shape db.js expects -- db.js
// itself trusts its caller, same split every other page's db.js here
// already follows (e.g. product-mappings' server.js normalizing values
// before ever calling into contract-checks/db.js).
function parseFields(body) {
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  if (!title) throw new Error('Title is required.');
  const severity = VALID_SEVERITIES.has(body?.severity) ? body.severity : 'info';
  const rawTargets = Array.isArray(body?.targets) ? body.targets : [];
  const targets = rawTargets.filter((t) => t && t.type === 'team' && KNOWN_TEAM_VALUES.has(t.value)).map((t) => ({ type: 'team', value: t.value }));
  return {
    title,
    body: typeof body?.body === 'string' ? body.body : '',
    severity,
    ackRequired: !!body?.ackRequired,
    startAt: typeof body?.startAt === 'string' && body.startAt ? body.startAt : null,
    endAt: typeof body?.endAt === 'string' && body.endAt ? body.endAt : null,
    targets,
  };
}

// Team membership is real Autotask data (ResourceRoleDepartments rows) --
// fine to call fresh-per-request on the handful of report pages that
// already do (ticket-times, times, about-me, ...), but GET /active here
// runs on literally every dashboard page open/refresh, for every signed-in
// user, which makes it uniquely hot. A small local 5-minute TTL cache
// (same in-flight-dedup shape as check-up/server.js's own
// createHourlyCache) keeps this endpoint fast without changing
// @dashboard/autotask-client's own fetchServiceDeskAndProfessionalServicesMembership,
// which stays fresh-per-request for its other 8 call sites.
const MEMBERSHIP_CACHE_TTL_MS = 5 * 60 * 1000;
let membershipCache = null; // { data, expiresAt }
let membershipInFlight = null;
function getCachedMembership(client) {
  if (membershipCache && Date.now() < membershipCache.expiresAt) return Promise.resolve(membershipCache.data);
  if (membershipInFlight) return membershipInFlight;
  membershipInFlight = fetchServiceDeskAndProfessionalServicesMembership(client)
    .then((data) => {
      membershipCache = { data, expiresAt: Date.now() + MEMBERSHIP_CACHE_TTL_MS };
      return data;
    })
    .finally(() => {
      membershipInFlight = null;
    });
  return membershipInFlight;
}

// The pop-up's own feed -- open to every signed-in user (not admin-gated),
// since this is what everyone's dashboard load/refresh calls.
router.get('/active', async (req, res) => {
  try {
    const client = await getClient();
    const [resourceId, membership] = await Promise.all([
      resolveResourceIdByEmail(client, req.session.user.email),
      getCachedMembership(client),
    ]);
    const announcements = listActiveAnnouncementsForUser({
      nowIso: new Date().toISOString(),
      resourceId,
      membership,
      byEmail: req.session.user.email,
    }).map(toApiAnnouncement);
    res.json({ announcements });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/acknowledge', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid announcement id.' });
  if (!getAnnouncement(id)) return res.status(404).json({ error: 'Announcement not found.' });
  acknowledge(id, actorFrom(req));
  res.json({ ok: true });
});

// Admin list -- reads open to anyone who can reach this page, writes
// gated below; `editable` tells client.js whether to show the Add/Edit/
// Retire/Delete controls at all (server re-checks on every write
// regardless of what the client shows/hides, same product-mappings
// convention).
router.get('/', (req, res) => {
  const includeRetired = req.query.includeRetired === '1' || req.query.includeRetired === 'true';
  res.json({ announcements: listAnnouncements({ includeRetired }).map(toApiAnnouncement), editable: isDashboardAdmin(req) });
});

router.post('/', requireAdmin, (req, res) => {
  try {
    const announcement = createAnnouncement(parseFields(req.body), actorFrom(req));
    res.status(201).json({ announcement: toApiAnnouncement(announcement) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid announcement id.' });
  try {
    const announcement = updateAnnouncement(id, parseFields(req.body), actorFrom(req));
    if (!announcement) return res.status(404).json({ error: 'Announcement not found.' });
    res.json({ announcement: toApiAnnouncement(announcement) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/retire', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid announcement id.' });
  const announcement = retireAnnouncement(id, actorFrom(req));
  if (!announcement) return res.status(404).json({ error: 'Announcement not found.' });
  res.json({ announcement: toApiAnnouncement(announcement) });
});

router.post('/:id/unretire', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid announcement id.' });
  const announcement = unretireAnnouncement(id);
  if (!announcement) return res.status(404).json({ error: 'Announcement not found.' });
  res.json({ announcement: toApiAnnouncement(announcement) });
});

router.delete('/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid announcement id.' });
  if (!deleteAnnouncement(id)) return res.status(404).json({ error: 'Announcement not found.' });
  res.status(204).end();
});

module.exports = router;
