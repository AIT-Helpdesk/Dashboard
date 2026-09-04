const path = require('path');
const fs = require('fs');
const express = require('express');
const { getClient, listAll, fetchByFieldIn, getTicketUrl, resolveCompanyName, getPicklistLabels, todayAestKey, isoDateAest } = require('@dashboard/autotask-client');
// Only for the Usage Instructions/Extended Help editor below (isDashboardAdmin()) -- same
// "everyone can read, only the dashboard admin can edit" gate Updates and every tabbed
// page's own Help-tab notes already use.
const { isDashboardAdmin } = require('@dashboard/shell/registry.js');
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
  listEquipmentForJob,
  replaceEquipmentForJob,
  recordAudit,
  getEquipmentById,
  setEquipmentChecked,
} = require('./db.js');

const PRIORITIES = ['urgent', 'complete', 'nearly_complete', 'waiting', 'in_progress', 'next_up', 'coming', 'not_started'];
const ACTION_COLORS = ['general', 'done', 'notewell', 'blue'];
const WORKFLOW_STAGES = ['new', 'free_text', 'in_car', 'take_onsite', 'ready_to_ship', 'ready_for_pickup', 'sent', 'delivered', 'collected', 'dispose', 'workshop_gear'];
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

// True only for a request that reached this app AS localhost -- a direct
// dev hit (`npm start`, http://localhost:3000), never the real production
// domain, even though both ultimately land on this same Express process
// (server.js's own listen() is bound to localhost-only either way, with a
// reverse proxy -- Caddy in production -- always sitting in front; see
// that bind's own comment further down). req.hostname reflects the
// ORIGINAL Host header the browser actually sent (via X-Forwarded-Host
// once `app.set('trust proxy', 1)` is in effect -- see auth.js), the same
// request-derived-host mechanism redirectUriFor()/stretyRedirectUriFor()
// already rely on elsewhere in this app, not a fixed env var -- so this
// naturally reads 'localhost' for a direct dev hit and the real domain in
// production, correctly, with zero configuration either way.
//
// By request: NOTHING this page does should ever write to a real Autotask
// ticket when reached this way -- a dev/test session testing Workshop
// Board must never post a note, move a ticket, or attach a photo to a
// REAL production ticket by accident. Deliberately a blanket, unconditional
// skip -- stronger than (and checked ALONGSIDE, never instead of) the
// per-job skip_ticket_updates flag, which is a user preference for
// production behaviour, not a dev-safety switch; even the hard-delete
// route's own "never silenced" note (see its own comment) is still
// skipped here, since a real ticket must never see dev-environment noise
// regardless of what other rule would otherwise force a note through.
function isLocalDevRequest(req) {
  return req?.hostname === 'localhost';
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
    flagNote: row.flag_note,
    flagAnswer: row.flag_answer,
    skipTicketUpdates: !!row.skip_ticket_updates,
    status: row.status,
    completedAt: row.completed_at,
    completedByName: row.completed_by_name,
    createdAt: row.created_at,
    createdByName: row.created_by_name,
    updatedAt: row.updated_at,
    updatedByName: row.updated_by_name,
  };
}

function shapeEquipmentRow(row) {
  return {
    id: row.id,
    count: row.count,
    description: row.description,
    inWorkshop: !!row.in_workshop,
    locationNote: row.location_note,
    configured: !!row.configured,
    delivered: !!row.delivered,
    checkedAt: row.checked_at,
    checkedByName: row.checked_by_name,
  };
}

// Attaches each job's own equipment list -- a small, per-job sub-table
// (a handful of rows at most), so a plain per-job fetch is fine here
// rather than needing fetchByFieldIn's batching (that's for the separate
// Autotask API round-trips in withTicketDetails() below, a genuinely
// different cost).
function attachEquipment(shapedJobs) {
  return shapedJobs.map((job) => ({ ...job, equipment: listEquipmentForJob(job.id).map(shapeEquipmentRow) }));
}

