// Run once per invocation: for every metric in metrics.js, count the real
// Autotask tickets that match its criteria and write a Strety check-in with
// that count. Meant to be triggered periodically by an external scheduler
// (Windows Task Scheduler on the production box -- see this package's
// README) -- there is no in-process timer/cron here, deliberately, so a
// hung or crashing run can't affect anything else and vice versa.
//
// One metric's failure does NOT stop the others -- each is attempted
// independently and its own success/failure is logged clearly. The process
// exits non-zero if ANY metric failed, so an external scheduler/monitor can
// detect a bad run even though partial progress was still made.
//
// Autotask access reuses the dashboard's own shared root .env (this
// package's own README explains why -- read-only ticket counting is lower
// risk than the Strety write access this package exists to isolate).
// Loaded HERE, explicitly, before requiring @dashboard/autotask-client --
// unlike when this runs inside the dashboard's own server process (which
// already loads the root .env at its own entry point), this script runs
// standalone with nothing else to load it first. require('./client.js')
// below separately loads THIS package's own .env for the Strety side.
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });

const { getClient, listAll } = require('@dashboard/autotask-client');
const stretyClient = require('./client.js');
const { METRICS } = require('./metrics.js');
const { writeLastRunStatus } = require('./status.js');

// Same AEST-anchoring convention as every other date-scoped page on this
// dashboard (see What's On's README) -- "today" for a daily check-in.
function todayAestKey() {
  return new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// Metrics are matched by TEAM + TITLE (a "NOT READY:" prefix, if still
// present, is stripped before comparing -- see metrics.js), not a
// hardcoded id. Zero or more-than-one match is a hard error for that
// metric, not a guess -- this is a write, and writing to the wrong record
// (or silently writing to nothing) is worse than a loud failure.
const NOT_READY_PREFIX = /^not ready\s*:\s*/i;
function findRealMetric(allMetrics, allTeams, config) {
  const team = allTeams.find((t) => t.attributes.name === config.team);
  if (!team) {
    throw new Error(`Team "${config.team}" not found in Strety.`);
  }
  const matches = allMetrics.filter(
    (m) =>
      m.relationships?.space?.data?.type === 'team' &&
      m.relationships.space.data.id === team.id &&
      m.attributes.title.replace(NOT_READY_PREFIX, '').trim() === config.title
  );
  if (matches.length === 0) {
    throw new Error(`No metric titled "${config.title}" (or "NOT READY: ${config.title}") found under team "${config.team}".`);
  }
  if (matches.length > 1) {
    throw new Error(`${matches.length} metrics titled "${config.title}" found under team "${config.team}" -- expected exactly one.`);
  }
  return matches[0];
}

// Confirmed against the real API: Strety enforces ONE check-in per metric
// per period -- a second POST for a period that already has one (e.g. a
// second run the same day, for a daily metric) gets a real `409 CONFLICT`,
// "Fetch and update it if needed", with the existing check-in's id handed
// back directly in the error body (`meta.existing_check_in.id`). So this
// isn't optional "nice to have" upsert logic -- without it, every run after
// the first one for a given period would simply fail outright. On a 409,
// PATCH that existing check-in instead of creating a new one.
async function createOrUpdateCheckIn(metricId, attributes) {
  try {
    return await stretyClient.post(`/metrics/${metricId}/check_ins`, {
      data: { type: 'metric_check_in', attributes },
    });
  } catch (err) {
    if (err.response?.status !== 409) throw err;
    const existingId = err.response.data?.errors?.[0]?.meta?.existing_check_in?.id;
    if (!existingId) throw err; // Strety's own error shape changed/unexpected -- don't guess, surface the real error.
    return await stretyClient.patch(`/metrics/${metricId}/check_ins/${existingId}`, {
      data: { type: 'metric_check_in', attributes },
    });
  }
}

async function main() {
  const autotaskClient = await getClient();
  const [allTeams, allMetrics] = [
    await stretyClient.fetchAllPages('/teams', {}),
    await stretyClient.fetchAllPages('/metrics', {}),
  ];

  const today = todayAestKey();
  const results = [];

  for (const config of METRICS) {
    try {
      const metric = findRealMetric(allMetrics, allTeams, config);
      const value = await config.countTickets({ listAll, client: autotaskClient });
      await createOrUpdateCheckIn(metric.id, { value, context: config.contextNote, date: today });
      console.log(`[OK] ${config.title}: ${value}`);
      results.push({ title: config.title, ok: true, value });
    } catch (err) {
      const detail = err.response ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
      console.error(`[FAILED] ${config.title}: ${detail}`);
      results.push({ title: config.title, ok: false, detail });
    }
  }

  const failed = results.filter((r) => !r.ok);
  // Written even on partial failure -- What's On (see status.js) reports
  // on the LAST run's real outcome, not just "did it complete", so a run
  // where 3 of 4 metrics succeeded still needs this to reflect the one
  // that didn't.
  writeLastRunStatus({ ranAt: new Date().toISOString(), success: failed.length === 0, results });
  if (failed.length > 0) {
    console.error(`\n${failed.length}/${results.length} metric(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log(`\nAll ${results.length} metric(s) updated successfully.`);
  }
}

main().catch((err) => {
  console.error('Sync run failed entirely:', err);
  // A TOTAL failure (e.g. Autotask/Strety unreachable before any metric was
  // even attempted) still needs recording -- otherwise What's On would keep
  // reporting whatever the last PARTIAL run's status.js said, which could
  // be an arbitrarily long time ago and no longer true.
  try {
    writeLastRunStatus({ ranAt: new Date().toISOString(), success: false, results: [], fatalError: err.message });
  } catch {
    // Best-effort -- if even this fails, the exit code below is still set.
  }
  process.exitCode = 1;
});
