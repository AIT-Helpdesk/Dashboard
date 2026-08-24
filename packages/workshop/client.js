export const id = "workshop";
export const label = "Workshop Board";

// Module-scope, not inside mount() -- the shell tears down and re-mounts
// a page's DOM on every navigation, but the imported module itself stays
// alive for the session, same "restore instantly instead of a blank
// flash on revisit" convention every other page here uses.
let lastJobs = null;
let showCompleted = false;
// Two side-by-side tables instead of one, for wide screens -- by
// request, unticked by default. Persists across remounts, same
// convention as showCompleted above.
let twoColumns = false;

// Urgent/Complete/Nearly Complete/In Progress/Next Up/Not Started, by
// request -- a completion-progress scheme replacing the original
// time-urgency one (Today/Tomorrow/2-4 days/Over 4 days -- see db.js's
// own comment on the priority column for how existing data was
// remapped). Still a manually-chosen magnet -- plenty of jobs have no
// linked ticket at all, so it can't be purely computed from a due date.
const PRIORITY_LABELS = { urgent: 'Urgent', complete: 'Complete', nearly_complete: 'Nearly Complete', in_progress: 'In Progress', next_up: 'Next Up', not_started: 'Not Started' };
const PRIORITY_ORDER = ['urgent', 'complete', 'nearly_complete', 'in_progress', 'next_up', 'not_started'];
// Plain colour names, by request -- Black (default)/Red/Blue/Green. The
// stored values keep their original names (general/done/notewell) for
// the three pre-existing ones plus a new 'blue' -- only the labels here
// changed, so no data migration was needed for the two that already
// existed (see migrateAddBlueColorAndNewStages() in db.js for 'blue'
// itself).
const ACTION_COLOR_LABELS = { general: 'Black', notewell: 'Red', blue: 'Blue', done: 'Green' };
const ACTION_COLOR_ORDER = ['general', 'notewell', 'blue', 'done'];
// Workshop's own workflow stage -- replaces the old free-text Req'd By
// column, by request. Purely informational/workflow tracking -- reaching
// "Collected" here does NOT complete/archive the job on its own; that's
// still the separate, explicit Mark Complete tick (see
// rowActionButtonsHtml/wireRowActions below).
const WORKFLOW_STAGE_LABELS = {
  new: 'New',
  free_text: 'Free Text',
  in_car: 'In Car',
  ready_to_ship: 'Ready to Ship',
  ready_for_pickup: 'Ready for Pickup',
  sent: 'Sent',
  delivered: 'Delivered',
  collected: 'Collected',
};
const WORKFLOW_STAGE_ORDER = ['new', 'free_text', 'in_car', 'ready_to_ship', 'ready_for_pickup', 'sent', 'delivered', 'collected'];
// Stages with a companion free-text field -- 'free_text' (was
// 'date_reqd', type anything) and 'in_car' (whose car, by request) --
// see statusStageCellHtml()/openStatusStageEditor()/buildJobForm() below
// for where this drives showing/hiding the text field.
const TEXT_ENABLED_STAGES = ['free_text', 'in_car'];
const TEXT_ENABLED_PLACEHOLDERS = { free_text: 'Type anything...', in_car: "Whose car?" };
// Stages that read as "done and on its way out/gone", coloured green in
// the list, by request -- everything else stays the default text
// colour.
const GREEN_WORKFLOW_STAGES = ['ready_for_pickup', 'sent', 'delivered', 'collected'];

