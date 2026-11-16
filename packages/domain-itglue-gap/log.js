// One structured JSON-Lines line per event, per the brief's own "Failure log
// for the Dashboard" section -- same plain fs.appendFileSync + JSON.stringify
// shape @dashboard/report/server.js's own appendAudit() and
// @dashboard/contract-services/server.js's own JSONL writer already use, no
// new logging library. Never committed (see .gitignore) -- runtime-generated
// state, same as status.js's own last-run.json.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOG_PATH = path.join(__dirname, 'run-log.jsonl');
const JOB_NAME = 'domain-itglue-gap';
const runId = crypto.randomUUID();

function writeLogLine(fields) {
  const entry = { timestamp: new Date().toISOString(), job: JOB_NAME, runId, ...fields };
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`);
  } catch (err) {
    // A logging failure must never stop the actual job -- surfaced on the
    // console only, same reasoning report/server.js's own appendAudit() uses.
    console.error('domain-itglue-gap: failed to write log line:', err.message);
  }
}

// `stage` is one of: tpp-pull, itglue-pull, comparison, autotask-search,
// ticket-create, ticket-update, csv-attach -- per the brief's own list.
function logEvent({ stage, severity = 'info', message, ...rest }) {
  writeLogLine({ stage, severity, message, ...rest });
  const line = `[${stage}] ${message}`;
  if (severity === 'error') console.error(line);
  else console.log(line);
}

// Never pass API keys, tokens, or request headers in `details` -- per the
// brief's own explicit instruction.
function logFailure(stage, error, details = {}) {
  logEvent({
    stage,
    severity: 'error',
    message: error.message,
    errorType: error.name || 'Error',
    httpStatus: error.response?.status ?? null,
    endpoint: error.config?.url ?? details.endpoint ?? null,
    ...details,
  });
}

module.exports = { runId, logEvent, logFailure };