// One line per equipment item, e.g. "2x Laptop (In Workshop, Configured)"
// -- used both for the audit_log summary when the list changes (see
// saveEquipment() below) and the "WORKSHOP BOARD UPDATE" ticket note
// snapshot (noteFieldSnapshot() below), same "reads the same way the
// on-screen view does" reasoning every other field on this page follows.
function equipmentSummaryText(items) {
  if (!items || items.length === 0) return '(none)';
  return items
    .map((item) => {
      const countPart = item.count ? `${item.count}x ` : '';
      const flags = [item.inWorkshop && 'In Workshop', item.configured && 'Configured', item.delivered && 'Delivered'].filter(Boolean);
      const flagsPart = flags.length ? ` (${flags.join(', ')})` : '';
      const notePart = item.locationNote ? ` -- ${item.locationNote}` : '';
      return `${countPart}${item.description || '(unnamed item)'}${flagsPart}${notePart}`;
    })
    .join('; ');
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
const NOTE_PRIORITY_LABELS = { urgent: 'Urgent', complete: 'Complete', nearly_complete: 'Nearly Complete', waiting: 'Waiting', in_progress: 'In Progress', next_up: 'Next Up', coming: 'Coming', not_started: 'Not Started' };
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
  dispose: 'Dispose',
  workshop_gear: 'Workshop Gear',
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
  flag_note: 'Question',
  flag_answer: 'Answer',
  skip_ticket_updates: 'Skip ticket update',
};
const NOTE_YES_NO_LABELS = { '0': 'No', '1': 'Yes' };

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
    // Question/Answer deliberately excluded, by request -- the Q&A stamp
    // stays entirely local (the History modal and print card still show
    // it), never sent to the ticket. See postWorkshopUpdateNote()'s own
    // "Full history" append below for the matching exclusion on that side
    // too (flag_note/flag_answer audit_log entries).
    `Equipment: ${equipmentSummaryText(job.equipment)}`,
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
    entry.field === 'priority'
      ? NOTE_PRIORITY_LABELS
      : entry.field === 'action_color'
        ? NOTE_ACTION_COLOR_LABELS
        : entry.field === 'workflow_stage'
          ? NOTE_WORKFLOW_STAGE_LABELS
          : entry.field === 'skip_ticket_updates'
            ? NOTE_YES_NO_LABELS
            : null;
  const fmt = (v) => (v ? labelMap?.[v] || v : '(blank)');
  return `${new Date(entry.changedAt).toLocaleString()} -- ${entry.changedByName}: ${label}: ${fmt(entry.oldValue)} -> ${fmt(entry.newValue)}`;
}

