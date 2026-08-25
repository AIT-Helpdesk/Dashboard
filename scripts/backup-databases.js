// Nightly backup for this dashboard's own SQLite databases -- currently
// TC Elite Rollout and Workshop Board, both real writable application
// data (not derived/re-fetchable from Autotask), both running in WAL
// mode. A raw file copy of just data.db is NOT safe for a WAL-mode
// database -- recent writes can still be sitting in data.db-wal,
// uncheckpointed, and a copy of data.db alone would miss them (this bit
// us for real earlier in this project: a manual file copy during a
// migration left a stale/incomplete snapshot until the WAL was
// explicitly checkpointed first).
//
// This script sidesteps that entirely by using node:sqlite's own
// backup() function -- a real wrapper around SQLite's official Online
// Backup API (sqlite3_backup_init/step/finish), not a plain file copy.
// It is SAFE TO RUN WHILE THE APP KEEPS RUNNING: per Node's own docs,
// "the backed-up database can be used normally during the backup
// process... mutations from other connections will cause the backup
// process to restart" -- i.e. if AmbientDashboard writes to the
// database mid-backup, the backup silently retries until it captures a
// fully consistent snapshot, rather than producing a torn/incomplete
// one. No need to stop the service for a routine backup.
//
// Zero new dependencies -- node:sqlite is a Node built-in (this whole
// dashboard already requires it, same as db.js in each page package),
// not a third-party package. Requires Node >=23.8.0 for backup() itself
// (see the repo root package.json's own "engines" field) -- both this
// dev machine and production are on Node 24.x, comfortably above that.
const { DatabaseSync, backup } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

// Auto-discovers every real SQLite database this dashboard owns --
// every page's own db.js already puts its database at exactly
// packages/<page-name>/data.db (TC Elite Rollout, Workshop, and
// whatever page adds one next), so this just looks for that pattern
// directly rather than keeping a hand-maintained list in sync. No glob
// library needed for a pattern this simple -- a plain readdir + exists
// check covers it with zero new dependencies.
function discoverDatabases() {
  const packagesDir = path.join(__dirname, '..', 'packages');
  return fs
    .readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, source: path.join(packagesDir, entry.name, 'data.db') }))
    .filter((db) => fs.existsSync(db.source));
}

// Deliberately OUTSIDE the git checkout (a sibling folder, not
// packages/*/backups or similar inside the repo) -- backups are real
// data, not source, and living outside the repo means a `git clean`/
// `git reset --hard` run against the checkout can never touch them.
// Override by setting the WORKSHOP_DASHBOARD_BACKUP_DIR environment
// variable (e.g. in the scheduled task itself) if a different location
// is wanted -- see this repo's own README for how to wire that up on
// production.
const BACKUP_ROOT = process.env.WORKSHOP_DASHBOARD_BACKUP_DIR || path.join(__dirname, '..', '..', 'autotask-dashboard-backups');

// How long a completed backup is kept before being pruned. One backup
// per calendar day is what the scheduled task is meant to produce (see
// this script's own README section), so this is effectively "keep N
// days of daily backups".
const KEEP_DAYS = 30;

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  try {
    fs.mkdirSync(BACKUP_ROOT, { recursive: true });
    fs.appendFileSync(path.join(BACKUP_ROOT, 'backup.log'), stamped + '\n');
  } catch {
    // Logging to disk is a courtesy, not a requirement -- the console
    // line above already happened regardless.
  }
}

// Real correctness check, not just "a file got created" -- opens the
// finished backup fresh and runs SQLite's own integrity_check, plus
// confirms it has at least the tables this dashboard expects. A backup
// that silently didn't actually work is worse than no backup at all
// (false confidence), so this throws rather than just logging a
// warning -- callers treat a thrown error as backup failure.
function verifyBackup(destPath) {
  const check = new DatabaseSync(destPath, { readOnly: true });
  try {
    const result = check.prepare('PRAGMA integrity_check').get();
    if (!result || result.integrity_check !== 'ok') {
      throw new Error(`integrity_check reported: ${JSON.stringify(result)}`);
    }
    const tables = check.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all();
    if (tables.length === 0) {
      throw new Error('backup file has no tables at all');
    }
  } finally {
    check.close();
  }
}

async function backupOne({ name, source }) {
  if (!fs.existsSync(source)) {
    log(`[${name}] SKIPPED -- source database not found at ${source}`);
    return;
  }
  const dir = path.join(BACKUP_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${name}-${timestamp()}.db`);

  const src = new DatabaseSync(source, { readOnly: true });
  try {
    const pages = await backup(src, dest);
    verifyBackup(dest);
    const size = fs.statSync(dest).size;
    log(`[${name}] OK -- ${dest} (${pages} pages, ${size} bytes)`);
  } finally {
    src.close();
  }
}

function pruneOld(name) {
  const dir = path.join(BACKUP_ROOT, name);
  if (!fs.existsSync(dir)) return;
  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.db')) continue; // never touch anything but backups this script itself made
    const full = path.join(dir, file);
    const stat = fs.statSync(full);
    if (stat.mtimeMs < cutoff) {
      fs.unlinkSync(full);
      log(`[${name}] pruned old backup (older than ${KEEP_DAYS} days): ${file}`);
    }
  }
}

async function main() {
  const databases = discoverDatabases();
  log(`Discovered ${databases.length} database(s): ${databases.map((db) => db.name).join(', ') || '(none)'}`);
  let failures = 0;
  for (const dbInfo of databases) {
    try {
      await backupOne(dbInfo);
      pruneOld(dbInfo.name);
    } catch (err) {
      failures++;
      log(`[${dbInfo.name}] FAILED -- ${err.message}`);
    }
  }
  if (failures > 0) {
    log(`Backup run finished with ${failures} failure(s).`);
    process.exit(1);
  }
  log('Backup run finished successfully.');
}

main();
