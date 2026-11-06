// Announcements' own persistent data -- a dashboard-wide pop-up (shown on
// every page open/refresh, packages/shell/public/app.js's own
// maybeShowAnnouncements()), managed through this page's own admin list so
// Amber can add/edit/retire announcements without a code change. Same
// `node:sqlite` DatabaseSync shape as Workshop/Contract Checks/Updates --
// zero new runtime dependencies, no native-binary-on-Windows risk. Needs
// Node >=22.5.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS announcements (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    severity TEXT NOT NULL DEFAULT 'info',   -- 'info' | 'warning' | 'critical'
    ack_required INTEGER NOT NULL DEFAULT 0, -- 0/1
    start_at TEXT,                           -- ISO instant, NULL = no start bound
    end_at TEXT,                             -- ISO instant, NULL = no end bound
    -- Extensible targeting: a JSON array of {type, value} objects, e.g.
    -- [{"type":"team","value":"serviceDesk"}]. Empty array ('[]') = shows
    -- to everyone. A later non-team criterion (e.g. a company-type rule)
    -- is a new matcher function in listActiveAnnouncementsForUser() below,
    -- not a schema change -- same '<col>_json TEXT' convention
    -- packages/contract-checks/db.js already uses for its own variable-
    -- shape columns (ticket_autotask_ids_json, products_json).
    targets_json TEXT NOT NULL DEFAULT '[]',
    -- Retiring just stops an announcement from matching/appearing (see
    -- listActiveAnnouncementsForUser and listAnnouncements below) -- it
    -- stays fully editable and un-retirable. No other table in this
    -- codebase has a dedicated retire column yet (Workshop overloads its
    -- own status column instead), but severity/retired aren't otherwise
    -- conflated here, so a plain NULL-means-active column is the cleaner
    -- fit for this table specifically.
    retired_at TEXT,
    retired_by_email TEXT,
    retired_by_name TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by_email TEXT,
    updated_by_name TEXT
  );
`);

// One row per (announcement, user) who has clicked Acknowledge -- genuinely
// server-side and cross-device (unlike e.g. tab-page-client.js's
// tabBarMinimized, a plain localStorage per-browser setting), so it stops
// an announcement reappearing for THAT person specifically while everyone
// else still sees it. The UNIQUE constraint makes acknowledging idempotent
// (a double-click or a second tab racing the same POST is a harmless
// no-op via INSERT OR IGNORE in acknowledge() below).
db.exec(`
  CREATE TABLE IF NOT EXISTS acknowledgements (
    id INTEGER PRIMARY KEY,
    announcement_id INTEGER NOT NULL REFERENCES announcements(id),
    acknowledged_at TEXT NOT NULL,
    acknowledged_by_email TEXT NOT NULL,
    acknowledged_by_name TEXT,
    UNIQUE (announcement_id, acknowledged_by_email)
  );
