// Workshop Board's own persistent data -- the second page on this
// dashboard with real, writable application data of its own (the first
// being TC Elite Rollout, whose db.js this closely mirrors). Replaces a
// physical whiteboard: one row per workshop job, with colour-coded
// "magnets" (priority) and "pen colours" (the action-text note) -- see
// this package's own README for the full mockup-to-schema mapping.
//
// Uses node's own built-in `node:sqlite` (DatabaseSync), not a
// third-party package -- same reasoning as TC Elite Rollout: zero new
// runtime dependencies, no native-binary-on-Windows risk. Needs Node
// >=22.5 (confirmed working on this machine, Node v24.18.0).
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.db');
const db = new DatabaseSync(DB_PATH);

// WAL, not the default rollback journal -- multiple staff in the
// workshop editing around the same time is the whole point of this
// page, same reasoning as TC Elite Rollout.
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// Idempotent -- CREATE TABLE IF NOT EXISTS, no separate migration
// framework for this first version (same convention as TC Elite
// Rollout's original build -- a real migration only gets added if/when
// the schema actually needs to change under already-live data).
db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY,
    reqd_by TEXT,
    ticket_number TEXT,
    ticket_autotask_id INTEGER,
    customer TEXT,
    job_description TEXT,
    action_text TEXT,
    -- Note colour (pen) -- Black/Red/Blue/Green in the UI (see
    -- ACTION_COLOR_LABELS in client.js), by request. The stored values
    -- themselves keep their original names (general/done/notewell) for
    -- the two pre-existing ones plus a new 'blue' -- only the DISPLAY
    -- labels changed to plain colour names; see
    -- migrateAddBlueActionColor() below for how 'blue' was added to an
    -- already-live CHECK constraint.
    action_color TEXT NOT NULL DEFAULT 'general' CHECK (action_color IN ('general','done','notewell','blue')),
    location TEXT,
    -- Urgent/Complete/Nearly Complete/In Progress/Next Up/Coming/Not
    -- Started, by request -- a status-progression scheme replacing the
    -- original time-urgency one (Today/Tomorrow/2-4 days/Over 4 days).
    -- See migrateRetierPriorityToStatusStyle()/migrateAddComingPriority()
    -- below for how the live data was remapped/widened. Still a
    -- manually-chosen magnet, not computed from a ticket's due date --
    -- plenty of jobs have no linked ticket at all, so priority has to
    -- stay settable on its own. Defaults to 'not_started' -- a fitting
    -- "nothing to highlight yet" default.
    priority TEXT NOT NULL DEFAULT 'not_started' CHECK (priority IN ('urgent','complete','nearly_complete','in_progress','next_up','coming','not_started')),
    -- Workshop's own workflow stage -- named workflow_stage, not
    -- status_stage/status2, to stay clearly distinct from the plain
    -- 'status' column below (open/completed, the archive mechanism --
    -- see completeJob()).
    -- Completing a job is still its own explicit action (the Mark
    -- Complete tick) regardless of this value, by request -- reaching
    -- "Collected" here doesn't auto-complete/archive the job.
    -- 'free_text' (was 'date_reqd') pairs with workflow_stage_text below
    -- -- by request, lets staff type anything instead of being limited
    -- to the fixed list. Also what a "deleted" job's status gets set to
    -- (text "Deleted") when the trash icon is used -- see deleteJob()'s
    -- own comment below for why that's a soft delete now, not a hard one.
    -- 'in_car' is the same idea, but as its own distinct stage rather
    -- than the generic free-text one -- workflow_stage_text holds WHOSE
    -- car, by request (see TEXT_ENABLED_STAGES in client.js, which now
    -- covers both 'free_text' and 'in_car').
    -- 'take_onsite' is the same idea again -- workflow_stage_text holds
    -- WHO took it onsite, by request. See
    -- migrateAddTakeOnsiteStage() below for how it was added to an
    -- already-live CHECK constraint.
    -- 'delivered' is new too -- Sent/Delivered/Collected are three
    -- distinct real-world endings (courier dispatched vs. courier
    -- confirmed arrived vs. customer picked up in person), by request.
    -- 'dispose' has no companion free text (unlike in_car/take_onsite)
    -- -- jobs in this stage get their own separate table below the
    -- priority legend on the client, by request, see client.js's own
    -- renderResults(). See migrateAddDisposeStage() below for how it
    -- was added to an already-live CHECK constraint.
    workflow_stage TEXT NOT NULL DEFAULT 'new' CHECK (workflow_stage IN ('new','free_text','in_car','take_onsite','ready_to_ship','ready_for_pickup','sent','delivered','collected','dispose')),
    workflow_stage_text TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed')),
    completed_at TEXT,
    completed_by_email TEXT,
    completed_by_name TEXT,
    created_at TEXT NOT NULL,
    created_by_email TEXT NOT NULL,
    created_by_name TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by_email TEXT NOT NULL,
    updated_by_name TEXT NOT NULL
  );

  -- Append-only history -- every field change writes a row here, same
  -- "this is the real reason it beats a whiteboard/spreadsheet" reasoning
  -- as TC Elite Rollout's own audit_log. One row per CHANGED field (not
  -- one lumped "job updated" entry), so the history view reads like a
  -- real changelog.
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY,
    job_id INTEGER NOT NULL REFERENCES jobs(id),
    changed_at TEXT NOT NULL,
    changed_by_email TEXT NOT NULL,
    changed_by_name TEXT NOT NULL,
    field TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_audit_job ON audit_log(job_id, changed_at);
