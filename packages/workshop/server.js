const express = require('express');
const { getClient, listAll, fetchByFieldIn, getTicketUrl, resolveCompanyName, getPicklistLabels } = require('@dashboard/autotask-client');
const {
  listOpenJobs,
  listCompletedJobs,
  getJob,
  createJob,
  updateJob,
  completeJob,
  reopenJob,
  deleteJob,
  getJobHistory,
} = require('./db.js');

const PRIORITIES = ['today', 'tomorrow', '2to4days', 'over4days'];
const ACTION_COLORS = ['general', 'done', 'notewell', 'blue'];
const WORKFLOW_STAGES = ['new', 'free_text', 'in_car', 'ready_to_ship', 'ready_for_pickup', 'sent', 'delivered', 'collected'];
// The two stages with a companion free-text field -- 'free_text' (type
// anything) and 'in_car' (whose car, by request). Kept as its own list
// (mirrors client.js's own TEXT_ENABLED_STAGES) since more than one
// stage now needs the "keep/clear workflowStageText" logic below.
const TEXT_ENABLED_STAGES = ['free_text', 'in_car'];

// { email, name } for whoever's making this request -- requireAuth (see
// packages/shell/auth.js) already guarantees a signed-in session before
// any route on this router runs, same as every other page's server.js.
function actorFrom(req) {
  return { email: req.session.user.email, name: req.session.user.name };
}

// Resolves a typed ticket number (e.g. "T20260730.0020") to the real
// Autotask ticket's internal id -- or null, gracefully, for a blank
// value, zero matches, more-than-one match (ambiguous, treated the same
// as not-found rather than guessing), or the lookup itself failing (a
// network blip shouldn't block saving the job). The typed text always
// saves regardless -- this only controls whether it links out.
async function resolveTicketAutotaskId(ticketNumber) {
  const trimmed = (ticketNumber || '').trim();
  if (!trimmed) return null;
  try {
    const client = await getClient();
    const matches = await listAll(client.tickets, [{ op: 'eq', field: 'ticketNumber', value: trimmed }]);
    return matches.length === 1 ? matches[0].id : null;
  } catch (err) {
    console.error('Workshop: ticket lookup failed for', trimmed, err);
    return null;
  }
}

function shapeJob(row) {
  return {
    id: row.id,
    ticketNumber: row.ticket_number,
    ticketAutotaskId: row.ticket_autotask_id,
    customer: row.customer,
    jobDescription: row.job_description,
    actionText: row.action_text,
    actionColor: row.action_color,
    location: row.location,
    priority: row.priority,
    workflowStage: row.workflow_stage,
    workflowStageText: row.workflow_stage_text,
    status: row.status,
    completedAt: row.completed_at,
    completedByName: row.completed_by_name,
    createdAt: row.created_at,
    createdByName: row.created_by_name,
    updatedAt: row.updated_at,
    updatedByName: row.updated_by_name,
  };
}

// Attaches the resolved Autotask ticket's URL, current due date, real
// client (company) name, and current status label to each already-
// shaped job. getTicketUrl()/resolveCompanyName()/getPicklistLabels()
// all cache across every invocation (see @dashboard/autotask-client),
// so repeat lookups for the same ticket/company/picklist cost nothing
// after the first. Due date/client name/status are always fetched LIVE
// (never cached on the job row) -- all three can change in Autotask
// after the job was logged, and should reflect reality, not whatever
// they were at create/edit time. Batched via fetchByFieldIn (one
// request covering every resolved ticket on the board, chunked the same
// way Contract Services/Client Details/Client Contacts already do this
// exact "id in [...]" fetch) rather than one request per job.
//
// ticketClientName -- by request, once a job's ticket resolves, the
// board shows THAT ticket's real client instead of whatever was typed
// into the free-text Client field. The typed value itself is never
// overwritten in the database (client.js just prefers ticketClientName
// over customer when rendering) -- if the ticket link is ever removed,
// the originally-typed value reappears rather than being lost.
//
// ticketStatus -- the ticket's own Autotask status label (New/In
// Progress/Complete/etc, via getPicklistLabels(client.tickets, 'status'),
// same picklist-resolution convention Service Calls already uses),
// shown by request in small print under the ticket number, only when a
// ticket actually resolved.
async function withTicketDetails(shapedJobs) {
  const ticketIds = [...new Set(shapedJobs.filter((j) => j.ticketAutotaskId).map((j) => j.ticketAutotaskId))];
  let ticketsById = new Map();
  let client = null;
  let statusLabels = new Map();
  if (ticketIds.length > 0) {
    try {
      client = await getClient();
      const [tickets, labels] = await Promise.all([
        fetchByFieldIn(client.tickets, 'id', ticketIds),
        getPicklistLabels(client.tickets, 'status'),
      ]);
      ticketsById = new Map(tickets.map((t) => [t.id, t]));
      statusLabels = labels;
    } catch (err) {
      // Degrade gracefully -- a failed lookup just means no due date/
      // client name/status shows this load, not a broken board.
      console.error('Workshop: batch ticket lookup failed', err);
    }
  }
  return Promise.all(
    shapedJobs.map(async (job) => {
      const ticket = ticketsById.get(job.ticketAutotaskId);
      return {
        ...job,
        ticketUrl: await getTicketUrl(job.ticketAutotaskId),
        ticketDueDate: ticket?.dueDateTime || null,
        ticketClientName: ticket && client ? await resolveCompanyName(client, ticket.companyID) : null,
        ticketStatus: ticket ? statusLabels.get(ticket.status) || `#${ticket.status}` : null,
      };
    })
  );
}

