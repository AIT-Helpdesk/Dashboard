// Entrypoint for Windows Task Scheduler (see README) -- loaded standalone,
// nothing else loads the root .env first the way the dashboard's own
// server process already does. Run once, exit; no in-process timer.
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });

const { runFullPull } = require('./job');
const { writeLastRunStatus } = require('./status');

runFullPull()
  .then((report) => {
    console.log(`Morning Pulse: ${report.verdict}, ${report.plan.length} plan item(s), ${report.durationMs}ms`);
  })
  .catch((err) => {
    console.error('Morning Pulse run failed entirely:', err);
    // Same reasoning as strety-autotask-sync's own run.js -- a failed run
    // still has to overwrite last-run.json, or the dashboard page would
    // keep showing an arbitrarily old report as if it were current.
    try {
      writeLastRunStatus({ ranAt: new Date().toISOString(), success: false, fatalError: err.message });
    } catch {
      // best-effort
    }
    process.exitCode = 1;
  });
