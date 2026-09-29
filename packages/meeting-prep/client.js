// The pure "given this component's data, return HTML" rendering library
// (widgets, tables, the Recommendations Summary) now lives in this shared
// module, not here -- Report (packages/report) renders the exact same
// output for whatever's ticked, with zero risk of the two drifting apart.
// See that module's own header for the fuller reasoning. Everything left
// in THIS file is the interactive card-grid/ticking/drag-to-reorder UX,
// which stays page-specific.
import {
  overviewSectionHtml,
  fullTableHtmlForComponent,
  detailsBlock,
  wireDeviceFilters,
  executiveSummaryWidgetsHtml,
  executiveSummaryHtml,
  deviceStorageWidgetsHtml,
  deviceStorageHtml,
  patchManagementSummaryWidgetsHtml,
  patchManagementSummaryHtml,
  deviceHealthSummaryWidgetsHtml,
  deviceHealthSummaryHtml,
  hardwareLifecycleWidgetsHtml,
  hardwareLifecycleHtml,
  darkWebMonitoringWidgetsHtml,
  darkWebMonitoringHtml,
  emailSecurityWidgetsHtml,
  emailSecurityHtml,
  dattoLiveDevicesWidgetsHtml,
  autotaskTicketsWidgetsHtml,
  networkAuditWidgetsHtml,
  networkAuditHtml,
  openMonitorAlertsHtml,
  softwareWidgetsHtml,
  softwareSummaryHtml,
  patchManagementActivityWidgetsHtml,
  genericSummaryHtml,
  buildRecommendationsSummary,
  formatDateTime,
  escapeHtml,
} from '/meeting-prep-report-render.js';
// Report (packages/report) reads whatever this page last saved here --
// see that module's own header for the full "why localStorage" reasoning.
import { saveSelection } from '/meeting-prep-selection.js';

export const id = 'meeting-prep';
export const label = 'Meeting Prep';

// Module-scope, not inside mount() -- same restore-instantly-on-remount
// convention as every other page here. Selections persist across a
// remount (nav away and back) but are cleared the moment a genuinely NEW
// client/site is searched -- a pick is scoped to whichever client you
// just searched for, not carried over to a different one.
let lastSite = '';
// The "exact match" checkbox next to Client / Site, by request -- same
// restore-on-remount scope as lastSite above.
let lastExactMatch = false;
// Classification selector + searchable client dropdown, by request ("add a
// selector for Classification... Next add a searchable dropdown selector
// of Clients with that Classification"). Codes match server.js's own
// TECH_COVER_ELITE_CODE/TECH_COVER_ESSENTIALS_CODE ('15'/'17'), plus
// 'others'/'all' -- default 'TC Elite' ('15'), by request. lastClientId/
// lastClientName restore the dropdown's own pick on remount, same
// "restore instantly, reset on a genuinely new search" scope as lastSite.
let lastClassification = '15';
let lastClientId = '';
let lastClientName = '';
let lastData = null;
let selectedIds = new Set();
let activeComponentId = null;

// Custom drag-to-reorder position, by request -- a plain array of
// component ids in display order. In-memory only, same "restore instantly
// on remount, cleared on a genuinely new search" convention as
// selectedIds/activeComponentId above (not persisted to localStorage or
// the server) -- reordering is scoped to whichever client you're currently
// reviewing, same as everything else here, and starts fresh (server's own
// REPORT_ORDER) every time you search someone new. orderedComponents()
// keeps this in sync with whatever data.components actually contains on
// each render (a new/missing component just gets appended/dropped rather
// than breaking the whole order).
let componentOrder = [];

// Which per-site tab is showing in Selected Overview, when the current
// search matched more than one distinct site (e.g. a broad term like
// "sleepy" matching several clients) -- by request, "have the Selected
// Overview break the results up into one tab per site" rather than
// lumping every matched site's ticked components into one combined block.
// null when there's only one site among what's ticked (the normal case,
// and every case before this) -- no tab strip shows at all then, same as
// today. Same "restore on remount, reset on a genuinely new search"
// convention as componentOrder/selectedIds above.
let overviewActiveSite = null;

