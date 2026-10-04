// Shared scan/schema logic -- split out of server.js so it can be
// required and tested directly (plain functions, no Express/session
// auth involved), same "logic file separate from the router that wires
// it up" convention @dashboard/teams-shifts' own lib.js already uses.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const PACKAGES_ROOT = path.join(__dirname, '..');
const DB_EXTENSIONS = ['.db', '.sqlite', '.sqlite3'];
const SKIP_DIR_NAMES = new Set(['node_modules', 'dist', 'build']);

// 10 minutes, by request. Re-scanning the filesystem is cheap (no
// network/API cost the way Datto RMM's own 20-minute cache is guarding
// against), so no inFlight-promise dedup is needed the way that page's
// own getCachedOverview() has -- a cache-expiry race just means two
// requests each redo one cheap recursive walk, not two expensive API
// calls.
const CACHE_TTL_MS = 10 * 60 * 1000;
let cache = null; // { databases, scannedAt, expiresAt }

// Recursively walks `dir`, collecting every file whose extension
// (case-insensitive) matches DB_EXTENSIONS -- deliberately excludes
// SQLite's own WAL/SHM/journal sidecar files just by construction: those
// are named `<name>.db-wal`/`<name>.db-shm`/`<name>.db-journal`, which
// don't end in one of DB_EXTENSIONS at all (they end in `-wal` etc.), so
// no separate exclusion rule is needed for them.
function findDbFiles(dir, found) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable dir (permissions, race with a delete) -- skip it, not a reason to fail the whole scan
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      findDbFiles(path.join(dir, entry.name), found);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (DB_EXTENSIONS.includes(ext)) found.push(path.join(dir, entry.name));
    }
  }
}

// One entry per real database file, by request ("A single package may
// contain MORE THAN ONE database. Handle this.") -- packageDir is the
// top-level folder directly under packages/ (what the dropdown groups
// by); relativePath is the file's path relative to THAT package folder
// (what the dropdown labels each option with, so two same-named files in
// different subfolders of the same package stay distinguishable); id is
// the file's path relative to packages/ itself (globally unique across
// every package, and the only thing the schema route trusts -- see
// server.js's own comment).
function scanDatabases() {
  const found = [];
  findDbFiles(PACKAGES_ROOT, found);
  const databases = found.map((fullPath) => {
    const idPath = path.relative(PACKAGES_ROOT, fullPath).split(path.sep).join('/');
    const packageDir = idPath.split('/')[0];
    const relativePath = idPath.slice(packageDir.length + 1);
    return { id: idPath, packageDir, relativePath, fullPath };
  });
  databases.sort((a, b) => a.packageDir.localeCompare(b.packageDir) || a.relativePath.localeCompare(b.relativePath));
  return databases;
}

function getCachedScan(force) {
  if (!force && cache && Date.now() < cache.expiresAt) return cache;
  const databases = scanDatabases();
  cache = { databases, scannedAt: new Date().toISOString(), expiresAt: Date.now() + CACHE_TTL_MS };
  return cache;
}

// Safe identifier quoting for interpolating a table/index name into a
// PRAGMA statement -- PRAGMAs don't accept bound (?) parameters for their
// own argument in SQLite, so this can't just use a prepared-statement
// placeholder the way every real query on this dashboard otherwise does.
// Real injection risk here is minimal regardless (table/index names come
// from sqlite_master itself, not from request input -- see getSchema()
// below), but quoting properly (doubling any embedded ") is correct
// practice and costs nothing.
function quoteIdent(name) {
  return `"${name.replace(/"/g, '""')}"`;
}

// Everything PRAGMA table_info/foreign_key_list/index_list/index_info
// expose, structure only -- never a SELECT against the table's own rows,
// by request ("never query table data"). Opens and closes its own
// read-only connection per call rather than keeping one open -- by
// request, schema results are never cached, so there's no long-lived
// handle worth holding onto between requests the way every other db.js
// on this dashboard holds its own single persistent connection.
function getSchema(fullPath) {
  const db = new DatabaseSync(fullPath, { readOnly: true });
  try {
    const tableRows = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const tables = tableRows.map((t) => {
      const columns = db.prepare(`PRAGMA table_info(${quoteIdent(t.name)})`).all();
      const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${quoteIdent(t.name)})`).all();
      const indexList = db.prepare(`PRAGMA index_list(${quoteIdent(t.name)})`).all();
      const indexes = indexList.map((idx) => ({
        name: idx.name,
        unique: !!idx.unique,
        origin: idx.origin,
        partial: !!idx.partial,
        columns: db
          .prepare(`PRAGMA index_info(${quoteIdent(idx.name)})`)
          .all()
          .map((c) => c.name),
      }));
      return {
        name: t.name,
        sql: t.sql,
        columns: columns.map((c) => ({ name: c.name, type: c.type, notNull: !!c.notnull, defaultValue: c.dflt_value, primaryKey: c.pk > 0 })),
        foreignKeys: foreignKeys.map((fk) => ({ table: fk.table, from: fk.from, to: fk.to, onUpdate: fk.on_update, onDelete: fk.on_delete })),
        indexes,
      };
    });
    const viewRows = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'view' ORDER BY name").all();
    return { tables, views: viewRows.map((v) => ({ name: v.name, sql: v.sql })) };
  } finally {
    db.close();
  }
}

// Capped regardless of what the client asks for -- by request ("a Show
// Data button for each table"), this is the one real exception to the
// original "never query table data" rule, so it gets its own hard
// ceiling rather than trusting a client-supplied limit outright.
const MAX_ROW_LIMIT = 500;
const DEFAULT_ROW_LIMIT = 100;

// `tableName` is checked against this database's OWN real table list
// (fresh off sqlite_master, not the request) before it's ever
// interpolated into SQL -- same "never trust a name straight off the
// request" reasoning the schema route's own `id` validation already
// follows, just one level deeper (which table within an already-
// validated database). Still read-only; still never writes -- this is
// real row data now, but the connection itself is exactly as locked down
// as every other read in this file.
function getTableRows(fullPath, tableName, limit) {
  const db = new DatabaseSync(fullPath, { readOnly: true });
  try {
    const realTables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((t) => t.name);
    if (!realTables.includes(tableName)) throw new Error(`No such table: ${tableName}`);
    const cappedLimit = Math.min(Math.max(1, Number(limit) || DEFAULT_ROW_LIMIT), MAX_ROW_LIMIT);
    const rows = db.prepare(`SELECT * FROM ${quoteIdent(tableName)} LIMIT ?`).all(cappedLimit);
    const { count: totalCount } = db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdent(tableName)}`).get();
    return { rows, totalCount, limit: cappedLimit };
  } finally {
    db.close();
  }
}

module.exports = { PACKAGES_ROOT, scanDatabases, getCachedScan, getSchema, getTableRows };
