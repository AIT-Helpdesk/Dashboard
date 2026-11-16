// The result of the last run, persisted to disk -- same pattern
// @dashboard/strety-autotask-sync's own status.js already established
// (copied, not imported -- a different package's own CJS internals), so
// something else (a future Dashboard page, matching the brief's own
// "Failure log for the Dashboard" section) can report "did the last run
// succeed, and how long ago was that" without re-running the job. Not a
// real credential -- runtime-generated state, not checked in.
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