function shapeHistoryRow(row) {
  return {
    changedAt: row.changed_at,
    changedByName: row.changed_by_name,
    field: row.field,
    oldValue: row.old_value,
    newValue: row.new_value,
  };
}

const router = express.Router();
router.use(express.json());

// The board -- open jobs by default, sorted by linked ticket due date
// (soonest first, by request), ?status=completed for the archive view
// (most recently completed first, unaffected by the due-date sort)
// behind client.js's "Show Completed" toggle.
router.get('/', async (req, res) => {
  try {
    const isCompletedView = req.query.status === 'completed';
    const rows = isCompletedView ? listCompletedJobs() : listOpenJobs();
    let jobs = await withTicketDetails(rows.map(shapeJob));
    if (!isCompletedView) {
      // Due dates aren't known until withTicketDetails() resolves them
      // live from Autotask, so this sort has to happen here in JS, after
      // that resolution -- not as a SQL ORDER BY in db.js (see
      // listOpenJobs()'s own comment). Jobs with no known due date (no
      // ticket, a ticket that didn't resolve, or a resolved ticket with
      // none set) sort FIRST, by request -- deliberately NOT sorted by
      // ticket_number (which can be blank, or hold arbitrary free text
      // rather than a real ticket), just kept in their existing
      // creation-order position (listOpenJobs()'s own ORDER BY) as a
      // stable tiebreak within this group.
      jobs = jobs.sort((a, b) => {
        if (!a.ticketDueDate && !b.ticketDueDate) return 0;
        if (!a.ticketDueDate) return -1;
        if (!b.ticketDueDate) return 1;
        return new Date(a.ticketDueDate) - new Date(b.ticketDueDate);
      });
    }
    res.json({ jobs, asOf: new Date().toISOString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Shared body-shaping for POST /jobs and PATCH /jobs/:id -- validates
// priority/actionColor against their real allowed values (the CHECK
// constraints in db.js would reject a bad value anyway, but a clean 400
// here is a far better error than a raw SQLite constraint failure) and
// resolves ticketNumber to a real Autotask ticket id when present.
async function parseJobBody(body, requireDefaults) {
  const fields = {};
  if ('ticketNumber' in body) fields.ticketNumber = body.ticketNumber ? String(body.ticketNumber).trim() : null;
  if ('customer' in body) fields.customer = body.customer ? String(body.customer).trim() : null;
  if ('jobDescription' in body) fields.jobDescription = body.jobDescription ? String(body.jobDescription).trim() : null;
  if ('actionText' in body) fields.actionText = body.actionText ? String(body.actionText).trim() : null;
  if ('location' in body) fields.location = body.location ? String(body.location).trim() : null;

  if ('actionColor' in body || requireDefaults) {
    const value = body.actionColor || 'general';
    if (!ACTION_COLORS.includes(value)) throw { status: 400, message: `actionColor must be one of ${ACTION_COLORS.join(', ')}.` };
    fields.actionColor = value;
  }
  if ('priority' in body || requireDefaults) {
    const value = body.priority || '2to4days';
    if (!PRIORITIES.includes(value)) throw { status: 400, message: `priority must be one of ${PRIORITIES.join(', ')}.` };
    fields.priority = value;
  }
  if ('workflowStage' in body || requireDefaults) {
    const value = body.workflowStage || 'new';
    if (!WORKFLOW_STAGES.includes(value)) throw { status: 400, message: `workflowStage must be one of ${WORKFLOW_STAGES.join(', ')}.` };
    fields.workflowStage = value;
    // Clear the free-text companion whenever moving AWAY from a
    // text-enabled stage, so stale text doesn't linger once a different
    // stage is chosen -- unless this same request is ALSO explicitly
    // setting workflowStageText (handled below, which runs after and
    // wins).
    if (!TEXT_ENABLED_STAGES.includes(value) && !('workflowStageText' in body)) {
      fields.workflowStageText = null;
    }
  }
  if ('workflowStageText' in body) {
    fields.workflowStageText = body.workflowStageText ? String(body.workflowStageText).trim() : null;
  }

  // Always a real null by default, never undefined -- node:sqlite's bind
  // params reject undefined outright ("Provided value cannot be bound to
  // SQLite parameter N"), unlike null, which is a perfectly valid bind
  // value. Caught the hard way: a create with no ticketNumber at all
  // (fields.ticketNumber never set) left this undefined and broke the
  // INSERT entirely.
  let ticketAutotaskId = null;
  if ('ticketNumber' in fields) {
    ticketAutotaskId = await resolveTicketAutotaskId(fields.ticketNumber);
  }
  return { fields, ticketAutotaskId };
}

router.post('/jobs', async (req, res) => {
  try {
    const { fields, ticketAutotaskId } = await parseJobBody(req.body || {}, true);
    const jobId = createJob(fields, ticketAutotaskId, actorFrom(req));
    const [shaped] = await withTicketDetails([shapeJob(getJob(jobId))]);
    res.status(201).json(shaped);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/jobs/:id', async (req, res) => {
  try {
    const jobId = Number(req.params.id);
    if (!getJob(jobId)) return res.status(404).json({ error: 'Job not found.' });
    const { fields, ticketAutotaskId } = await parseJobBody(req.body || {}, false);
    const updated = updateJob(jobId, fields, ticketAutotaskId, actorFrom(req));
    const [shaped] = await withTicketDetails([shapeJob(updated)]);
    res.json(shaped);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/jobs/:id/complete', (req, res) => {
  try {
    const jobId = Number(req.params.id);
    if (!getJob(jobId)) return res.status(404).json({ error: 'Job not found.' });
    const updated = completeJob(jobId, actorFrom(req));
    res.json(shapeJob(updated));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/jobs/:id/reopen', (req, res) => {
  try {
    const jobId = Number(req.params.id);
    if (!getJob(jobId)) return res.status(404).json({ error: 'Job not found.' });
    const updated = reopenJob(jobId, actorFrom(req));
    res.json(shapeJob(updated));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// The trash icon's real behaviour now, by request -- a SOFT delete, not
// the hard one below. Sets workflow_stage to the free-text option with
// the text "Deleted", then completes the job (moves it into the Show
// Completed archive) -- one atomic call rather than client.js making
// two separate requests and risking a partial-failure state (workflow
// updated but not completed, or vice versa) if the second one fails.
router.patch('/jobs/:id/soft-delete', (req, res) => {
  try {
    const jobId = Number(req.params.id);
    if (!getJob(jobId)) return res.status(404).json({ error: 'Job not found.' });
    const actor = actorFrom(req);
    updateJob(jobId, { workflowStage: 'free_text', workflowStageText: 'Deleted' }, null, actor);
    const completed = completeJob(jobId, actor);
    res.json(shapeJob(completed));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Hard delete -- kept for genuine cleanup (e.g. direct API/admin use),
// but no longer what the UI's trash icon does -- see PATCH
// .../soft-delete above, and deleteJob()'s own comment in db.js.
router.delete('/jobs/:id', (req, res) => {
  try {
    const jobId = Number(req.params.id);
    if (!getJob(jobId)) return res.status(404).json({ error: 'Job not found.' });
    deleteJob(jobId);
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/jobs/:id/history', (req, res) => {
  try {
    const jobId = Number(req.params.id);
    if (!getJob(jobId)) return res.status(404).json({ error: 'Job not found.' });
    res.json({ history: getJobHistory(jobId).map(shapeHistoryRow) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
