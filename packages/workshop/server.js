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

const PRIORITIES = ['urgent', 'complete', 'nearly_complete', 'in_progress', 'next_up', 'coming', 'not_started'];
const ACTION_COLORS = ['general', 'done', 'notewell', 'blue'];
const WORKFLOW_STAGES = ['new', 'free_text', 'in_car', 'take_onsite', 'ready_to_ship', 'ready_for_pickup', 'sent', 'delivered', 'collected'];
// The two stages with a companion free-text field -- 'free_text' (type
// anything) and 'in_car' (whose car, by request). Kept as its own list
// (mirrors client.js's own TEXT_ENABLED_STAGES) since more than one
// stage now needs the "keep/clear workflowStageText" logic below.
const TEXT_ENABLED_STAGES = ['free_text', 'in_car', 'take_onsite'];

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

// ---- "WORKSHOP BOARD UPDATE" ticket notes -- by request, whenever a job
// with a resolved ticket changes, and (with the job's full audit history
// appended) the first time a ticket number resolves on a job. ----
//
// noteType/publish are real picklist IDs confirmed against this Autotask
// tenant's own TicketNotes field metadata (autotask_get_field_info) --
// never guessed, since the wrong `publish` value could expose an
// internal note to the client portal. This tenant has no generic
// "General/Internal Note" noteType option, so "Task Notes" was chosen as
// the closest fit; "Internal & Co-Managed" was chosen for publish.
const NOTE_TITLE = 'WORKSHOP BOARD UPDATE';
const TICKET_NOTE_TYPE = 3; // "Task Notes"
const TICKET_NOTE_PUBLISH = 4; // "Internal & Co-Managed"

// Server-side mirror of client.js's own label maps -- server.js has no
// access to that browser module's exports, and the note's field list is
// meant to read the same way the on-screen print card does ("contain all
// the current data for the fields like the print process", by request).
const NOTE_PRIORITY_LABELS = { urgent: 'Urgent', complete: 'Complete', nearly_complete: 'Nearly Complete', in_progress: 'In Progress', next_up: 'Next Up', coming: 'Coming', not_started: 'Not Started' };
const NOTE_WORKFLOW_STAGE_LABELS = {
  new: 'New',
  free_text: 'Free Text',
  in_car: 'In Car',
  take_onsite: 'Take Onsite',
  ready_to_ship: 'Ready to Ship',
  ready_for_pickup: 'Ready for Pickup',
  sent: 'Sent',
  delivered: 'Delivered',
  collected: 'Collected',
};
const NOTE_ACTION_COLOR_LABELS = { general: 'Black', notewell: 'Red', blue: 'Blue', done: 'Green' };
const NOTE_FIELD_LABELS = {
  ticket_number: 'Ticket',
  customer: 'Client',
  job_description: 'Job description',
  action_text: 'Current / required action',
  action_color: 'Note colour',
  location: 'Location',
  priority: 'Priority',
  workflow_stage: 'Status',
  workflow_stage_text: 'Status detail',
};

function noteWorkflowStageLabel(job) {
  if (job.workflowStage === 'free_text' && job.workflowStageText) return job.workflowStageText;
  if (job.workflowStage === 'in_car' && job.workflowStageText) return `In Car -- ${job.workflowStageText}`;
  if (job.workflowStage === 'take_onsite' && job.workflowStageText) return `Take Onsite -- ${job.workflowStageText}`;
  return NOTE_WORKFLOW_STAGE_LABELS[job.workflowStage] || job.workflowStage;
}

// Same "ticket's resolved client name, with anything manually typed
// afterward in brackets" combination the print card uses.
function noteClientText(job) {
  if (job.ticketClientName) return job.customer ? `${job.ticketClientName} (${job.customer})` : job.ticketClientName;
  return job.customer || '(none)';
}

function noteFieldSnapshot(job) {
  return [
    // Who made this particular change -- by request, same as the
    // History modal already shows per entry. job.updatedByName always
    // reflects whoever just triggered THIS save (createJob/updateJob/
    // completeJob/reopenJob all re-touch it), so this is accurate for
    // every note that goes through this function.
    `Changed by: ${job.updatedByName || '(unknown)'}`,
    `Ticket: ${job.ticketNumber || '(none)'}${job.ticketStatus ? ` (${job.ticketStatus})` : ''}`,
    `Due date: ${job.ticketDueDate ? new Date(job.ticketDueDate).toLocaleDateString() : '(none)'}`,
    `Client: ${noteClientText(job)}`,
    `Status: ${noteWorkflowStageLabel(job)}`,
    `Priority: ${NOTE_PRIORITY_LABELS[job.priority] || job.priority}`,
    `Location: ${job.location || '(none)'}`,
    `Job description: ${job.jobDescription || '(none)'}`,
    `Current / required action (${NOTE_ACTION_COLOR_LABELS[job.actionColor] || job.actionColor}): ${job.actionText || '(none)'}`,
  ].join('\n');
}