`);

const VALID_SEVERITIES = new Set(['info', 'warning', 'critical']);
const SEVERITY_RANK = { critical: 0, warning: 1, info: 2 };

function nowIso() {
  return new Date().toISOString();
}

function getAnnouncement(id) {
  return db.prepare('SELECT * FROM announcements WHERE id = ?').get(id);
}

// Newest-created-first -- same "id DESC is insertion order" convention
// packages/updates/db.js's own listEntries() uses. includeRetired lets the
// admin list show retired rows behind its own "Show retired" toggle without
// a second table or a second query shape.
function listAnnouncements({ includeRetired } = {}) {
  const sql = includeRetired
    ? 'SELECT * FROM announcements ORDER BY id DESC'
    : 'SELECT * FROM announcements WHERE retired_at IS NULL ORDER BY id DESC';
  return db.prepare(sql).all();
}

function normalizeSeverity(value) {
  return VALID_SEVERITIES.has(value) ? value : 'info';
}

// fields.targets is always an ARRAY of {type, value} objects by the time it
// reaches here -- server.js is responsible for validating/coercing the
// request body before calling create/update, same "db.js trusts its
// caller's shapes, server.js validates the wire format" split every other
// page's db.js here already follows.
function createAnnouncement(fields, actor) {
  const now = nowIso();
  const info = db
    .prepare(
      `INSERT INTO announcements
         (title, body, severity, ack_required, start_at, end_at, targets_json, created_at, updated_at, updated_by_email, updated_by_name)
       VALUES ($title, $body, $severity, $ackRequired, $startAt, $endAt, $targetsJson, $now, $now, $email, $name)`
    )
    .run({
      $title: fields.title,
      $body: fields.body || '',
      $severity: normalizeSeverity(fields.severity),
      $ackRequired: fields.ackRequired ? 1 : 0,
      $startAt: fields.startAt || null,
      $endAt: fields.endAt || null,
      $targetsJson: JSON.stringify(fields.targets || []),
      $now: now,
      $email: actor.email,
      $name: actor.name,
    });
  return getAnnouncement(Number(info.lastInsertRowid));
}

// Edits every field regardless of retired state, by design -- retiring is
// meant to stop an announcement SHOWING, not freeze it (see retired_at's
// own comment above).
function updateAnnouncement(id, fields, actor) {
  const existing = getAnnouncement(id);
  if (!existing) return null;
  db.prepare(
    `UPDATE announcements SET
       title = $title, body = $body, severity = $severity, ack_required = $ackRequired,
       start_at = $startAt, end_at = $endAt, targets_json = $targetsJson,
       updated_at = $updatedAt, updated_by_email = $email, updated_by_name = $name
     WHERE id = $id`
  ).run({
    $id: id,
    $title: fields.title,
    $body: fields.body || '',
    $severity: normalizeSeverity(fields.severity),
    $ackRequired: fields.ackRequired ? 1 : 0,
    $startAt: fields.startAt || null,
    $endAt: fields.endAt || null,
    $targetsJson: JSON.stringify(fields.targets || []),
    $updatedAt: nowIso(),
    $email: actor.email,
    $name: actor.name,
  });
  return getAnnouncement(id);
}

function retireAnnouncement(id, actor) {
  const existing = getAnnouncement(id);
  if (!existing) return null;
  db.prepare(
    `UPDATE announcements SET retired_at = $now, retired_by_email = $email, retired_by_name = $name WHERE id = $id`
  ).run({ $id: id, $now: nowIso(), $email: actor.email, $name: actor.name });
  return getAnnouncement(id);
}

function unretireAnnouncement(id) {
  const existing = getAnnouncement(id);
  if (!existing) return null;
  db.prepare('UPDATE announcements SET retired_at = NULL, retired_by_email = NULL, retired_by_name = NULL WHERE id = ?').run(id);
  return getAnnouncement(id);
}

function deleteAnnouncement(id) {
  const existing = getAnnouncement(id);
  if (!existing) return false;
  db.prepare('DELETE FROM acknowledgements WHERE announcement_id = ?').run(id);
  db.prepare('DELETE FROM announcements WHERE id = ?').run(id);
  return true;
}

// INSERT OR IGNORE -- acknowledging twice (a double-click, or a second
// browser tab racing the same POST) is a harmless no-op thanks to the
// UNIQUE(announcement_id, acknowledged_by_email) constraint above, not a
// constraint-violation error the caller would otherwise have to catch.
function acknowledge(announcementId, actor) {
  db.prepare(
    `INSERT OR IGNORE INTO acknowledgements (announcement_id, acknowledged_at, acknowledged_by_email, acknowledged_by_name)
     VALUES ($announcementId, $now, $email, $name)`
  ).run({ $announcementId: announcementId, $now: nowIso(), $email: actor.email, $name: actor.name });
}

function hasAcknowledged(announcementId, byEmail) {
  return !!db
    .prepare('SELECT 1 FROM acknowledgements WHERE announcement_id = ? AND acknowledged_by_email = ?')
    .get(announcementId, byEmail);
}

// Extensible targeting dispatch -- today only 'team' exists (OR'd against
// the current user's own 3 real Autotask team-membership Sets, fetched by
// server.js via @dashboard/autotask-client's own
// fetchServiceDeskAndProfessionalServicesMembership and passed in as
// `membership`), but a later Autotask-based criterion is a new case here,
// never a schema or wire-format change (see targets_json's own comment).
function targetMatches(target, { resourceId, membership }) {
  if (target.type === 'team') {
    const set = membership && membership[target.value];
    return !!(set && resourceId != null && set.has(resourceId));
  }
  return false; // an unrecognized target type never matches -- fail closed, not open
}

function isWithinWindow(row, nowIso_) {
  if (row.start_at && nowIso_ < row.start_at) return false;
  if (row.end_at && nowIso_ > row.end_at) return false;
  return true;
}

// The one real "what applies to THIS user right now" query behind the
// pop-up's own GET /active route. All-JS filtering (not SQL) -- the table
// is small (an admin-maintained announcement list, not event data) and the
// targeting/ack checks need the caller's own resourceId/membership/email
// context anyway, so there's no real SQL to push this into.
function listActiveAnnouncementsForUser({ nowIso: nowIso_, resourceId, membership, byEmail }) {
  const rows = listAnnouncements({ includeRetired: false }).filter((row) => isWithinWindow(row, nowIso_));
  const matching = rows.filter((row) => {
    const targets = JSON.parse(row.targets_json || '[]');
    if (targets.length > 0 && !targets.some((t) => targetMatches(t, { resourceId, membership }))) return false;
    if (row.ack_required && hasAcknowledged(row.id, byEmail)) return false;
    return true;
  });
  return matching.sort((a, b) => {
    const rankDiff = (SEVERITY_RANK[a.severity] ?? 99) - (SEVERITY_RANK[b.severity] ?? 99);
    if (rankDiff !== 0) return rankDiff;
    return (b.start_at || b.created_at).localeCompare(a.start_at || a.created_at);
  });
}

module.exports = {
  listAnnouncements,
  getAnnouncement,
  createAnnouncement,
  updateAnnouncement,
  retireAnnouncement,
  unretireAnnouncement,
  deleteAnnouncement,
  acknowledge,
  listActiveAnnouncementsForUser,
};
