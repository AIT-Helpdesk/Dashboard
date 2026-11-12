// "My Favourites" -- a per-user, server-side (NOT localStorage) list of
// sidebar page ids, by request: unlike Rotate (a per-browser personal
// shortcut list, see app.js's own rotateIds), this needs to persist across
// sessions, devices, and browsers for the same signed-in person, so it has
// to live server-side keyed by identity, not in one browser's storage.
// Same `node:sqlite` DatabaseSync + WAL pattern every other package's own
// db.js here already uses (announcements, tc-elite-rollout, workshop, ...)
// -- kept in packages/shell specifically because this is a shell-level/
// nav feature, not a single page's own data (see announcements/db.js's
// own acknowledgements table for the precedent this follows: keyed by
// email, the stable per-user identity packages/shell/auth.js's session
// already carries, not an internal user id).
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS favorites (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL,
    page_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (email, page_id)
  );
`);

// Insertion order (id ASC) -- the order a user added their own favourites
// in, which is what the sidebar renders them in (app.js never reorders
// this list itself; a removed-then-re-added page simply moves to the end,
// same as Rotate's own Set-based ordering).
function listFavoritePageIds(email) {
  return db.prepare('SELECT page_id FROM favorites WHERE email = ? ORDER BY id ASC').all(email).map((r) => r.page_id);
}

// INSERT OR IGNORE -- adding a page that's already a favourite (a double-
// click, or a second tab/device racing the same request) is a harmless
// no-op thanks to the UNIQUE(email, page_id) constraint above, same
// idempotent-write reasoning announcements/db.js's own acknowledge() uses.
function addFavorite(email, pageId) {
  db.prepare('INSERT OR IGNORE INTO favorites (email, page_id, created_at) VALUES ($email, $pageId, $now)').run({
    $email: email,
    $pageId: pageId,
    $now: new Date().toISOString(),
  });
}

function removeFavorite(email, pageId) {
  db.prepare('DELETE FROM favorites WHERE email = ? AND page_id = ?').run(email, pageId);
}

module.exports = {
  listFavoritePageIds,
  addFavorite,
  removeFavorite,
};