`);

// One real migration, run every startup but a no-op after the first
// time -- CREATE TABLE IF NOT EXISTS above doesn't touch an
// already-existing table's columns, so adding job_description to the
// live data.db needed an actual schema change. Unlike TC Elite
// Rollout's status-enum migrations, this one's just a plain nullable
// column with no CHECK constraint -- SQLite's ALTER TABLE ADD COLUMN
// handles that directly, no recreate-table-and-copy dance needed.
// Guarded by checking the table's real current columns (pragma_table_info)
// rather than a separate migrations table.
function migrateAddJobDescription() {
  const columns = db.prepare(`SELECT name FROM pragma_table_info('jobs')`).all();
  if (columns.some((c) => c.name === 'job_description')) return;
  db.exec('ALTER TABLE jobs ADD COLUMN job_description TEXT');
}
migrateAddJobDescription();

// Same pattern, for workflow_stage replacing the old free-text Req'd By
// column in the UI (see FIELD_TO_COLUMN below -- reqd_by itself is left
// alone in the schema, not dropped, so any real historical value already
// entered there isn't destroyed, it's just no longer shown/editable).
// NOT NULL DEFAULT + CHECK on a brand-new column (nothing existing to
// violate it) is well within SQLite's real ADD COLUMN support -- unlike
// TC Elite Rollout's status-enum migrations, which had to widen a CHECK
// on a column that already held live data, this needed no recreate-
// table-and-copy dance.
function migrateAddWorkflowStage() {
  const columns = db.prepare(`SELECT name FROM pragma_table_info('jobs')`).all();
  if (columns.some((c) => c.name === 'workflow_stage')) return;
  db.exec(
    `ALTER TABLE jobs ADD COLUMN workflow_stage TEXT NOT NULL DEFAULT 'new' CHECK (workflow_stage IN ('new','date_reqd','ready_to_ship','ready_for_pickup','sent','collected'))`
  );
}
migrateAddWorkflowStage();

// This one DOES need the full recreate-table-and-copy dance (unlike the
// two ADD COLUMN migrations above) -- both priority and workflow_stage
// already had live data under their OLD CHECK constraints, which SQLite
// can't widen/change in place. Guarded on workflow_stage_text existing
// (a brand-new column only this migration adds), same
// pragma_table_info() idempotency check as the others.
//
// Data remapping, both real judgment calls (documented so they're easy
// to revisit if wrong), confirmed necessary by inspecting the real live
// data before writing this:
//   priority:        today -> today (unchanged); 2days -> 2to4days (2
//                     falls inside the new 2-4 day band); 3days_plus ->
//                     over4days (the old "3 or more, open-ended" tier
//                     maps most naturally onto the new open-ended top
//                     tier, even though a literal "3" is also inside
//                     2-4).
//   workflow_stage:   date_reqd -> free_text, with workflow_stage_text
//                     set to "Date Req'd" for exactly those rows -- so
//                     the old label's meaning isn't silently lost, just
//                     carried into the new free-text field instead of
//                     staying a fixed enum value. Every other value
//                     (new/ready_to_ship/ready_for_pickup/sent/collected)
//                     is unchanged.
//
// foreign_keys is turned off for the duration -- audit_log.job_id
// REFERENCES jobs(id), and dropping/recreating the table it references
// mid-transaction is the standard documented reason to do this for a
// SQLite recreate-table migration; turned back on immediately after.
function migrateRetierPriorityAndFreeTextStage() {
  const columns = db.prepare(`SELECT name FROM pragma_table_info('jobs')`).all();
  if (columns.some((c) => c.name === 'workflow_stage_text')) return;

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE jobs_new (
        id INTEGER PRIMARY KEY,
        reqd_by TEXT,
        ticket_number TEXT,
        ticket_autotask_id INTEGER,
        customer TEXT,
        job_description TEXT,
        action_text TEXT,
        action_color TEXT NOT NULL DEFAULT 'general' CHECK (action_color IN ('general','done','notewell')),
        location TEXT,
        priority TEXT NOT NULL DEFAULT '2to4days' CHECK (priority IN ('today','tomorrow','2to4days','over4days')),
        workflow_stage TEXT NOT NULL DEFAULT 'new' CHECK (workflow_stage IN ('new','free_text','ready_to_ship','ready_for_pickup','sent','collected')),
        workflow_stage_text TEXT,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed')),
        completed_at TEXT,
        completed_by_email TEXT,
        completed_by_name TEXT,
        created_at TEXT NOT NULL,
        created_by_email TEXT NOT NULL,
        created_by_name TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by_email TEXT NOT NULL,
        updated_by_name TEXT NOT NULL
      );
      INSERT INTO jobs_new (
        id, reqd_by, ticket_number, ticket_autotask_id, customer, job_description, action_text, action_color, location,
        priority, workflow_stage, workflow_stage_text,
        status, completed_at, completed_by_email, completed_by_name, created_at, created_by_email, created_by_name, updated_at, updated_by_email, updated_by_name
      )
      SELECT
        id, reqd_by, ticket_number, ticket_autotask_id, customer, job_description, action_text, action_color, location,
        CASE priority WHEN 'today' THEN 'today' WHEN '2days' THEN '2to4days' WHEN '3days_plus' THEN 'over4days' ELSE priority END,
        CASE workflow_stage WHEN 'date_reqd' THEN 'free_text' ELSE workflow_stage END,
        CASE WHEN workflow_stage = 'date_reqd' THEN 'Date Req''d' ELSE NULL END,
        status, completed_at, completed_by_email, completed_by_name, created_at, created_by_email, created_by_name, updated_at, updated_by_email, updated_by_name
      FROM jobs;
      DROP TABLE jobs;
      ALTER TABLE jobs_new RENAME TO jobs;
    `);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