// One line per audit_log entry, plain-text equivalent of client.js's own
// historyEntryHtml()/valueChangeHtml() -- most recent first, matching
// the History modal's own convention.
function noteHistoryLine(entry) {
  if (entry.field === 'created' || entry.field === 'completed' || entry.field === 'reopened') {
    const label = entry.field === 'created' ? 'Created' : entry.field === 'completed' ? 'Completed' : 'Reopened';
    return `${new Date(entry.changedAt).toLocaleString()} -- ${entry.changedByName}: ${label}`;
  }
  const label = NOTE_FIELD_LABELS[entry.field] || entry.field;
  const labelMap =
    entry.field === 'priority' ? NOTE_PRIORITY_LABELS : entry.field === 'action_color' ? NOTE_ACTION_COLOR_LABELS : entry.field === 'workflow_stage' ? NOTE_WORKFLOW_STAGE_LABELS : null;
  const fmt = (v) => (v ? labelMap?.[v] || v : '(blank)');
  return `${new Date(entry.changedAt).toLocaleString()} -- ${entry.changedByName}: ${label}: ${fmt(entry.oldValue)} -> ${fmt(entry.newValue)}`;
}

// Posts the actual note. Best-effort and never blocking: any failure
// here (Autotask unreachable, note rejected, etc.) is logged but never
// propagates -- posting a note is a courtesy on top of the real save,
// never something that should be able to fail the job save itself. Not
// awaited by any caller for the same reason -- fire-and-forget, so it
// never adds latency to the job save's own response.
async function postWorkshopUpdateNote(jobId, { headline, includeFullHistory = false } = {}) {
  try {
    const row = getJob(jobId);
    if (!row || !row.ticket_autotask_id) return; // nothing to notify -- no linked ticket
    const [job] = await withTicketDetails([shapeJob(row)]);
    const lines = [];
    if (headline) lines.push(headline, '');
    lines.push(noteFieldSnapshot(job));
    if (includeFullHistory) {
      const history = getJobHistory(jobId).map(shapeHistoryRow);
      if (history.length > 0) lines.push('', '-- Full history --', ...history.map(noteHistoryLine));
    }
    const client = await getClient();
    await client.ticketNotes.create(job.ticketAutotaskId, {
      title: NOTE_TITLE,
      description: lines.join('\n'),
      noteType: TICKET_NOTE_TYPE,
      publish: TICKET_NOTE_PUBLISH,
    });
  } catch (err) {
    console.error(`Workshop: failed to post ticket note for job ${jobId}:`, err);
  }
}

// Tells the OLD ticket, when a job's ticket link changes away from it (to
// a different ticket, or removed entirely), where the job went -- by
// request, so a tech watching that ticket isn't left wondering why
// Workshop Board update notes suddenly stopped arriving. `newTicketNumber`
// is the raw typed/stored value (not resolved) -- when it's blank, the
// link was simply removed rather than moved. Same best-effort,
// never-blocking, not-awaited approach as postWorkshopUpdateNote() above.
// The note headline for a PATCH that changed the ticket link -- a
// genuine transfer (had a different real ticket before) names the old
// ticket by number; a first-time link uses the generic wording;
// anything else (no ticket-link change at all) is a plain update.
function noteHeadlineFor(transferredFromTicket, ticketLinkChanged) {
  if (transferredFromTicket) return `Workshop Job transferred from Ticket ${transferredFromTicket}.`;
  if (ticketLinkChanged) return 'Ticket linked to this Workshop job.';
  return 'Workshop job updated.';
}

function ticketMovedDescription(newTicketNumber) {
  return newTicketNumber
    ? `Workshop Board moved this job from this ticket to ${newTicketNumber}.`
    : `Workshop Board removed this job's link to this ticket.`;
}

// A short, single-line note (not the full field snapshot) -- used for
// the specific literal messages requested for the ticket-transfer note
// above and Complete/Delete/Reopen below. Same best-effort,
// never-blocking, not-awaited approach as postWorkshopUpdateNote().
async function postWorkshopActionNote(ticketAutotaskId, message) {
  if (!ticketAutotaskId) return; // nothing to notify -- no linked ticket
  try {
    const client = await getClient();
    await client.ticketNotes.create(ticketAutotaskId, {
      title: NOTE_TITLE,
      description: message,
      noteType: TICKET_NOTE_TYPE,
      publish: TICKET_NOTE_PUBLISH,
    });
  } catch (err) {
    console.error(`Workshop: failed to post action note to ticket ${ticketAutotaskId}:`, err);
  }
}

