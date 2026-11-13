const express = require('express');
const { getClient, listAll, resolveResourceIdByEmail, fetchServiceDeskAndProfessionalServicesMembership } = require('@dashboard/autotask-client');
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
  listAcknowledgements,
  listActiveAnnouncementsForUser,
} = require('./db.js');

const router = express.Router();
router.use(express.json());

const KNOWN_TEAM_VALUES = new Set(['serviceDesk', 'professionalServices', 'leadership']);
const VALID_SEVERITIES = new Set(['info', 'warning', 'critical']);

// Resources.licenseType 7 is "API User" -- same real fact @dashboard/
// accrued-time's own fetchAccrualResources() already relies on -- excluded
// here too, since a service account was never going to acknowledge
// anything.
const API_USER_LICENSE_TYPE = 7;

// Who's actually eligible to see (and so expected to acknowledge) a given
// announcement, for the "hasn't acknowledged yet" list below -- an
// announcement with no team targets is shown to literally everyone, so
// every active, non-API-user Autotask resource counts as eligible; one
// targeted at specific team(s) narrows that down via the same real
// ResourceRoleDepartments membership GET /active already uses.
async function fetchEligibleUsers(client, targets) {
  const resources = await listAll(client.resources, [{ op: 'eq', field: 'isActive', value: true }]);
  const people = resources
    .filter((r) => r.licenseType !== API_USER_LICENSE_TYPE)
    .map((r) => ({ id: r.id, email: r.email || null, name: [r.firstName, r.lastName].filter(Boolean).join(' ').trim() || r.email || `Resource #${r.id}` }));
  if (!targets || targets.length === 0) return people;
  const membership = await fetchServiceDeskAndProfessionalServicesMembership(client);
  const eligibleIds = new Set();
  for (const t of targets) {
    const set = membership[t.value];
    if (set) for (const resourceId of set) eligibleIds.add(resourceId);
  }
  return people.filter((p) => eligibleIds.has(p.id));
}

function actorFrom(req) {
  return { email: req.session.user.email, name: req.session.user.name };
}

// By request: anyone signed in may ADD an announcement, but managing one
// (edit/archive/restore/delete) is restricted to the dashboard admin OR the
// original creator of that specific announcement -- never every signed-in
// user, and never gated on isDashboardAdmin() alone the way the rest of
// this route file used to be. Viewing who's acknowledged (GET
// /:id/acknowledgements, below) is deliberately NOT gated by this -- by
// request, that one's open to everyone.
function isOwnerOrAdmin(req, announcement) {
  return isDashboardAdmin(req) || announcement.created_by_email === req.session.user.email;
}

// Looks the announcement up once, 404s if it doesn't exist, 403s if the
// caller is neither its creator nor the admin -- shared by every
// management route below so the same rule can't drift between them.
// Stashes the row on req so handlers that also need it (none currently do,
// since db.js re-fetches internally) don't have to query twice.
function requireOwnerOrAdmin(req, res, next) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid announcement id.' });
  const announcement = getAnnouncement(id);
  if (!announcement) return res.status(404).json({ error: 'Announcement not found.' });
  if (!isOwnerOrAdmin(req, announcement)) {
    return res.status(403).json({ error: 'Only the person who created this announcement, or the dashboard admin, can do that.' });
  }
  req.announcement = announcement;
  next();
}

// Admin-only, same 404-then-403 shape as requireOwnerOrAdmin above -- by
// request: the creator can archive/restore/edit their own announcement,
// but NOT delete it outright; only the dashboard admin can. Scoped to just
// DELETE below, not the other management routes.
function requireAdmin(req, res, next) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid announcement id.' });
  const announcement = getAnnouncement(id);
  if (!announcement) return res.status(404).json({ error: 'Announcement not found.' });
  if (!isDashboardAdmin(req)) {
    return res.status(403).json({ error: 'Only the dashboard admin can delete an announcement.' });
  }
  req.announcement = announcement;
  next();
}

