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
// "Mobile View" -- hides the Ticket/Due Date columns together, as one
// set, across every table on the page (main list, both halves in
// 2-column mode, and the separate Dispose table) -- by request, unticked
// by default. Completion (Actions) stays visible even in Mobile View, by
// request. Pure CSS (see .wsp-mobile-view in styles.css) rather than
// anything per-table, so this stays in sync automatically no matter how
// many tables are currently rendered. Persists across remounts, same
// convention as showCompleted/twoColumns
// above.
let mobileView = false;
// "Rotation View" -- hides the Completion (buttons) column, by request,
// specifically for unattended display during a Rotate cycle (see
// packages/shell/public/app.js's own Rotate feature) where nobody is
// there to click those buttons anyway. Unticked by default for a normal
// visit, same persists-across-remounts convention as the toggles above
// -- forced to true the moment a Rotate cycle turns ON, and forced back
// to false the moment it turns OFF, by request, via the
// dashboard-rotate-active-change listener just below (fired once per
// actual transition by app.js's renderRotateControls(), regardless of
// whether Workshop happens to be the mounted page at that exact moment).
// Deliberately ONLY reacts to that transition, never re-forced on a
// later mount() while a rotation is already running (see mount()'s own
// comment on why that was tried and reverted) -- otherwise a user who
// manually unticks it mid-rotation would see it silently flip back on
// the next time Workshop is rotated back to.
let rotationView = false;
// Live DOM refs for the currently-mounted page's own Rotation View
// checkbox/wrapper, kept up to date at the top of mount() below (null
// while Workshop isn't the mounted page at all). Lets the
// dashboard-rotate-active-change listener just below react immediately
// even when Workshop is already the VISIBLE page the moment Rotate
// turns on/off -- see that listener's own comment, and app.js's own
// comment on why it dispatches this event, for the full picture of why
// mount()'s own data-rotate-active check alone isn't enough (that only
// covers being ROTATED TO, never the page already on screen).
let activeRotationViewToggle = null;
let activeWspPageEl = null;
// Global, not per-mount -- added once when this module first loads, same
// "module scope, persists for the session" convention as the state
// variables above, so remounting Workshop never stacks up duplicate
// listeners. Mirrors rotationActive exactly both ways, by request: ticks
// ON the moment Rotate starts, unticks OFF the moment it stops --
// whether or not Workshop happens to be the mounted page either time.
document.addEventListener('dashboard-rotate-active-change', (e) => {
  rotationView = e.detail.active;
  if (activeRotationViewToggle) activeRotationViewToggle.checked = rotationView;
  if (activeWspPageEl) activeWspPageEl.classList.toggle('wsp-rotation-view', rotationView);
});
// "Show Workshop Gear" -- off by default, by request. Jobs in the
// 'workshop_gear' stage are excluded from the main table unconditionally
// (unlike 'dispose', which always shows in its own table when non-empty),
// and only appear in their own separate table, at the very bottom of the
// page, while this is ticked. Persists across remounts, same convention
// as showCompleted/twoColumns/mobileView above -- a content-filtering
// preference, not a transient UI state like bottomPanelsCollapsed below.
let showWorkshopGear = false;
// The bottom-right "Deliveries" panel's own cached data -- same "restore
// instantly instead of a blank flash on revisit" convention as lastJobs
// above. A genuine cross-page read (this page's own client.js fetches
// Goods Received's real GET /api/packages-received/ directly, see
// loadDeliveriesPreview() below) rather than duplicating any data/logic.
let lastDeliveriesPreview = null;

// Urgent/Complete/Nearly Complete/In Progress/Next Up/Coming/Not
// Started, by request -- a completion-progress scheme replacing the
// original time-urgency one (Today/Tomorrow/2-4 days/Over 4 days -- see
// db.js's own comment on the priority column for how existing data was
// remapped). Still a manually-chosen magnet -- plenty of jobs have no
// linked ticket at all, so it can't be purely computed from a due date.
const PRIORITY_LABELS = { urgent: 'Urgent', complete: 'Complete', nearly_complete: 'Nearly Complete', in_progress: 'In Progress', next_up: 'Next Up', coming: 'Coming', not_started: 'Not Started' };
const PRIORITY_ORDER = ['urgent', 'complete', 'nearly_complete', 'in_progress', 'next_up', 'not_started', 'coming'];
// Client/Current-Required-Action background tint applies to these
// tiers only, by request -- Coming and Not Started stay unshaded (the
// bars still carry their colour either way).
const TINTED_PRIORITIES = ['urgent', 'complete', 'nearly_complete', 'in_progress', 'next_up'];
// Plain colour names, by request -- Black (default)/Red/Blue/Green. The
// stored values keep their original names (general/done/notewell) for
// the three pre-existing ones plus a new 'blue' -- only the labels here
// changed, so no data migration was needed for the two that already
// existed (see migrateAddBlueColorAndNewStages() in db.js for 'blue'
// itself).
const ACTION_COLOR_LABELS = { general: 'Black', notewell: 'Red', blue: 'Blue', done: 'Green' };
// For the History modal's skip_ticket_updates entries -- audit_log stores
// the raw 0/1 (as strings, see recordAudit()'s own String() coercion in
// db.js), this just renders that as Yes/No instead of a bare digit.
const YES_NO_LABELS = { '0': 'No', '1': 'Yes' };
const ACTION_COLOR_ORDER = ['general', 'notewell', 'blue', 'done'];
// Matches the .wsp-action-text--* CSS classes, for the Pen Colour live
// preview on the Add/Edit form (see buildJobForm()) -- the form applies
// these directly as inline styles rather than swapping classes, since the
// previewed fields (Client/Location inputs, the action textarea) aren't
// styled via .wsp-action-text-- themselves.
const ACTION_COLOR_HEX = { general: 'var(--fg)', notewell: '#dc2626', blue: 'var(--accent)', done: '#16a34a' };
// Workshop's own workflow stage -- replaces the old free-text Req'd By
// column, by request. Purely informational/workflow tracking -- reaching
// "Collected" here does NOT complete/archive the job on its own; that's
// still the separate, explicit Mark Complete tick (see
// rowActionButtonsHtml/wireRowActions below).
const WORKFLOW_STAGE_LABELS = {
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
  // Gear that lives in/belongs to the workshop itself, not a specific
  // client job, by request. Like 'dispose', excluded from the main table
  // entirely and shown in its own separate table -- but unlike 'dispose'
  // (always shown when there's anything in it), this one is hidden by
  // default behind its own checkbox at the bottom of the page (see
  // showWorkshopGear below).
  workshop_gear: 'Workshop Gear',
};
const WORKFLOW_STAGE_ORDER = ['new', 'free_text', 'in_car', 'take_onsite', 'ready_to_ship', 'ready_for_pickup', 'sent', 'delivered', 'collected', 'dispose', 'workshop_gear'];
// Stages with a companion free-text field -- 'free_text' (was
// 'date_reqd', type anything), 'in_car' (whose car), and 'take_onsite'
// (who took it onsite), by request -- see
// statusStageCellHtml()/openStatusStageEditor()/buildJobForm() below
// for where this drives showing/hiding the text field.
const TEXT_ENABLED_STAGES = ['free_text', 'in_car', 'take_onsite'];
const TEXT_ENABLED_PLACEHOLDERS = { free_text: 'Type anything...', in_car: "Whose car?", take_onsite: 'Who?' };
// Stages that read as "done and on its way out/gone", coloured green in
// the list, by request -- everything else stays the default text
// colour.
const GREEN_WORKFLOW_STAGES = ['ready_for_pickup', 'sent', 'delivered', 'collected'];
// Stages that read as "not yet actioned/still waiting on the workshop",
// coloured red in the list, by request. 'in_car'/'take_onsite' are
// special-cased further in statusStageCellHtml() below -- only the
// stage NAME renders red, the WHO text after it renders in the default
// colour, by request (see SPLIT_COLOR_STAGES below), rather than the
// whole label being uniformly red the way it is here for 'new'/
// 'ready_to_ship'.
const RED_WORKFLOW_STAGES = ['new', 'ready_to_ship', 'in_car', 'take_onsite'];
// The subset of RED_WORKFLOW_STAGES that split their colouring once
// there's real WHO text -- see statusStageCellHtml() below.
const SPLIT_COLOR_STAGES = ['in_car', 'take_onsite'];

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
  flag_note: 'Question',
  flag_answer: 'Answer',
  equipment: 'Equipment',
  skip_ticket_updates: 'Skip ticket update',
};