async function postTicketMovedNote(oldTicketAutotaskId, newTicketNumber) {
  await postWorkshopActionNote(oldTicketAutotaskId, ticketMovedDescription(newTicketNumber));
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
    const value = body.priority || 'not_started';
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
    // A ticket was already linked at creation time -- treat that the same
    // as "just added" (full history, which at this point is only the
    // single "created" entry).
    if (shaped.ticketAutotaskId) postWorkshopUpdateNote(jobId, { headline: 'Job created.', includeFullHistory: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/jobs/:id', async (req, res) => {
  try {
    const jobId = Number(req.params.id);
    const existing = getJob(jobId);
    if (!existing) return res.status(404).json({ error: 'Job not found.' });
    const { fields, ticketAutotaskId } = await parseJobBody(req.body || {}, false);
    // Captured BEFORE the update, so afterward we can tell exactly which
    // audit_log rows this specific call just wrote -- i.e. whether
    // anything actually changed (a no-op re-save writes none, see
    // updateJob()'s own comment in db.js) and whether the ticket link
    // just changed -- without duplicating updateJob()'s own diff logic.
    const beforeHistory = getJobHistory(jobId);
    const beforeMaxId = beforeHistory.length ? beforeHistory[0].id : 0;
    const updated = updateJob(jobId, fields, ticketAutotaskId, actorFrom(req));
    const [shaped] = await withTicketDetails([shapeJob(updated)]);
    res.json(shaped);

    const changedThisCall = getJobHistory(jobId).some((h) => h.id > beforeMaxId);
    if (changedThisCall) {
      const ticketLinkChanged = updated.ticket_autotask_id !== existing.ticket_autotask_id;
      // A genuine transfer (had a DIFFERENT real ticket before) vs. a
      // first-time link (had none before) get distinct headlines on the
      // new ticket's note -- existing.ticket_number is the OLD job row's
      // own stored value, already on hand, no extra lookup needed.
      const transferredFromTicket = ticketLinkChanged && existing.ticket_autotask_id ? existing.ticket_number : null;
      // The OLD ticket, if it had one, gets told where the job went (or
      // that the link was simply removed) -- by request, so a tech
      // watching that ticket isn't left wondering why Workshop Board
      // notes suddenly stopped.
      if (ticketLinkChanged && existing.ticket_autotask_id) {
        postTicketMovedNote(existing.ticket_autotask_id, updated.ticket_number);
      }
      if (shaped.ticketAutotaskId) {
        // Covers both "was unlinked, now linked" and "linked to a
        // different ticket than before" -- either way this ticket has
        // never seen a Workshop Board note, so it gets the full history.
        postWorkshopUpdateNote(jobId, {
          headline: noteHeadlineFor(transferredFromTicket, ticketLinkChanged),
          includeFullHistory: ticketLinkChanged,
        });
      }
    }
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
    const actor = actorFrom(req);
    const updated = completeJob(jobId, actor);
    res.json(shapeJob(updated));
    postWorkshopActionNote(updated.ticket_autotask_id, `Workshop Job marked as complete by ${actor.name}.`);
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
    postWorkshopActionNote(updated.ticket_autotask_id, 'Completed Workshop Job Reopened.');
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
    // One consolidated note for this whole action (not one from the
    // updateJob() above plus another from completeJob()) -- it's really
    // a single user action, not two separate changes worth notifying
    // about individually.
    if (completed.ticket_autotask_id) postWorkshopUpdateNote(jobId, { headline: 'Job deleted from Workshop Board (marked complete).' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Hard delete -- the Show Completed archive's own trash icon (see
// deleteJob()'s own comment in db.js), plus still available for direct
// API/admin use. Requires a resolved ticket link, by request -- once
// this row is gone, the ticket note posted below is the ONLY remaining
// record this job ever existed, so there has to be a real ticket for
// that note to land on. (The open-jobs view's own trash icon, PATCH
// .../soft-delete above, has no such requirement -- it never destroys
// anything, it's fully reversible via Reopen.)
router.delete('/jobs/:id', (req, res) => {
  try {
    const jobId = Number(req.params.id);
    const job = getJob(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    if (!job.ticket_autotask_id) {
      return res.status(400).json({ error: 'Cannot delete a job with no linked ticket -- link a real Autotask ticket first, so a permanent record of the deletion can be posted there.' });
    }
    const actor = actorFrom(req);
    deleteJob(jobId);
    res.status(204).end();
    postWorkshopActionNote(job.ticket_autotask_id, `Workshop Job deleted by ${actor.name}.`);
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