// `req` is used to compute canManage (creator or admin) for this specific
// viewer -- every call site below has a req in scope, so it's just passed
// through rather than defaulting/guarding it as optional.
function toApiAnnouncement(row, req) {
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
    // canManage: edit/archive/restore (creator or admin). canDelete:
    // delete outright -- admin only, deliberately narrower, by request.
    canManage: isOwnerOrAdmin(req, row),
    canDelete: isDashboardAdmin(req),
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
    }).map((row) => toApiAnnouncement(row, req));
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

// List -- open to anyone who can reach this page (adding is open to
// everyone too, by request). Each row's own `canManage` (creator or admin)
// tells client.js whether to show that row's Edit/Archive/Ack's controls;
// `canDelete` (admin only) separately gates just Delete -- two per-row
// flags now, not a single page-wide `editable` -- the server re-checks on
// every write regardless of what the client shows/hides, same
// product-mappings convention.
router.get('/', (req, res) => {
  const includeRetired = req.query.includeRetired === '1' || req.query.includeRetired === 'true';
  res.json({ announcements: listAnnouncements({ includeRetired }).map((row) => toApiAnnouncement(row, req)) });
});

// By request: any signed-in user may add an announcement, not just the
// dashboard admin -- no requireOwnerOrAdmin gate here (there's no existing
// row to own yet; the creator becomes its owner via actorFrom() below).
router.post('/', (req, res) => {
  try {
    const announcement = createAnnouncement(parseFields(req.body), actorFrom(req));
    res.status(201).json({ announcement: toApiAnnouncement(announcement, req) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/:id', requireOwnerOrAdmin, (req, res) => {
  const id = Number(req.params.id);
  try {
    const announcement = updateAnnouncement(id, parseFields(req.body), actorFrom(req));
    if (!announcement) return res.status(404).json({ error: 'Announcement not found.' });
    res.json({ announcement: toApiAnnouncement(announcement, req) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Who's acknowledged a given announcement -- by request, open to every
// signed-in user, not just its creator or the admin (unlike Edit/Archive/
// Delete above, which stay restricted). Also returns notAcknowledged: the
// real eligible-but-hasn't-acked list, via fetchEligibleUsers() above; a
// failure fetching that (e.g. an Autotask hiccup) doesn't block the
// acknowledgements themselves, which come straight out of this page's own
// SQLite db either way.
router.get('/:id/acknowledgements', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid announcement id.' });
  const announcement = getAnnouncement(id);
  if (!announcement) return res.status(404).json({ error: 'Announcement not found.' });
  const acknowledgements = listAcknowledgements(id);
  try {
    const targets = JSON.parse(announcement.targets_json || '[]');
    const client = await getClient();
    const eligible = await fetchEligibleUsers(client, targets);
    const ackedEmails = new Set(acknowledgements.map((a) => a.email));
    const notAcknowledged = eligible
      .filter((u) => u.email && !ackedEmails.has(u.email))
      .map((u) => ({ name: u.name, email: u.email }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ acknowledgements, notAcknowledged });
  } catch (err) {
    res.json({ acknowledgements, notAcknowledged: null, notAcknowledgedError: err.message });
  }
});

router.post('/:id/retire', requireOwnerOrAdmin, (req, res) => {
  const id = Number(req.params.id);
  const announcement = retireAnnouncement(id, actorFrom(req));
  if (!announcement) return res.status(404).json({ error: 'Announcement not found.' });
  res.json({ announcement: toApiAnnouncement(announcement, req) });
});

router.post('/:id/unretire', requireOwnerOrAdmin, (req, res) => {
  const id = Number(req.params.id);
  const announcement = unretireAnnouncement(id);
  if (!announcement) return res.status(404).json({ error: 'Announcement not found.' });
  res.json({ announcement: toApiAnnouncement(announcement, req) });
});

// Admin-only -- by request, narrower than Edit/Archive above (creator-or-
// admin): "the creator can Archive but not delete, only the admin can
// delete."
router.delete('/:id', requireAdmin, (req, res) => {
  deleteAnnouncement(req.announcement.id);
  res.status(204).end();
});

module.exports = router;
