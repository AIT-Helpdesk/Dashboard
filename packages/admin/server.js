const express = require('express');
const { execFile } = require('child_process');
const { getClient, getUserDefinedFieldDefinitions } = require('@dashboard/autotask-client');
const { listUdfSystemMatches } = require('@dashboard/shell/udf-system-matches-db.js');

// Scoped to this dashboard's own scheduled jobs only (the "Ambient*" naming
// convention every Register-ScheduledTask call in DEPLOYMENT.md already
// follows), not literally every Windows Scheduled Task on the box (a real
// dev/production machine has 100+ unrelated ones -- confirmed live, 205 on
// this one) -- this page is for operating the dashboard's own automation,
// not auditing the whole OS.
const TASK_NAME_PATTERN = 'Ambient*';

// Windows PowerShell's own ConvertTo-Json date convention
// ("/Date(1234567890000)/" -- a WCF-era serialization quirk, confirmed
// live against a real scheduled task's own LastRunTime/NextRunTime), not
// ISO -- parsed here rather than asking PowerShell for an ISO string
// directly.
function parseWcfDate(value) {
  if (typeof value !== 'string') return null;
  const m = /\/Date\((-?\d+)\)\//.exec(value);
  if (!m) return null;
  const ms = Number(m[1]);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString();
}

// Sunday=1, Monday=2, Tuesday=4, Wednesday=8, Thursday=16, Friday=32,
// Saturday=64 -- Task Scheduler's own DaysOfWeek bitmask, confirmed live
// against a real Weekly trigger (127 = every day).
const DAY_BITS = [
  [1, 'Sunday'],
  [2, 'Monday'],
  [4, 'Tuesday'],
  [8, 'Wednesday'],
  [16, 'Thursday'],
  [32, 'Friday'],
  [64, 'Saturday'],
];
function daysOfWeekLabel(bitmask) {
  if (!bitmask) return null;
  const days = DAY_BITS.filter(([bit]) => bitmask & bit).map(([, name]) => name);
  return days.length === 7 ? 'Every day' : days.join(', ');
}

// "PT30M"/"PT5H"/"P1D" -- ISO 8601 duration, Task Scheduler's own
// Repetition.Interval/.Duration shape, confirmed live against this
// dashboard's own Strety sync task. Only the units this dashboard's own
// jobs actually use (days/hours/minutes) are decoded; anything else falls
// back to the raw ISO string rather than guessing.
function formatIsoDuration(iso) {
  if (!iso) return null;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(iso);
  if (!m) return iso;
  const [, days, hours, minutes] = m;
  const parts = [];
  if (days) parts.push(`${days} day${days === '1' ? '' : 's'}`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes} min`);
  return parts.length > 0 ? parts.join(' ') : iso;
}

// startBoundary is a plain LOCAL "YYYY-MM-DDTHH:mm:ss" with no timezone --
// only the clock-TIME portion is ever meaningful for a recurring trigger
// (the date portion is just whenever the task was first registered),
// confirmed live against several real Daily/Weekly triggers.
function formatClockTime(startBoundary) {
  if (!startBoundary) return null;
  const m = /T(\d{2}):(\d{2})/.exec(startBoundary);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = m[2];
  const period = hour >= 12 ? 'PM' : 'AM';
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${minute} ${period}`;
}

const TRIGGER_TYPE_LABELS = {
  MSFT_TaskLogonTrigger: 'At logon',
  MSFT_TaskBootTrigger: 'At startup',
  MSFT_TaskIdleTrigger: 'When idle',
  MSFT_TaskTimeTrigger: 'One time',
  MSFT_TaskEventTrigger: 'On an event',
  MSFT_TaskSessionStateChangeTrigger: 'On session state change',
};

// Every real schedule this dashboard's own jobs actually use is Weekly or
// Daily (see DEPLOYMENT.md) -- those two get a real human-readable
// description; anything else (logon/boot/idle/etc.) falls back to a
// plain label rather than guessing a format for a case that doesn't
// exist yet.
function describeTrigger(t) {
  if (t.type === 'MSFT_TaskWeeklyTrigger') {
    const days = daysOfWeekLabel(t.daysOfWeek) || 'Weekly';
    const time = formatClockTime(t.startBoundary);
    return `${days}${time ? `, ${time}` : ''}`;
  }
  if (t.type === 'MSFT_TaskDailyTrigger') {
    const time = formatClockTime(t.startBoundary);
    const base = `Daily${time ? ` at ${time}` : ''}`;
    if (t.repetitionInterval) {
      const every = formatIsoDuration(t.repetitionInterval);
      const forDuration = formatIsoDuration(t.repetitionDuration);
      return `${base}, every ${every}${forDuration ? ` for ${forDuration}` : ''}`;
    }
    return base;
  }
  return TRIGGER_TYPE_LABELS[t.type] || t.type;
}