export function mount(container) {
  container.innerHTML = `
    <div class="wsp-page">
      <header class="page-header">
        <div class="wsp-usage-box wsp-intro-box">
          <p>All equipment in the workshop (or in the responsibility of the workshop) must be identified, listed, ticketed and labelled. It's location, whether in the workshop, in the warehouse, or out with a repairer, must be known and noted. <span class="wsp-status-caveat">This board does not replace ticket management. Tickets notes only are updated, not status.</span></p>
        </div>
        <div class="date-form date-form--stacked wsp-controls">
          <div class="date-form-row">
            <button type="button" id="refresh-button">Refresh</button>
            <button type="button" id="add-job-button" class="button-link">+ Add job</button>
            <button type="button" id="equipment-checklist-button" class="button-link">Equipment Checklist</button>
          </div>
          <div class="date-form-row">
            <label style="display:inline-flex;align-items:center;gap:0.35rem;font-weight:normal;">
              <input type="checkbox" id="show-completed-toggle" /> Show Completed
            </label>
            <label class="wsp-two-column-toggle-label" style="display:inline-flex;align-items:center;gap:0.35rem;font-weight:normal;">
              <input type="checkbox" id="two-column-toggle" /> Show in 2 columns
            </label>
            <label style="display:inline-flex;align-items:center;gap:0.35rem;font-weight:normal;">
              <input type="checkbox" id="mobile-view-toggle" data-auto-mobile-view /> Mobile View
            </label>
            <label style="display:inline-flex;align-items:center;gap:0.35rem;font-weight:normal;">
              <input type="checkbox" id="rotation-view-toggle" /> Rotation View
            </label>
          </div>
        </div>
      </header>

      <div id="job-form-container"></div>

      <p id="status" class="status">Loading...</p>
      <div id="results"></div>

      <div class="wsp-priority-legend" id="priority-legend"></div>

      <div id="dispose-results"></div>

      <div class="date-form-row wsp-workshop-gear-toggle-row">
        <label style="display:inline-flex;align-items:center;gap:0.35rem;font-weight:normal;font-size:0.85rem;">
          <input type="checkbox" id="show-workshop-gear-toggle" /> Show Workshop Gear
        </label>
      </div>
      <div id="workshop-gear-results"></div>

      <div class="wsp-bottom-panels" id="bottom-panels">
        <div class="wsp-usage-box">
          <div class="wsp-usage-box-title">
            Usage instructions
            <button type="button" class="wsp-icon-btn wsp-bottom-panels-toggle" id="bottom-panels-toggle" title="Minimize">−</button>
          </div>
          <ul>
            <li>The Workshop Status is about what's happening in the room -- what's in progress, up next, not started, etc. Anything else can be entered with the Free Text option.</li>
            <li>The following Statuses can have free text added: Free Text, In Car, and Take Onsite.</li>
            <li>When a ticket number is entered, the ticket will be updated with all item updates and information to date.</li>
            <li>If a ticket number is changed, the old ticket will be noted with the new ticket number, and all historical info will be added to the new ticket.</li>
            <li>The only ticket information drawn from Autotask using the ticket number is the Ticket Status and the Due Date.</li>
          </ul>
        </div>
        <a href="#packages-received" class="wsp-usage-box wsp-deliveries-box wsp-deliveries-link" title="Open Goods Received">
          <div id="deliveries-preview" class="wsp-deliveries-body"><p class="wsp-deliveries-placeholder">Loading...</p></div>
        </a>
      </div>
    </div>
  `;

  const statusEl = container.querySelector('#status');
  const resultsEl = container.querySelector('#results');
  const disposeResultsEl = container.querySelector('#dispose-results');
  const showWorkshopGearToggle = container.querySelector('#show-workshop-gear-toggle');
  const workshopGearResultsEl = container.querySelector('#workshop-gear-results');
  const legendEl = container.querySelector('#priority-legend');
  const formContainer = container.querySelector('#job-form-container');
  const addJobButton = container.querySelector('#add-job-button');
  const equipmentChecklistButton = container.querySelector('#equipment-checklist-button');
  const refreshButton = container.querySelector('#refresh-button');
  const showCompletedToggle = container.querySelector('#show-completed-toggle');
  const twoColumnToggle = container.querySelector('#two-column-toggle');
  const mobileViewToggle = container.querySelector('#mobile-view-toggle');
  const rotationViewToggle = container.querySelector('#rotation-view-toggle');
  const wspPageEl = container.querySelector('.wsp-page');
  const bottomPanelsEl = container.querySelector('#bottom-panels');
  const bottomPanelsToggle = container.querySelector('#bottom-panels-toggle');
  const deliveriesPreviewEl = container.querySelector('#deliveries-preview');

  // See these two module-scope vars' own declaration above -- keeps the
  // dashboard-rotate-active-change listener able to reach this specific
  // mount's own elements.
  activeRotationViewToggle = rotationViewToggle;
  activeWspPageEl = wspPageEl;

  showCompletedToggle.checked = showCompleted;
  twoColumnToggle.checked = twoColumns;
  mobileViewToggle.checked = mobileView;
  showWorkshopGearToggle.checked = showWorkshopGear;
  wspPageEl.classList.toggle('wsp-mobile-view', mobileView);
  // Deliberately NOT re-checking documentElement's data-rotate-active
  // attribute here on every mount -- that was tried first and caused a
  // real bug: it forced Rotation View back ON every time Workshop was
  // rotated BACK to, even after the user had deliberately unticked it
  // mid-rotation, since every rotation cycle back to this page is a
  // fresh mount(). rotationView (module-scope, persists across remounts
  // same as every other toggle here) is set once, at the actual ON/OFF
  // TRANSITION, by the dashboard-rotate-active-change listener above --
  // that already covers "was already true before this mount" correctly
  // too (the listener ran once when rotation first started, whether or
  // not Workshop happened to be mounted at that moment), so this mount()
  // just reads whatever rotationView already is, exactly like every
  // other toggle on this page.
  rotationViewToggle.checked = rotationView;
  wspPageEl.classList.toggle('wsp-rotation-view', rotationView);

  // Deliberately a plain local variable, not module-scope like
  // showCompleted/twoColumns above -- by request, any refresh of this
  // page (including just navigating away and back within the SPA, since
  // mount() runs fresh each time) should always restore both panels
  // maximized, never remember a collapsed state.
  let bottomPanelsCollapsed = false;
  bottomPanelsToggle.addEventListener('click', () => {
    bottomPanelsCollapsed = !bottomPanelsCollapsed;
    bottomPanelsEl.classList.toggle('wsp-bottom-panels--collapsed', bottomPanelsCollapsed);
    bottomPanelsToggle.textContent = bottomPanelsCollapsed ? '+' : '−';
    bottomPanelsToggle.title = bottomPanelsCollapsed ? 'Maximize' : 'Minimize';
  });

  addJobButton.addEventListener('click', () => openForm(null));
  // A real separate window, not an in-page modal -- by request, this is
  // meant to be left open on its own device in the workshop (a mounted
  // tablet), polling on its own, independent of whether this SPA tab stays
  // open. A dedicated named window (not '_blank') so clicking this button
  // again re-focuses the same window instead of stacking up duplicates.
  equipmentChecklistButton.addEventListener('click', () => {
    window.open('/api/workshop/equipment-checklist/view', 'workshop-equipment-checklist', 'width=480,height=900,scrollbars=yes');
  });
  refreshButton.addEventListener('click', () => {
    loadJobs();
    loadDeliveriesPreview();
  });
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
  mobileViewToggle.addEventListener('change', () => {
    mobileView = mobileViewToggle.checked;
    // Just a class toggle -- the CSS (.wsp-mobile-view in styles.css)
    // handles hiding the columns in every currently-rendered table at
    // once, no re-render needed.
    wspPageEl.classList.toggle('wsp-mobile-view', mobileView);
  });
  rotationViewToggle.addEventListener('change', () => {
    rotationView = rotationViewToggle.checked;
    // Same "just a class toggle, no re-render needed" pattern as Mobile
    // View above -- .wsp-rotation-view (styles.css) hides the Completion
    // column in every currently-rendered table at once.
    wspPageEl.classList.toggle('wsp-rotation-view', rotationView);
  });
  showWorkshopGearToggle.addEventListener('change', () => {
    showWorkshopGear = showWorkshopGearToggle.checked;
    // Same "purely a re-layout of jobs already in memory" reasoning as
    // twoColumnToggle above -- Workshop Gear jobs are already in
    // lastJobs (the server never filters them out), this just changes
    // whether renderResults() draws their table or not.
    if (lastJobs) renderResults(lastJobs);
  });

  async function loadJobs() {
    formContainer.innerHTML = '';
    refreshButton.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = 'Loading...';
    resultsEl.innerHTML = '';
    disposeResultsEl.innerHTML = '';
    workshopGearResultsEl.innerHTML = '';
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

  function legendHtml() {
    return `<span class="wsp-priority-legend-prefix">Workshop Status: </span>${PRIORITY_ORDER.map(
      (p) => `<span><span class="wsp-dot wsp-dot--${p}"></span>${escapeHtml(PRIORITY_LABELS[p])}</span>`
    ).join('')}`;
  }

  // Dispose jobs get their own separate table, kept apart from the main
  // list rather than mixed in with everything else still active in the
  // workshop, by request. The main table's own empty-state message is
  // judged on the NON-dispose, non-workshop-gear count, so "everything
  // left is Dispose/Workshop Gear" correctly shows "No open jobs" up top
  // with the real items still visible in their own table(s), not a
  // misleading blank page.
  //
  // Workshop Gear jobs get their own separate table too, same idea as
  // Dispose, but hidden entirely (not rendered at all, not just an empty
  // container) unless showWorkshopGear is ticked -- and, unlike Dispose,
  // always in its own standalone spot at the very bottom of the page
  // regardless of 2-column mode (Dispose folds into the 2-column layout
  // itself, see below; Workshop Gear deliberately doesn't, by request --
  // "a checkbox at the bottom of the page ... its own table below", not
  // woven into the main layout the way Dispose is).
  //
  // Normally (single-column mode) the legend and the Dispose table both
  // sit in their own static full-width spots below the main table, in
  // that order. In 2-column mode specifically, by request, they instead
  // move INTO the two columns themselves -- the legend at the end of
  // column 1, the Dispose table at the end of column 2 -- rather than
  // staying full-width below both columns. legendEl/disposeResultsEl
  // are reset to their normal standalone position/content first, then
  // overridden (content moved, standalone spot emptied/hidden) only in
  // the 2-column branch below.
  function renderResults(jobs) {
    const mainJobs = jobs.filter((j) => j.workflowStage !== 'dispose' && j.workflowStage !== 'workshop_gear');
    const disposeJobs = jobs.filter((j) => j.workflowStage === 'dispose');
    const workshopGearJobs = jobs.filter((j) => j.workflowStage === 'workshop_gear');

    resultsEl.innerHTML = '';
    legendEl.innerHTML = legendHtml();
    legendEl.style.display = '';
    disposeResultsEl.innerHTML = '';
    workshopGearResultsEl.innerHTML = '';
    if (showWorkshopGear && workshopGearJobs.length > 0) {
      workshopGearResultsEl.appendChild(buildTableGroup(workshopGearJobs));
    }

    if (mainJobs.length === 0) {
      resultsEl.innerHTML = `<p class="status">${showCompleted ? 'No completed jobs yet.' : 'No open jobs -- add one to get started.'}</p>`;
      if (disposeJobs.length > 0) disposeResultsEl.appendChild(buildTableGroup(disposeJobs));
      return;
    }

    if (twoColumns && mainJobs.length > 1) {
      // Two side-by-side tables on a very large screen, by request --
      // splits the already-sorted list in half sequentially (left
      // column gets the first/more-urgent half), not any fancier
      // interleaving. Just a re-layout of the same data, not a second
      // fetch.
      const mid = Math.ceil(mainJobs.length / 2);
      const layout = document.createElement('div');
      layout.className = 'wsp-two-column-layout';

      const leftCol = document.createElement('div');
      leftCol.appendChild(buildTableGroup(mainJobs.slice(0, mid)));
      const legendCopy = document.createElement('div');
      legendCopy.className = 'wsp-priority-legend';
      legendCopy.innerHTML = legendHtml();
      leftCol.appendChild(legendCopy);
      layout.appendChild(leftCol);

      const rightCol = document.createElement('div');
      rightCol.appendChild(buildTableGroup(mainJobs.slice(mid)));
      if (disposeJobs.length > 0) rightCol.appendChild(buildTableGroup(disposeJobs));
      layout.appendChild(rightCol);

      resultsEl.appendChild(layout);

      // The legend/Dispose table's content now lives inside the columns
      // above instead -- hide/leave empty their normal standalone spots
      // so nothing shows twice.
      legendEl.style.display = 'none';
    } else {
      resultsEl.appendChild(buildTableGroup(mainJobs));
      if (disposeJobs.length > 0) disposeResultsEl.appendChild(buildTableGroup(disposeJobs));
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
            <th class="wsp-col-client">Client</th>
            <th>Current / Required Action</th>
            <th class="wsp-col-location"><span class="wsp-location-header-text">Location</span></th>
            <th>Ticket</th>
            <th>Due Date</th>
            <th class="wsp-col-actions"></th>
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
    //
    // The typed Client field is still shown too now, by request -- in
    // brackets, grey, right after the resolved ticket client (only when
    // there's actually something typed there to show -- a ticket-resolved
    // job with a blank Client field shows nothing extra). With no ticket
    // at all, the typed Client field IS the only client info there is --
    // still rendered grey (not the row's normal text colour), just
    // without brackets, since there's nothing else it's "in addition to".
    // Desktop-only, by request -- Mobile View hides this whole cell and
    // shows a separate, unaffected .wsp-mobile-client-line instead (see
    // actionCellHtml() below), which still shows just the plain
    // ticket-or-typed name, no brackets/grey treatment.
    const typedClient = job.customer ? escapeHtml(job.customer) : '';
    const client = job.ticketClientName
      ? `<span title="From ${escapeHtml(job.ticketNumber || 'linked ticket')}">${escapeHtml(job.ticketClientName)}</span>${typedClient ? ` <span class="wsp-client-typed">(${typedClient})</span>` : ''}`
      : `<span class="wsp-client-typed">${typedClient || '—'}</span>`;
    const actionCell = actionCellHtml(job);
    // Equipment icon moved here (inline with the text), by request -- was
    // originally at the end of the Current/Required Action cell. The text
    // half is its own span (.wsp-location-text) so Rotation View can hide
    // just that and leave the icon alone -- see .wsp-rotation-view in
    // styles.css.
    const location = `${equipmentIconHtml(job)}<span class="wsp-location-text"> ${escapeHtml(job.location) || '—'}${equipmentLocationsText(job)}</span>`;
    // The solid priority-colour bar runs the full width of the row, by
    // request -- left edge of Status, both sides of Client/Action,
    // right edge of Location, AND right edge of Due Date (the true last
    // data column, right before the action buttons) -- two separate
    // right-bars, same as Client/Action already had. Client/Action also
    // get a background tint, but only for TINTED_PRIORITIES (see
    // above) -- Coming and Not Started stay unshaded, by request.
    const tintClass = TINTED_PRIORITIES.includes(job.priority) ? `wsp-row-tint--${job.priority} ` : '';
    // Ticket/Due Date moved to after Location, by request -- these are
    // exactly the 2 columns Mobile View hides as one set (see
    // .wsp-mobile-view in styles.css, which targets the 2nd/3rd-to-last
    // columns -- Completion stays visible, so it deliberately isn't the
    // last 2/3 columns generically, just these two specifically).
    return `
      <tr>
        <td class="wsp-col-status wsp-bar-left--${job.priority}"><div class="wsp-status-cell-row"><span class="wsp-status-cell-main">${statusStageCellHtml(job)}</span>${qaIconsHtml(job)}</div></td>
        <td class="wsp-col-client ${tintClass}wsp-bar-left--${job.priority}">${client}</td>
        <td class="${tintClass}wsp-bar-right--${job.priority}">${actionCell}</td>
        <td class="wsp-col-location wsp-bar-right--${job.priority}">${location}</td>
        <td>${ticketCell}</td>
        <td class="wsp-bar-right--${job.priority}">${dueDateCell}</td>
        <td class="wsp-actions">${rowActionButtonsHtml(job)}</td>
      </tr>`;
  }

  // Job Description (bold) stacked above the actual Current/Required
  // Action text, both inside the same cell -- by request, this is a
  // display-only combination, not a separate table column; the two stay
  // separate real fields underneath (job_description/action_text), each
  // with its own audit trail entry.
  //
  // Mobile View, by request, also hides the whole Client column (see
  // .wsp-col-client in styles.css) and shows the client's name as this
  // cell's own first line instead (yellow/bold, see
  // .wsp-mobile-client-line) -- since that's the one piece of context lost
  // by hiding the Client column outright. Always rendered (same "pure CSS
  // toggle, no re-render needed" architecture the rest of Mobile View
  // uses -- see mobileViewToggle's own change handler above), just hidden
  // via CSS outside Mobile View.
  function actionCellHtml(job) {
    const clientText = job.ticketClientName || job.customer;
    const mobileClientLine = clientText ? `<div class="wsp-mobile-client-line">${escapeHtml(clientText)}</div>` : '';
    const descriptionLine = job.jobDescription ? `<div class="wsp-job-description">${escapeHtml(job.jobDescription)}</div>` : '';
    const actionLine = job.actionText ? `<div class="wsp-action-text--${job.actionColor}">${escapeHtml(job.actionText)}</div>` : '';
    const body = descriptionLine || actionLine ? `${descriptionLine}${actionLine}` : '—';
    return `${mobileClientLine}${body}`;
  }

  // True once every one of a job's equipment items has been ticked in
  // the Equipment Checklist popup SOMETIME TODAY (item.checkedAt --
  // "checked" here means that popup's own tick box, see
  // equipmentSummaryLines()'s own comment on checkedAt, not this row's
  // icon itself). "Today" compares in the browser's own local time/date,
  // same as every other date this page displays via toLocaleString()/
  // toLocaleDateString() (formatDateTime()/formatDate() below) -- there's
  // no separate "workshop timezone" concept anywhere else on this page.
  function isCheckedToday(item) {
    if (!item.checkedAt) return false;
    const checked = new Date(item.checkedAt);
    const now = new Date();
    return checked.getFullYear() === now.getFullYear() && checked.getMonth() === now.getMonth() && checked.getDate() === now.getDate();
  }

  // The equipment "symbol", shown inline with the Location text (see
  // jobRowHtml() above), by request -- same "always clickable, dim when
  // empty, bold once set" pattern as the Q/A stamp (qaIconsHtml() above):
  // there'd otherwise be no way to add the FIRST equipment item. A third
  // state, by request -- green (.wsp-equipment-icon--checked, styles.css)
  // once EVERY item has been checked off today (isCheckedToday() above);
  // still counts as "set" (full opacity/size), just with the extra green
  // badge on top, not a fourth size/opacity tier of its own. Hovering
  // shows the full list (including each item's own last-checked date/
  // time) via a plain native tooltip; clicking (any state) opens the
  // standalone equipment modal -- see openEquipmentModal() and
  // wireRowActions() below.
  function equipmentIconHtml(job) {
    const items = job.equipment || [];
    const hasItems = items.length > 0;
    const allCheckedToday = hasItems && items.every(isCheckedToday);
    let cls = 'wsp-equipment-icon';
    cls += hasItems ? ' wsp-equipment-icon--set' : ' wsp-equipment-icon--empty';
    if (allCheckedToday) cls += ' wsp-equipment-icon--checked';
    const summary = hasItems ? equipmentSummaryLines(items) : 'Click to add equipment';
    const title = allCheckedToday ? `All items checked today\n${summary}` : summary;
    return `<span class="${cls}" data-id="${job.id}" title="${escapeHtml(title)}">\u{1F4E6}</span>`;
  }

  // Every distinct equipment location note, in brackets after the job's own
  // Location field, by request -- e.g. job.location "Bay 3" with two items
  // noted "Shelf A"/"Shelf B" reads "Bay 3 (Shelf A, Shelf B)". ALL of the
  // job's equipment, regardless of Delivered -- unlike the Equipment
  // Checklist popup (which deliberately excludes delivered items, see its
  // own comment in server.js), this is just "where is everything", not a
  // still-outstanding worklist. Items with no location note set are left
  // out rather than showing a blank entry; duplicate notes (two items on
  // the same shelf) are only listed once, in first-seen order. Blank
  // brackets never show -- no equipment, or equipment with no location
  // notes at all, both just fall back to the plain job.location text alone.
  // Shared by equipmentLocationsText() (board row) and
  // equipmentLocationsSummaryHtml() (edit form) below -- one place for the
  // actual dedup/order logic so the two displays can never drift apart.
  function distinctEquipmentLocationNotes(job) {
    return [...new Set((job?.equipment || []).map((item) => item.locationNote).filter(Boolean))];
  }

  function equipmentLocationsText(job) {
    const notes = distinctEquipmentLocationNotes(job);
    return notes.length > 0 ? ` (${notes.map(escapeHtml).join(', ')})` : '';
  }

  // Same distinct location-note list as the board row's own bracketed text
  // (equipmentLocationsText() above), but shown next to the edit form's
  // Location (Job Note) label instead -- in blue, by request, so it's
  // visually distinct from the plain "-- see equipment list" hint beside
  // it. Its own class (.wsp-location-summary), not the shared
  // .cell-flag-blue -- that one is also bold (!important font-weight, by
  // design for table cells elsewhere), and this was asked to be blue
  // WITHOUT the bold, so reusing it would mean fighting its own
  // !important rather than just not applying one in the first place. A
  // static snapshot of the job's SAVED equipment (existingJob?.equipment),
  // same as every other preview in this form -- it does not live-update
  // while the equipment editor below is being edited in the same session,
  // only on next open/save.
  function equipmentLocationsSummaryHtml(job) {
    const notes = distinctEquipmentLocationNotes(job);
    if (notes.length === 0) return '';
    return ` <span class="wsp-location-summary">${notes.map(escapeHtml).join(', ')}</span>`;
  }

  // One line per item, e.g. "2x Laptop (In Workshop, Configured) -- shelf
  // 3" -- used for both the row icon's hover tooltip and the standalone
  // equipment modal's own title context. Mirrors equipmentSummaryText() in
  // server.js (used there for the audit_log summary/ticket note instead),
  // just newline- rather than semicolon-joined for a real multi-line
  // tooltip.
  function equipmentSummaryLines(items) {
    return items
      .map((item) => {
        const countPart = item.count ? `${item.count}x ` : '';
        const flags = [item.inWorkshop && 'In Workshop', item.configured && 'Configured', item.delivered && 'Delivered'].filter(Boolean);
        const flagsPart = flags.length ? ` (${flags.join(', ')})` : '';
        const notePart = item.locationNote ? ` -- ${item.locationNote}` : '';
        // Same "Last checked" info the equipment editor table's own
        // read-only column shows, by request -- so hovering the row's
        // 📦 icon (without opening the editor at all) gives the same
        // answer. Date AND time (formatDateTime), same reasoning as that
        // column's own comment.
        const checkedPart = ` [Checked: ${item.checkedAt ? formatDateTime(item.checkedAt) : 'Never'}]`;
        return `${countPart}${item.description || '(unnamed item)'}${flagsPart}${notePart}${checkedPart}`;
      })
      .join('\n');
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
      // withTicketDetails() in server.js). Green specifically for
      // "Complete" (Autotask's real status-5 label, confirmed against
      // real data -- see completed-tickets/server.js's own comment), by
      // request -- every other status stays the default muted colour.
      const statusLine = job.ticketStatus
        ? `<div class="wsp-ticket-status${job.ticketStatus === 'Complete' ? ' wsp-ticket-status--complete' : ''}">${escapeHtml(job.ticketStatus)}</div>`
        : '';
      // Real popup window, not just a new tab -- same convention every
      // other ticket link on this dashboard uses.
      return `<a class="wsp-ticket-link" href="${escapeHtml(job.ticketUrl)}" target="_blank" rel="noopener noreferrer" onclick="window.open(this.href, '_blank', 'noopener,noreferrer,width=1200,height=900'); return false;">${escapeHtml(job.ticketNumber)}</a>${statusLine}`;
    }
    return `<span title="Ticket not found in Autotask">${escapeHtml(job.ticketNumber)}</span>`;
  }

  // Red when overdue (due date genuinely in the past, not bold -- by
  // request), green when due today, dark yellow when due tomorrow --
  // compared as CALENDAR days in the browser's own local time, not a
  // raw 24-hour window, so a due time late tonight still reads as
  // "today" and one early tomorrow morning still reads as "tomorrow".
  // A blank due date (no ticket resolved, or the ticket has no due date
  // set) just shows the usual em-dash, unstyled.
  function dueDateCellHtml(job) {
    if (!job.ticketAutotaskId || !job.ticketDueDate) return '—';
    const due = new Date(job.ticketDueDate);
    const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate()).getTime();
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const oneDayMs = 24 * 60 * 60 * 1000;
    const text = escapeHtml(formatDate(job.ticketDueDate));
    if (dueDay < today) return `<span class="wsp-due-overdue">${text}</span>`;
    if (dueDay === today) return `<span class="wsp-due-today">${text}</span>`;
    if (dueDay === today + oneDayMs) return `<span class="wsp-due-tomorrow">${text}</span>`;
    return text;
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
  // job -- see the trash icon's own handling below). 'in_car'/
  // 'take_onsite' keep their own label but append the typed WHO text,
  // by request, rather than replacing it -- unlike free_text, "In Car"/
  // "Take Onsite" on their own are still meaningful.
  //
  // Plain-text version -- shared with the print card below
  // (printJobCard()) and with the ticket-note text server-side (see
  // noteWorkflowStageLabel() in server.js, which mirrors this exactly
  // since notes are plain text with no HTML/colour concept). The
  // on-screen list cell has its own separate, colour-aware version
  // below (statusStageCellHtml()) since it needs real markup, not a
  // plain string.
  function workflowStageLabel(job) {
    if (job.workflowStage === 'free_text' && job.workflowStageText) {
      return job.workflowStageText;
    }
    if (SPLIT_COLOR_STAGES.includes(job.workflowStage) && job.workflowStageText) {
      return `${WORKFLOW_STAGE_LABELS[job.workflowStage]} -- ${job.workflowStageText}`;
    }
    return WORKFLOW_STAGE_LABELS[job.workflowStage] || job.workflowStage;
  }

  // Green text for the stages that read as "done and on its way
  // out/gone" (see GREEN_WORKFLOW_STAGES above); red for the stages that
  // read as "not yet actioned/still waiting on the workshop" (see
  // RED_WORKFLOW_STAGES above); everything else stays the default text
  // colour. Both by request.
  //
  // 'in_car'/'take_onsite' (SPLIT_COLOR_STAGES) get a further split once
  // there's real WHO text, by request: only the stage NAME ("In Car"/
  // "Take Onsite") renders red, the person's name after it renders in
  // the default colour -- an inner span carries the colour instead of
  // colouring the whole outer .wsp-status-stage the way every other
  // case here does. With no WHO text yet, there's nothing to
  // distinguish from, so it falls through to the plain uniform-red case
  // like 'new'/'ready_to_ship'.
  function statusStageCellHtml(job) {
    const hasSplitText = SPLIT_COLOR_STAGES.includes(job.workflowStage) && job.workflowStageText;
    let innerHtml;
    let outerColorClass;
    if (hasSplitText) {
      innerHtml = `<span class="wsp-status-stage--red">${escapeHtml(WORKFLOW_STAGE_LABELS[job.workflowStage])} --</span> ${escapeHtml(job.workflowStageText)}`;
      outerColorClass = '';
    } else {
      innerHtml = escapeHtml(workflowStageLabel(job));
      outerColorClass = GREEN_WORKFLOW_STAGES.includes(job.workflowStage)
        ? ' wsp-status-stage--green'
        : RED_WORKFLOW_STAGES.includes(job.workflowStage)
          ? ' wsp-status-stage--red'
          : '';
    }
    // The dot itself is its own click target -- by request, priority can
    // be re-triaged straight from the list (see openPriorityEditor()
    // below), independently of the Status/workflow-stage text next to it.
    return `<span class="wsp-priority-dot" data-id="${job.id}" data-value="${job.priority}" title="Click to change priority"><span class="wsp-dot wsp-dot--${job.priority}"></span></span><span class="wsp-status-stage${outerColorClass}" data-id="${job.id}" data-value="${job.workflowStage}" data-text="${escapeHtml(job.workflowStageText || '')}" title="Click to change">${innerHtml}</span>`;
  }

  // The "stamp" -- Q/A icons right-justified in the Status column (see
  // jobRowHtml's .wsp-status-cell-row wrapper), by request. Both fields are
  // filled in together via one combined popup form (openQaModal() below),
  // not two separate editors, but which icon(s) actually render depends on
  // which of the two has real content:
  //   - neither set  -> just "?", dim/small (the entry point -- there'd
  //                     otherwise be no way to click to add the first one)
  //   - Q only       -> just "?", bold orange
  //   - Q and A      -> "?" (bold orange) followed by "A" (bold blue)
  //   - A only       -> just "A", bold blue -- the "?" is deliberately
  //                     NOT shown in this case, by request
  // Plain "?"/"A" text characters, not emoji -- a plain text glyph is what
  // actually lets CSS `color` control it at all; an emoji-presentation
  // character renders as a fixed-color glyph from the font/OS's own emoji
  // set, which CSS can't override (confirmed the hard way with the ❓ emoji
  // this replaced). Hovering each icon shows that field's own text via a
  // plain native tooltip, same convention as the "Ticket not found in
  // Autotask" tooltip elsewhere on this page.
  function qaIconsHtml(job) {
    const hasQuestion = !!job.flagNote;
    const hasAnswer = !!job.flagAnswer;
    const dataAttrs = `data-id="${job.id}" data-question="${escapeHtml(job.flagNote || '')}" data-answer="${escapeHtml(job.flagAnswer || '')}"`;

    if (!hasQuestion && !hasAnswer) {
      return `<span class="wsp-qa-icon wsp-qa-icon--q wsp-qa-icon--empty" ${dataAttrs} title="Click to leave a question/answer">?</span>`;
    }
    if (!hasQuestion && hasAnswer) {
      return `<span class="wsp-qa-icon wsp-qa-icon--a wsp-qa-icon--set" ${dataAttrs} title="${escapeHtml(job.flagAnswer)}">A</span>`;
    }
    const qIcon = `<span class="wsp-qa-icon wsp-qa-icon--q wsp-qa-icon--set" ${dataAttrs} title="${escapeHtml(job.flagNote)}">?</span>`;
    if (!hasAnswer) return qIcon;
    const aIcon = `<span class="wsp-qa-icon wsp-qa-icon--a wsp-qa-icon--set" ${dataAttrs} title="${escapeHtml(job.flagAnswer)}">A</span>`;
    return `${qIcon}${aIcon}`;
  }

  function rowActionButtonsHtml(job) {
    const historyBtn = `<button type="button" class="wsp-icon-btn wsp-history-btn" data-id="${job.id}" title="View history">\u{1F553}</button>`;
    // Available in both views, by request -- reprinting a completed
    // job's card is a real thing too (e.g. it comes back for warranty
    // work), not just open ones.
    const printBtn = `<button type="button" class="wsp-icon-btn wsp-print-btn" data-id="${job.id}" title="Print job card">\u{1F5A8}️</button>`;
    // Also available in both views, same reasoning as printBtn above --
    // photos of a completed/archived job (e.g. proof of finished work) are
    // just as real as photos of one still in progress. Requires a
    // resolved ticket, by request -- there's nowhere else for the
    // attachment to live (see server.js's own POST /jobs/:id/photos).
    const canUploadPhotos = !!job.ticketAutotaskId;
    const photoBtn = `<button type="button" class="wsp-icon-btn wsp-photo-btn" data-id="${job.id}" title="${canUploadPhotos ? 'Upload photos' : 'Cannot upload -- no linked ticket'}"${canUploadPhotos ? '' : ' disabled'}>📷</button>`;
    if (showCompleted) {
      // Already completed/archived -- "send to completed" doesn't apply
      // here, so the X icon in THIS view stays a genuine hard delete, for
      // cleaning the archive itself up (a duplicate/mistake that already
      // got completed). Requires a resolved ticket, by request -- the
      // server route rejects it either way, this just avoids the round
      // trip and tells staff why up front. See the DELETE route's own
      // comment in server.js. Icon changed from the rubbish bin to a
      // plain X, by request -- same icon the (now-removed) open-jobs
      // delete button used.
      const canDelete = !!job.ticketAutotaskId;
      return `${historyBtn}${printBtn}${photoBtn}
        <button type="button" class="wsp-icon-btn wsp-reopen-btn" data-id="${job.id}" title="Reopen">↺</button>
        <button type="button" class="wsp-icon-btn wsp-hard-delete-btn" data-id="${job.id}" title="${canDelete ? 'Permanently delete' : 'Cannot delete -- no linked ticket'}"${canDelete ? '' : ' disabled'}>❌</button>`;
    }
    // No delete button on the open-jobs view itself, by request -- the
    // soft-delete route (PATCH .../soft-delete) is left in server.js/db.js
    // as a dormant capability (direct API/admin use), just no longer
    // wired to any button here.
    return `${historyBtn}${printBtn}${photoBtn}
      <button type="button" class="wsp-icon-btn wsp-edit-btn" data-id="${job.id}" title="Edit">✏️</button>
      <button type="button" class="wsp-icon-btn wsp-complete-btn" data-id="${job.id}" title="Mark complete">✅</button>`;
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
    // Either icon (Q or A -- whichever is currently showing) opens the
    // SAME combined popup form, by request.
    group.querySelectorAll('.wsp-qa-icon').forEach((el) => {
      el.addEventListener('click', () => openQaModal(el.dataset.id, findJob(el.dataset.id)));
    });
    group.querySelectorAll('.wsp-equipment-icon').forEach((el) => {
      el.addEventListener('click', () => openEquipmentModal(el.dataset.id, findJob(el.dataset.id)));
    });
    group.querySelectorAll('.wsp-photo-btn').forEach((btn) => {
      btn.addEventListener('click', () => openPhotoUploadModal(btn.dataset.id, findJob(btn.dataset.id)));
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

  // The Q/A stamp's combined popup form -- opened by clicking either the Q
  // or the A icon (see qaIconsHtml()/wireRowActions() above), by request:
  // both fields are filled in together here, not as two separate inline
  // editors the way this used to work (openFlagNoteEditor(), a single
  // question-only text input swapped into the cell). Same overlay+panel
  // shape as the History/Equipment modals (.history-modal-*), reused
  // rather than a separate one-off dialog. Labeled just "Q"/"A" (matching
  // the icons themselves), not the full words "Question"/"Answer", by
  // request. Saving with a field left empty clears that field specifically
  // -- the OTHER field, if it still has content, is untouched (this is one
  // PATCH carrying both flagNote and flagAnswer, so both are always
  // written together based on whatever's currently in each input).
  function openQaModal(jobId, job) {
    const overlay = document.createElement('div');
    overlay.className = 'history-modal-overlay';
    const title = job ? job.ticketClientName || job.customer || `Job #${jobId}` : `Job #${jobId}`;
    overlay.innerHTML = `
      <div class="history-modal-panel wsp-qa-modal-panel wsp-qa-sticky-note">
        <div class="history-modal-panel-header">
          <span>${escapeHtml(title)} -- Q &amp; A</span>
          <button type="button" class="history-modal-close" aria-label="Close">✕</button>
        </div>
        <div class="history-modal-body">
          <label class="wsp-qa-modal-label wsp-qa-modal-label--top">
            <span class="wsp-qa-icon wsp-qa-icon--q wsp-qa-icon--set">?</span>
            <textarea class="wsp-field wsp-qa-question-input" rows="2" placeholder="Leave a question..." maxlength="300">${escapeHtml((job && job.flagNote) || '')}</textarea>
          </label>
          <label class="wsp-qa-modal-label wsp-qa-modal-label--top">
            <span class="wsp-qa-icon wsp-qa-icon--a wsp-qa-icon--set">A</span>
            <textarea class="wsp-field wsp-qa-answer-input" rows="2" placeholder="Leave an answer..." maxlength="300">${escapeHtml((job && job.flagAnswer) || '')}</textarea>
          </label>
          <p class="status error wsp-qa-modal-error" hidden></p>
          <div class="wsp-form-actions">
            <button type="button" class="button-link wsp-qa-save-button">Save</button>
            <button type="button" class="wsp-qa-cancel-button">Cancel</button>
          </div>
        </div>
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
    overlay.querySelector('.wsp-qa-cancel-button').addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    const questionInput = overlay.querySelector('.wsp-qa-question-input');
    const answerInput = overlay.querySelector('.wsp-qa-answer-input');

    async function save() {
      const errorEl = overlay.querySelector('.wsp-qa-modal-error');
      errorEl.hidden = true;
      try {
        await fetchJson(`/api/workshop/jobs/${jobId}`, 'PATCH', {
          flagNote: questionInput.value.trim(),
          flagAnswer: answerInput.value.trim(),
        });
        close();
        await loadJobs();
      } catch (err) {
        errorEl.hidden = false;
        errorEl.textContent = `Error: ${err.message}`;
      }
    }
    overlay.querySelector('.wsp-qa-save-button').addEventListener('click', save);
    questionInput.focus();
  }

  // Reads a browser File as base64 -- the part after the
  // "data:...;base64," prefix FileReader.readAsDataURL() produces.
  // Autotask's own TicketAttachments API wants base64 in the request body
  // either way (see server.js's own POST /jobs/:id/photos), so this is
  // sent through as-is -- no multipart upload/new dependency needed for
  // what has to become base64 on the wire regardless.
  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result || '';
        const commaIndex = result.indexOf(',');
        resolve(commaIndex === -1 ? result : result.slice(commaIndex + 1));
      };
      reader.onerror = () => reject(reader.error || new Error('Failed to read file.'));
      reader.readAsDataURL(file);
    });
  }

  // Uploads one or more photos straight to the job's linked Autotask
  // ticket, with an optional shared text description, by request -- see
  // server.js's own POST /jobs/:id/photos for the real Autotask API shape
  // this was confirmed against (a live round-trip, not guessed). Same
  // overlay+panel shell as the other modals on this page. Doesn't
  // reload/re-render the job list on success -- unlike Q&A/Equipment,
  // nothing about a job's own row display changes because of an
  // attachment upload.
  function openPhotoUploadModal(jobId, job) {
    const overlay = document.createElement('div');
    overlay.className = 'history-modal-overlay';
    const title = job ? job.ticketClientName || job.customer || `Job #${jobId}` : `Job #${jobId}`;
    overlay.innerHTML = `
      <div class="history-modal-panel wsp-photo-modal-panel">
        <div class="history-modal-panel-header">
          <span>${escapeHtml(title)} -- Upload Photos</span>
          <button type="button" class="history-modal-close" aria-label="Close">✕</button>
        </div>
        <div class="history-modal-body">
          <label class="wsp-photo-modal-label">
            <span>Photos</span>
            <input type="file" class="wsp-photo-file-input" accept="image/*" multiple />
          </label>
          <ul class="wsp-photo-file-list"></ul>
          <label class="wsp-photo-modal-label">
            <span>Description (optional)</span>
            <input type="text" class="wsp-field wsp-photo-description-input" placeholder="What's in these photos..." maxlength="300" />
          </label>
          <p class="status wsp-photo-modal-status" hidden></p>
          <div class="wsp-form-actions">
            <button type="button" class="button-link wsp-photo-upload-button" disabled>Upload</button>
            <button type="button" class="wsp-photo-cancel-button">Cancel</button>
          </div>
        </div>
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
    overlay.querySelector('.wsp-photo-cancel-button').addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    const fileInput = overlay.querySelector('.wsp-photo-file-input');
    const fileListEl = overlay.querySelector('.wsp-photo-file-list');
    const descriptionInput = overlay.querySelector('.wsp-photo-description-input');
    const statusEl = overlay.querySelector('.wsp-photo-modal-status');
    const uploadButton = overlay.querySelector('.wsp-photo-upload-button');

    // Accumulated separately from fileInput.files, and NOT just read fresh
    // at upload time -- confirmed the hard way (a real user report: "I
    // added 2 photos but only one made it") that a native <input
    // type="file" multiple> does NOT accumulate across separate uses of
    // the picker the way it might look like it should -- selecting one
    // photo, then opening the picker AGAIN to add a second, REPLACES the
    // whole FileList with just the second photo, silently discarding the
    // first. Confirmed server-side round-trips with 1 and 2 files sent
    // TOGETHER both worked perfectly -- the bug was entirely this client-
    // side selection-replacement gap, not the upload path itself. Fixed by
    // keeping our own running list and merging each picker use into it,
    // clearing the underlying input's own value afterward so the same
    // picker can be reopened for more without it thinking those files are
    // already "selected" (which would silently no-op the next choose).
    let selectedFiles = [];

    function renderFileList() {
      fileListEl.innerHTML = selectedFiles
        .map(
          (f, i) => `
        <li class="wsp-photo-file-list-item">
          <span>${escapeHtml(f.name)}</span>
          <button type="button" class="wsp-icon-btn wsp-photo-remove-file" data-index="${i}" title="Remove">✕</button>
        </li>`
        )
        .join('');
      fileListEl.querySelectorAll('.wsp-photo-remove-file').forEach((btn) => {
        btn.addEventListener('click', () => {
          selectedFiles.splice(Number(btn.dataset.index), 1);
          renderFileList();
        });
      });
      uploadButton.disabled = selectedFiles.length === 0;
    }

    fileInput.addEventListener('change', () => {
      // De-duplicated by name+size+lastModified -- picking the exact same
      // file twice (easy to do by accident when reopening the picker
      // repeatedly) adds it once, not twice.
      for (const f of fileInput.files) {
        const isDuplicate = selectedFiles.some((existing) => existing.name === f.name && existing.size === f.size && existing.lastModified === f.lastModified);
        if (!isDuplicate) selectedFiles.push(f);
      }
      fileInput.value = ''; // see selectedFiles' own comment above
      renderFileList();
    });

    uploadButton.addEventListener('click', async () => {
      if (selectedFiles.length === 0) return;
      uploadButton.disabled = true;
      statusEl.hidden = false;
      statusEl.className = 'status';
      statusEl.textContent = `Uploading ${selectedFiles.length} photo${selectedFiles.length === 1 ? '' : 's'}...`;
      try {
        const payloadFiles = await Promise.all(
          selectedFiles.map(async (f) => ({ filename: f.name, contentType: f.type || 'application/octet-stream', dataBase64: await readFileAsBase64(f) }))
        );
        const result = await fetchJson(`/api/workshop/jobs/${jobId}/photos`, 'POST', {
          description: descriptionInput.value.trim(),
          files: payloadFiles,
        });
        // Best-effort per file server-side -- a partial failure leaves the
        // modal open and only the FAILED files still selected (the
        // succeeded ones are removed from the list, so re-clicking Upload
        // doesn't re-send duplicates of what already landed) rather than
        // silently discarding which ones failed and why.
        if (result.failed.length === 0) {
          close();
        } else {
          const failedNames = new Set(result.failed.map((f) => f.filename));
          selectedFiles = selectedFiles.filter((f) => failedNames.has(f.name));
          renderFileList();
          statusEl.className = 'status error';
          statusEl.textContent = `Uploaded ${result.uploaded} of ${result.uploaded + result.failed.length}. Failed: ${result.failed.map((f) => `${f.filename} (${f.error})`).join('; ')}`;
          uploadButton.disabled = selectedFiles.length === 0;
        }
      } catch (err) {
        statusEl.className = 'status error';
        statusEl.textContent = `Error: ${err.message}`;
        uploadButton.disabled = false;
      }
    });
  }

  // Swaps the plain Status text for a <select>, focused and open --
  // choosing a new value saves immediately (no separate Save button),
  // same "quick inline update" reasoning as statusStageCellHtml()'s own
  // comment above. The exception is the TEXT_ENABLED_STAGES ('free_text',
  // 'in_car', 'take_onsite') -- picking one reveals a text input + its
  // own small save button instead of saving right away, since there's
  // real text to type first. Clicking elsewhere without changing
  // anything just leaves the select showing until the next loadJobs()
  // re-render (harmless --
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
        <input type="text" class="wsp-field wsp-status-stage-text" value="${escapeHtml(currentText)}" placeholder="${escapeHtml(TEXT_ENABLED_PLACEHOLDERS[currentValue] || '')}" maxlength="25" />
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

  // ---- Equipment editor -- one shared table-editing widget used in TWO
  // places, by request: embedded at the bottom of the Add/Edit job form
  // (buildJobForm() below, saved together with everything else on that
  // form's own Save button), and inside the standalone modal the row's
  // own equipment icon opens (openEquipmentModal() below, with its own
  // independent Save so equipment can be updated without opening the full
  // Edit form). Row order has no stable identity worth tracking across
  // edits (see replaceEquipmentForJob()'s own comment in db.js) -- adding/
  // removing rows is just DOM insertion/removal, and saving just reads
  // whatever rows are currently in the table, in order, no id bookkeeping
  // needed. ----
  function equipmentRowEditHtml(item) {
    // Read-only -- there's no input here, by request the ONLY way to set
    // checked_at is the Equipment Checklist popup's own tick box (see its
    // section in server.js/README.md). A brand-new row (the "+ Add
    // equipment" button below calls this with `{}`) has never been
    // checked, so it just reads "Never", same as any existing item that
    // hasn't been ticked yet. Date AND time (formatDateTime, not the
    // date-only formatDate() every other date column here uses) -- by
    // request, "last checked today at 2:15pm" vs "3:40pm" is a real,
    // meaningful distinction when multiple checks can happen in one day.
    const lastChecked = item.checkedAt ? formatDateTime(item.checkedAt) : 'Never';
    return `
      <tr>
        <td><input type="number" min="0" step="1" class="wsp-field wsp-equipment-count" value="${item.count ?? ''}" /></td>
        <td><input type="text" class="wsp-field wsp-equipment-description" value="${escapeHtml(item.description || '')}" /></td>
        <td class="wsp-equipment-checkbox-cell"><input type="checkbox" class="wsp-equipment-in-workshop"${item.inWorkshop ? ' checked' : ''} /></td>
        <td><input type="text" class="wsp-field wsp-equipment-location-note" maxlength="60" placeholder="Where exactly..." value="${escapeHtml(item.locationNote || '')}" /></td>
        <td class="wsp-equipment-checkbox-cell"><input type="checkbox" class="wsp-equipment-configured"${item.configured ? ' checked' : ''} /></td>
        <td class="wsp-equipment-checkbox-cell"><input type="checkbox" class="wsp-equipment-delivered"${item.delivered ? ' checked' : ''} /></td>
        <td class="wsp-equipment-last-checked">${escapeHtml(lastChecked)}</td>
        <td><button type="button" class="wsp-icon-btn wsp-equipment-remove-row" title="Remove">❌</button></td>
      </tr>`;
  }

  function buildEquipmentEditor(items) {
    const wrapper = document.createElement('div');
    wrapper.className = 'wsp-equipment-editor';
    wrapper.innerHTML = `
      <div class="resource-group wsp-equipment-table-wrap">
        <table class="wsp-equipment-table">
          <thead>
            <tr class="shaded-row">
              <th>Count</th>
              <th>Description</th>
              <th>In Workshop</th>
              <th>Location Note</th>
              <th>Configured</th>
              <th>Delivered</th>
              <th>Last checked</th>
              <th></th>
            </tr>
          </thead>
          <tbody>${items.map(equipmentRowEditHtml).join('')}</tbody>
        </table>
      </div>
      <button type="button" class="button-link wsp-equipment-add-row">+ Add equipment</button>
    `;
    const tbody = wrapper.querySelector('tbody');
    function wireRemoveButtons() {
      tbody.querySelectorAll('.wsp-equipment-remove-row').forEach((btn) => {
        btn.onclick = () => btn.closest('tr').remove();
      });
    }
    wrapper.querySelector('.wsp-equipment-add-row').addEventListener('click', () => {
      tbody.insertAdjacentHTML('beforeend', equipmentRowEditHtml({}));
      wireRemoveButtons();
    });
    wireRemoveButtons();
    return wrapper;
  }

  function collectEquipmentFromEditor(editorContainer) {
    const rows = editorContainer.querySelectorAll('.wsp-equipment-table tbody tr');
    return Array.from(rows).map((tr) => {
      const countValue = tr.querySelector('.wsp-equipment-count').value.trim();
      return {
        count: countValue === '' ? null : Number(countValue),
        description: tr.querySelector('.wsp-equipment-description').value.trim(),
        inWorkshop: tr.querySelector('.wsp-equipment-in-workshop').checked,
        locationNote: tr.querySelector('.wsp-equipment-location-note').value.trim(),
        configured: tr.querySelector('.wsp-equipment-configured').checked,
        delivered: tr.querySelector('.wsp-equipment-delivered').checked,
      };
    });
  }

  // Standalone equipment modal -- opened by clicking the row's own
  // equipment icon (see equipmentIconHtml()/wireRowActions() above), with
  // its own independent Save (PUT /jobs/:id/equipment) so the list can be
  // updated without opening the full Edit form. Same overlay+panel shape
  // as the History modal (.history-modal-*), reused rather than a
  // separate one-off dialog.
  function openEquipmentModal(jobId, job) {
    const overlay = document.createElement('div');
    overlay.className = 'history-modal-overlay';
    const title = job ? job.ticketClientName || job.customer || `Job #${jobId}` : `Job #${jobId}`;
    overlay.innerHTML = `
      <div class="history-modal-panel wsp-equipment-modal-panel">
        <div class="history-modal-panel-header">
          <span>${escapeHtml(title)} -- Equipment</span>
          <button type="button" class="history-modal-close" aria-label="Close">✕</button>
        </div>
        <div class="history-modal-body">
          <div class="wsp-equipment-editor-container"></div>
          <p class="status error wsp-equipment-modal-error" hidden></p>
          <div class="wsp-form-actions">
            <button type="button" class="button-link wsp-equipment-save-button">Save</button>
            <button type="button" class="wsp-equipment-cancel-button">Cancel</button>
          </div>
        </div>
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
    overlay.querySelector('.wsp-equipment-cancel-button').addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    const editorContainer = overlay.querySelector('.wsp-equipment-editor-container');
    editorContainer.appendChild(buildEquipmentEditor((job && job.equipment) || []));

    overlay.querySelector('.wsp-equipment-save-button').addEventListener('click', async () => {
      const errorEl = overlay.querySelector('.wsp-equipment-modal-error');
      errorEl.hidden = true;
      const items = collectEquipmentFromEditor(editorContainer);
      try {
        await fetchJson(`/api/workshop/jobs/${jobId}/equipment`, 'PUT', { equipment: items });
        close();
        await loadJobs();
      } catch (err) {
        errorEl.hidden = false;
        errorEl.textContent = `Error: ${err.message}`;
      }
    });
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
        <div class="wsp-form-columns">
          <div class="wsp-form-column">
            <label>Current Status
              <select class="wsp-field" data-field="priority">
                ${PRIORITY_ORDER.map((p) => `<option value="${p}"${isSelected(existingJob?.priority, p, 'not_started')}>${escapeHtml(PRIORITY_LABELS[p])}</option>`).join('')}
              </select>
            </label>
            <label>Status Type
              <select class="wsp-field" data-field="workflowStage" id="form-workflow-stage">
                ${WORKFLOW_STAGE_ORDER.map((s) => `<option value="${s}"${isSelected(existingJob?.workflowStage, s, 'new')}>${escapeHtml(WORKFLOW_STAGE_LABELS[s])}</option>`).join('')}
              </select>
            </label>
            <label id="form-workflow-stage-text-wrap"${TEXT_ENABLED_STAGES.includes(existingJob?.workflowStage) ? '' : ' hidden'}>Status Free Text Note
              <input type="text" class="wsp-field" data-field="workflowStageText" value="${escapeHtml(existingJob?.workflowStageText || '')}" placeholder="${escapeHtml(TEXT_ENABLED_PLACEHOLDERS[existingJob?.workflowStage] || '')}" maxlength="25" />
            </label>
            <label>Client
              <input type="text" class="wsp-field" data-field="customer" value="${escapeHtml(existingJob?.customer || '')}" />
            </label>
            <label>Ticket
              <input type="text" class="wsp-field" data-field="ticketNumber" value="${escapeHtml(existingJob?.ticketNumber || '')}" />
            </label>
            <label class="wsp-checkbox-field" title="When checked, none of this job's changes (including equipment checklist ticks) post a note to its linked ticket.">
              <input type="checkbox" class="wsp-field" data-field="skipTicketUpdates" ${existingJob?.skipTicketUpdates ? 'checked' : ''} /> Skip ticket update
            </label>
          </div>
          <div class="wsp-form-column">
            <label>Job description
              <input type="text" class="wsp-field" data-field="jobDescription" value="${escapeHtml(existingJob?.jobDescription || '')}" required />
            </label>
            <label>Action Current/Next/Required
              <textarea class="wsp-field" data-field="actionText" rows="3" required>${escapeHtml(existingJob?.actionText || '')}</textarea>
            </label>
            <label>
              <span class="wsp-location-label-row">
                Location (Job Note) <span class="inline-subtext">-- see equipment list</span>${equipmentLocationsSummaryHtml(existingJob)}
              </span>
              <input type="text" class="wsp-field" data-field="location" value="${escapeHtml(existingJob?.location || '')}" />
            </label>
            <label>Pen Colour
              <select class="wsp-field" data-field="actionColor">
                ${ACTION_COLOR_ORDER.map((c) => `<option value="${c}"${isSelected(existingJob?.actionColor, c, 'general')}>${escapeHtml(ACTION_COLOR_LABELS[c])}</option>`).join('')}
              </select>
            </label>
          </div>
        </div>
        <div class="wsp-equipment-section">
          <div class="section-heading">Equipment</div>
          <div class="wsp-equipment-editor-container"></div>
        </div>
        <p class="status error wsp-form-error" hidden></p>
        <div class="wsp-form-actions">
          <button type="button" class="button-link wsp-save-button">Save</button>
          <button type="button" class="wsp-cancel-button">Cancel</button>
        </div>
      </div>
    `;

    // Equipment table, by request -- shown at the bottom of the Add/Edit
    // form, same shared editor (buildEquipmentEditor()) the standalone
    // equipment-icon modal uses (see openEquipmentModal() below), saved
    // together with everything else in this form on the one Save button
    // below rather than needing its own separate save action here.
    const equipmentEditorContainer = wrapper.querySelector('.wsp-equipment-editor-container');
    equipmentEditorContainer.appendChild(buildEquipmentEditor(existingJob?.equipment || []));

    // Show/hide the free-text companion field alongside the Status
    // select -- and CLEAR its value when hiding it, not just visually
    // hide it, since the save handler below collects every [data-field]
    // element's value regardless of visibility. Without clearing it, a
    // job that WAS on a text-enabled stage with real text, then switched
    // to a different Status in this form, would silently keep submitting
    // the old (now-hidden) text alongside the new stage. The placeholder
    // also swaps to match which stage is picked (see
    // TEXT_ENABLED_PLACEHOLDERS above).
    const workflowStageSelect = wrapper.querySelector('#form-workflow-stage');
    const workflowStageTextWrap = wrapper.querySelector('#form-workflow-stage-text-wrap');
    workflowStageSelect.addEventListener('change', () => {
      const isTextEnabled = TEXT_ENABLED_STAGES.includes(workflowStageSelect.value);
      workflowStageTextWrap.hidden = !isTextEnabled;
      const textInput = workflowStageTextWrap.querySelector('input');
      textInput.placeholder = TEXT_ENABLED_PLACEHOLDERS[workflowStageSelect.value] || '';
      if (!isTextEnabled) textInput.value = '';
    });

    // Pen Colour live preview -- applied to Client, Current/Required
    // Action, and Location, matching what the colour will actually look
    // like on the board once saved (see ACTION_COLOR_HEX above). Also run
    // once immediately so an existing job's current Pen Colour shows right
    // away, not just after the user touches the select.
    const actionColorSelect = wrapper.querySelector('[data-field="actionColor"]');
    const previewFields = [
      wrapper.querySelector('[data-field="customer"]'),
      wrapper.querySelector('[data-field="actionText"]'),
      wrapper.querySelector('[data-field="location"]'),
    ];
    function applyActionColorPreview() {
      const hex = ACTION_COLOR_HEX[actionColorSelect.value] || ACTION_COLOR_HEX.general;
      previewFields.forEach((field) => {
        field.style.color = hex;
      });
    }
    actionColorSelect.addEventListener('change', applyActionColorPreview);
    applyActionColorPreview();

    wrapper.querySelector('.wsp-cancel-button').addEventListener('click', () => {
      formContainer.innerHTML = '';
    });
    wrapper.querySelector('.wsp-save-button').addEventListener('click', async () => {
      const errorEl = wrapper.querySelector('.wsp-form-error');
      errorEl.hidden = true;
      const fields = {};
      wrapper.querySelectorAll('[data-field]').forEach((el) => {
        // Checkboxes (currently just skipTicketUpdates) read .checked, not
        // .value -- a native checkbox's .value is a fixed "on" regardless
        // of whether it's actually ticked, so the generic .value.trim()
        // every other (text/select) field here uses would always send
        // true.
        fields[el.dataset.field] = el.type === 'checkbox' ? el.checked : el.value.trim();
      });
      fields.equipment = collectEquipmentFromEditor(equipmentEditorContainer);
      // Client-side check for an instant error, no round trip -- server.js
      // enforces the same thing regardless (parseJobBody()), so a direct
      // API call can't bypass this, this is purely the fast path. This
      // form isn't a real <form> element (the Save button is type="button",
      // not type="submit"), so the [required] attribute on these two
      // fields alone doesn't trigger the browser's own native validation
      // UI -- that only fires on an actual form submit event.
      if (!fields.jobDescription) {
        errorEl.hidden = false;
        errorEl.textContent = 'Error: Job description is required.';
        wrapper.querySelector('[data-field="jobDescription"]').focus();
        return;
      }
      if (!fields.actionText) {
        errorEl.hidden = false;
        errorEl.textContent = 'Error: Action Current/Next/Required is required.';
        wrapper.querySelector('[data-field="actionText"]').focus();
        return;
      }
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

  const PRINT_PRIORITY_DOT_COLORS = { urgent: '#dc2626', complete: '#16a34a', nearly_complete: '#2563eb', in_progress: '#f97316', next_up: '#8b5cf6', coming: '#eab308', not_started: '#6b7280' };
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
    ${job.flagNote ? row('Question', escapeHtml(job.flagNote)) : ''}
    ${job.flagAnswer ? row('Answer', escapeHtml(job.flagAnswer)) : ''}
    ${job.equipment && job.equipment.length > 0 ? row('Equipment', equipmentSummaryLines(job.equipment).split('\n').map(escapeHtml).join('<br>')) : ''}
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
    } else if (entry.field === 'skip_ticket_updates') {
      changeText = `${escapeHtml(label)}: ${valueChangeHtml(entry, YES_NO_LABELS)}`;
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

  // Bottom-right "Deliveries" panel -- up to 5 most recent Goods Received
  // entries, by request, showing only Date & Time, Sender + Freight
  // Company (combined into one cell), and Receiver Name -- deliberately a
  // narrow preview, not the full Goods Received table (that's what the
  // "Deliveries" heading link is for). Goods Received's own GET
  // /api/packages-received/ already sorts newest-first, so this just
  // slices the first 5 rather than duplicating that sort here.
  async function loadDeliveriesPreview() {
    try {
      const res = await fetch('/api/packages-received/');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastDeliveriesPreview = data.deliveries.slice(0, 5);
      deliveriesPreviewEl.innerHTML = deliveriesPreviewHtml(lastDeliveriesPreview);
    } catch (err) {
      // Degrade gracefully -- a failed lookup (e.g. Goods Received's own
      // router not loaded) just leaves this one panel showing an error,
      // never breaks the rest of the board.
      deliveriesPreviewEl.innerHTML = `<p class="status error wsp-deliveries-placeholder">Error: ${escapeHtml(err.message)}</p>`;
    }
  }

  function deliveriesPreviewHtml(deliveries) {
    if (!deliveries || deliveries.length === 0) {
      return '<p class="wsp-deliveries-placeholder">No deliveries logged yet.</p>';
    }
    const rows = deliveries
      .map((d) => {
        const senderFreight = [d.sender, d.freightCompany].filter(Boolean).join(' / ') || '—';
        const cartons = d.cartonCount === null || d.cartonCount === undefined ? '—' : d.cartonCount;
        return `<tr>
          <td>${deliveryReceivedHtml(d.receivedAt)}</td>
          <td>${escapeHtml(senderFreight)}</td>
          <td>${cartons}</td>
        </tr>`;
      })
      .join('');
    return `<table class="wsp-deliveries-table">
      <thead><tr><th>Received</th><th>Sender</th><th>#</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  // Minimizes the space this panel needs, by request -- reuses What's On's
  // own Today/Tomorrow tag colour convention (green=today, amber=the
  // adjacent day -- see .tt-tag--today/--tomorrow in styles.css and
  // ttDayTag() in whats-on/client.js), scoped under this page's own
  // .wsp-delivery-tag-- classes rather than reusing those literally (same
  // "each page owns its own class names even when visually mirroring
  // another page" convention as .wsp-table vs .tcr-table). Every row gets
  // a tag now, by request:
  //   - Received TODAY: a green tag showing the TIME instead of the word
  //     "Today" -- the time is the useful bit once "today" is already
  //     implied by the colour.
  //   - Received YESTERDAY: an amber tag (same colour as What's On's
  //     "Tomorrow" tag) showing just day + month, not the word "Yesterday".
  //   - Anything older: a blue tag, also just day + month.
  // Compared as CALENDAR days in the browser's own local time, same
  // convention as dueDateCellHtml()'s own today/tomorrow comparison above.
  function deliveryReceivedHtml(receivedAtIso) {
    const received = new Date(receivedAtIso);
    const receivedDay = new Date(received.getFullYear(), received.getMonth(), received.getDate()).getTime();
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const oneDayMs = 24 * 60 * 60 * 1000;
    if (receivedDay === today) {
      const time = received.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      return `<span class="wsp-delivery-tag wsp-delivery-tag--today">${escapeHtml(time)}</span>`;
    }
    const dayMonth = formatDayMonth(receivedAtIso);
    if (receivedDay === today - oneDayMs) {
      return `<span class="wsp-delivery-tag wsp-delivery-tag--yesterday">${escapeHtml(dayMonth)}</span>`;
    }
    return `<span class="wsp-delivery-tag wsp-delivery-tag--older">${escapeHtml(dayMonth)}</span>`;
  }

  if (lastJobs) {
    statusEl.hidden = true;
    renderResults(lastJobs);
  } else {
    loadJobs();
  }

  if (lastDeliveriesPreview) {
    deliveriesPreviewEl.innerHTML = deliveriesPreviewHtml(lastDeliveriesPreview);
  } else {
    loadDeliveriesPreview();
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

// Day + month only (e.g. "24 Aug"), no year -- for the Deliveries preview
// panel's yesterday/older tags, by request. Same format What's On's own
// formatShortDate() uses for its overdue tag, for consistency.
function formatDayMonth(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