migrateRetierPriorityAndFreeTextStage();

// Widens action_color's CHECK to also allow 'blue' (Note colour becomes
// a plain 4-way Black/Red/Blue/Green choice, see
// ACTION_COLOR_LABELS/ACTION_COLOR_ORDER in client.js) AND widens
// workflow_stage's CHECK to add 'in_car' and 'delivered' (see
// TEXT_ENABLED_STAGES/WORKFLOW_STAGE_LABELS in client.js) -- two
// unrelated columns, but both are "add a new allowed value to an
// already-live CHECK constraint", so both ride the same single
// recreate-table-and-copy pass rather than two separate ones. Every
// existing value on both columns keeps its original name/meaning --
// only new values were added, so no data remapping is needed, just a
// straight `SELECT *` copy. Idempotency is checked against the live
// table's own CREATE TABLE SQL (sqlite_master) rather than
// pragma_table_info(), since this migration adds no new column to guard
// on -- 'in_car' only ever appears in that SQL once this migration has
// run.
function migrateAddBlueColorAndNewStages() {
  const table = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jobs'`).get();
  if (table && table.sql && table.sql.includes("'in_car'")) return;

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE jobs_new (
        id INTEGER PRIMARY KEY,
        reqd_by TEXT,
        ticket_number TEXT,
        ticket_autotask_id INTEGER,
        customer TEXT,
        job_description TEXT,
        action_text TEXT,
        action_color TEXT NOT NULL DEFAULT 'general' CHECK (action_color IN ('general','done','notewell','blue')),
        location TEXT,
        priority TEXT NOT NULL DEFAULT '2to4days' CHECK (priority IN ('today','tomorrow','2to4days','over4days')),
        workflow_stage TEXT NOT NULL DEFAULT 'new' CHECK (workflow_stage IN ('new','free_text','in_car','ready_to_ship','ready_for_pickup','sent','delivered','collected')),
        workflow_stage_text TEXT,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed')),
        completed_at TEXT,
        completed_by_email TEXT,
        completed_by_name TEXT,
        created_at TEXT NOT NULL,
        created_by_email TEXT NOT NULL,
        created_by_name TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by_email TEXT NOT NULL,
        updated_by_name TEXT NOT NULL
      );
      INSERT INTO jobs_new SELECT * FROM jobs;
      DROP TABLE jobs;
      ALTER TABLE jobs_new RENAME TO jobs;
    `);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
migrateAddBlueColorAndNewStages();

// Replaces priority's entire tier scheme -- Today/Tomorrow/2-4 days/Over
// 4 days (time urgency) becomes Urgent/Complete/Nearly Complete/In
// Progress/Next Up/Not Started (completion progress), by request. Unlike
// the previous priority retiering, there's no clean semantic mapping
// between the two schemes -- they measure genuinely different things --
// so this is a best-effort default mapping (documented so it's easy to
// revisit), NOT a guarantee the result matches each job's real current
// state. Confirmed against real live data before writing this (6 real
// jobs, only today/tomorrow/2to4days/over4days actually in use):
//   today -> urgent, tomorrow -> in_progress, 2to4days -> next_up,
//   over4days -> not_started -- preserves relative ordering (most
//   urgent old tier -> most urgent-sounding new tier, and so on) as the
//   least-wrong available default. Staff should re-check/re-set
//   priority on existing jobs after this migration rather than trust it
//   blindly.
// Same recreate-table-and-copy dance as the other CHECK-widening
// migrations above (SQLite can't change an existing CHECK in place).
// Default also changes, '2to4days' -> 'not_started' -- see the CREATE
// TABLE comment above for why.
function migrateRetierPriorityToStatusStyle() {
  const table = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jobs'`).get();
  if (table && table.sql && table.sql.includes("'not_started'")) return;

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE jobs_new (
        id INTEGER PRIMARY KEY,
        reqd_by TEXT,
        ticket_number TEXT,
        ticket_autotask_id INTEGER,
        customer TEXT,
        job_description TEXT,
        action_text TEXT,
        action_color TEXT NOT NULL DEFAULT 'general' CHECK (action_color IN ('general','done','notewell','blue')),
        location TEXT,
        priority TEXT NOT NULL DEFAULT 'not_started' CHECK (priority IN ('urgent','complete','nearly_complete','in_progress','next_up','not_started')),
        workflow_stage TEXT NOT NULL DEFAULT 'new' CHECK (workflow_stage IN ('new','free_text','in_car','ready_to_ship','ready_for_pickup','sent','delivered','collected')),
        workflow_stage_text TEXT,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed')),
        completed_at TEXT,
        completed_by_email TEXT,
        completed_by_name TEXT,
        created_at TEXT NOT NULL,
        created_by_email TEXT NOT NULL,
        created_by_name TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by_email TEXT NOT NULL,
        updated_by_name TEXT NOT NULL
      );
      INSERT INTO jobs_new (
        id, reqd_by, ticket_number, ticket_autotask_id, customer, job_description, action_text, action_color, location,
        priority, workflow_stage, workflow_stage_text,
        status, completed_at, completed_by_email, completed_by_name, created_at, created_by_email, created_by_name, updated_at, updated_by_email, updated_by_name
      )
      SELECT
        id, reqd_by, ticket_number, ticket_autotask_id, customer, job_description, action_text, action_color, location,
        CASE priority
          WHEN 'today' THEN 'urgent'
          WHEN 'tomorrow' THEN 'in_progress'
          WHEN '2to4days' THEN 'next_up'
          WHEN 'over4days' THEN 'not_started'
          ELSE priority
        END,
        workflow_stage, workflow_stage_text,
        status, completed_at, completed_by_email, completed_by_name, created_at, created_by_email, created_by_name, updated_at, updated_by_email, updated_by_name
      FROM jobs;
      DROP TABLE jobs;
      ALTER TABLE jobs_new RENAME TO jobs;
    `);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
migrateRetierPriorityToStatusStyle();

// Widens priority's CHECK to also allow 'coming' (yellow -- "coming up
// but not next in line yet", between Next Up and Not Started), by
// request. Every existing value keeps its original name/meaning -- only
// 'coming' is new, so no data remapping is needed, just the same
// recreate-table-and-copy dance as the other CHECK-widening migrations
// (SQLite can't widen an existing CHECK in place). Idempotency is
// checked against the live table's own CREATE TABLE SQL, same as
// migrateAddBlueColorAndNewStages() above.
function migrateAddComingPriority() {
  const table = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jobs'`).get();
  if (table && table.sql && table.sql.includes("'coming'")) return;

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE jobs_new (
        id INTEGER PRIMARY KEY,
        reqd_by TEXT,
        ticket_number TEXT,
        ticket_autotask_id INTEGER,
        customer TEXT,
        job_description TEXT,
        action_text TEXT,
        action_color TEXT NOT NULL DEFAULT 'general' CHECK (action_color IN ('general','done','notewell','blue')),
        location TEXT,
        priority TEXT NOT NULL DEFAULT 'not_started' CHECK (priority IN ('urgent','complete','nearly_complete','in_progress','next_up','coming','not_started')),
        workflow_stage TEXT NOT NULL DEFAULT 'new' CHECK (workflow_stage IN ('new','free_text','in_car','ready_to_ship','ready_for_pickup','sent','delivered','collected')),
        workflow_stage_text TEXT,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed')),
        completed_at TEXT,
        completed_by_email TEXT,
        completed_by_name TEXT,
        created_at TEXT NOT NULL,
        created_by_email TEXT NOT NULL,
        created_by_name TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by_email TEXT NOT NULL,
        updated_by_name TEXT NOT NULL
      );
      INSERT INTO jobs_new SELECT * FROM jobs;
      DROP TABLE jobs;
      ALTER TABLE jobs_new RENAME TO jobs;
    `);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
migrateAddComingPriority();

// Widens workflow_stage's CHECK to also allow 'take_onsite' -- the same
// idea as 'in_car' (workflow_stage_text holds WHO took it onsite), by
// request. Every existing value keeps its original name/meaning -- only
// 'take_onsite' is new, so no data remapping is needed, just the same
// recreate-table-and-copy dance as the other CHECK-widening migrations
// (SQLite can't widen an existing CHECK in place).
function migrateAddTakeOnsiteStage() {
  const table = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jobs'`).get();
  if (table && table.sql && table.sql.includes("'take_onsite'")) return;

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE jobs_new (
        id INTEGER PRIMARY KEY,
        reqd_by TEXT,
        ticket_number TEXT,
        ticket_autotask_id INTEGER,
        customer TEXT,
        job_description TEXT,
        action_text TEXT,
        action_color TEXT NOT NULL DEFAULT 'general' CHECK (action_color IN ('general','done','notewell','blue')),
        location TEXT,
        priority TEXT NOT NULL DEFAULT 'not_started' CHECK (priority IN ('urgent','complete','nearly_complete','in_progress','next_up','coming','not_started')),
        workflow_stage TEXT NOT NULL DEFAULT 'new' CHECK (workflow_stage IN ('new','free_text','in_car','take_onsite','ready_to_ship','ready_for_pickup','sent','delivered','collected')),
        workflow_stage_text TEXT,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed')),
        completed_at TEXT,
        completed_by_email TEXT,
        completed_by_name TEXT,
        created_at TEXT NOT NULL,
        created_by_email TEXT NOT NULL,
        created_by_name TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by_email TEXT NOT NULL,
        updated_by_name TEXT NOT NULL
      );
      INSERT INTO jobs_new SELECT * FROM jobs;
      DROP TABLE jobs;
      ALTER TABLE jobs_new RENAME TO jobs;
    `);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
migrateAddTakeOnsiteStage();

// Widens workflow_stage's CHECK to also allow 'dispose' -- unlike
// 'in_car'/'take_onsite', this one has no companion free-text field
// (jobs in this stage instead get their own separate table on the
// client, see client.js's renderResults()). Every existing value keeps
// its original name/meaning -- only 'dispose' is new, so no data
// remapping is needed, just the same recreate-table-and-copy dance as
// the other CHECK-widening migrations.
function migrateAddDisposeStage() {
  const table = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jobs'`).get();
  if (table && table.sql && table.sql.includes("'dispose'")) return;

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE jobs_new (
        id INTEGER PRIMARY KEY,
        reqd_by TEXT,
        ticket_number TEXT,
        ticket_autotask_id INTEGER,
        customer TEXT,
        job_description TEXT,
        action_text TEXT,
        action_color TEXT NOT NULL DEFAULT 'general' CHECK (action_color IN ('general','done','notewell','blue')),
        location TEXT,
        priority TEXT NOT NULL DEFAULT 'not_started' CHECK (priority IN ('urgent','complete','nearly_complete','in_progress','next_up','coming','not_started')),
        workflow_stage TEXT NOT NULL DEFAULT 'new' CHECK (workflow_stage IN ('new','free_text','in_car','take_onsite','ready_to_ship','ready_for_pickup','sent','delivered','collected','dispose')),
        workflow_stage_text TEXT,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed')),
        completed_at TEXT,
        completed_by_email TEXT,
        completed_by_name TEXT,
        created_at TEXT NOT NULL,
        created_by_email TEXT NOT NULL,
        created_by_name TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by_email TEXT NOT NULL,
        updated_by_name TEXT NOT NULL
      );
      INSERT INTO jobs_new SELECT * FROM jobs;
      DROP TABLE jobs;
      ALTER TABLE jobs_new RENAME TO jobs;
    `);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
migrateAddDisposeStage();

function nowIso() {
  return new Date().toISOString();
}

// `actor` is always { email, name } -- req.session.user, same shape
// every other page on this dashboard already reads it (requireAuth
// guarantees a signed-in session before any route runs).
function recordAudit({ jobId, field, oldValue = null, newValue = null, actor }) {
  db.prepare(
    `INSERT INTO audit_log (job_id, changed_at, changed_by_email, changed_by_name, field, old_value, new_value)
     VALUES ($jobId, $changedAt, $email, $name, $field, $oldValue, $newValue)`
  ).run({
    $jobId: jobId,
    $changedAt: nowIso(),
    $email: actor.email,
    $name: actor.name,
    $field: field,
    $oldValue: oldValue === null || oldValue === undefined ? null : String(oldValue),
    $newValue: newValue === null || newValue === undefined ? null : String(newValue),
  });
}

// Open jobs -- returned in a simple, stable base order (creation order).
// The REAL default ordering (by linked ticket's due date, soonest
// first) happens in server.js, AFTER ticket details are resolved (see
// withTicketDetails() there) -- due dates live in Autotask, not this
// table, so they can't be part of a SQL ORDER BY here. Jobs with no due
// date (no ticket, or a ticket with none set) keep this creation-order
// position as their tiebreak/fallback.
function listOpenJobs() {
  return db.prepare(`SELECT * FROM jobs WHERE status = 'open' ORDER BY created_at ASC`).all();
}

// Completed jobs, most recently completed first -- the archive/history
// view behind client.js's "Show Completed" toggle.
function listCompletedJobs() {
  return db.prepare(`SELECT * FROM jobs WHERE status = 'completed' ORDER BY completed_at DESC`).all();
}

function getJob(jobId) {
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
}

// camelCase API field name -> real column name, for the editable fields
// (excludes status/completed_*/audit-only columns, which have their own
// dedicated functions below).
const FIELD_TO_COLUMN = {
  ticketNumber: 'ticket_number',
  customer: 'customer',
  jobDescription: 'job_description',
  actionText: 'action_text',
  actionColor: 'action_color',
  location: 'location',
  priority: 'priority',
  workflowStage: 'workflow_stage',
  workflowStageText: 'workflow_stage_text',
};

// `fields` is the camelCase request body; `ticketAutotaskId` is already
// resolved by the caller (server.js) before this runs -- db.js itself
// never talks to Autotask. Writes one single "created" audit entry
// (not one per field) -- the row's own current state already shows
// what was initially entered, audit_log exists to track CHANGES from
// here on.
function createJob(fields, ticketAutotaskId, actor) {
  const now = nowIso();
  const info = db
    .prepare(
      `INSERT INTO jobs (ticket_number, ticket_autotask_id, customer, job_description, action_text, action_color, location, priority, workflow_stage, workflow_stage_text, status, created_at, created_by_email, created_by_name, updated_at, updated_by_email, updated_by_name)
       VALUES ($ticketNumber, $ticketAutotaskId, $customer, $jobDescription, $actionText, $actionColor, $location, $priority, $workflowStage, $workflowStageText, 'open', $now, $email, $name, $now, $email, $name)`
    )
    .run({
      $ticketNumber: fields.ticketNumber || null,
      $ticketAutotaskId: ticketAutotaskId,
      $customer: fields.customer || null,
      $jobDescription: fields.jobDescription || null,
      $actionText: fields.actionText || null,
      $actionColor: fields.actionColor || 'general',
      $location: fields.location || null,
      $priority: fields.priority || 'not_started',
      $workflowStage: fields.workflowStage || 'new',
      $workflowStageText: fields.workflowStageText || null,
      $now: now,
      $email: actor.email,
      $name: actor.name,
    });
  const jobId = Number(info.lastInsertRowid);
  recordAudit({ jobId, field: 'created', newValue: 'Job created', actor });
  return jobId;
}

// Diffs `fields` against the existing row -- writes only columns that
// actually changed (and only THOSE get an audit_log entry each), but
// always re-touches updated_at/by regardless, so "re-saved the form
// with no real change" still records who last touched it without
// polluting history with identical old/new values. `ticketAutotaskId`
// is only re-applied when ticketNumber is actually part of this update
// (server.js re-resolves it whenever ticketNumber changes).
function updateJob(jobId, fields, ticketAutotaskId, actor) {
  const existing = getJob(jobId);
  if (!existing) return null;

  const sets = ['updated_at = $updatedAt', 'updated_by_email = $email', 'updated_by_name = $name'];
  const params = { $id: jobId, $updatedAt: nowIso(), $email: actor.email, $name: actor.name };

  for (const [field, column] of Object.entries(FIELD_TO_COLUMN)) {
    if (!(field in fields)) continue;
    const newValue = fields[field] || null;
    const oldValue = existing[column];
    if (newValue === oldValue) continue;
    sets.push(`${column} = $${field}`);
    params[`$${field}`] = newValue;
    recordAudit({ jobId, field: column, oldValue, newValue, actor });
  }
  if ('ticketNumber' in fields) {
    sets.push('ticket_autotask_id = $ticketAutotaskId');
    params.$ticketAutotaskId = ticketAutotaskId;
  }

  db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = $id`).run(params);
  return getJob(jobId);
}