// One PowerShell call, not schtasks /query's own plain-text table --
// Get-ScheduledTask's own structured trigger objects are what makes a
// real Weekly-vs-Daily-vs-repetition schedule decodable at all (confirmed
// live: schtasks' own table output just prints "Weekly"/"Daily" with no
// day/time/repetition detail). Triggers are projected down to plain
// fields BEFORE ConvertTo-Json -- the raw CIM trigger object serializes
// as a huge class-metadata dump otherwise, confirmed live.
//
// The WHOLE pipeline is collected into $results via @(...) and THEN
// passed to ConvertTo-Json via -InputObject (not piped) -- confirmed
// live this is the only way that survives a 0-or-1-match result as a
// real JSON array: piping a single object (or nothing) into
// ConvertTo-Json silently unwraps it to a bare object (or empty string),
// even with @(...) around the piped expression. -InputObject is immune
// to that unwrapping.
const QUERY_SCRIPT = `
$results = @(Get-ScheduledTask -TaskName '${TASK_NAME_PATTERN}' | ForEach-Object {
  $task = $_
  $info = Get-ScheduledTaskInfo -InputObject $task
  $triggers = @($task.Triggers | ForEach-Object {
    [PSCustomObject]@{
      type = $_.CimClass.CimClassName
      startBoundary = $_.StartBoundary
      daysOfWeek = $_.DaysOfWeek
      repetitionInterval = $_.Repetition.Interval
      repetitionDuration = $_.Repetition.Duration
    }
  })
  [PSCustomObject]@{
    name = $task.TaskName
    state = $task.State.ToString()
    description = $task.Description
    lastRunTime = $info.LastRunTime
    lastTaskResult = $info.LastTaskResult
    nextRunTime = $info.NextRunTime
    triggers = $triggers
  }
})
ConvertTo-Json -InputObject $results -Depth 6
`.trim();

function queryScheduledTasks() {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', QUERY_SCRIPT],
      { timeout: 15000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr?.trim() || err.message));
        const trimmed = (stdout || '').trim();
        if (!trimmed) return resolve([]);
        try {
          const parsed = JSON.parse(trimmed);
          resolve(Array.isArray(parsed) ? parsed : [parsed]);
        } catch (parseErr) {
          reject(new Error(`Failed to parse scheduled task data: ${parseErr.message}`));
        }
      }
    );
  });
}

async function buildScheduledTasksTab() {
  const raw = await queryScheduledTasks();
  const rows = raw
    .map((t) => ({
      name: t.name,
      state: t.state,
      description: t.description || null,
      schedule: (t.triggers || []).map(describeTrigger).join('; ') || 'No triggers',
      lastRunTime: parseWcfDate(t.lastRunTime),
      lastTaskResult: t.lastTaskResult,
      nextRunTime: parseWcfDate(t.nextRunTime),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { key: 'scheduled-tasks', label: 'Scheduled Tasks', rows };
}

// "UDF Name Mapping" tab, by request -- the real Companies UDFs this
// dashboard uses to cross-reference a Client's identity in another
// system (e.g. "Name:TPP" holding TPP Wholesale's own account reference
// code). The AUTHORITATIVE list already lives in code, not just
// discovered here fresh: @dashboard/shell/udf-system-matches-db.js's own
// SEED_ROWS, a hand-maintained reference table that ALSO records what
// each UDF's value actually holds and which page reads/writes it --
// confirmed live against the real account when that file was written
// ("these 5 are the complete current list"). This tab shows those 5
// documented rows, AND cross-checks them against a fresh live pull of
// every real "Name:*" UDF currently defined on Companies (same
// `getUserDefinedFieldDefinitions(client.companies)` call
// @dashboard/data-matching's own GET /other-udf-concepts already uses
// for the identical purpose) -- any live one NOT in the documented set
// is flagged, since that means a new UDF was added by hand in Autotask
// and udf-system-matches-db.js's own SEED_ROWS needs a new entry, per
// that file's own comment.
async function buildUdfNameMappingTab() {
  const documented = listUdfSystemMatches();
  const documentedNames = new Set(documented.map((r) => r.udf_name));

  const client = await getClient();
  const fields = await getUserDefinedFieldDefinitions(client.companies);
  const undocumented = fields
    .filter((f) => /^Name:/i.test(f.name) && !documentedNames.has(f.name))
    .map((f) => ({ udfName: f.name, documented: false }));

  const rows = [
    ...documented.map((r) => ({
      udfName: r.udf_name,
      systemLabel: r.system_label,
      matchesField: r.matches_field,
      notes: r.notes,
      documented: true,
    })),
    ...undocumented,
  ].sort((a, b) => a.udfName.localeCompare(b.udfName));

  return { key: 'udf-name-mapping', label: 'UDF Name Mapping', rows };
}

// Tabs array, same shape @dashboard/tc-elite-services' own GET / uses --
// built this way so a later admin tab is just one more entry here, not a
// page restructure.
const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const [scheduledTasksTab, udfNameMappingTab] = await Promise.all([buildScheduledTasksTab(), buildUdfNameMappingTab()]);
    res.json({ asOf: new Date().toISOString(), tabs: [scheduledTasksTab, udfNameMappingTab] });
  } catch (err) {
    console.error('admin: failed to build a tab:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