// Posts the actual note. Best-effort and never blocking: any failure
// here (Autotask unreachable, note rejected, etc.) is logged but never
// propagates -- posting a note is a courtesy on top of the real save,
// never something that should be able to fail the job save itself. Not
// awaited by any caller for the same reason -- fire-and-forget, so it
// never adds latency to the job save's own response. `req` is only ever
// used for isLocalDevRequest() below -- every caller already has it in
// scope from its own route handler.
async function postWorkshopUpdateNote(jobId, { headline, includeFullHistory = false } = {}, req) {
  try {
    if (isLocalDevRequest(req)) return; // never write to a real ticket from a dev/localhost session -- see isLocalDevRequest()'s own comment
    const row = getJob(jobId);
    if (!row || !row.ticket_autotask_id) return; // nothing to notify -- no linked ticket
    // "Skip ticket update" checkbox, by request -- checked entirely inside
    // this one shared function, since every regular (non-hard-delete) call
    // site funnels through here with just a jobId, already re-fetching the
    // row fresh. The hard-delete route posts via postWorkshopActionNote()
    // directly instead (see its own comment there for why that one is NOT
    // gated on this flag).
    if (row.skip_ticket_updates) return;
    const [job] = attachEquipment(await withTicketDetails([shapeJob(row)]));
    const lines = [];
    if (headline) lines.push(headline, '');
    lines.push(noteFieldSnapshot(job));
    if (includeFullHistory) {
      // flag_note/flag_answer (the Q&A stamp) excluded here too, by
      // request -- same "never sent to the ticket" exclusion
      // noteFieldSnapshot() applies above, just on the audit-log side of
      // things. The local History modal (client.js) still shows every
      // entry, including these -- only the ticket-bound copy is filtered.
      const history = getJobHistory(jobId)
        .map(shapeHistoryRow)
        .filter((h) => h.field !== 'flag_note' && h.field !== 'flag_answer');
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
// `skip` is the caller's own job row's skip_ticket_updates flag -- this
// function has no jobId of its own to look it up (it only ever gets a raw
// ticketAutotaskId), so each call site passes whichever job's flag applies
// (see below). Defaults to false so the hard-delete route -- which must
// NEVER be silenced, see its own comment -- can simply not pass it at all.
// `req` is a trailing, separately-optional param (unlike `skip`, which
// every real call site always passes explicitly) -- see
// isLocalDevRequest()'s own comment for why this check applies even to
// the hard-delete route's otherwise-unsilenceable note.
async function postWorkshopActionNote(ticketAutotaskId, message, skip = false, req) {
  if (skip || isLocalDevRequest(req) || !ticketAutotaskId) return; // nothing to notify -- no linked ticket, this job opted out, or a dev/localhost session
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

async function postTicketMovedNote(oldTicketAutotaskId, newTicketNumber, skip = false, req) {
  await postWorkshopActionNote(oldTicketAutotaskId, ticketMovedDescription(newTicketNumber), skip, req);
}

const router = express.Router();
// Raised from express.json()'s own default (~100kb) -- by request, jobs can
// have real photos attached (POST /jobs/:id/photos below), sent as base64
// JSON (Autotask's own TicketAttachments API expects base64 in the request
// body either way, so this avoids adding multer/a multipart parser as a new
// dependency for what Autotask needs re-encoded as base64 regardless).
// 40mb comfortably covers several real phone photos at once (base64
// inflates raw size by ~1/3) -- not a real DoS concern for an internal
// tool behind Microsoft 365 sign-in.
router.use(express.json({ limit: '40mb' }));

// Same tier order as client.js's own PRIORITY_ORDER (kept as a separate
// copy, not a shared import -- this package has no existing shared-
// constants module between client.js and server.js, and duplicating one
// eight-entry array is simpler than introducing one just for this).
// Urgent first, by request, then completion-progress order Complete ->
// Nearly Complete -> Waiting -> In Progress -> Next Up -> Not Started ->
// Coming -- this REPLACES due-date as the board's primary sort (due date
// is now only the tiebreak within a tier, see below), where before
// priority wasn't sorted on at all. Waiting inserted between Nearly
// Complete and In Progress, by request.
const PRIORITY_SORT_ORDER = ['urgent', 'complete', 'nearly_complete', 'waiting', 'in_progress', 'next_up', 'not_started', 'coming'];
const PRIORITY_RANK = new Map(PRIORITY_SORT_ORDER.map((p, i) => [p, i]));

// The board -- open jobs by default, sorted by priority tier first
// (Urgent/Complete/.../Coming, by request), then by linked ticket due
// date (soonest first, by request) as the tiebreak WITHIN a tier.
// ?status=completed for the archive view (most recently completed first,
// unaffected by either sort) behind client.js's "Show Completed" toggle.
router.get('/', async (req, res) => {
  try {
    const isCompletedView = req.query.status === 'completed';
    const rows = isCompletedView ? listCompletedJobs() : listOpenJobs();
    let jobs = attachEquipment(await withTicketDetails(rows.map(shapeJob)));
    if (!isCompletedView) {
      // Due dates aren't known until withTicketDetails() resolves them
      // live from Autotask, so this sort has to happen here in JS, after
      // that resolution -- not as a SQL ORDER BY in db.js (see
      // listOpenJobs()'s own comment). Jobs with no known due date (no
      // ticket, a ticket that didn't resolve, or a resolved ticket with
      // none set) sort FIRST within their own priority tier, by request
      // (unchanged from before priority sorting existed) -- deliberately
      // NOT sorted by ticket_number (which can be blank, or hold
      // arbitrary free text rather than a real ticket), just kept in
      // their existing creation-order position (listOpenJobs()'s own
      // ORDER BY) as a stable tiebreak within that group. An unrecognized
      // priority value (shouldn't happen -- db.js's own CHECK constraint
      // guards against it -- but Map.get() on a miss returns undefined,
      // not a crash) sorts to the very end rather than throwing.
      jobs = jobs.sort((a, b) => {
        const rankA = PRIORITY_RANK.has(a.priority) ? PRIORITY_RANK.get(a.priority) : PRIORITY_SORT_ORDER.length;
        const rankB = PRIORITY_RANK.has(b.priority) ? PRIORITY_RANK.get(b.priority) : PRIORITY_SORT_ORDER.length;
        if (rankA !== rankB) return rankA - rankB;
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
  // Mandatory, by request -- unlike every other free-text field on this
  // form (Client/Ticket/Location, all still optional), a job needs at
  // least a description and a current/next/required action to actually
  // be useful on the board. Same "|| requireDefaults" pattern as
  // actionColor/priority/workflowStage below -- required on create even
  // via a direct API call that omits the field entirely, and rejected on
  // update only if the field is explicitly sent blank (an update that
  // doesn't mention the field at all leaves whatever's already saved
  // alone, same as every other optional field here).
  if ('jobDescription' in body || requireDefaults) {
    const value = body.jobDescription ? String(body.jobDescription).trim() : '';
    if (!value) throw { status: 400, message: 'jobDescription is required.' };
    fields.jobDescription = value;
  }
  if ('actionText' in body || requireDefaults) {
    const value = body.actionText ? String(body.actionText).trim() : '';
    if (!value) throw { status: 400, message: 'actionText is required.' };
    fields.actionText = value;
  }
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
    // 25 characters max, by request -- the client's own <input maxlength>
    // already enforces this in the UI; this is just the same limit
    // enforced server-side too, in case of a direct API call bypassing
    // the browser control.
    fields.workflowStageText = body.workflowStageText ? String(body.workflowStageText).trim().slice(0, 25) : null;
  }
  if ('flagNote' in body) {
    // The "stamp" Question -- 300 characters max (the client's own <input
    // maxlength> enforces the same limit in the UI), a real question can
    // run longer than workflowStageText's own 25-char cap. Blank clears it
    // (see qaIconsHtml() in client.js for the display logic once it's
    // combined with flagAnswer below).
    fields.flagNote = body.flagNote ? String(body.flagNote).trim().slice(0, 300) : null;
  }
  if ('flagAnswer' in body) {
    // The stamp's companion Answer -- same 300-char cap/blank-clears
    // convention as flagNote above, filled in via the same popup form
    // (openQaModal() in client.js), not a separate editor.
    fields.flagAnswer = body.flagAnswer ? String(body.flagAnswer).trim().slice(0, 300) : null;
  }
  if ('skipTicketUpdates' in body) {
    // Plain boolean coercion, not the trimmed-string pattern every other
    // field above uses -- this is a checkbox, not text, and db.js's own
    // updateJob() specifically expects a real true/false here (see its own
    // comment for why this field is handled outside the generic
    // FIELD_TO_COLUMN diff loop).
    fields.skipTicketUpdates = !!body.skipTicketUpdates;
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

// Validates the optional `equipment` array (present on POST/PATCH /jobs
// when the Add/Edit form's own equipment table is being saved alongside
// everything else, and always present on the dedicated PUT
// /jobs/:id/equipment route the standalone equipment-icon modal uses).
// Same "a clean 400 beats a raw SQLite constraint failure" reasoning as
// parseJobBody()'s own actionColor/priority checks.
function parseEquipmentItems(rawItems) {
  if (!Array.isArray(rawItems)) throw { status: 400, message: 'equipment must be an array.' };
  return rawItems.map((raw, index) => {
    let count = null;
    if (raw.count !== undefined && raw.count !== null && raw.count !== '') {
      count = Number(raw.count);
      if (!Number.isInteger(count) || count < 0) throw { status: 400, message: `equipment[${index}].count must be a whole number of 0 or more.` };
    }
    return {
      count,
      description: raw.description ? String(raw.description).trim() : null,
      inWorkshop: !!raw.inWorkshop,
      // "Small note field", by request -- 60 characters max, well short of
      // workflowStageText's own 25-char cap being too tight but nowhere
      // near a full free-text field like actionText.
      locationNote: raw.locationNote ? String(raw.locationNote).trim().slice(0, 60) : null,
      configured: !!raw.configured,
      delivered: !!raw.delivered,
    };
  });
}

// Shared by POST/PATCH /jobs and PUT /jobs/:id/equipment -- replaces the
// job's whole equipment list (see replaceEquipmentForJob()'s own comment
// in db.js for why a wholesale replace, not a per-row diff) and writes
// ONE audit_log summary entry for the whole list, only when it actually
// changed (comparing readable summaries is simpler and just as accurate
// as a structural diff here, since the summary already captures every
// field). Returns whether anything changed, so callers can decide whether
// a "WORKSHOP BOARD UPDATE" ticket note is warranted.
function saveEquipmentIfProvided(jobId, body, actor) {
  if (!('equipment' in body)) return false;
  const items = parseEquipmentItems(body.equipment);
  const beforeSummary = equipmentSummaryText(listEquipmentForJob(jobId).map(shapeEquipmentRow));
  replaceEquipmentForJob(jobId, items);
  const afterSummary = equipmentSummaryText(items);
  if (beforeSummary === afterSummary) return false;
  recordAudit({ jobId, field: 'equipment', oldValue: beforeSummary, newValue: afterSummary, actor });
  return true;
}

router.post('/jobs', async (req, res) => {
  try {
    const { fields, ticketAutotaskId } = await parseJobBody(req.body || {}, true);
    const actor = actorFrom(req);
    const jobId = createJob(fields, ticketAutotaskId, actor);
    saveEquipmentIfProvided(jobId, req.body || {}, actor);
    const [shaped] = attachEquipment(await withTicketDetails([shapeJob(getJob(jobId))]));
    res.status(201).json(shaped);
    // A ticket was already linked at creation time -- treat that the same
    // as "just added" (full history, which at this point is only the
    // single "created" entry).
    if (shaped.ticketAutotaskId) postWorkshopUpdateNote(jobId, { headline: 'Job created.', includeFullHistory: true }, req);
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
    const actor = actorFrom(req);
    // Captured BEFORE the update, so afterward we can tell exactly which
    // audit_log rows this specific call just wrote -- i.e. whether
    // anything actually changed (a no-op re-save writes none, see
    // updateJob()'s own comment in db.js) and whether the ticket link
    // just changed -- without duplicating updateJob()'s own diff logic.
    // Equipment changes (below) write to this same audit_log table, so
    // this one check naturally covers both without any special-casing.
    const beforeHistory = getJobHistory(jobId);
    const beforeMaxId = beforeHistory.length ? beforeHistory[0].id : 0;
    const updated = updateJob(jobId, fields, ticketAutotaskId, actor);
    saveEquipmentIfProvided(jobId, req.body || {}, actor);
    const [shaped] = attachEquipment(await withTicketDetails([shapeJob(updated)]));
    res.json(shaped);

    const changedFieldsThisCall = getJobHistory(jobId)
      .filter((h) => h.id > beforeMaxId)
      .map((h) => h.field);
    const changedThisCall = changedFieldsThisCall.length > 0;
    // Q&A-only saves never reach the ticket at all, by request -- not just
    // the CONTENT (see noteFieldSnapshot()'s/postWorkshopUpdateNote()'s own
    // flag_note/flag_answer exclusions above), but the note itself. Editing
    // Question/Answer and nothing else in this same call is treated
    // exactly like "nothing worth notifying the ticket about" -- otherwise
    // a content-free "Workshop job updated." note would still show up on
    // the ticket every time someone answers a question, which is exactly
    // the kind of side effect this exclusion is meant to avoid.
    const onlyQaChanged = changedThisCall && changedFieldsThisCall.every((f) => f === 'flag_note' || f === 'flag_answer');
    if (changedThisCall && !onlyQaChanged) {
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
        postTicketMovedNote(existing.ticket_autotask_id, updated.ticket_number, !!updated.skip_ticket_updates, req);
      }
      if (shaped.ticketAutotaskId) {
        // Covers both "was unlinked, now linked" and "linked to a
        // different ticket than before" -- either way this ticket has
        // never seen a Workshop Board note, so it gets the full history.
        postWorkshopUpdateNote(
          jobId,
          {
            headline: noteHeadlineFor(transferredFromTicket, ticketLinkChanged),
            includeFullHistory: ticketLinkChanged,
          },
          req
        );
      }
    }
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Standalone save for the equipment-icon's own modal, by request -- lets
// staff update just the equipment list without opening the full Edit
// form (which also has this same table embedded at its bottom and saves
// it as part of the regular PATCH above; both paths go through the same
// saveEquipmentIfProvided()).
router.put('/jobs/:id/equipment', (req, res) => {
  try {
    const jobId = Number(req.params.id);
    const existing = getJob(jobId);
    if (!existing) return res.status(404).json({ error: 'Job not found.' });
    const actor = actorFrom(req);
    const changed = saveEquipmentIfProvided(jobId, req.body || {}, actor);
    const equipment = listEquipmentForJob(jobId).map(shapeEquipmentRow);
    res.json({ equipment });
    if (changed && existing.ticket_autotask_id) {
      postWorkshopUpdateNote(jobId, { headline: 'Equipment list updated.' }, req);
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
    postWorkshopActionNote(updated.ticket_autotask_id, `Workshop Job marked as complete by ${actor.name}.`, !!updated.skip_ticket_updates, req);
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
    postWorkshopActionNote(updated.ticket_autotask_id, 'Completed Workshop Job Reopened.', !!updated.skip_ticket_updates, req);
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
    if (completed.ticket_autotask_id) postWorkshopUpdateNote(jobId, { headline: 'Job deleted from Workshop Board (marked complete).' }, req);
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
// Deliberately NOT gated on skip_ticket_updates, unlike every other note in
// this file -- "skip ticket update" opts a job's ROUTINE changes out of
// noise on its ticket, it does not mean "let this job's own permanent
// record of being destroyed go unwritten anywhere." postWorkshopActionNote()
// is called below with its `skip` param left at the default (false).
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
    postWorkshopActionNote(job.ticket_autotask_id, `Workshop Job deleted by ${actor.name}.`, undefined, req);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Photo upload -- attaches one or more photos directly to the job's
// linked Autotask ticket, with an optional shared text description, by
// request. Requires a resolved ticket link (400 otherwise) -- there's
// nowhere else for a photo attachment to live; this isn't stored in
// Workshop's own database at all, it goes straight to Autotask.
//
// The real Autotask API shape here was NOT guessable from the SDK's own
// TicketAttachments.create() -- that method posts to the flat
// /TicketAttachments collection, which returns a genuine "Resource not
// found" (confirmed via a live test). Autotask's real create endpoint is
// NESTED under the parent ticket instead -- POST /Tickets/{id}/Attachments
// -- the exact same shape TicketNotes' own create(ticketId, ...) already
// uses elsewhere in the SDK (that entity DOES have the nested-path
// handling; TicketAttachments just never got it). Confirmed via a real
// round-trip against a genuine internal ticket: created a tiny test
// attachment, fetched it back (confirmed the field shape below), then
// deleted it -- which ALSO isn't the flat /TicketAttachments/{id} DELETE
// the SDK exposes (a real 405) -- the real delete endpoint is nested too
// (DELETE /Tickets/{id}/Attachments/{id}), not used by this route but
// worth documenting here since it was confirmed the same session.
//
// Required fields, confirmed against the entity's own live
// entityInformation/fields plus real trial and error (Autotask's own
// error messages named each one as it was added): title, fullPath
// (filename), contentType, data (base64), publish (same picklist/value
// TicketNotes.publish already uses on this tenant -- see
// TICKET_NOTE_PUBLISH above), and attachmentType (FILE_ATTACHMENT, vs.
// FILE_LINK/FOLDER_LINK/URL -- this is always a real uploaded file, never
// one of those other three).
//
// Always uploads regardless of skip_ticket_updates -- that flag opts a
// job's routine NARRATIVE notes out of its ticket, it doesn't mean
// "photos silently go nowhere"; the attachment itself is the entire point
// of this action, the same way the Equipment Checklist's own checked_at
// stamp always writes regardless of that flag (see its own route's
// comment). No separate "WORKSHOP BOARD UPDATE" note is posted alongside
// it -- the shared description is already visible as each attachment's
// own title directly on the ticket's Attachments tab, a second note
// narrating the same thing would just be noise.
//
// Best-effort per file, not all-or-nothing -- one bad file (Autotask
// rejects it, a network blip) shouldn't silently lose the others in the
// same batch. Response reports exactly which succeeded/failed so the
// client can tell the user precisely what happened.
router.post('/jobs/:id/photos', async (req, res) => {
  try {
    const jobId = Number(req.params.id);
    const job = getJob(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    if (!job.ticket_autotask_id) {
      return res.status(400).json({ error: 'Cannot upload photos -- this job has no linked ticket.' });
    }
    // Blocked entirely on a dev/localhost session, by request -- unlike
    // every other note in this file, a photo upload has no "skip"
    // parameter to just quietly not-send; the write to a real Autotask
    // ticket IS the entire action here (see this route's own top comment
    // on why it's not gated on skip_ticket_updates either, for the same
    // "the attachment is the whole point" reason -- isLocalDevRequest()
    // overrides even that). A clear 400 rather than a silent fake success,
    // so testing this from localhost surfaces exactly why nothing uploaded.
    if (isLocalDevRequest(req)) {
      return res.status(400).json({ error: 'Photo uploads are disabled from a localhost/dev session -- this would attach a real file to a real Autotask ticket.' });
    }
    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    if (files.length === 0) return res.status(400).json({ error: 'No files provided.' });
    if (files.length > 10) return res.status(400).json({ error: 'Upload at most 10 photos at once.' });

    const description = req.body?.description ? String(req.body.description).trim().slice(0, 300) : '';
    const client = await getClient();

    const results = { uploaded: 0, failed: [] };
    for (const file of files) {
      const filename = file?.filename ? String(file.filename).slice(0, 255) : 'photo';
      try {
        if (!file?.dataBase64) throw new Error('No file data received.');
        await client.ticketAttachments.axios.post(`/Tickets/${job.ticket_autotask_id}/Attachments`, {
          title: (description || filename).slice(0, 255),
          fullPath: filename,
          contentType: file.contentType || 'application/octet-stream',
          data: file.dataBase64,
          publish: TICKET_NOTE_PUBLISH,
          attachmentType: 'FILE_ATTACHMENT',
        });
        results.uploaded += 1;
      } catch (err) {
        console.error(`Workshop: failed to upload photo "${filename}" to ticket ${job.ticket_autotask_id}:`, err);
        const detail = err.response ? `HTTP ${err.response.status}${err.response.data?.errors ? `: ${err.response.data.errors.join(', ')}` : ''}` : err.message;
        results.failed.push({ filename, error: detail });
      }
    }
    res.json(results);
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

// ---- Equipment Checklist -- a standalone popup (equipment-checklist.html)
// meant to be left open on its own device in the workshop, listing every
// still-outstanding piece of equipment across every OPEN job so it can be
// physically ticked off. Three routes: the standalone page itself, the data
// it polls, and the tick-box write. ----

// Not-yet-delivered equipment across every open job, grouped by the
// EQUIPMENT ITEM's own location (never the job's own Location field -- by
// request, those are two genuinely different things: a job's Location is
// where the JOB/ticket sits, an item's own location note is where that
// specific piece of gear physically is, and only the latter is meaningful
// for "walk around and find/tick this thing"). Originally grouped by
// client with items ordered by location within each group; inverted by
// request -- now grouped by location, with each item's own client shown
// alongside it (a location group can span several different jobs/clients).
// Reuses listOpenJobs()/attachEquipment()/withTicketDetails() rather than a
// new SQL join -- same already-tested "resolve the ticket's real client
// name live, prefer it over the free-text customer field" resolution the
// main board view uses (see withTicketDetails()'s own comment).
router.get('/equipment-checklist', async (req, res) => {
  try {
    const jobs = attachEquipment(await withTicketDetails(listOpenJobs().map(shapeJob)));
    const todayKey = todayAestKey();

    const NO_LOCATION = '(No location)';
    const byLocation = new Map(); // equipment's own locationNote -> items[]
    for (const job of jobs) {
      const clientName = job.ticketClientName || job.customer || '(No client)';
      for (const item of job.equipment) {
        if (item.delivered) continue; // "Do not show the item if it's marked as delivered", by request
        const location = item.locationNote || NO_LOCATION;
        if (!byLocation.has(location)) byLocation.set(location, []);
        byLocation.get(location).push({
          equipmentId: item.id,
          jobId: job.id,
          clientName,
          // Shown under the client name in the popup, by request -- both
          // already resolved live on `job` by withTicketDetails() above
          // (ticketNumber straight off the job row itself, ticketStatus
          // via the same real-Autotask-status lookup the main board's own
          // Status column uses), no extra work needed here. Null/blank
          // for a job with no linked ticket at all -- equipmentChecklist.js
          // decides how to render that case.
          ticketNumber: job.ticketNumber || null,
          ticketStatus: job.ticketStatus || null,
          description: item.description || '(unnamed item)',
          count: item.count,
          // "Show the tick if the current date-time stamp is today, blank
          // if it's blank or earlier" -- computed fresh on every request
          // from the real stamp (see setEquipmentChecked() in db.js),
          // rather than a plain boolean that would need a daily reset job
          // to blank it back out at midnight.
          checkedToday: !!item.checkedAt && isoDateAest(item.checkedAt) === todayKey,
        });
      }
    }

    // "(No location)" sorts last, by request-equivalent reasoning to the
    // old blank-sorts-last item order this replaces -- a real location
    // reads more usefully first than an unlocated catch-all group. Items
    // within a location group are sorted by client, then item name, so two
    // items for the same client on the same shelf still read as a
    // readable, stable block rather than in arbitrary job-fetch order.
    const groups = [...byLocation.entries()]
      .map(([location, items]) => ({
        location,
        items: items.sort((a, b) => a.clientName.localeCompare(b.clientName) || a.description.localeCompare(b.description)),
      }))
      .sort((a, b) => {
        if (a.location === NO_LOCATION) return 1;
        if (b.location === NO_LOCATION) return -1;
        return a.location.localeCompare(b.location);
      });

    res.json({ generatedAt: new Date().toISOString(), groups });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// The tick box write. Ticking (checked: true) stamps checked_at/by (see
// setEquipmentChecked() in db.js) AND posts a note to the item's job's
// linked Autotask ticket -- by request, that note is deliberately narrow:
// ONLY who ticketed it, the date-time stamp, the equipment item, and its
// location, nothing else (not the job/client, not the count) -- unlike
// every other "WORKSHOP BOARD UPDATE" note on this page, which includes
// the full field snapshot. Unticking just clears the local stamp -- no
// note, since there's nothing meaningful to tell the ticket about a
// checklist tick being taken back.
router.put('/equipment-checklist/:equipmentId/checked', (req, res) => {
  try {
    const equipmentId = Number(req.params.equipmentId);
    const existing = getEquipmentById(equipmentId);
    if (!existing) return res.status(404).json({ error: 'Equipment item not found.' });
    const checked = !!req.body?.checked;
    const actor = actorFrom(req);
    const updated = setEquipmentChecked(equipmentId, checked, actor);
    res.json({ equipment: shapeEquipmentRow(updated) });

    if (checked) {
      const job = getJob(existing.job_id);
      const stamp = new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane', dateStyle: 'medium', timeStyle: 'short' });
      const message = `Equipment checked by ${actor.name} on ${stamp}: ${existing.description || '(unnamed item)'} -- ${existing.location_note || '(no location set)'}.`;
      postWorkshopActionNote(job?.ticket_autotask_id, message, !!job?.skip_ticket_updates, req);
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// The standalone page itself -- a plain static file (not part of the SPA
// shell: no sidebar/nav, meant to be opened as its own window and left
// running on a dedicated device), same res.sendFile() pattern
// packages/shell/server.js's own /pages/:id/client.js route uses. Still
// behind this whole router's requireAuth gate (mounted in
// packages/shell/server.js before any /api/<page> router), so it's not
// reachable signed out.
router.get('/equipment-checklist/view', (req, res) => {
  res.sendFile(path.join(__dirname, 'equipment-checklist.html'));
});

// Usage Instructions box's own content, plus a second "Extended Help"
// page reached via the small help button in its bottom corner -- both
// admin-editable, by request ("have it be able to have 2 edit areas").
// Same plain JSON-file "runtime-configured state" pattern
// packages/shell/tab-page-server.js's own help-text.json already uses for
// this identical kind of thing (a small shared, admin-editable text blob
// every viewer sees the same version of) -- not the real SQLite database
// db.js otherwise uses for actual job/equipment records, which this isn't.
const HELP_CONTENT_PATH = path.join(__dirname, 'help-content.json');
// Seeded as the exact HTML the Usage Instructions box always used to show
// hardcoded in client.js -- so nothing looks any different for anyone
// until an admin actually edits it via the new button.
const DEFAULT_USAGE_INSTRUCTIONS_HTML = `<ul>
<li>The Workshop Status is about what's happening in the room -- what's in progress, up next, not started, etc. Anything else can be entered with the Free Text option.</li>
<li>The following Statuses can have free text added: Free Text, In Car, and Take Onsite.</li>
<li>When a ticket number is entered, the ticket will be updated with all item updates and information to date.</li>
<li>If a ticket number is changed, the old ticket will be noted with the new ticket number, and all historical info will be added to the new ticket.</li>
<li>The only ticket information drawn from Autotask using the ticket number is the Ticket Status and the Due Date.</li>
</ul>`;

function readHelpContent() {
  try {
    const data = JSON.parse(fs.readFileSync(HELP_CONTENT_PATH, 'utf8'));
    return {
      usageInstructions: typeof data.usageInstructions === 'string' ? data.usageInstructions : DEFAULT_USAGE_INSTRUCTIONS_HTML,
      extendedHelp: typeof data.extendedHelp === 'string' ? data.extendedHelp : '',
    };
  } catch {
    // No file yet, or unreadable -- nobody's ever saved via the editor.
    return { usageInstructions: DEFAULT_USAGE_INSTRUCTIONS_HTML, extendedHelp: '' };
  }
}

function writeHelpContent(usageInstructions, extendedHelp) {
  fs.writeFileSync(HELP_CONTENT_PATH, JSON.stringify({ usageInstructions, extendedHelp }, null, 2));
}

router.get('/help-content', (req, res) => {
  res.json({ ...readHelpContent(), editable: isDashboardAdmin(req) });
});

router.put('/help-content', (req, res) => {
  // Enforced here too, not just hidden in the UI -- same convention every
  // other admin-only write on this dashboard follows.
  if (!isDashboardAdmin(req)) {
    return res.status(403).json({ error: 'Only the dashboard admin can edit this.' });
  }
  if (typeof req.body?.usageInstructions !== 'string' || typeof req.body?.extendedHelp !== 'string') {
    return res.status(400).json({ error: 'Body must be { usageInstructions: string, extendedHelp: string }.' });
  }
  writeHelpContent(req.body.usageInstructions, req.body.extendedHelp);
  res.json({ ok: true });
});

module.exports = router;