// audit_log's `field` values -> a human label for the history modal.
// 'created'/'completed'/'reopened' are whole-job events (see db.js's
// recordAudit calls); the rest are real column names.
const FIELD_LABELS = {
  created: 'Created',
  completed: 'Completed',
  reopened: 'Reopened',
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

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>Workshop Board</h1>
      <div class="date-form">
        <label style="display:inline-flex;align-items:center;gap:0.35rem;font-weight:normal;">
          <input type="checkbox" id="show-completed-toggle" /> Show Completed
        </label>
        <label style="display:inline-flex;align-items:center;gap:0.35rem;font-weight:normal;">
          <input type="checkbox" id="two-column-toggle" /> Show in 2 columns
        </label>
        <button type="button" id="refresh-button">Refresh</button>
        <button type="button" id="add-job-button" class="button-link">+ Add job</button>
      </div>
    </header>
    <p class="status">All equipment in the workshop (or in the responsibility of the workshop) must be identified, listed, ticketed and labelled. It's location, whether in the workshop, in the warehouse, or out with a repairer, must be known and noted.</p>

    <div id="job-form-container"></div>

    <p id="status" class="status">Loading...</p>
    <div id="results"></div>

    <div class="wsp-priority-legend">
      <span class="wsp-priority-legend-prefix">Workshop Status: </span>
      ${PRIORITY_ORDER.map((p) => `<span><span class="wsp-dot wsp-dot--${p}"></span>${escapeHtml(PRIORITY_LABELS[p])}</span>`).join('')}
    </div>
  `;

  const statusEl = container.querySelector('#status');
  const resultsEl = container.querySelector('#results');
  const formContainer = container.querySelector('#job-form-container');
  const addJobButton = container.querySelector('#add-job-button');
  const refreshButton = container.querySelector('#refresh-button');
  const showCompletedToggle = container.querySelector('#show-completed-toggle');
  const twoColumnToggle = container.querySelector('#two-column-toggle');

  showCompletedToggle.checked = showCompleted;
  twoColumnToggle.checked = twoColumns;

  addJobButton.addEventListener('click', () => openForm(null));
  refreshButton.addEventListener('click', () => loadJobs());
  showCompletedToggle.addEventListener('change', () => {
    showCompleted = showCompletedToggle.checked;
    loadJobs();
  });
  twoColumnToggle.addEventListener('change', () => {
    twoColumns = twoColumnToggle.checked;
    // Purely a re-layout of jobs already in memory -- no need to
    // re-fetch, same reasoning the filter input elsewhere on this
    // dashboard uses for an instant, no-round-trip re-render.
    if (lastJobs) renderResults(lastJobs);
  });

  async function loadJobs() {
    formContainer.innerHTML = '';
    refreshButton.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = 'Loading...';
    resultsEl.innerHTML = '';
    try {
      const res = await fetch(`/api/workshop/${showCompleted ? '?status=completed' : ''}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastJobs = data.jobs;
      statusEl.hidden = true;
      renderResults(data.jobs);
    } catch (err) {
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      refreshButton.disabled = false;
    }
  }

  function renderResults(jobs) {
    resultsEl.innerHTML = '';
    if (jobs.length === 0) {
      resultsEl.innerHTML = `<p class="status">${showCompleted ? 'No completed jobs yet.' : 'No open jobs -- add one to get started.'}</p>`;
      return;
    }
    // Two side-by-side tables on a very large screen, by request --
    // splits the already-sorted list in half sequentially (left column
    // gets the first/more-urgent half), not any fancier interleaving.
    // Just a re-layout of the same data, not a second fetch.
    if (twoColumns && jobs.length > 1) {
      const mid = Math.ceil(jobs.length / 2);
      const layout = document.createElement('div');
      layout.className = 'wsp-two-column-layout';
      layout.appendChild(buildTableGroup(jobs.slice(0, mid)));
      layout.appendChild(buildTableGroup(jobs.slice(mid)));
      resultsEl.appendChild(layout);
    } else {
      resultsEl.appendChild(buildTableGroup(jobs));
    }
  }

  function buildTableGroup(jobs) {
    const group = document.createElement('div');
    group.className = 'resource-group';
    group.innerHTML = `
      <table class="wsp-table">
        <thead>
          <tr class="shaded-row">
            <th class="wsp-col-status">Status</th>
            <th>Ticket</th>
            <th>Due Date</th>
            <th class="wsp-col-client">Client</th>
            <th>Current / Required Action</th>
            <th>Location</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${jobs.map(jobRowHtml).join('')}
        </tbody>
      </table>
    `;
    wireRowActions(group);
    return group;
  }

  function jobRowHtml(job) {
    const ticketCell = ticketCellHtml(job);
    const dueDateCell = dueDateCellHtml(job);
    // Prefer the linked ticket's real client over whatever's typed --
    // by request, once a ticket resolves, its own client is more
    // authoritative than the free-text Client field. The stored
    // `customer` value itself is untouched; this is display-only (see
    // withTicketDetails() in server.js).
    const client = job.ticketClientName
      ? `<span title="From ${escapeHtml(job.ticketNumber || 'linked ticket')}">${escapeHtml(job.ticketClientName)}</span>`
      : escapeHtml(job.customer) || '—';
    const actionCell = actionCellHtml(job);
    const location = escapeHtml(job.location) || '—';
    // The solid priority-colour bar runs the full width of the row, by
    // request -- left edge of the first (Status) cell, both sides of
    // Client/Action, and right edge of the last real-data cell (Location
    // -- there's no separate Priority column anymore, the dot in the
    // Status cell plus the legend under the table are the only priority
    // display now).
    return `
      <tr>
        <td class="wsp-col-status wsp-bar-left--${job.priority}">${statusStageCellHtml(job)}</td>
        <td>${ticketCell}</td>
        <td>${dueDateCell}</td>
        <td class="wsp-col-client wsp-row-tint--${job.priority} wsp-bar-left--${job.priority}">${client}</td>
        <td class="wsp-row-tint--${job.priority} wsp-bar-right--${job.priority}">${actionCell}</td>
        <td class="wsp-bar-right--${job.priority}">${location}</td>
        <td class="wsp-actions">${rowActionButtonsHtml(job)}</td>
      </tr>`;
  }

  // Job Description (bold) stacked above the actual Current/Required
  // Action text, both inside the same cell -- by request, this is a
  // display-only combination, not a separate table column; the two stay
  // separate real fields underneath (job_description/action_text), each
  // with its own audit trail entry.
  function actionCellHtml(job) {
    const descriptionLine = job.jobDescription ? `<div class="wsp-job-description">${escapeHtml(job.jobDescription)}</div>` : '';
    const actionLine = job.actionText ? `<div class="wsp-action-text--${job.actionColor}">${escapeHtml(job.actionText)}</div>` : '';
    return descriptionLine || actionLine ? `${descriptionLine}${actionLine}` : '—';
  }

  // A blank ticket shows the same em-dash as every other empty field. A
  // filled-in ticket that DIDN'T resolve to a real Autotask ticket (see
  // resolveTicketAutotaskId() in server.js -- blank, not-found, or
  // ambiguous all land here) still shows the typed text, just as plain
  // text with a tooltip explaining why it isn't a link, never a hard
  // error blocking the save.
  function ticketCellHtml(job) {
    if (!job.ticketNumber) return '—';
    if (job.ticketUrl) {
      // By request: the ticket's own current Autotask status, in small
      // print under the number, only when it actually resolved -- an
      // unresolved ticket has no real status to show (see
      // withTicketDetails() in server.js).
      const statusLine = job.ticketStatus ? `<div class="wsp-ticket-status">${escapeHtml(job.ticketStatus)}</div>` : '';
      return `<a href="${escapeHtml(job.ticketUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(job.ticketNumber)}</a>${statusLine}`;
    }
    return `<span title="Ticket not found in Autotask">${escapeHtml(job.ticketNumber)}</span>`;
  }

  // Red + bold when overdue (due date genuinely in the past) -- by
  // request. A blank due date (no ticket resolved, or the ticket has no
  // due date set) just shows the usual em-dash, unstyled.
  function dueDateCellHtml(job) {
    if (!job.ticketAutotaskId || !job.ticketDueDate) return '—';
    const overdue = new Date(job.ticketDueDate).getTime() < Date.now();
    const text = escapeHtml(formatDate(job.ticketDueDate));
    return overdue ? `<span class="wsp-overdue">${text}</span>` : text;
  }

  // Status (workflow stage) -- click-to-edit inline, same "no separate
  // form trip needed" reasoning as TC Elite Rollout's own cell editors:
  // by request, this is the field workshop staff update most often as a
  // job moves through the process, so it gets its own quick inline
  // dropdown rather than only being editable via the full Edit form
  // (though it's in that form too, for when editing everything else at
  // once). Reaching "Collected" here does NOT complete/archive the job
  // on its own -- that's still the separate Mark Complete tick.
  //
  // A bare priority-colour dot (no label -- see the legend under the
  // table for what each colour means) leads the cell, by request, so
  // the row's urgency is visible from the very first column.
  //
  // When the stage is 'free_text', the typed text itself is shown
  // instead of the generic "Free Text" label -- that's the whole point
  // of the option (e.g. a specific date, or "Deleted" for a soft-deleted
  // job -- see the trash icon's own handling below). 'in_car' keeps its
  // own "In Car" label but appends the typed text (whose car), by
  // request, rather than replacing it -- unlike free_text, "In Car" on
  // its own is still meaningful.
  //
  // Green text, by request, for the stages that read as "done and on
  // its way out/gone" (see GREEN_WORKFLOW_STAGES above) -- everything
  // else stays the default text colour.
  // Shared with the print card below (printJobCard()) -- one place for
  // the free_text/in_car label logic instead of duplicating it.
  function workflowStageLabel(job) {
    if (job.workflowStage === 'free_text' && job.workflowStageText) {
      return job.workflowStageText;
    }
    if (job.workflowStage === 'in_car' && job.workflowStageText) {
      return `In Car -- ${job.workflowStageText}`;
    }
    return WORKFLOW_STAGE_LABELS[job.workflowStage] || job.workflowStage;
  }

  function statusStageCellHtml(job) {
    const label = workflowStageLabel(job);
    const greenClass = GREEN_WORKFLOW_STAGES.includes(job.workflowStage) ? ' wsp-status-stage--green' : '';
    // The dot itself is its own click target -- by request, priority can
    // be re-triaged straight from the list (see openPriorityEditor()
    // below), independently of the Status/workflow-stage text next to it.
    return `<span class="wsp-priority-dot" data-id="${job.id}" data-value="${job.priority}" title="Click to change priority"><span class="wsp-dot wsp-dot--${job.priority}"></span></span><span class="wsp-status-stage${greenClass}" data-id="${job.id}" data-value="${job.workflowStage}" data-text="${escapeHtml(job.workflowStageText || '')}" title="Click to change">${escapeHtml(label)}</span>`;
  }

  function rowActionButtonsHtml(job) {
    const historyBtn = `<button type="button" class="wsp-icon-btn wsp-history-btn" data-id="${job.id}" title="View history">\u{1F553}</button>`;
    // Available in both views, by request -- reprinting a completed
    // job's card is a real thing too (e.g. it comes back for warranty
    // work), not just open ones.
    const printBtn = `<button type="button" class="wsp-icon-btn wsp-print-btn" data-id="${job.id}" title="Print job card">\u{1F5A8}️</button>`;
    if (showCompleted) {
      // Already completed/archived -- "send to completed" doesn't apply
      // here, so the trash icon in THIS view stays a genuine hard
      // delete (real rubbish bin icon, by request), for cleaning the
      // archive itself up (a duplicate/mistake that already got
      // completed). Requires a resolved ticket, by request -- the server
      // route rejects it either way, this just avoids the round trip and
      // tells staff why up front. See the DELETE route's own comment in
      // server.js.
      const canDelete = !!job.ticketAutotaskId;
      return `${historyBtn}${printBtn}
        <button type="button" class="wsp-icon-btn wsp-reopen-btn" data-id="${job.id}" title="Reopen">↺</button>
        <button type="button" class="wsp-icon-btn wsp-hard-delete-btn" data-id="${job.id}" title="${canDelete ? 'Permanently delete' : 'Cannot delete -- no linked ticket'}"${canDelete ? '' : ' disabled'}>\u{1F5D1}️</button>`;
    }
    return `${historyBtn}${printBtn}
      <button type="button" class="wsp-icon-btn wsp-edit-btn" data-id="${job.id}" title="Edit">✏️</button>
      <button type="button" class="wsp-icon-btn wsp-complete-btn" data-id="${job.id}" title="Mark complete">✅</button>
      <button type="button" class="wsp-icon-btn wsp-soft-delete-btn" data-id="${job.id}" title="Delete">❌</button>`;
  }

  function wireRowActions(group) {
    group.querySelectorAll('.wsp-edit-btn').forEach((btn) => {
      btn.addEventListener('click', () => openForm(findJob(btn.dataset.id)));
    });
    group.querySelectorAll('.wsp-complete-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Mark this job complete? It will move to the Show Completed archive.')) return;
        try {
          await fetchJson(`/api/workshop/jobs/${btn.dataset.id}/complete`, 'PATCH');
          await loadJobs();
        } catch (err) {
          alert(`Error: ${err.message}`);
        }
      });
    });
    group.querySelectorAll('.wsp-reopen-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await fetchJson(`/api/workshop/jobs/${btn.dataset.id}/reopen`, 'PATCH');
          await loadJobs();
        } catch (err) {
          alert(`Error: ${err.message}`);
        }
      });
    });
    group.querySelectorAll('.wsp-soft-delete-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this job? It will move to the Show Completed archive with status "Deleted" -- use Reopen there if this was a mistake.')) return;
        try {
          await fetchJson(`/api/workshop/jobs/${btn.dataset.id}/soft-delete`, 'PATCH');
          await loadJobs();
        } catch (err) {
          alert(`Error: ${err.message}`);
        }
      });
    });
    group.querySelectorAll('.wsp-hard-delete-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Permanently delete this job? This cannot be undone.')) return;
        try {
          await fetchJson(`/api/workshop/jobs/${btn.dataset.id}`, 'DELETE');
          await loadJobs();
        } catch (err) {
          alert(`Error: ${err.message}`);
        }
      });
    });
    group.querySelectorAll('.wsp-history-btn').forEach((btn) => {
      btn.addEventListener('click', () => openHistoryModal(btn.dataset.id, findJob(btn.dataset.id)));
    });
    group.querySelectorAll('.wsp-print-btn').forEach((btn) => {
      btn.addEventListener('click', () => printJobCard(findJob(btn.dataset.id)));
    });
    group.querySelectorAll('.wsp-status-stage').forEach((el) => {
      el.addEventListener('click', () => openStatusStageEditor(el));
    });
    group.querySelectorAll('.wsp-priority-dot').forEach((el) => {
      el.addEventListener('click', () => openPriorityEditor(el));
    });
  }

  // Swaps the plain priority dot for a <select> of the same 4 priority
  // tiers, focused and open -- by request, lets staff re-triage a job's
  // urgency straight from the list without opening the full Edit form.
  // Saves immediately on change (no separate Save button), same
  // "quick inline update" pattern as openStatusStageEditor() above.
  function openPriorityEditor(el) {
    if (el.querySelector('select')) return; // already open
    const currentValue = el.dataset.value;
    const jobId = el.dataset.id;
    el.innerHTML = `<select class="wsp-field wsp-priority-select">${PRIORITY_ORDER.map(
      (p) => `<option value="${p}"${p === currentValue ? ' selected' : ''}>${escapeHtml(PRIORITY_LABELS[p])}</option>`
    ).join('')}</select>`;
    const select = el.querySelector('select');
    // Same "don't re-trigger the click-to-open handler by bubbling" guard
    // openStatusStageEditor() uses.
    select.addEventListener('click', (e) => e.stopPropagation());
    select.addEventListener('change', async () => {
      try {
        await fetchJson(`/api/workshop/jobs/${jobId}`, 'PATCH', { priority: select.value });
        await loadJobs();
      } catch (err) {
        alert(`Error: ${err.message}`);
      }
    });
    select.focus();
  }

  // Swaps the plain Status text for a <select>, focused and open --
  // choosing a new value saves immediately (no separate Save button),
  // same "quick inline update" reasoning as statusStageCellHtml()'s own
  // comment above. The exception is the TEXT_ENABLED_STAGES ('free_text'
  // and 'in_car') -- picking either reveals a text input + its own small
  // save button instead of saving right away, since there's real text to
  // type first. Clicking elsewhere without changing anything just leaves
  // the select showing until the next loadJobs() re-render (harmless --
  // it still shows the correct current value).
  function openStatusStageEditor(el) {
    if (el.querySelector('select')) return; // already open
    const currentValue = el.dataset.value;
    const currentText = el.dataset.text;
    const jobId = el.dataset.id;
    el.innerHTML = `
      <select class="wsp-field wsp-status-stage-select">${WORKFLOW_STAGE_ORDER.map(
        (s) => `<option value="${s}"${s === currentValue ? ' selected' : ''}>${escapeHtml(WORKFLOW_STAGE_LABELS[s])}</option>`
      ).join('')}</select>
      <span class="wsp-status-stage-text-wrap"${TEXT_ENABLED_STAGES.includes(currentValue) ? '' : ' hidden'}>
        <input type="text" class="wsp-field wsp-status-stage-text" value="${escapeHtml(currentText)}" placeholder="${escapeHtml(TEXT_ENABLED_PLACEHOLDERS[currentValue] || '')}" />
        <button type="button" class="wsp-icon-btn" title="Save">✓</button>
      </span>
    `;
    const select = el.querySelector('select');
    const textWrap = el.querySelector('.wsp-status-stage-text-wrap');
    const textInput = el.querySelector('.wsp-status-stage-text');
    const saveTextButton = el.querySelector('.wsp-status-stage-text-wrap .wsp-icon-btn');

    // Clicking anything inside this editor shouldn't re-trigger
    // openStatusStageEditor by bubbling back up to the cell's own click
    // listener (see wireRowActions).
    el.querySelectorAll('select, input, button').forEach((child) => child.addEventListener('click', (e) => e.stopPropagation()));

    select.addEventListener('change', async () => {
      if (TEXT_ENABLED_STAGES.includes(select.value)) {
        textInput.placeholder = TEXT_ENABLED_PLACEHOLDERS[select.value] || '';
        textWrap.hidden = false;
        textInput.focus();
        return; // wait for the explicit save below, there's real text to enter first
      }
      try {
        await fetchJson(`/api/workshop/jobs/${jobId}`, 'PATCH', { workflowStage: select.value });
        await loadJobs();
      } catch (err) {
        alert(`Error: ${err.message}`);
      }
    });

    async function saveText() {
      try {
        await fetchJson(`/api/workshop/jobs/${jobId}`, 'PATCH', { workflowStage: select.value, workflowStageText: textInput.value.trim() });
        await loadJobs();
      } catch (err) {
        alert(`Error: ${err.message}`);
      }
    }
    saveTextButton.addEventListener('click', saveText);
    textInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveText();
    });

    select.focus();
  }

  function findJob(jobId) {
    return (lastJobs || []).find((j) => String(j.id) === String(jobId));
  }

  // ---- Add/Edit job form -- one shared form for both, matching the
  // mockup's "Edit job" layout exactly (Add job is the same form, just
  // starting blank with the defaults new jobs seed to). ----
  function openForm(existingJob) {
    formContainer.innerHTML = '';
    formContainer.appendChild(buildJobForm(existingJob));
    formContainer.querySelector('.wsp-field').focus();
  }

  function buildJobForm(existingJob) {
    const isEdit = !!existingJob;
    const wrapper = document.createElement('div');
    wrapper.className = 'resource-group wsp-job-form';
    wrapper.innerHTML = `
      <div class="section-heading section-heading--nav">${isEdit ? 'Edit job' : 'Add job'}</div>
      <div class="wsp-form-body">
        <div class="wsp-form-grid">
          <label>Status
            <select class="wsp-field" data-field="workflowStage" id="form-workflow-stage">
              ${WORKFLOW_STAGE_ORDER.map((s) => `<option value="${s}"${isSelected(existingJob?.workflowStage, s, 'new')}>${escapeHtml(WORKFLOW_STAGE_LABELS[s])}</option>`).join('')}
            </select>
          </label>
          <label>Priority (magnet)
            <select class="wsp-field" data-field="priority">
              ${PRIORITY_ORDER.map((p) => `<option value="${p}"${isSelected(existingJob?.priority, p, 'not_started')}>${escapeHtml(PRIORITY_LABELS[p])}</option>`).join('')}
            </select>
          </label>
          <label>Job description
            <input type="text" class="wsp-field" data-field="jobDescription" value="${escapeHtml(existingJob?.jobDescription || '')}" />
          </label>
          <label>Note colour (pen)
            <select class="wsp-field" data-field="actionColor">
              ${ACTION_COLOR_ORDER.map((c) => `<option value="${c}"${isSelected(existingJob?.actionColor, c, 'general')}>${escapeHtml(ACTION_COLOR_LABELS[c])}</option>`).join('')}
            </select>
          </label>
          <label>Ticket
            <input type="text" class="wsp-field" data-field="ticketNumber" value="${escapeHtml(existingJob?.ticketNumber || '')}" />
          </label>
          <label>Client
            <input type="text" class="wsp-field" data-field="customer" value="${escapeHtml(existingJob?.customer || '')}" />
          </label>
          <label>Location
            <input type="text" class="wsp-field" data-field="location" value="${escapeHtml(existingJob?.location || '')}" />
          </label>
          <label id="form-workflow-stage-text-wrap"${TEXT_ENABLED_STAGES.includes(existingJob?.workflowStage) ? '' : ' hidden'}>Status detail
            <input type="text" class="wsp-field" data-field="workflowStageText" value="${escapeHtml(existingJob?.workflowStageText || '')}" placeholder="${escapeHtml(TEXT_ENABLED_PLACEHOLDERS[existingJob?.workflowStage] || '')}" />
          </label>
          <label>Current / required action
            <textarea class="wsp-field" data-field="actionText" rows="3">${escapeHtml(existingJob?.actionText || '')}</textarea>
          </label>
        </div>
        <p class="status error wsp-form-error" hidden></p>
        <div class="wsp-form-actions">
          <button type="button" class="button-link wsp-save-button">Save</button>
          <button type="button" class="wsp-cancel-button">Cancel</button>
        </div>
      </div>
    `;

    // Show/hide the free-text companion field alongside the Status
    // select -- and CLEAR its value when hiding it, not just visually
    // hide it, since the save handler below collects every [data-field]
    // element's value regardless of visibility. Without clearing it, a
    // job that WAS on a text-enabled stage with real text, then switched
    // to a different Status in this form, would silently keep submitting
    // the old (now-hidden) text alongside the new stage. The placeholder
    // also swaps to match which stage is picked (free_text vs in_car).
    const workflowStageSelect = wrapper.querySelector('#form-workflow-stage');
    const workflowStageTextWrap = wrapper.querySelector('#form-workflow-stage-text-wrap');
    workflowStageSelect.addEventListener('change', () => {
      const isTextEnabled = TEXT_ENABLED_STAGES.includes(workflowStageSelect.value);
      workflowStageTextWrap.hidden = !isTextEnabled;
      const textInput = workflowStageTextWrap.querySelector('input');
      textInput.placeholder = TEXT_ENABLED_PLACEHOLDERS[workflowStageSelect.value] || '';
      if (!isTextEnabled) textInput.value = '';
    });

    wrapper.querySelector('.wsp-cancel-button').addEventListener('click', () => {
      formContainer.innerHTML = '';
    });
    wrapper.querySelector('.wsp-save-button').addEventListener('click', async () => {
      const errorEl = wrapper.querySelector('.wsp-form-error');
      errorEl.hidden = true;
      const fields = {};
      wrapper.querySelectorAll('[data-field]').forEach((el) => {
        fields[el.dataset.field] = el.value.trim();
      });
      try {
        if (isEdit) {
          await fetchJson(`/api/workshop/jobs/${existingJob.id}`, 'PATCH', fields);
        } else {
          await fetchJson('/api/workshop/jobs', 'POST', fields);
        }
        formContainer.innerHTML = '';
        await loadJobs();
      } catch (err) {
        errorEl.hidden = false;
        errorEl.textContent = `Error: ${err.message}`;
      }
    });

    return wrapper;
  }

  function isSelected(currentValue, optionValue, defaultValue) {
    const effective = currentValue === undefined ? defaultValue : currentValue;
    return effective === optionValue ? ' selected' : '';
  }

  // ---- Print job card -- opens a new browser tab/window containing a
  // single self-contained A5-sized HTML document for one job, then
  // triggers the browser's own print dialog (window.print()) -- by
  // request, deliberately NOT a custom print pipeline: the browser's own
  // print dialog already lets staff pick a real printer OR "Save as
  // PDF" as the destination, which is exactly what was asked for, with
  // zero extra plumbing. A separate window (not an overlay inside this
  // page) so the shell's own on-screen styles/nav never leak into the
  // printed page, and the card's own <style> only has to describe
  // itself. ----
  function printJobCard(job) {
    if (!job) return;
    const win = window.open('', '_blank', 'width=580,height=780');
    if (!win) {
      alert('Please allow pop-ups for this site to print a job card.');
      return;
    }
    win.document.write(buildPrintCardHtml(job));
    win.document.close();
    win.focus();
    // Give the new document a moment to finish laying out before
    // triggering print -- calling window.print() before onload can open
    // a blank/partial print preview in some browsers.
    win.onload = () => {
      win.print();
    };
  }

  // "Client name from the Ticket with anything manually entered after
  // that in brackets", by request -- deliberately different from the
  // list row's own Client cell (which shows the ticket's name alone,
  // with the typed value only in a tooltip): the printed card is a
  // physical record that leaves the screen, so both values are worth
  // keeping visible on it together.
  function printClientText(job) {
    if (job.ticketClientName) {
      return job.customer ? `${job.ticketClientName} (${job.customer})` : job.ticketClientName;
    }
    return job.customer || '—';
  }

  const PRINT_PRIORITY_DOT_COLORS = { urgent: '#dc2626', complete: '#16a34a', nearly_complete: '#2563eb', in_progress: '#f97316', next_up: '#8b5cf6', not_started: '#6b7280' };
  const PRINT_ACTION_COLORS = { general: '#111827', notewell: '#dc2626', blue: '#2563eb', done: '#16a34a' };

  function buildPrintCardHtml(job) {
    const priorityLabel = PRIORITY_LABELS[job.priority] || job.priority;
    const priorityDotColor = PRINT_PRIORITY_DOT_COLORS[job.priority] || '#6b7280';
    const statusLabel = workflowStageLabel(job);
    const overdue = job.ticketDueDate && new Date(job.ticketDueDate).getTime() < Date.now();
    const dueDateText = job.ticketDueDate ? formatDate(job.ticketDueDate) : '—';
    const dueDateValue = overdue ? `<span class="wspp-overdue">${escapeHtml(dueDateText)}</span>` : escapeHtml(dueDateText);
    const ticketValue = job.ticketNumber
      ? `${escapeHtml(job.ticketNumber)}${job.ticketStatus ? ` <span class="wspp-muted">(${escapeHtml(job.ticketStatus)})</span>` : ''}`
      : '—';
    const actionValue = job.actionText
      ? `<span style="color:${PRINT_ACTION_COLORS[job.actionColor] || PRINT_ACTION_COLORS.general}">${escapeHtml(job.actionText)}</span>`
      : '—';
    const printedAt = escapeHtml(new Date().toLocaleString());
    const docTitle = `Workshop Job -- ${job.ticketNumber || job.customer || `Job #${job.id}`}`;

    const row = (label, valueHtml) => `
      <div class="wspp-row">
        <div class="wspp-label">${escapeHtml(label)}</div>
        <div class="wspp-value">${valueHtml}</div>
      </div>`;

    return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${escapeHtml(docTitle)}</title>
<style>
  @page { size: A5; margin: 12mm; }
  * { box-sizing: border-box; }
  body {
    font-family: system-ui, -apple-system, "Segoe UI", Arial, sans-serif;
    color: #111827;
    margin: 0;
  }
  .wspp-card { padding: 4mm; }
  .wspp-title { font-size: 1.1rem; font-weight: 700; margin: 0 0 2mm; }
  .wspp-sub { font-size: 0.75rem; color: #6b7280; margin: 0 0 5mm; }
  .wspp-row { display: flex; gap: 3mm; padding: 1.6mm 0; border-bottom: 1px solid #e5e7eb; }
  .wspp-label { width: 32mm; flex: none; font-size: 0.75rem; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.02em; }
  .wspp-value { flex: 1; font-size: 0.9rem; word-break: break-word; }
  .wspp-muted { color: #6b7280; font-weight: 400; text-transform: none; }
  .wspp-overdue { color: #dc2626; font-weight: 700; }
  .wspp-dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 1.5mm; vertical-align: middle; background: ${priorityDotColor}; }
  .wspp-footer { margin-top: 6mm; font-size: 0.7rem; color: #9ca3af; }
  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
</style>
</head>
<body>
  <div class="wspp-card">
    <p class="wspp-title">Workshop Job Card</p>
    <p class="wspp-sub">Job #${job.id}</p>
    ${row('Ticket', ticketValue)}
    ${row('Due date', dueDateValue)}
    ${row('Client', escapeHtml(printClientText(job)))}
    ${row('Status', escapeHtml(statusLabel))}
    ${row('Priority', `<span class="wspp-dot"></span>${escapeHtml(priorityLabel)}`)}
    ${row('Location', escapeHtml(job.location) || '—')}
    ${row('Job description', escapeHtml(job.jobDescription) || '—')}
    ${row('Current / required action', actionValue)}
    <p class="wspp-footer">Printed ${printedAt}</p>
  </div>
</body>
</html>`;
  }

  // ---- History modal -- reuses the shared .history-modal-* classes
  // TC Elite Rollout's own per-cell history window uses (see
  // packages/shell/public/styles.css), same overlay+panel shape, just a
  // per-job audit trail instead of a per-cell one. ----
  async function openHistoryModal(jobId, job) {
    const overlay = document.createElement('div');
    overlay.className = 'history-modal-overlay';
    const title = job ? job.ticketClientName || job.customer || `Job #${jobId}` : `Job #${jobId}`;
    overlay.innerHTML = `
      <div class="history-modal-panel">
        <div class="history-modal-panel-header">
          <span>${escapeHtml(title)} -- History</span>
          <button type="button" class="history-modal-close" aria-label="Close">✕</button>
        </div>
        <div class="history-modal-body"><p class="status">Loading...</p></div>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKeydown);
    };
    function onKeydown(e) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('keydown', onKeydown);
    overlay.querySelector('.history-modal-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    try {
      const res = await fetch(`/api/workshop/jobs/${jobId}/history`);
      const data = await res.json();
      const body = overlay.querySelector('.history-modal-body');
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      if (!data.history || data.history.length === 0) {
        body.innerHTML = '<p class="status">No history found.</p>';
        return;
      }
      body.innerHTML = `<ul class="history-modal-list">${data.history.map(historyEntryHtml).join('')}</ul>`;
    } catch (err) {
      overlay.querySelector('.history-modal-body').innerHTML = `<p class="status error">Error: ${escapeHtml(err.message)}</p>`;
    }
  }

  function historyEntryHtml(entry) {
    const label = FIELD_LABELS[entry.field] || entry.field;
    let changeText;
    if (entry.field === 'created' || entry.field === 'completed' || entry.field === 'reopened') {
      changeText = escapeHtml(label);
    } else if (entry.field === 'priority') {
      changeText = `${escapeHtml(label)}: ${valueChangeHtml(entry, PRIORITY_LABELS)}`;
    } else if (entry.field === 'action_color') {
      changeText = `${escapeHtml(label)}: ${valueChangeHtml(entry, ACTION_COLOR_LABELS)}`;
    } else if (entry.field === 'workflow_stage') {
      changeText = `${escapeHtml(label)}: ${valueChangeHtml(entry, WORKFLOW_STAGE_LABELS)}`;
    } else {
      changeText = `${escapeHtml(label)}: ${valueChangeHtml(entry, null)}`;
    }
    const when = `${escapeHtml(entry.changedByName)} -- ${escapeHtml(formatDateTime(entry.changedAt))}`;
    return `<li class="history-modal-entry"><div>${changeText}</div><div class="history-modal-when">${when}</div></li>`;
  }

  function valueChangeHtml(entry, labelMap) {
    const label = (v) => (v ? (labelMap ? labelMap[v] || v : v) : '(blank)');
    const oldLabel = label(entry.oldValue);
    const newLabel = label(entry.newValue);
    return `${escapeHtml(oldLabel)} &rarr; ${escapeHtml(newLabel)}`;
  }

  async function fetchJson(url, method, body) {
    const res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    if (res.status !== 204) data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
    return data;
  }

  if (lastJobs) {
    statusEl.hidden = true;
    renderResults(lastJobs);
  } else {
    loadJobs();
  }
}

function formatDateTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString();
}

// Date-only, for the Ticket Due Date column -- a workshop pickup
// deadline reads as a day, not a precise time.
function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString();
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