// A fixed sentinel id for the "Selected Overview" tile (see overviewCardEl()
// below) -- not a real component id from the API, so it can never collide
// with one, and it's how renderDetail() tells "show the overview" apart
// from "show a normal card's own detail".
const OVERVIEW_ID = '__overview__';

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <div class="mtg-title-row">
        <h1>Meeting Prep</h1>
        <button type="button" id="ingest-button" class="button-link button-link--small">Process Incoming Reports</button>
        <button type="button" id="summary-button" class="button-link button-link--small" hidden>Generate Recommendations Summary</button>
      </div>
      <p id="ingest-status" class="status" hidden></p>
      <form id="filter-form" class="date-form">
        <label for="classification-select">Classification</label>
        <select id="classification-select">
          <option value="15">TC Elite</option>
          <option value="17">TC Essentials</option>
          <option value="others">Others</option>
          <option value="all">All</option>
        </select>
        <div class="mtg-client-picker-box">
          <div class="mtg-client-picker-field">
            <label for="client-dropdown-input">Client</label>
            <input type="text" id="client-dropdown-input" list="client-datalist" placeholder="Search clients..." autocomplete="off" />
            <datalist id="client-datalist"></datalist>
          </div>
          <div class="mtg-client-picker-or">OR</div>
          <div class="mtg-client-picker-field">
            <label for="site-input">Client / Site</label>
            <span class="mtg-exact-match-wrap">
              <input type="text" id="site-input" placeholder="e.g. Acme* (wildcards with *)" />
              <label for="exact-match-checkbox" class="mtg-exact-match-label" title="Match the site name exactly, instead of a wildcard/substring search">
                <input type="checkbox" id="exact-match-checkbox" />
                Exact
              </label>
            </span>
          </div>
        </div>
        <button type="submit" id="load-button">Find Report Components</button>
      </form>
    </header>
    <p id="status" class="status">Type a client or site name above to get started.</p>
    <div id="summary" class="summary" hidden></div>
    <div id="recommendations" hidden></div>
    <div id="tick-toolbar" class="mtg-tick-toolbar" hidden>
      <button type="button" id="tick-all-button" class="button-link button-link--small">Tick All</button>
      <button type="button" id="invert-ticks-button" class="button-link button-link--small">Invert Ticks</button>
      <button type="button" id="untick-all-button" class="button-link button-link--small">Untick All</button>
    </div>
    <div id="card-grid" class="datto-card-grid"></div>
    <div id="detail"></div>
  `;

  const form = container.querySelector('#filter-form');
  const classificationSelect = container.querySelector('#classification-select');
  const clientDropdownInput = container.querySelector('#client-dropdown-input');
  const clientDatalist = container.querySelector('#client-datalist');
  const siteInput = container.querySelector('#site-input');
  const exactMatchCheckbox = container.querySelector('#exact-match-checkbox');
  const loadButton = container.querySelector('#load-button');
  const ingestButton = container.querySelector('#ingest-button');
  const ingestStatusEl = container.querySelector('#ingest-status');
  const summaryButton = container.querySelector('#summary-button');
  const statusEl = container.querySelector('#status');
  const summaryEl = container.querySelector('#summary');
  const recommendationsEl = container.querySelector('#recommendations');
  const tickToolbarEl = container.querySelector('#tick-toolbar');
  const tickAllButton = container.querySelector('#tick-all-button');
  const invertTicksButton = container.querySelector('#invert-ticks-button');
  const untickAllButton = container.querySelector('#untick-all-button');
  const gridEl = container.querySelector('#card-grid');
  const detailEl = container.querySelector('#detail');

  siteInput.value = lastSite;
  exactMatchCheckbox.checked = lastExactMatch;
  classificationSelect.value = lastClassification;
  clientDropdownInput.value = lastClientName;

  // Name -> id, for whatever the current Classification's client list holds
  // -- rebuilt every time refreshClientOptions() runs (mount, and again on
  // every Classification change). The dropdown itself is a plain
  // <input list> against a <datalist> (no existing searchable-dropdown/
  // combobox pattern exists anywhere else on this dashboard to reuse --
  // checked first), which gives free-text-with-suggestions natively; this
  // map is what turns whatever text ends up in the box back into a real
  // Autotask company id on submit.
  let clientNameToId = new Map();
  async function refreshClientOptions() {
    try {
      const params = new URLSearchParams({ classification: classificationSelect.value });
      const res = await fetch(`/api/meeting-prep/clients?${params.toString()}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      clientNameToId = new Map(data.clients.map((c) => [c.companyName, c.id]));
      clientDatalist.innerHTML = data.clients.map((c) => `<option value="${escapeHtml(c.companyName)}"></option>`).join('');
    } catch (err) {
      console.error('Meeting Prep: failed to load the classification-filtered client list:', err);
    }
  }
  refreshClientOptions();
  // A new Classification invalidates whatever was picked from the OLD
  // list (that company may not even belong to the new one) -- cleared
  // rather than left showing a name that no longer matches its own
  // dropdown's own options.
  classificationSelect.addEventListener('change', () => {
    clientDropdownInput.value = '';
    refreshClientOptions();
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const siteText = siteInput.value.trim();
    const classification = classificationSelect.value;
    // Free text wins over the dropdown when both are present, by request
    // ("If the existing Client / Site wildcard selector is entered, use
    // this and ignore the dropdown client field").
    if (siteText) {
      load({ site: siteText, exact: exactMatchCheckbox.checked, clientId: '', clientName: '', classification });
      return;
    }
    const pickedName = clientDropdownInput.value.trim();
    const pickedId = clientNameToId.get(pickedName);
    if (!pickedName || !pickedId) {
      statusEl.hidden = false;
      statusEl.className = 'status error';
      statusEl.textContent = 'Pick a client from the dropdown, or type a Client / Site search term.';
      return;
    }
    load({ site: '', exact: exactMatchCheckbox.checked, clientId: String(pickedId), clientName: pickedName, classification });
  });

  // A toggle, not a one-shot generator -- clicking again while it's showing
  // hides it, same "click to open, click to close" feel as a card preview.
  // Regenerated fresh each time it's shown rather than cached, since it's
  // cheap to build and this way it can never go stale against whatever's
  // currently loaded.
  summaryButton.addEventListener('click', () => {
    if (!recommendationsEl.hidden) {
      recommendationsEl.hidden = true;
      return;
    }
    recommendationsEl.innerHTML = buildRecommendationsSummary(lastData.components, lastData.siteTerm);
    recommendationsEl.hidden = false;
    recommendationsEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  // Tick All / Invert Ticks / Untick All -- by request, bulk operations on
  // the same selectedIds Set every individual checkbox already mutates
  // (see cardEl()'s own checkbox 'change' handler below). "Invert Ticks"
  // is this page's own name for what's more commonly called "Invert
  // Selection" elsewhere (Photoshop, Windows Explorer's own Edit menu,
  // most file-manager/list UIs all use that term) -- named "Ticks" instead
  // of "Selection" here purely to match this page's own existing
  // vocabulary (every card already calls this a "tick", not a
  // "selection"), not because the underlying operation is any different.
  // All three go through a full render(lastData) rather than patching
  // individual checkboxes/classes in place, same "rebuild from state"
  // approach reorderComponent() already uses for its own bulk change --
  // simpler and less error-prone than hand-syncing N checkboxes, the
  // overview tile's sub-text, and the summary line separately for what's
  // already a full-grid change anyway. The "Selected Overview" tile is
  // deliberately excluded from all three (it's read from lastData.components,
  // which never includes it -- see OVERVIEW_ID's own comment), consistent
  // with it having no checkbox of its own to begin with.
  tickAllButton.addEventListener('click', () => {
    if (!lastData) return;
    selectedIds = new Set(lastData.components.map((c) => c.id));
    render(lastData);
  });
  untickAllButton.addEventListener('click', () => {
    if (!lastData) return;
    selectedIds = new Set();
    render(lastData);
  });
  invertTicksButton.addEventListener('click', () => {
    if (!lastData) return;
    const next = new Set();
    for (const c of lastData.components) {
      if (!selectedIds.has(c.id)) next.add(c.id);
    }
    selectedIds = next;
    render(lastData);
  });

  // "Process Incoming Reports" -- pulls new report PDFs from SharePoint's
  // Incoming/ folder, parses them into this page's own data/*.json files,
  // and moves each original into Processed/<Client>/<date>/ once written
  // (see packages/meeting-prep/ingest.js for the full pipeline). A real,
  // consequential action against live SharePoint data -- confirm() first,
  // same as every other real-side-effect action this dashboard gates
  // behind one. Shows the FULL result (not just a one-line summary) since
  // the needsAttention list -- a file that couldn't be matched to a client,
  // an unrecognized report title, a kind with no parser yet -- is exactly
  // the thing someone running this needs to actually see, not just a
  // silent count.
  ingestButton.addEventListener('click', async () => {
    if (!confirm('This will pull new report PDFs from SharePoint\'s Incoming folder, parse them, and move the originals into Processed/. Continue?')) return;
    ingestButton.disabled = true;
    ingestStatusEl.hidden = false;
    ingestStatusEl.className = 'status';
    ingestStatusEl.textContent = 'Processing incoming reports -- this can take a little while...';
    try {
      const res = await fetch('/api/meeting-prep/ingest', { method: 'POST' });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || `Request failed (${res.status})`);
      const attentionHtml =
        result.needsAttention.length > 0
          ? `<ul class="mtg-ingest-attention">${result.needsAttention
              .map((n) => `<li><strong>${escapeHtml(n.filename)}</strong> (${escapeHtml(n.source)}) -- ${escapeHtml(n.reason)}</li>`)
              .join('')}</ul>`
          : '';
      ingestStatusEl.className = result.needsAttention.length > 0 ? 'status warn' : 'status';
      ingestStatusEl.innerHTML = `${escapeHtml(result.message)}${attentionHtml}`;
    } catch (err) {
      ingestStatusEl.className = 'status error';
      ingestStatusEl.textContent = `Error: ${err.message}`;
    } finally {
      ingestButton.disabled = false;
    }
  });

  // Which card is currently mid-drag, for the drag-to-reorder handlers
  // wired into cardEl() below -- plain HTML5 drag-and-drop (no library),
  // same "hand-rolled, no new dependency" approach as this page's widgets.
  // Transient UI state, so mount()-local rather than module-scope like
  // componentOrder itself -- nothing to restore across a remount, a drag
  // never spans one.
  let draggedId = null;

  if (lastData) render(lastData);

  async function load({ site, exact, clientId, clientName, classification }) {
    if (!site && !clientId) return;
    const displayTerm = site || clientName;
    loadButton.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = `Loading report components for "${displayTerm}"...`;
    summaryEl.hidden = true;
    summaryButton.hidden = true;
    recommendationsEl.hidden = true;
    tickToolbarEl.hidden = true;
    gridEl.innerHTML = '';
    detailEl.innerHTML = '';
    // A genuinely new search -- previous picks don't carry over to a
    // different client, a different exact-match setting, or a different
    // Classification (any of which can just as easily change which
    // components come back), by design.
    if (site !== lastSite || exact !== lastExactMatch || clientId !== lastClientId || classification !== lastClassification) {
      selectedIds = new Set();
      activeComponentId = null;
      componentOrder = [];
      overviewActiveSite = null;
    }
    try {
      const params = new URLSearchParams({ exact: exact ? 'true' : 'false', classification });
      if (site) params.set('client', site);
      if (clientId) params.set('clientId', clientId);
      // no-store -- this data is live (device check-ins, ticket counts,
      // whatever's newest in data/), so a repeated search for the same
      // client must always hit the network again rather than risk the
      // browser serving back an old cached response. Matched by the
      // server's own Cache-Control: no-store on this route.
      const res = await fetch(`/api/meeting-prep/components?${params.toString()}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastSite = site;
      lastExactMatch = exact;
      lastClientId = clientId;
      lastClientName = clientName;
      lastClassification = classification;
      lastData = data;
      render(data);
    } catch (err) {
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      loadButton.disabled = false;
    }
  }

  // Display label for whatever Classification the search that produced
  // `data` actually ran with -- lastClassification (set in load(), right
  // before render() is called) rather than reading classificationSelect's
  // live value, so this can never drift out of sync if the selector's been
  // changed again since the search that's currently on screen. Reuses the
  // <select>'s own option text ("TC Elite" etc.) rather than a second
  // hardcoded label list.
  function classificationLabel(code) {
    const option = classificationSelect.querySelector(`option[value="${CSS.escape(code)}"]`);
    return option ? option.textContent : code;
  }

  function render(data) {
    if (data.components.length === 0) {
      statusEl.hidden = false;
      statusEl.className = 'status';
      statusEl.textContent = `No report components matched "${data.siteTerm}" in Classification "${classificationLabel(lastClassification)}".`;
      summaryEl.hidden = true;
      summaryButton.hidden = true;
      recommendationsEl.hidden = true;
      tickToolbarEl.hidden = true;
      gridEl.innerHTML = '';
      detailEl.innerHTML = '';
      // Clears whatever Report was showing from a previous search too --
      // there's nothing here to tick any more, so Report shouldn't keep
      // showing a stale selection from before this (now empty) search.
      persistSelectionForReport(data);
      return;
    }

    statusEl.hidden = true;
    summaryEl.hidden = false;
    summaryButton.hidden = false;
    tickToolbarEl.hidden = false;
    updateSummary(data);

    gridEl.innerHTML = '';
    // Always first, by request ("as the first selection, a tile which
    // shows the widgets from all sections with ticks on") -- not one of
    // data.components, so it never counts toward "N components found",
    // never gets a checkbox of its own, and can't be picked as a meeting
    // pack item -- it's a live preview OF whatever's ticked, not a
    // component to tick itself.
    gridEl.appendChild(overviewCardEl());
    // Each card built in its own try/catch -- a bug in one component's own
    // rendering (a malformed payload, an unexpected kind) skips just that
    // card rather than throwing out of the whole loop and silently taking
    // every card after it down too (which is exactly what an uncaught
    // exception here would otherwise do, and is indistinguishable from
    // "the data's just not there" without opening devtools).
    for (const component of orderedComponents(data)) {
      try {
        gridEl.appendChild(cardEl(component));
      } catch (err) {
        console.error('Meeting Prep: failed to render a card, skipping it:', component && component.id, err);
      }
    }
    renderDetail();
  }

  // Applies the current drag-to-reorder position (componentOrder) to
  // whatever data.components actually holds right now, keeping the two in
  // sync rather than assuming they already match: a component id from a
  // previous render that's no longer present (e.g. Datto RMM not
  // configured this time round) is dropped, and any id componentOrder
  // doesn't know about yet (the very first render for this search, or a
  // component that's newly appeared) is appended in the server's own
  // order -- so a fresh search always starts in REPORT_ORDER, and only
  // diverges from it once you've actually dragged something.
  // Default position for a component that componentOrder doesn't know
  // about yet -- by request ("Datto RMM (Live) tile first, then Executive
  // Summary, then all other Summary Reports, then any others"): the live
  // Datto widget leads even though it's appended after every file-based
  // component server-side, Executive Summary (the one-page overview of
  // everything else) comes next, then every OTHER report whose title
  // contains "Summary" (Device Health Summary, Patch Management Summary
  // today -- title-matched rather than a hardcoded kind list so a future
  // "X Summary" report kind falls into this group automatically, no edit
  // needed here), then everything else keeps the server's own REPORT_ORDER
  // relative order. Only ever consulted for ids NOT already in
  // componentOrder -- once dragged, a tile stays wherever it was put,
  // this never runs again for it.
  function defaultOrderPriority(component) {
    if (component.kind === 'datto-live-devices') return 0;
    if (component.kind === 'executive-summary') return 1;
    if (component.title && component.title.includes('Summary')) return 2;
    return 3;
  }

  function orderedComponents(data) {
    const known = new Set(componentOrder);
    const newOnes = data.components.filter((c) => !known.has(c.id));
    // Array.prototype.sort is stable (ES2019+), so components sharing a
    // priority keep the server's own relative order between themselves --
    // this only ever reorders across priority tiers, never within one.
    newOnes.sort((a, b) => defaultOrderPriority(a) - defaultOrderPriority(b));
    for (const c of newOnes) componentOrder.push(c.id);
    const present = new Set(data.components.map((c) => c.id));
    componentOrder = componentOrder.filter((id) => present.has(id));
    const byId = new Map(data.components.map((c) => [c.id, c]));
    // .filter(Boolean) is belt-and-braces -- the .filter() on componentOrder
    // just above already guarantees every id here has a match in byId, but
    // failing safe (silently dropping a stray id) instead of handing
    // render()'s loop an `undefined` to choke on is a cheap defence against
    // that invariant ever being wrong in a future edit.
    return componentOrder.map((id) => byId.get(id)).filter(Boolean);
  }

  // Moves sourceId to sit just before targetId in componentOrder, then
  // re-renders the grid from that new order -- a full render() rather than
  // a manual DOM move, same "rebuild from state" approach every other
  // mutation on this page already uses (ticking a box aside, which updates
  // in place for its own stated reasons). Dropping a card onto itself is a
  // no-op, handled by the dragover/drop handlers below before this is ever
  // called.
  function reorderComponent(sourceId, targetId) {
    const from = componentOrder.indexOf(sourceId);
    const to = componentOrder.indexOf(targetId);
    if (from === -1 || to === -1 || from === to) return;
    componentOrder.splice(from, 1);
    componentOrder.splice(componentOrder.indexOf(targetId), 0, sourceId);
    render(lastData);
  }

  function updateSummary(data) {
    summaryEl.innerHTML = `<strong>${data.components.length}</strong> report component${data.components.length === 1 ? '' : 's'} found<span class="inline-subtext"> -- ${selectedIds.size} selected -- as of ${formatDateTime(data.asOf)}</span>`;
    persistSelectionForReport(data);
  }

  // Pushes the currently-ticked components (in current tile order) to
  // localStorage for the Report page (packages/report) to pick up, by
  // request -- "The selections will be made on Meeting Prep and then
  // displayed on Report page". Called every time updateSummary() is (i.e.
  // after every tick/untick/reorder/new search -- see this function's own
  // callers), so Report always mirrors whatever's currently ticked here,
  // live, the moment it's next viewed (or immediately, if it's open in
  // another tab right now -- see meeting-prep-selection.js's own
  // onSelectionChange()). allComponents is the FULL set (not just ticked)
  // -- Report's own Recommendations Summary needs every loaded component to
  // match what this page's "Generate Recommendations Summary" button
  // itself would produce, same reasoning as that button's own handler
  // above.
  function persistSelectionForReport(data) {
    saveSelection({
      siteTerm: data.siteTerm,
      asOf: data.asOf,
      savedAt: new Date().toISOString(),
      selectedComponents: orderedComponents(data).filter((c) => selectedIds.has(c.id)),
      allComponents: data.components,
    });
  }

  // Set which card is open in the detail panel below (a real component's
  // id, or OVERVIEW_ID) -- shared by every card's own click handler
  // (including the overview tile's) so the "click to open, click again to
  // close" toggle and the .mtg-card--active styling stay in exactly one
  // place.
  function setActiveComponent(id) {
    activeComponentId = activeComponentId === id ? null : id;
    container.querySelectorAll('.mtg-card').forEach((el) => el.classList.toggle('mtg-card--active', el.dataset.id === activeComponentId));
    renderDetail();
  }

  function overviewStatsLine() {
    const total = lastData.components.length;
    return `${selectedIds.size} of ${total} section${total === 1 ? '' : 's'} ticked -- click to preview ${selectedIds.size === 0 ? 'their widgets together' : 'them together'}`;
  }

  // The "Selected Overview" tile -- no checkbox (see the comment where
  // it's appended above), styled as its own `--overview` variant so it
  // reads as a pinned utility tile rather than just another report card.
  // Its sub-text tracks the current tick count live (updated in place from
  // the checkbox handler below, not by re-rendering the whole grid).
  function overviewCardEl() {
    const div = document.createElement('div');
    div.className = 'datto-card mtg-card mtg-card--overview' + (activeComponentId === OVERVIEW_ID ? ' mtg-card--active' : '');
    div.dataset.id = OVERVIEW_ID;
    div.innerHTML = `
      <div class="mtg-card-source">Meeting Pack Preview</div>
      <div class="datto-card-label">Selected Overview</div>
      <div class="datto-card-sub mtg-overview-sub">${escapeHtml(overviewStatsLine())}</div>
    `;
    div.addEventListener('click', () => setActiveComponent(OVERVIEW_ID));
    return div;
  }

  // Keeps the overview tile's own sub-text, and its detail panel if it's
  // the one currently open, in sync with the tick state -- called after
  // every checkbox change rather than re-rendering the whole grid, same
  // "update just what changed" approach the rest of this page already
  // uses for ticking.
  function refreshOverview() {
    const sub = gridEl.querySelector('.mtg-overview-sub');
    if (sub) sub.textContent = overviewStatsLine();
    if (activeComponentId === OVERVIEW_ID) renderDetail();
  }

  function cardEl(component) {
    const div = document.createElement('div');
    // A wildcard search that matched devices across more than one real
    // site is a real data-mixing risk on the ONE card that shows live,
    // unfiltered devices (see buildDattoLiveDevicesComponent()'s own
    // comment on the "Core Resources" bug this already burned once) --
    // flagged here rather than silently trusted, by request.
    const multiSiteWarning = component.kind === 'datto-live-devices' && component.matchedSites && component.matchedSites.length > 1;
    div.className =
      'datto-card mtg-card' +
      (selectedIds.has(component.id) ? ' mtg-card--selected' : '') +
      (component.id === activeComponentId ? ' mtg-card--active' : '') +
      (multiSiteWarning ? ' mtg-card--warning' : '');
    div.dataset.id = component.id;
    // Drag-to-reorder, by request -- every real component card can be
    // dragged and dropped on another to reorder the grid (the "Selected
    // Overview" tile above is deliberately NOT draggable, and can't be
    // dropped on either -- it's a pinned utility tile, not a report to
    // reorder, same reasoning it already has no checkbox of its own).
    div.draggable = true;
    // Native title attribute -- listing every real site name the search
    // actually matched -- doubles as the "Tooltip showing list ot sites
    // found" this warning was requested with, no custom hover widget
    // needed. Only ever set when the warning itself is showing.
    // '\n', not ', ' -- browsers render a literal newline in a native
    // title tooltip as its own line, by request ("use new line for each
    // entity in the tooltip").
    const multiSiteTooltip = multiSiteWarning ? escapeHtml(component.matchedSites.join('\n')) : '';
    div.innerHTML = `
      <label class="mtg-card-checkbox" title="Include in the meeting pack">
        <input type="checkbox" ${selectedIds.has(component.id) ? 'checked' : ''} />
      </label>
      <div class="mtg-card-source">${escapeHtml(component.source)}</div>
      ${multiSiteWarning ? `<div class="mtg-card-warning-label" title="${multiSiteTooltip}">WARNING</div>` : ''}
      <div class="datto-card-label${multiSiteWarning ? ' mtg-card-label--warning' : ''}" ${multiSiteWarning ? `title="${multiSiteTooltip}"` : ''}>${escapeHtml(component.title)}</div>
      <div class="datto-card-sub">${escapeHtml(statsLine(component))}</div>
      ${
        component.sourceUrl
          ? `<a class="mtg-card-original-link" href="${escapeHtml(component.sourceUrl)}" target="_blank" rel="noopener noreferrer">Original File</a>`
          : ''
      }
    `;
    const checkbox = div.querySelector('input[type="checkbox"]');
    // Stops the click from also bubbling into the card's own listener
    // below (which would immediately re-toggle the detail panel open/
    // closed for whatever was just ticked) -- checking a box and
    // previewing a card are two independent actions here.
    checkbox.addEventListener('click', (e) => e.stopPropagation());
    // Same reasoning as the checkbox above -- opening the source PDF in a
    // new tab shouldn't also toggle the detail panel for this card.
    const originalLink = div.querySelector('.mtg-card-original-link');
    if (originalLink) originalLink.addEventListener('click', (e) => e.stopPropagation());
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedIds.add(component.id);
      else selectedIds.delete(component.id);
      div.classList.toggle('mtg-card--selected', checkbox.checked);
      updateSummary(lastData);
      refreshOverview();
    });
    div.addEventListener('click', () => setActiveComponent(component.id));

    div.addEventListener('dragstart', (e) => {
      draggedId = component.id;
      div.classList.add('mtg-card--dragging');
      e.dataTransfer.effectAllowed = 'move';
      // Firefox in particular won't start a drag at all without data set
      // on it -- the value itself isn't read back anywhere, draggedId
      // (closed over above) is what drop/dragover actually use.
      e.dataTransfer.setData('text/plain', component.id);
    });
    div.addEventListener('dragend', () => {
      div.classList.remove('mtg-card--dragging');
      draggedId = null;
      gridEl.querySelectorAll('.mtg-card--drag-over').forEach((el) => el.classList.remove('mtg-card--drag-over'));
    });
    // dragover must preventDefault() for drop to ever fire at all -- native
    // HTML5 drag-and-drop's own quirk, not optional.
    div.addEventListener('dragover', (e) => {
      if (!draggedId || draggedId === component.id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      div.classList.add('mtg-card--drag-over');
    });
    div.addEventListener('dragleave', () => div.classList.remove('mtg-card--drag-over'));
    div.addEventListener('drop', (e) => {
      e.preventDefault();
      div.classList.remove('mtg-card--drag-over');
      if (!draggedId || draggedId === component.id) return;
      reorderComponent(draggedId, component.id);
    });

    return div;
  }

  function statsLine(component) {
    if (component.kind === 'executive-summary') {
      const s = component.stats;
      return `Overall score ${s.overallScore}%${component.createDate ? ` (as of ${component.createDate})` : ''}`;
    }
    if (component.kind === 'device-storage') {
      const s = component.stats;
      return `${s.driveCount} drive${s.driveCount === 1 ? '' : 's'}${s.criticalCount ? ` (${s.criticalCount} over 90% full)` : ''}`;
    }
    if (component.kind === 'patch-management-summary') {
      const s = component.stats;
      return `${s.fullyPatched} of ${s.total} devices fully patched`;
    }
    if (component.kind === 'device-health-summary') {
      const s = component.stats;
      return `${s.checksPassed} passed, ${s.checksFailed} failed health checks`;
    }
    if (component.kind === 'hardware-lifecycle') {
      const s = component.stats;
      return `${s.within12} due within 12 months, ${s.months12to24} due in 12 to 24 months, ${s.plus24} suitable 24+ months`;
    }
    if (component.kind === 'dark-web-monitoring') {
      const s = component.stats;
      return `${s.totalCompromises} compromise${s.totalCompromises === 1 ? '' : 's'} this period (customer average ${s.customerAverage})`;
    }
    if (component.kind === 'email-security') {
      const s = component.stats;
      return `${s.messagesProcessed} message${s.messagesProcessed === 1 ? '' : 's'} processed${s.dangerCount ? `, ${s.dangerCount} flagged Danger` : ''}`;
    }
    if (component.kind === 'network-audit') {
      const s = component.stats;
      return `${s.managedCount} managed${s.unmanagedCount ? `, ${s.unmanagedCount} unmanaged` : ''}`;
    }
    if (component.kind === 'open-monitor-alerts') {
      const s = component.stats;
      return `${s.totalOpen} open alert${s.totalOpen === 1 ? '' : 's'} across ${s.devicesWithAlerts} device${s.devicesWithAlerts === 1 ? '' : 's'}`;
    }
    // Device Activity/Monitor Status, Software, and the two Patch
    // Management event-log kinds only ever carry a `summary` object (see
    // buildReportComponent()'s own comment on why -- huge per-device data,
    // counts only), so each just surfaces its own headline count here.
    if (component.kind === 'device-activity') {
      const s = component.stats;
      return `${s.failedEvents} failed event${s.failedEvents === 1 ? '' : 's'} this period`;
    }
    if (component.kind === 'device-monitor-status') {
      return `${component.stats.totalMonitorEntries} monitor entries`;
    }
    if (component.kind === 'software') {
      return `${component.stats.distinctTitles} distinct titles installed`;
    }
    if (component.kind === 'patch-management-activity') {
      const s = component.stats;
      return `${s.totalPatchInstallEvents} patch install event${s.totalPatchInstallEvents === 1 ? '' : 's'}`;
    }
    if (component.kind === 'patch-management-details') {
      return `${component.stats.totalPatchesListed} patches listed`;
    }
    if (component.kind === 'datto-live-devices') {
      const s = component.stats;
      return `${s.total} device${s.total === 1 ? '' : 's'} (live)${s.notSeenStale ? `, ${s.notSeenStale} not seen 30+ days` : ''}`;
    }
    if (component.kind === 'autotask-tickets') {
      if (component.resolveStatus !== 'ok') return component.resolveStatus === 'ambiguous' ? 'Search matches more than one Autotask company' : 'No matching Autotask company found';
      const s = component.stats;
      return `${s.openCount} open, ${s.closedThisMonth} closed in ${component.monthLabel}`;
    }
    return '';
  }

  // A single always-visible detail panel below the grid (not a popup like
  // Datto RMM's own page uses) -- by request, this is a "review then pick"
  // workflow, not a one-off drill-down, so the preview stays on the same
  // screen as the cards and the checkboxes.
  function renderDetail() {
    detailEl.innerHTML = '';
    if (!activeComponentId || !lastData) {
      detailEl.innerHTML = '<p class="status">Click a card above to preview its content here.</p>';
      return;
    }
    if (activeComponentId === OVERVIEW_ID) {
      detailEl.appendChild(overviewDetailEl());
      wireDeviceFilters(detailEl);
      return;
    }
    const component = lastData.components.find((c) => c.id === activeComponentId);
    if (!component) return;

    const group = document.createElement('div');
    group.className = 'resource-group';
    if (component.kind === 'executive-summary') {
      group.innerHTML = `
        <div class="resource-group-header"><span>${escapeHtml(component.source)} -- ${escapeHtml(component.title)}</span><span class="count">${component.createDate ? escapeHtml(component.createDate) : ''}</span></div>
        ${executiveSummaryWidgetsHtml(component)}
        ${detailsBlock('Show full table data', executiveSummaryHtml(component))}
      `;
    } else if (component.kind === 'device-storage') {
      group.innerHTML = `
        <div class="resource-group-header"><span>${escapeHtml(component.source)} -- ${escapeHtml(component.title)}</span><span class="count">${component.drives.length} drive${component.drives.length === 1 ? '' : 's'}</span></div>
        ${deviceStorageWidgetsHtml(component)}
        ${detailsBlock('Show full table data', deviceStorageHtml(component))}
      `;
    } else if (component.kind === 'patch-management-summary') {
      group.innerHTML = `
        <div class="resource-group-header"><span>${escapeHtml(component.source)} -- ${escapeHtml(component.title)}</span><span class="count">${component.devices.length} device${component.devices.length === 1 ? '' : 's'}</span></div>
        ${patchManagementSummaryWidgetsHtml(component)}
        ${detailsBlock('Show full table data', patchManagementSummaryHtml(component))}
      `;
    } else if (component.kind === 'device-health-summary') {
      group.innerHTML = `
        <div class="resource-group-header"><span>${escapeHtml(component.source)} -- ${escapeHtml(component.title)}</span><span class="count">${component.devices.length} device${component.devices.length === 1 ? '' : 's'}</span></div>
        ${deviceHealthSummaryWidgetsHtml(component)}
        ${detailsBlock('Show full table data', deviceHealthSummaryHtml(component))}
      `;
    } else if (component.kind === 'hardware-lifecycle') {
      const total = component.bands.reduce((n, b) => n + b.devices.length, 0);
      group.innerHTML = `
        <div class="resource-group-header"><span>${escapeHtml(component.source)} -- ${escapeHtml(component.title)}</span><span class="count">${total} device${total === 1 ? '' : 's'}</span></div>
        ${hardwareLifecycleWidgetsHtml(component)}
        ${detailsBlock('Show full table data', hardwareLifecycleHtml(component))}
      `;
    } else if (component.kind === 'dark-web-monitoring') {
      group.innerHTML = `
        <div class="resource-group-header"><span>${escapeHtml(component.source)} -- ${escapeHtml(component.title)}</span><span class="count">${component.createDate ? escapeHtml(component.createDate) : ''}</span></div>
        ${darkWebMonitoringWidgetsHtml(component)}
        ${detailsBlock('Show full table data', darkWebMonitoringHtml(component))}
      `;
    } else if (component.kind === 'email-security') {
      group.innerHTML = `
        <div class="resource-group-header"><span>${escapeHtml(component.source)} -- ${escapeHtml(component.title)}</span><span class="count">${component.createDate ? escapeHtml(component.createDate) : ''}</span></div>
        ${emailSecurityWidgetsHtml(component)}
        ${detailsBlock('Show full table data', emailSecurityHtml(component))}
      `;
    } else if (component.kind === 'datto-live-devices') {
      // No collapsed "Show full table data" toggle here, unlike every
      // other kind below -- the device list (fullTableHtmlForComponent())
      // is appended directly, always visible right under the KPI tiles,
      // same as it's always been (a live tool, not a static report
      // snapshot, so a second collapsed copy would just be clutter). Now
      // its own dispatcher entry rather than baked into
      // dattoLiveDevicesWidgetsHtml() itself -- see that function's own
      // comment -- purely an internal reshuffle; this branch's own visible
      // output is unchanged.
      group.innerHTML = `
        <div class="resource-group-header"><span>${escapeHtml(component.source)} -- ${escapeHtml(component.title)}</span><span class="count">${component.summary.total} device${component.summary.total === 1 ? '' : 's'}</span></div>
        ${dattoLiveDevicesWidgetsHtml(component)}
        ${fullTableHtmlForComponent(component)}
      `;
    } else if (component.kind === 'autotask-tickets') {
      group.innerHTML = `
        <div class="resource-group-header"><span>${escapeHtml(component.source)} -- ${escapeHtml(component.title)}</span><span class="count">${component.resolveStatus === 'ok' ? escapeHtml(component.companyName) : ''}</span></div>
        ${autotaskTicketsWidgetsHtml(component)}
      `;
    } else if (component.kind === 'network-audit') {
      group.innerHTML = `
        <div class="resource-group-header"><span>${escapeHtml(component.source)} -- ${escapeHtml(component.title)}</span><span class="count">${component.devices.length} device${component.devices.length === 1 ? '' : 's'}</span></div>
        ${networkAuditWidgetsHtml(component)}
        ${detailsBlock('Show full table data', networkAuditHtml(component))}
      `;
    } else if (component.kind === 'open-monitor-alerts') {
      group.innerHTML = `
        <div class="resource-group-header"><span>${escapeHtml(component.source)} -- ${escapeHtml(component.title)}</span><span class="count">${component.stats.totalOpen} open</span></div>
        ${openMonitorAlertsHtml(component)}
      `;
    } else if (component.kind === 'software') {
      group.innerHTML = `
        <div class="resource-group-header"><span>${escapeHtml(component.source)} -- ${escapeHtml(component.title)}</span><span class="count">${component.stats.distinctTitles} titles</span></div>
        ${softwareWidgetsHtml(component)}
        ${detailsBlock('Show full table data', softwareSummaryHtml(component))}
      `;
    } else if (component.kind === 'patch-management-activity') {
      group.innerHTML = `
        <div class="resource-group-header"><span>${escapeHtml(component.source)} -- ${escapeHtml(component.title)}</span><span class="count">${component.createDate ? escapeHtml(component.createDate) : ''}</span></div>
        ${patchManagementActivityWidgetsHtml(component)}
        ${detailsBlock('Show full table data', genericSummaryHtml(component.summary))}
      `;
    } else if (['device-activity', 'device-monitor-status', 'patch-management-details'].includes(component.kind)) {
      // Summary-only kinds (see buildReportComponent()'s own comment) --
      // just the counts already computed into data/*.json's own `summary`,
      // no per-device breakdown to render.
      group.innerHTML = `
        <div class="resource-group-header"><span>${escapeHtml(component.source)} -- ${escapeHtml(component.title)}</span><span class="count">${component.createDate ? escapeHtml(component.createDate) : ''}</span></div>
        ${genericSummaryHtml(component.summary)}
      `;
    }
    detailEl.appendChild(group);
    // Wires up any live-filterable device table(s) just rendered into
    // detailEl -- a no-op when there isn't one (e.g. every other report
    // kind, or the ticket summary). See wireDeviceFilters()'s own comment.
    wireDeviceFilters(detailEl);
  }


  function overviewDetailEl() {
    const group = document.createElement('div');
    group.className = 'resource-group';
    const selected = orderedComponents(lastData).filter((c) => selectedIds.has(c.id));
    if (selected.length === 0) {
      group.innerHTML = `
        <div class="resource-group-header"><span>Selected Overview</span></div>
        <p class="status">Tick the cards below to build a combined preview of their widgets here.</p>
      `;
      return group;
    }

    // Grouped into one tab per distinct site among what's ticked, by
    // request -- but ONLY when there actually is more than one (the
    // ordinary case, a search that matched a single client, shows exactly
    // what it always has: no tab strip at all). A component with no clear
    // single site of its own (site === null -- a live Datto devices card
    // whose own devices span more than one real site) falls into its own
    // "Other" tab rather than being silently dropped or guessed into one
    // real site's tab.
    const siteNames = [...new Set(selected.map((c) => c.site).filter(Boolean))];
    if (siteNames.length <= 1) {
      const sections = selected.map(overviewSectionHtml).join('');
      group.innerHTML = `
        <div class="resource-group-header"><span>Selected Overview</span><span class="count">${selected.length} of ${lastData.components.length} ticked</span></div>
        <div class="mtg-overview-panel">${sections}</div>
      `;
      return group;
    }

    const OTHER_TAB = '__other__';
    const hasOther = selected.some((c) => !c.site);
    const tabs = [...siteNames, ...(hasOther ? [OTHER_TAB] : [])];
    if (!overviewActiveSite || !tabs.includes(overviewActiveSite)) overviewActiveSite = tabs[0];

    const tabButtons = tabs
      .map((site) => {
        const label = site === OTHER_TAB ? 'Other' : site;
        const count = selected.filter((c) => (site === OTHER_TAB ? !c.site : c.site === site)).length;
        const active = site === overviewActiveSite;
        return `<button type="button" class="mtg-overview-tab${active ? ' mtg-overview-tab--active' : ''}" data-site="${escapeHtml(site)}">${escapeHtml(label)} <span class="inline-subtext">(${count})</span></button>`;
      })
      .join('');

    const activeSections = selected
      .filter((c) => (overviewActiveSite === OTHER_TAB ? !c.site : c.site === overviewActiveSite))
      .map(overviewSectionHtml)
      .join('');

    group.innerHTML = `
      <div class="resource-group-header"><span>Selected Overview</span><span class="count">${selected.length} of ${lastData.components.length} ticked, ${siteNames.length} sites</span></div>
      <div class="mtg-overview-tabs">${tabButtons}</div>
      <div class="mtg-overview-panel">${activeSections}</div>
    `;
    group.querySelectorAll('.mtg-overview-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        overviewActiveSite = btn.dataset.site;
        renderDetail();
      });
    });
    return group;
  }

}
