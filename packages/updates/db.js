// Updates page's own persistent data -- a simple admin-maintained changelog,
// same "real, writable application data of its own" shape Workshop/Contract
// Checks/Packages Received already use (node's own built-in `node:sqlite`,
// zero new runtime dependencies, no native-binary-on-Windows risk). Needs
// Node >=22.5.
//
// One flat table, no history/audit trail (unlike Workshop/Contract Checks) --
// by request this is meant to stay simple ("only needs to be edited in
// place"), and an edit here just overwrites the row; who last touched it is
// enough (updated_by_email/name), not a full change log.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY,
    -- The date of the CHANGE being described, not necessarily today (the
    -- admin can be logging something that happened a few days ago) --
    -- always editable, "YYYY-MM-DD". Deliberately NOT the sort key (see
    -- listEntries() below) -- by request, entries stay in the order they
    -- were added (newest addition always on top), independent of whatever
    -- date is typed here.
    entry_date TEXT NOT NULL,
    -- One optional pasted thumbnail per entry, already resized/compressed
    -- client-side before it ever reaches here (same MAX_IMAGE_DIMENSION/
    -- IMAGE_JPEG_QUALITY canvas round-trip What's On's own Update editor
    -- uses) -- a real data: URL, or NULL when no image was pasted.
    image_data_url TEXT,
    -- Rich text via contenteditable + document.execCommand
    -- (Bold/Underline/Bulleted list/Link), same toolbar/approach as the
    -- tabbed pages' own Help notes editor and What's On's Update editor --
    -- real HTML, not plain text.
    content_html TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by_email TEXT,
    updated_by_name TEXT
  );
`);

function nowIso() {
  return new Date().toISOString();
}

// Newest-added-first, by request ("I will place the latest updates at the
// top") -- id DESC is insertion order here (id is a plain AUTOINCREMENT-ish
// rowid, never reused), which is exactly "newest addition on top" without
// needing a separate sort/reorder feature. The entry_date field is purely
// informational text about when the change happened, not the sort key.
function listEntries() {
  return db.prepare('SELECT * FROM entries ORDER BY id DESC').all();
}

// Start Here's own excerpt column -- content_html only (no image_data_url,
// which can be tens of KB and isn't shown there anyway) and capped to a
// small `limit`, so that page's payload stays light regardless of how long
// the full Updates history eventually grows.
function listRecentEntries(limit) {
  return db.prepare('SELECT id, entry_date, content_html FROM entries ORDER BY id DESC LIMIT ?').all(limit);
}

function getEntry(id) {
  return db.prepare('SELECT * FROM entries WHERE id = ?').get(id);
}

function createEntry(fields, actor) {
  const now = nowIso();
  const info = db
    .prepare(
      `INSERT INTO entries (entry_date, image_data_url, content_html, created_at, updated_at, updated_by_email, updated_by_name)
       VALUES ($entryDate, $imageDataUrl, $contentHtml, $now, $now, $email, $name)`
    )
    .run({
      $entryDate: fields.entryDate,
      $imageDataUrl: fields.imageDataUrl || null,
      $contentHtml: fields.contentHtml || '',
      $now: now,
      $email: actor.email,
      $name: actor.name,
    });
  return getEntry(Number(info.lastInsertRowid));
}

function updateEntry(id, fields, actor) {
  const existing = getEntry(id);
  if (!existing) return null;
  db.prepare(
    `UPDATE entries SET entry_date = $entryDate, image_data_url = $imageDataUrl, content_html = $contentHtml,
       updated_at = $updatedAt, updated_by_email = $email, updated_by_name = $name
     WHERE id = $id`
  ).run({
    $id: id,
    $entryDate: fields.entryDate,
    $imageDataUrl: fields.imageDataUrl || null,
    $contentHtml: fields.contentHtml || '',
    $updatedAt: nowIso(),
    $email: actor.email,
    $name: actor.name,
  });
  return getEntry(id);
}

function deleteEntry(id) {
  const existing = getEntry(id);
  if (!existing) return false;
  db.prepare('DELETE FROM entries WHERE id = ?').run(id);
  return true;
}

module.exports = { listEntries, listRecentEntries, getEntry, createEntry, updateEntry, deleteEntry };
