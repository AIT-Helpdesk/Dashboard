// The result of the last run, persisted to disk -- same pattern
// @dashboard/strety-autotask-sync's and @dashboard/domain-itglue-gap's own
// status.js already established (copied, not imported -- a different
// package's own CJS internals). Here the "status" IS the report -- there's
// no separate live-queryable store (unlike domain-itglue-gap's db.js) --
// server.js's GET / just hands this file's contents straight back.
const fs = require('fs');
const path = require('path');

const STATUS_PATH = path.join(__dirname, 'last-run.json');

function readLastRunStatus() {
  try {
    return JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8'));
  } catch {
    return null; // never run yet, or unreadable
  }
}

function writeLastRunStatus(status) {
  fs.writeFileSync(STATUS_PATH, JSON.stringify(status, null, 2));
}

module.exports = { readLastRunStatus, writeLastRunStatus };
