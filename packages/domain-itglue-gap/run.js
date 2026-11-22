// Standalone entrypoint -- NOT an Express route. Can be run manually:
//   node packages/domain-itglue-gap/run.js [--dry-run]
// Also scheduled weekly via Windows Task Scheduler on production -- see
// DEPLOYMENT.md's own "Setting up the Domain / IT Glue Gaps weekly job"
// section for the real Register-ScheduledTask command.
//
// Loads the repo-root .env explicitly -- unlike running inside the
// dashboard's own server process (which already loads it), this script has
// nothing else to load it first. Same exact call every other standalone
// script in this repo uses (strety-autotask-sync/sync.js,
// contract-checks/sync.js).
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });

const { run } = require('./job');
const { writeLastRunStatus } = require('./status');
const { runId, logEvent, logFailure } = require('./log');

// No existing --dry-run/argv-parsing convention anywhere in this repo
// (confirmed) -- a plain argv check is enough for one flag.
const dryRun = process.argv.includes('--dry-run');

async function main() {
  logEvent({ stage: 'start', message: `Run starting${dryRun ? ' (DRY RUN -- nothing will be written to Autotask)' : ''}.` });
  const result = await run({ dryRun });

  if (dryRun) {
    console.log('\n--- DRY RUN RESULT (nothing written to Autotask) ---');
    console.log(JSON.stringify(
      {
        action: result.action,
        gapCount: result.gaps.length,
        unmatchedCount: result.unmatched.length,
        wrongClientCount: result.wrongClient.length,
        ticketNumber: result.ticket?.ticketNumber,
        dueDateTime: result.dueDateTime,
      },
      null,
      2
    ));
    if (result.body) {
      console.log('\n--- Ticket body that would be written ---\n' + result.body);
    }
    if (result.csv) {
      console.log('\n--- CSV that would be attached ---\n' + result.csv);
    }
  }

  logEvent({
    stage: 'end',
    message: `Run finished. Action: ${result.action}. ${result.gaps.length} gap(s), ${result.unmatched.length} unmatched, ${result.wrongClient.length} wrong-client.`,
    action: result.action,
    gapCount: result.gaps.length,
    unmatchedCount: result.unmatched.length,
    wrongClientCount: result.wrongClient.length,
  });
  writeLastRunStatus({
    runId,
    timestamp: new Date().toISOString(),
    ok: true,
    dryRun,
    action: result.action,
    gapCount: result.gaps.length,
    unmatchedCount: result.unmatched.length,
    wrongClientCount: result.wrongClient.length,
    ticketId: result.ticketId || result.ticket?.id || null,
    ticketNumber: result.ticket?.ticketNumber || null,
  });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logFailure('end', err, { dryRun, stopped: true });
    writeLastRunStatus({ runId, timestamp: new Date().toISOString(), ok: false, dryRun, error: err.message });
    process.exit(1);
  });
