// The result of the last sync.js run, persisted to disk so something else
// (What's On, currently) can report on it WITHOUT making a live Strety API
// call itself -- a plain file read is enough to answer "did the last run
// succeed, and how long ago was that", and doesn't cost this page one more
// request against a rate limit already worth being careful with (see
// @dashboard/strety-client's README, "Rate limiting"). Not a real
// credential (no tokens in it), but still runtime-generated state, not
// checked in -- see .gitignore.
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
