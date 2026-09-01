const express = require('express');
// Same admin gate the tabbed pages' own Help notes editor uses
// (packages/shell/tab-page-server.js) -- by request, this page follows that
// exact precedent: everyone can read Updates, only the dashboard admin can
// add/edit/delete entries.
const { isDashboardAdmin } = require('@dashboard/shell/registry.js');
const { listEntries, listRecentEntries, getEntry, createEntry, updateEntry, deleteEntry } = require('./db.js');

const router = express.Router();
// This router's first POST/PATCH routes -- a pasted screenshot as a base64
// data: URL routinely exceeds Express's default 100kb body limit, same fix
// What's On's own manual-check-in route needed for the identical reason.
router.use(express.json({ limit: '10mb' }));

const DEFAULT_RECENT_LIMIT = 5;
const MAX_RECENT_LIMIT = 20;

function toApiEntry(row) {
  return {
    id: row.id,
    entryDate: row.entry_date,
    imageDataUrl: row.image_data_url,
    contentHtml: row.content_html,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedByName: row.updated_by_name,
  };
}

function actorFrom(req) {
  return { email: req.session.user.email, name: req.session.user.name };
}

router.get('/', (req, res) => {
  res.json({ entries: listEntries().map(toApiEntry), editable: isDashboardAdmin(req) });
});

// Start Here's own excerpt column -- a separate, lighter route (no
// image_data_url -- see listRecentEntries()'s own comment in db.js) rather
// than reusing "/" and just slicing client-side, so that page's payload
// never grows with the full image history.
router.get('/recent', (req, res) => {
  const requested = Number(req.query.limit);
  const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, MAX_RECENT_LIMIT) : DEFAULT_RECENT_LIMIT;
  const rows = listRecentEntries(limit);
  res.json({ entries: rows.map((r) => ({ id: r.id, entryDate: r.entry_date, contentHtml: r.content_html })) });
});

// today's AEST date as "YYYY-MM-DD" -- a plain server-side default for a
// brand-new entry's date field (the client always sends its own value on
// create/update; this is a safety net if it doesn't). Not worth pulling in
// @dashboard/autotask-client's own todayAestKey() for one fallback default --
// same "AEST is close enough as a browser-local default" reasoning Service
// Calls' own client.js already uses for its calendar's initial month guess.
function todayKeyFallback() {
  const d = new Date(Date.now() + 10 * 60 * 60 * 1000); // UTC+10, no DST in Queensland
  return d.toISOString().slice(0, 10);
}

function requireAdmin(req, res, next) {
  if (!isDashboardAdmin(req)) return res.status(403).json({ error: 'Only the dashboard admin can do that.' });
  next();
}

router.post('/entries', requireAdmin, (req, res) => {
  const entryDate = typeof req.body?.entryDate === 'string' && req.body.entryDate.trim() ? req.body.entryDate.trim() : todayKeyFallback();
  const imageDataUrl = typeof req.body?.imageDataUrl === 'string' && req.body.imageDataUrl ? req.body.imageDataUrl : null;
  const contentHtml = typeof req.body?.contentHtml === 'string' ? req.body.contentHtml : '';
  const entry = createEntry({ entryDate, imageDataUrl, contentHtml }, actorFrom(req));
  res.status(201).json({ entry: toApiEntry(entry) });
});

router.patch('/entries/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid entry id.' });
  const entryDate = typeof req.body?.entryDate === 'string' && req.body.entryDate.trim() ? req.body.entryDate.trim() : todayKeyFallback();
  const imageDataUrl = typeof req.body?.imageDataUrl === 'string' && req.body.imageDataUrl ? req.body.imageDataUrl : null;
  const contentHtml = typeof req.body?.contentHtml === 'string' ? req.body.contentHtml : '';
  const entry = updateEntry(id, { entryDate, imageDataUrl, contentHtml }, actorFrom(req));
  if (!entry) return res.status(404).json({ error: 'Entry not found.' });
  res.json({ entry: toApiEntry(entry) });
});

router.delete('/entries/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid entry id.' });
  const ok = deleteEntry(id);
  if (!ok) return res.status(404).json({ error: 'Entry not found.' });
  res.status(204).end();
});

module.exports = router;