// The archive path -- "finished" means marked complete, never deleted,
// so full history survives. See deleteJob() below for the genuinely
// separate "clean up a mistake" path.
function completeJob(jobId, actor) {
  const existing = getJob(jobId);
  if (!existing) return null;
  const now = nowIso();
  db.prepare(
    `UPDATE jobs SET status = 'completed', completed_at = $now, completed_by_email = $email, completed_by_name = $name, updated_at = $now, updated_by_email = $email, updated_by_name = $name WHERE id = $id`
  ).run({ $id: jobId, $now: now, $email: actor.email, $name: actor.name });
  recordAudit({ jobId, field: 'completed', newValue: 'Job marked complete', actor });
  return getJob(jobId);
}

function reopenJob(jobId, actor) {
  const existing = getJob(jobId);
  if (!existing) return null;
  const now = nowIso();
  db.prepare(
    `UPDATE jobs SET status = 'open', completed_at = NULL, completed_by_email = NULL, completed_by_name = NULL, updated_at = $now, updated_by_email = $email, updated_by_name = $name WHERE id = $id`
  ).run({ $id: jobId, $now: now, $email: actor.email, $name: actor.name });
  recordAudit({ jobId, field: 'reopened', newValue: 'Job reopened', actor });
  return getJob(jobId);
}

// Hard delete -- kept as a real capability (e.g. direct API/admin use
// for a genuine duplicate/test entry), but by request the UI's own trash
// icon no longer calls this at all. "Deleting" a job from the board now
// means server.js sets workflow_stage='free_text' + workflow_stage_text
// = 'Deleted' and calls completeJob() -- a soft delete that keeps full
// history and just moves it into the Show Completed archive, same as
// any other finished job. See rowActionButtonsHtml()/wireRowActions() in
// client.js and the trash-icon route in server.js.
function deleteJob(jobId) {
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM audit_log WHERE job_id = ?').run(jobId);
    db.prepare('DELETE FROM jobs WHERE id = ?').run(jobId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function getJobHistory(jobId) {
  return db.prepare('SELECT * FROM audit_log WHERE job_id = ? ORDER BY changed_at DESC').all(jobId);
}

module.exports = {
  db,
  nowIso,
  recordAudit,
  listOpenJobs,
  listCompletedJobs,
  getJob,
  createJob,
  updateJob,
  completeJob,
  reopenJob,
  deleteJob,
  getJobHistory,
};
