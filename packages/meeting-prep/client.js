import { computeFindings } from '/meeting-prep-recommendations.js';

export const id = 'meeting-prep';
export const label = 'Meeting Prep';

// Module-scope, not inside mount() -- same restore-instantly-on-remount
// convention as every other page here. Selections persist across a
// remount (nav away and back) but are cleared the moment a genuinely NEW
// client/site is searched -- a pick is scoped to whichever client you
// just searched for, not carried over to a different one.
let lastSite = '';
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
        <label for="site-input">Client / Site</label>
        <input type="text" id="site-input" placeholder="e.g. Acme* (wildcards with *)" required />
        <button type="submit" id="load-button">Find Report Components</button>
      </form>
    </header>
    <p class="inline-subtext mtg-intro">
      Pulls every reportable chunk of data for one client into selectable cards, so you can pick what to actually
      bring into the meeting. Built from parsed report files (Datto RMM's Report Center reports, Dark Web
      Monitoring) matched against the site name in each file, plus a couple of live sources (Datto RMM devices,
      Autotask ticket counts) fetched fresh on every search -- more systems (SaaS Alerts, INKY) get added the
      same way as they're wired in.
    </p>
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
  const siteInput = container.querySelector('#site-input');
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

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    load(siteInput.value.trim());
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

  async function load(site) {
    if (!site) return;
    loadButton.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = `Loading report components for "${site}"...`;
    summaryEl.hidden = true;
    summaryButton.hidden = true;
    recommendationsEl.hidden = true;
    tickToolbarEl.hidden = true;
    gridEl.innerHTML = '';
    detailEl.innerHTML = '';
    // A genuinely new search -- previous picks don't carry over to a
    // different client, by design.
    if (site !== lastSite) {
      selectedIds = new Set();
      activeComponentId = null;
      componentOrder = [];
    }
    try {
      const params = new URLSearchParams({ client: site });
      // no-store -- this data is live (device check-ins, ticket counts,
      // whatever's newest in data/), so a repeated search for the same
      // client must always hit the network again rather than risk the
      // browser serving back an old cached response. Matched by the
      // server's own Cache-Control: no-store on this route.
      const res = await fetch(`/api/meeting-prep/components?${params.toString()}`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastSite = site;
      lastData = data;
      render(data);
    } catch (err) {
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      loadButton.disabled = false;
    }
  }

  function render(data) {
    if (data.components.length === 0) {
      statusEl.hidden = false;
      statusEl.className = 'status';
      statusEl.textContent = `No report components matched "${data.siteTerm}".`;
      summaryEl.hidden = true;
      summaryButton.hidden = true;
      recommendationsEl.hidden = true;
      tickToolbarEl.hidden = true;
      gridEl.innerHTML = '';
      detailEl.innerHTML = '';
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
    div.className =
      'datto-card mtg-card' + (selectedIds.has(component.id) ? ' mtg-card--selected' : '') + (component.id === activeComponentId ? ' mtg-card--active' : '');
    div.dataset.id = component.id;
    // Drag-to-reorder, by request -- every real component card can be
    // dragged and dropped on another to reorder the grid (the "Selected
    // Overview" tile above is deliberately NOT draggable, and can't be
    // dropped on either -- it's a pinned utility tile, not a report to
    // reorder, same reasoning it already has no checkbox of its own).
    div.draggable = true;
    div.innerHTML = `
      <label class="mtg-card-checkbox" title="Include in the meeting pack">
        <input type="checkbox" ${selectedIds.has(component.id) ? 'checked' : ''} />
      </label>
      <div class="mtg-card-source">${escapeHtml(component.source)}</div>
      <div class="datto-card-label">${escapeHtml(component.title)}</div>
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
    } else if (component.kind === 'datto-live-devices') {
      // No collapsed "full table data" underneath this one -- the
      // filterable device list below the KPI tiles already IS the full
      // device list (a live tool, not a static report snapshot), so a
      // second table repeating the same rows would just be clutter.
      group.innerHTML = `
        <div class="resource-group-header"><span>${escapeHtml(component.source)} -- ${escapeHtml(component.title)}</span><span class="count">${component.summary.total} device${component.summary.total === 1 ? '' : 's'}</span></div>
        ${dattoLiveDevicesWidgetsHtml(component)}
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

  // Same kind -> widgets-function mapping renderDetail() uses just above,
  // but returning ONLY the widgets (no header, no collapsed table) --
  // that's all the overview tile wants for each ticked section. Kept as
  // its own small dispatcher rather than refactoring renderDetail() to
  // call it too, so the already-verified per-card branches above stay
  // untouched.
  function widgetsHtmlForComponent(component) {
    if (component.kind === 'executive-summary') return executiveSummaryWidgetsHtml(component);
    if (component.kind === 'device-storage') return deviceStorageWidgetsHtml(component);
    if (component.kind === 'patch-management-summary') return patchManagementSummaryWidgetsHtml(component);
    if (component.kind === 'device-health-summary') return deviceHealthSummaryWidgetsHtml(component);
    if (component.kind === 'hardware-lifecycle') return hardwareLifecycleWidgetsHtml(component);
    if (component.kind === 'dark-web-monitoring') return darkWebMonitoringWidgetsHtml(component);
    if (component.kind === 'datto-live-devices') return dattoLiveDevicesWidgetsHtml(component);
    if (component.kind === 'autotask-tickets') return autotaskTicketsWidgetsHtml(component);
    if (component.kind === 'network-audit') return networkAuditWidgetsHtml(component);
    if (component.kind === 'patch-management-activity') return patchManagementActivityWidgetsHtml(component);
    if (component.kind === 'software') return softwareWidgetsHtml(component);
    return '';
  }

  // Same kind -> full-table-html mapping renderDetail()'s own per-card
  // branches use (each wrapped there in its own detailsBlock('Show full
  // table data', ...)) -- kept as its own dispatcher for the same reason
  // widgetsHtmlForComponent() above already is: so the individual-card
  // branches stay untouched. null for the two live kinds (datto-live-
  // devices, autotask-tickets), same as renderDetail() -- their own
  // filterable device list/summary already IS the full picture, nothing
  // collapsed underneath there either.
  function fullTableHtmlForComponent(component) {
    if (component.kind === 'executive-summary') return executiveSummaryHtml(component);
    if (component.kind === 'device-storage') return deviceStorageHtml(component);
    if (component.kind === 'patch-management-summary') return patchManagementSummaryHtml(component);
    if (component.kind === 'device-health-summary') return deviceHealthSummaryHtml(component);
    if (component.kind === 'hardware-lifecycle') return hardwareLifecycleHtml(component);
    if (component.kind === 'dark-web-monitoring') return darkWebMonitoringHtml(component);
    if (component.kind === 'network-audit') return networkAuditHtml(component);
    if (component.kind === 'open-monitor-alerts') return openMonitorAlertsHtml(component);
    if (component.kind === 'software') return softwareSummaryHtml(component);
    if (['device-activity', 'device-monitor-status', 'patch-management-activity', 'patch-management-details'].includes(component.kind)) {
      return genericSummaryHtml(component.summary);
    }
    return null;
  }

  // The overview tile's own detail: every ticked component's widgets, one
  // after another, in the CURRENT tile order (whatever componentOrder is
  // right now, including any dragging -- by request, "always use the
  // current tile order after user has dragged"; orderedComponents() is the
  // one place that already knows that order, so this reuses it rather than
  // lastData.components' own raw server order), each followed by its own
  // "Show full table data" toggle (by request) when that kind has one --
  // the individual card is still there to click for the same thing on its
  // own. Nothing ticked yet is treated as a normal, expected starting
  // state, not an error.
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
    const sections = selected
      .map((c) => {
        const table = fullTableHtmlForComponent(c);
        const widgets = widgetsHtmlForComponent(c);
        // No widgets means this section is just a header plus (usually) a
        // "Show full table data" link -- give it the compact, fit-content
        // treatment (see .mtg-report-section--compact in styles.css)
        // instead of claiming a full row for one line of text.
        const compact = !widgets;
        return `
        <div class="mtg-report-section${compact ? ' mtg-report-section--compact' : ''}">
          <h3>${escapeHtml(c.source)} -- ${escapeHtml(c.title)}</h3>
          ${widgets}
          ${table ? detailsBlock('Show full table data', table) : ''}
        </div>`;
      })
      .join('');
    group.innerHTML = `
      <div class="resource-group-header"><span>Selected Overview</span><span class="count">${selected.length} of ${lastData.components.length} ticked</span></div>
      <div class="mtg-overview-panel">${sections}</div>
    `;
    return group;
  }

  // -- Report-derived detail rendering -------------------------------------
  // One render function per report kind, all producing plain HTML strings
  // rather than DOM nodes since none of these need event listeners -- a
  // report's content is read-only, unlike a card's own checkbox/click
  // handlers.

  // Same 4-tier colour scale on every score in these reports (>=90 good,
  // 70-89 ok, 50-69 warn, below that bad) so a TAM can tell at a glance
  // which section of which report actually needs discussing.
  function scoreBadge(score) {
    if (score === null || score === undefined) return '';
    let tier = 'bad';
    if (score >= 90) tier = 'good';
    else if (score >= 70) tier = 'ok';
    else if (score >= 50) tier = 'warn';
    return `<span class="mtg-score-badge mtg-score-badge--${tier}">${score}%</span>`;
  }

  // -- Widgets: gauge / donut / bar / check-icon ---------------------------
  // Hand-built SVG and CSS, no chart library added, by request ("let's
  // formulate some results creating widgets like those... It's ok to use
  // different ones in different places"). Each report kind picks whichever
  // of these fit its own data, shown above the fold; the plain table
  // version everything already had stays available underneath, collapsed,
  // via detailsBlock() ("with the ability to include the table data where
  // required").

  // A collapsed-by-default <details>/<summary> -- no JS state to manage,
  // works without a click handler, and reads clearly as "here if you want
  // it" rather than cluttering the widget view by default.
  function detailsBlock(summaryLabel, innerHtml) {
    return `
      <details class="mtg-details">
        <summary>${escapeHtml(summaryLabel)}</summary>
        <div class="mtg-details-body">${innerHtml}</div>
      </details>
    `;
  }

  // Semi-circle gauge, 4 fixed 25-point colour bands (red/orange/light
  // green/green) plus a needle -- same shape as Datto's own Overall Score
  // gauge, redrawn from scratch (it's 4 arcs and a line) rather than
  // reusing any image of theirs.
  function gaugeSvg(score) {
    const cx = 90,
      cy = 90,
      r = 75;
    const point = (s) => {
      const a = ((180 - (s / 100) * 180) * Math.PI) / 180;
      return [cx + r * Math.cos(a), cy - r * Math.sin(a)];
    };
    const stops = [0, 25, 50, 75, 100];
    const colors = ['#dc2626', '#f59e0b', '#86c95e', '#16a34a'];
    const bands = stops
      .slice(0, -1)
      .map((s0, i) => {
        const [x0, y0] = point(s0);
        const [x1, y1] = point(stops[i + 1]);
        return `<path d="M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${r} ${r} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}" stroke="${colors[i]}" stroke-width="16" fill="none" stroke-linecap="round"/>`;
      })
      .join('');
    const clamped = Math.max(0, Math.min(100, score ?? 0));
    const [nx, ny] = point(clamped);
    const label = score === null || score === undefined ? '?' : `${score}%`;
    return `
      <svg width="180" height="105" viewBox="0 0 180 105" class="mtg-gauge">
        ${bands}
        <line x1="${cx}" y1="${cy}" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>
        <circle cx="${cx}" cy="${cy}" r="5" fill="currentColor"/>
        <text x="${cx}" y="${cy - 12}" text-anchor="middle" class="mtg-gauge-score">${label}</text>
      </svg>
    `;
  }

  // Donut from {label, value, color} segments (zero-value ones skipped --
  // nothing to draw) with a centre total and a legend beside it -- the same
  // shape Datto's own "Server/Workstation Patch Status" donuts use,
  // generalised so one function draws every donut across all 5 report
  // kinds rather than one bespoke chart per report.
  function donutSvg(segments, centerLabel) {
    const r = 62,
      circ = 2 * Math.PI * r;
    const total = segments.reduce((sum, s) => sum + s.value, 0);
    let offset = 0;
    const arcs = segments
      .filter((s) => s.value > 0)
      .map((s) => {
        const length = total > 0 ? (s.value / total) * circ : 0;
        const dash = `${length.toFixed(2)} ${(circ - length).toFixed(2)}`;
        const dashoffset = (-offset).toFixed(2);
        offset += length;
        return `<circle cx="72" cy="72" r="${r}" fill="none" stroke="${s.color}" stroke-width="18" stroke-dasharray="${dash}" stroke-dashoffset="${dashoffset}" transform="rotate(-90 72 72)"/>`;
      })
      .join('');
    return `
      <svg width="144" height="144" viewBox="0 0 144 144" class="mtg-donut">
        <circle cx="72" cy="72" r="${r}" fill="none" stroke="var(--border)" stroke-width="18"/>
        ${arcs}
        <text x="72" y="80" text-anchor="middle" class="mtg-donut-total">${centerLabel === undefined ? total : centerLabel}</text>
      </svg>
    `;
  }

  function donutWidget(title, segments, centerLabel) {
    const rows = segments
      .map(
        (s) =>
          `<div class="mtg-donut-legend-row" title="${escapeHtml(s.label)}"><span class="mtg-swatch" style="background:${s.color}"></span><span class="mtg-donut-legend-label">${escapeHtml(s.label)}</span><span class="mtg-donut-val">${s.value}</span></div>`
      )
      .join('');
    return `
      <div class="mtg-widget">
        ${title ? `<p class="mtg-widget-title">${escapeHtml(title)}</p>` : ''}
        <div class="mtg-donut-row">
          ${donutSvg(segments, centerLabel)}
          <div class="mtg-donut-legend">${rows}</div>
        </div>
      </div>
    `;
  }

  // Coloured horizontal capacity bar -- built for storage %, but any 0-100
  // value with a red/amber/green threshold read fits it.
  function barWidget(label, pct, opts) {
    const o = opts || {};
    const redAt = o.redAt ?? 90;
    const amberAt = o.amberAt ?? 70;
    const color = pct >= redAt ? '#dc2626' : pct >= amberAt ? '#f59e0b' : '#16a34a';
    const shown = Number.isInteger(pct) ? pct : Math.round(pct * 10) / 10;
    return `
      <div class="mtg-bar-row">
        <span class="mtg-bar-label">${escapeHtml(label)}</span>
        <div class="mtg-bar-track"><div class="mtg-bar-fill" style="width:${Math.min(100, pct)}%; background:${color}"></div></div>
        <span class="mtg-bar-pct" style="color:${color}">${shown}%</span>
      </div>
    `;
  }

  // Small coloured tick/cross/dot icon -- replaces the plain "Pass"/"Fail"
  // text that used to sit in every check-grid cell (Device Health Summary,
  // Hardware Lifecycle), same colour language as the rest of the page.
  function checkIconSvg(status) {
    if (status === 'pass') {
      return `<svg class="mtg-check-icon" viewBox="0 0 20 20"><circle cx="10" cy="10" r="9" fill="#16a34a"/><path d="M6 10.5l2.5 2.5 6-6" stroke="white" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    }
    if (status === 'fail') {
      return `<svg class="mtg-check-icon" viewBox="0 0 20 20"><circle cx="10" cy="10" r="9" fill="#dc2626"/><path d="M6.5 6.5l7 7M13.5 6.5l-7 7" stroke="white" stroke-width="2.2" stroke-linecap="round"/></svg>`;
    }
    if (status === 'unknown') {
      return `<svg class="mtg-check-icon" viewBox="0 0 20 20"><circle cx="10" cy="10" r="9" fill="#f59e0b"/><text x="10" y="14" text-anchor="middle" font-size="12" fill="white" font-weight="700">?</text></svg>`;
    }
    return `<svg class="mtg-check-icon mtg-check-icon--na" viewBox="0 0 20 20"><circle cx="10" cy="10" r="3" fill="#c7cbd1"/></svg>`; // no icon at all for this cell on the source report -- not a value, not a failure
  }

  // Full-width clean/found headline -- the one thing a TAM wants to know
  // before any of the other widgets, for a report kind (Dark Web
  // Monitoring) where "nothing happened this period" is the common,
  // genuinely good outcome and deserves to read as good news rather than
  // an empty donut.
  function statusBanner(clean, text) {
    return `
      <div class="mtg-status-banner ${clean ? 'mtg-status-banner--good' : 'mtg-status-banner--bad'}">
        <span class="mtg-status-icon">${checkIconSvg(clean ? 'pass' : 'fail')}</span>
        <span class="mtg-status-text">${escapeHtml(text)}</span>
      </div>
    `;
  }

  // Two (or more) bars compared against each other rather than against a
  // fixed 0-100% capacity read like barWidget -- there's no natural
  // ceiling for "how many compromises were found", so the largest value
  // in the set is what fills a bar completely.
  function compareBarsWidget(title, items) {
    const max = Math.max(1, ...items.map((i) => i.value));
    const rows = items
      .map(
        (i) => `
      <div class="mtg-bar-row">
        <span class="mtg-bar-label">${escapeHtml(i.label)}</span>
        <div class="mtg-bar-track"><div class="mtg-bar-fill" style="width:${(i.value / max) * 100}%; background:${i.color}"></div></div>
        <span class="mtg-bar-pct" style="color:${i.color}">${i.value}</span>
      </div>`
      )
      .join('');
    return `
      <div class="mtg-widget">
        ${title ? `<p class="mtg-widget-title">${escapeHtml(title)}</p>` : ''}
        ${rows}
      </div>
    `;
  }

  // -- Per-report widget selections -----------------------------------------
  // Different reports get different widgets, deliberately ("it's ok to use
  // different ones in different places") -- whichever shape actually suits
  // that report's own numbers, not one uniform layout forced onto all 6.

  function executiveSummaryWidgetsHtml(component) {
    const summarySection = component.sections.find((s) => s.kind === 'summary') || { overallScore: null, services: {} };
    const gauge = `
      <div class="mtg-widget mtg-widget--gauge">
        ${gaugeSvg(summarySection.overallScore)}
        <div class="mtg-gauge-services">
          ${Object.entries(summarySection.services || {})
            .map(([name, score]) => `<span class="mtg-mini-score">${escapeHtml(name)} ${scoreBadge(score)}</span>`)
            .join('')}
        </div>
      </div>
    `;
    // Same legend labels genuinely repeat across Patch/Software/Antivirus
    // (validated against the real report -- see executiveSummaryHtml's own
    // comment on this), so one colour map covers all three donuts.
    const donutColors = {
      'Fully Patched': '#16a34a',
      'Running and Up to Date': '#16a34a',
      Compliant: '#16a34a',
      'Approved Pending': '#86c95e',
      'Install Error': '#f59e0b',
      'Not up to date': '#f59e0b',
      'Reboot Required': '#dc2626',
      'Not Running': '#dc2626',
      'Not Compliant': '#dc2626',
      'No Data': '#7f1d1d',
      'Not Detected': '#7f1d1d',
      'No Policy': '#9aa3af',
      Unmanaged: '#9aa3af',
    };
    // Open (unresolved) alerts by priority -- same semantics as the
    // separate Open Monitor Alerts report kind, just this section's own
    // cross-check of it. Fixed colour map (not the Patch/Software/
    // Antivirus one above -- these are priority levels, not agent
    // status) since Critical/High/Moderate/Low/Information is a fixed,
    // known set of labels every Monitoring section uses.
    const alertPriorityColors = { Critical: '#dc2626', High: '#f59e0b', Moderate: '#2563eb', Low: '#9aa3af', Information: '#9aa3af' };
    const monitoringSection = component.sections.find((s) => s.kind === 'monitoring');
    let monitoringDonut = '';
    if (monitoringSection && (monitoringSection.alertsByPriority || []).length > 0) {
      const segments = monitoringSection.alertsByPriority.map((a) => ({ label: a.priority, value: a.unresolved, color: alertPriorityColors[a.priority] || '#9aa3af' }));
      const total = segments.reduce((s, x) => s + x.value, 0);
      monitoringDonut = donutWidget(`Open Alerts by Priority (${monitoringSection.score}%)`, segments, total);
    }
    const donuts = [];
    for (const section of component.sections) {
      if (section.kind === 'summary' || section.kind === 'asset-management' || section.kind === 'monitoring' || section.kind === 'proactive-maintenance') continue;
      for (const who of ['server', 'workstation']) {
        const d = section[who];
        if (!d || d.total === 0) continue;
        const segments = Object.entries(d.legend || {}).map(([label, value]) => ({ label, value, color: donutColors[label] || '#9aa3af' }));
        const whoLabel = who === 'server' ? 'Server' : 'Workstation';
        donuts.push(donutWidget(`${escapeHtml(section.title)} (${whoLabel}, ${d.score}%)`, segments, d.total));
      }
    }
    // Gauge on its own row, everything else below it -- by request. Two
    // separate .mtg-widget-grid containers rather than one, since a flex
    // row only wraps when it runs out of width; on a wide enough screen
    // the gauge would otherwise happily share a row with a donut or two.
    return `<div class="mtg-widget-grid">${gauge}</div><div class="mtg-widget-grid">${monitoringDonut}${donuts.join('')}</div>`;
  }

  // The PDF's own SUMMARY page is a Managed/Unmanaged donut (matching
  // Network Audit Report's own colour convention, blue for managed) --
  // missed the first time round (device table only, no chart), by
  // request ("check the other reports for missing widgets").
  function networkAuditWidgetsHtml(component) {
    const segments = [
      { label: 'Managed', value: component.stats.managedCount, color: '#2563eb' },
      { label: 'Unmanaged', value: component.stats.unmanagedCount, color: '#dc2626' },
    ];
    const total = component.stats.managedCount + component.stats.unmanagedCount;
    return `<div class="mtg-widget-grid">${donutWidget('Managed / Unmanaged', segments, total)}</div>`;
  }

  // Patches installed per device (compareBarsWidget -- there's no natural
  // 0-100% ceiling here the way there is for disk usage), plus a severity
  // donut -- by request ("see if there's something you can summarise
  // there"). Both come straight from data/*.json's own summary.byDevice /
  // summary.bySeverity, computed once at parse time from the real
  // per-device patch tables (see that file's own comment on why only
  // counts are kept, not the full per-patch listing).
  function patchManagementActivityWidgetsHtml(component) {
    const s = component.summary || {};
    const byDevice = compareBarsWidget(
      'Patches Installed by Device',
      (s.byDevice || []).map((d) => ({ label: d.device, value: d.count, color: '#2563eb' }))
    );
    const severityColors = { Critical: '#dc2626', Important: '#f59e0b', Moderate: '#2563eb', Low: '#9aa3af', Unspecified: '#9aa3af' };
    const severitySegments = Object.entries(s.bySeverity || {}).map(([label, value]) => ({ label, value, color: severityColors[label] || '#9aa3af' }));
    const severityTotal = severitySegments.reduce((n, x) => n + x.value, 0);
    const severityDonut = severityTotal > 0 ? donutWidget('Patches by Severity', severitySegments, severityTotal) : '';
    return `<div class="mtg-widget-grid">${byDevice}${severityDonut}</div>`;
  }

  // Top software titles by install count -- the report's own SUMMARY page
  // is already the whole client's software inventory (up to ~100 distinct
  // titles for a real client), too many to chart at once, so this caps at
  // the top 15 by instance count and says so; the full list is still one
  // click away via "Show full table data".
  function softwareWidgetsHtml(component) {
    const titles = ((component.summary || {}).titles || []).slice().sort((a, b) => b.instances - a.instances);
    const top = titles.slice(0, 15);
    const bar = compareBarsWidget(
      `Top ${top.length} Software by Installs${titles.length > top.length ? ` (of ${titles.length} total)` : ''}`,
      top.map((t) => ({ label: t.name, value: t.instances, color: '#2563eb' }))
    );
    return `<div class="mtg-widget-grid">${bar}</div>`;
  }

  function deviceStorageWidgetsHtml(component) {
    const bars = component.drives
      .slice()
      .sort((a, b) => (b.usedPercent ?? 0) - (a.usedPercent ?? 0))
      .map((d) => barWidget(d.device, d.usedPercent ?? 0))
      .join('');
    return `<div class="mtg-widget"><p class="mtg-widget-title">Disk Usage (highest first)</p>${bars}</div>`;
  }

  function patchManagementSummaryWidgetsHtml(component) {
    const colors = {
      'Fully Patched': '#16a34a',
      'Approved Pending': '#86c95e',
      'Install Error': '#f59e0b',
      'Reboot Required': '#dc2626',
      'No Data': '#7f1d1d',
      'No Policy': '#9aa3af',
    };
    const segments = Object.entries(component.summary || {}).map(([label, value]) => ({ label, value, color: colors[label] || '#9aa3af' }));
    const total = segments.reduce((s, x) => s + x.value, 0);
    return `<div class="mtg-widget-grid">${donutWidget('Patch Status (all devices)', segments, total)}</div>`;
  }

  function deviceHealthSummaryWidgetsHtml(component) {
    const s = component.summary || {};
    const passFail = donutWidget(
      'Checks Passed / Failed',
      [
        { label: 'Passed', value: s.checksPassed || 0, color: '#1e3a8a' },
        { label: 'Failed', value: s.checksFailed || 0, color: '#dc2626' },
      ],
      (s.checksPassed || 0) + (s.checksFailed || 0)
    );
    const typeColors = ['#2563eb', '#7c3aed', '#0891b2', '#ca8a04', '#be185d', '#4d7c0f'];
    const typeEntries = Object.entries(s.byDeviceType || {}).filter(([, v]) => v > 0);
    const typeSegments = typeEntries.map(([label, value], i) => ({ label, value, color: typeColors[i % typeColors.length] }));
    const typeDonut = typeSegments.length > 0 ? donutWidget('Devices by Type', typeSegments, typeSegments.reduce((sum, x) => sum + x.value, 0)) : '';
    return `<div class="mtg-widget-grid">${passFail}${typeDonut}</div>`;
  }

  function hardwareLifecycleWidgetsHtml(component) {
    const summary = component.summary || {};
    const repl = summary.replacementRecommendation || {};
    const replSegments = [
      { label: 'Within 12 months', value: repl['Replacement recommended within 12 months'] || 0, color: '#dc2626' },
      { label: '12 to 24 months', value: repl['Replacement recommended within 12-24 months'] || 0, color: '#f59e0b' },
      { label: 'Suitable 24+ months', value: repl['Suitable for 24 months+'] || 0, color: '#16a34a' },
      { label: 'Unknown', value: repl['Unknown'] || 0, color: '#9aa3af' },
    ];
    const replTotal = replSegments.reduce((s, x) => s + x.value, 0);
    const os = summary.osSupport || {};
    const osSegments = [
      { label: 'Supported', value: os['Operating system is supported'] || 0, color: '#16a34a' },
      { label: 'Unsupported (extended support needed)', value: os['Operating system is unsupported unless manufacturer extended support has been arranged'] || 0, color: '#f59e0b' },
      { label: 'Unsupported', value: os['Operating system is unsupported'] || 0, color: '#dc2626' },
    ];
    const osTotal = osSegments.reduce((s, x) => s + x.value, 0);
    return `<div class="mtg-widget-grid">${donutWidget('Replacement Recommendation', replSegments, replTotal)}${donutWidget('OS Support', osSegments, osTotal)}</div>`;
  }

  function darkWebMonitoringWidgetsHtml(component) {
    const s = component.summary || {};
    const clean = (s.totalCompromises || 0) === 0;
    const period = component.createDate ? ` (${component.createDate})` : '';
    const banner = statusBanner(clean, clean ? `No compromises found this period${period}` : `${s.totalCompromises} compromise${s.totalCompromises === 1 ? '' : 's'} found this period${period}`);

    // Same 3 categories every time (IPs / Personal Emails / Company
    // Domains) -- Dark Web ID's own fixed monitoring scope -- so a static
    // colour map is fine here, unlike Executive Summary's open-ended
    // section list.
    const catColors = { IPs: '#2563eb', 'Personal Emails': '#7c3aed', 'Company Domains': '#0891b2' };
    const catSegments = (s.byCategory || []).map((c) => ({ label: c.category, value: c.count, color: catColors[c.category] || '#9aa3af' }));
    const catTotal = catSegments.reduce((n, x) => n + x.value, 0);
    const categoryDonut = donutWidget('Compromises by Category', catSegments, catTotal);

    const compare = compareBarsWidget('This Client vs Customer Average', [
      { label: 'This client', value: s.totalCompromises || 0, color: '#dc2626' },
      { label: 'Customer average', value: (component.benchmark || {}).customerAverageCompromises || 0, color: '#9aa3af' },
    ]);

    const monitored = s.monitored || {};
    const monitoredRows = Object.entries(monitored)
      .map(([label, value]) => `<span class="mtg-mini-score">${escapeHtml(label)}: <strong>${value}</strong></span>`)
      .join('');
    const monitoredWidget = `
      <div class="mtg-widget">
        <p class="mtg-widget-title">Monitored Scope</p>
        <div class="mtg-gauge-services">${monitoredRows}</div>
      </div>
    `;

    return `${banner}<div class="mtg-widget-grid">${categoryDonut}${compare}${monitoredWidget}</div>`;
  }

  // -- Live widgets (Datto RMM devices, Autotask tickets) ------------------
  // Built for the "Core Resources" style layout Amber shared as a reference
  // screenshot (KPI tiles, a devices-by-type breakdown, a single check-in-
  // freshness bar, and a filterable device list), by request ("From Datto
  // RMM like you previously did but as widgets like this"). Unlike every
  // report widget above (read-only strings), the device table below wires
  // up its own filter input -- see wireDeviceFilters().

  // A small badge, same visual language as scoreBadge() (reusing its exact
  // CSS classes) but keyed off the server's own freshness bucket rather
  // than a numeric score.
  function freshnessBadge(freshness) {
    const map = { recent: ['good', 'Recent'], ageing: ['warn', 'Ageing'], stale: ['bad', 'Stale'], unknown: ['ok', 'Unknown'] };
    const [tier, label] = map[freshness] || ['ok', 'Unknown'];
    return `<span class="mtg-score-badge mtg-score-badge--${tier}">${escapeHtml(label)}</span>`;
  }

  // A row of KPI/stat tiles -- {label, value, sub?, tier?}. `tier` (good/
  // warn/bad) colours the value and sub-text the same red/amber/green
  // language every other widget on this page already uses; left off for a
  // neutral tile like "Total Devices".
  function kpiTileRow(tiles) {
    return `
      <div class="mtg-kpi-row">
        ${tiles
          .map(
            (t) => `
          <div class="mtg-kpi-tile${t.tier ? ` mtg-kpi-tile--${t.tier}` : ''}">
            <div class="mtg-kpi-value">${escapeHtml(String(t.value))}</div>
            <div class="mtg-kpi-label">${escapeHtml(t.label)}</div>
            ${t.sub ? `<div class="mtg-kpi-sub">${escapeHtml(t.sub)}</div>` : ''}
          </div>`
          )
          .join('')}
      </div>
    `;
  }

  // Devices-by-type breakdown -- deliberately reuses .mtg-bar-row/
  // .mtg-bar-track/.mtg-swatch as-is (no new CSS) rather than a donut, so
  // longer type names stay legible as a list rather than a legend crammed
  // beside a small circle. See buildDattoLiveDevicesComponent()'s own
  // server-side comment: the deviceType field this is grouped by hasn't
  // been confirmed against a real Datto payload from this account yet --
  // deviceTypeConfirmed carries that through to the caveat text below.
  function deviceTypeBarWidget(byType, total) {
    const colors = ['#2563eb', '#7c3aed', '#0891b2', '#ca8a04', '#be185d', '#4d7c0f'];
    const max = Math.max(1, ...byType.map((t) => t.count));
    const rows = byType
      .map(
        (t, i) => `
      <div class="mtg-bar-row">
        <span class="mtg-swatch" style="background:${colors[i % colors.length]}"></span>
        <span class="mtg-bar-label">${escapeHtml(t.type)}</span>
        <div class="mtg-bar-track"><div class="mtg-bar-fill" style="width:${(t.count / max) * 100}%; background:${colors[i % colors.length]}"></div></div>
        <span class="mtg-bar-pct">${t.count}</span>
      </div>`
      )
      .join('');
    return `
      <div class="mtg-widget">
        <p class="mtg-widget-title">Devices by Type</p>
        ${rows}
        <p class="inline-subtext mtg-devicetype-caveat">${byType.length} device type${byType.length === 1 ? '' : 's'} across ${total} device${total === 1 ? '' : 's'}.</p>
      </div>
    `;
  }

  // One bar, split into coloured segments by proportion (unlike
  // compareBarsWidget's several separate bars) -- the same
  // "seen <7d / 7-30d / 30+d / never" bucketing the KPI tiles above use,
  // shown as one glance-able read rather than 4 separate numbers.
  function checkinFreshnessWidget(summary) {
    const total = summary.total || 0;
    const segs = [
      { label: 'Seen <7 days', value: summary.seenRecent || 0, color: '#16a34a' },
      { label: 'Seen 7-30 days', value: summary.seenAgeing || 0, color: '#f59e0b' },
      { label: 'Not seen 30+ days', value: summary.notSeenStale || 0, color: '#dc2626' },
      { label: 'Never reported', value: summary.unknown || 0, color: '#9aa3af' },
    ].filter((s) => s.value > 0);
    const bar = segs.map((s) => `<div class="mtg-segbar-seg" style="width:${total > 0 ? (s.value / total) * 100 : 0}%; background:${s.color}"></div>`).join('');
    const legend = segs
      .map(
        (s) =>
          `<span><span class="mtg-swatch" style="background:${s.color}"></span>${escapeHtml(s.label)}: ${s.value} (${total > 0 ? Math.round((s.value / total) * 100) : 0}%)</span>`
      )
      .join('');
    return `
      <div class="mtg-widget">
        <p class="mtg-widget-title">Check-in Freshness</p>
        <div class="mtg-segbar-track">${bar}</div>
        <div class="mtg-segbar-legend">${legend}</div>
        <p class="inline-subtext">Based on each device's last RMM check-in (Datto's own lastSeen field).</p>
      </div>
    `;
  }

  // The live-filterable device list -- the table IS the full device list
  // (see renderDetail()'s own comment on why there's no second collapsed
  // copy), with a text filter matching against hostname OR last user, same
  // "Filter by hostname or user" behaviour as the reference screenshot.
  // Wired up by wireDeviceFilters() after this HTML lands in the DOM.
  function deviceListTableHtml(component) {
    if (component.devices.length === 0) {
      return '<p class="mtg-device-table-empty">No devices to list.</p>';
    }
    const bodyId = `mtg-device-table-body-${component.id}`;
    const rows = component.devices
      .map(
        (d) => `
      <tr data-filter-text="${escapeHtml(`${(d.hostname || '').toLowerCase()} ${(d.lastUser || '').toLowerCase()}`)}">
        <td>${escapeHtml(d.hostname || 'Unknown')}</td>
        <td>${escapeHtml(d.type)}</td>
        <td>${d.lastSeen ? escapeHtml(formatDateTime(d.lastSeen)) : 'Never reported'}</td>
        <td>${freshnessBadge(d.freshness)}</td>
        <td>${escapeHtml(d.lastUser || 'Unknown')}</td>
      </tr>`
      )
      .join('');
    return `
      <div class="mtg-device-filter">
        <input type="text" class="mtg-device-filter-input" data-target-body="${bodyId}" placeholder="Filter by hostname or user..." />
      </div>
      <div class="mtg-device-table-wrap">
        <table>
          <thead><tr><th>Hostname</th><th>Type</th><th>Last Seen</th><th>Status</th><th>Last User</th></tr></thead>
          <tbody id="${bodyId}">${rows}</tbody>
        </table>
      </div>
    `;
  }

  // Finds every device-filter input inside `root` (the just-rendered detail
  // panel) and wires its live filtering -- called after both the normal
  // per-card detail render and the Selected Overview panel, since either
  // one can contain a datto-live-devices widget. A plain substring match
  // against each row's own pre-lowercased data-filter-text (hostname + last
  // user together), same "type to narrow" behaviour as the reference
  // screenshot's own filter box. A no-op when `root` has no such input
  // (every other report kind, and the ticket summary).
  function wireDeviceFilters(root) {
    root.querySelectorAll('.mtg-device-filter-input').forEach((input) => {
      const tbody = root.querySelector(`#${input.dataset.targetBody}`);
      if (!tbody) return;
      input.addEventListener('input', () => {
        const term = input.value.trim().toLowerCase();
        tbody.querySelectorAll('tr').forEach((tr) => {
          tr.hidden = term.length > 0 && !(tr.dataset.filterText || '').includes(term);
        });
      });
    });
  }

  function dattoLiveDevicesWidgetsHtml(component) {
    const s = component.summary;
    const pct = (n) => (s.total > 0 ? Math.round((n / s.total) * 100) : 0);
    const kpis = kpiTileRow([
      { label: 'Total Devices', value: s.total },
      { label: 'Seen <7 Days', value: s.seenRecent, sub: `${pct(s.seenRecent)}%`, tier: 'good' },
      { label: 'Seen 7-30 Days', value: s.seenAgeing, sub: `${pct(s.seenAgeing)}%`, tier: 'warn' },
      { label: 'Not Seen 30+ Days', value: s.notSeenStale, sub: `${pct(s.notSeenStale)}%`, tier: 'bad' },
    ]);
    const typeWidget = component.byType.length > 0 ? deviceTypeBarWidget(component.byType, s.total) : '';
    const freshnessWidget = checkinFreshnessWidget(s);
    // Flagged in the UI itself, not just in conversation -- see this
    // component's own server-side comment (buildDattoLiveDevicesComponent())
    // for why deviceTypeConfirmed is false.
    const caveat = component.deviceTypeConfirmed
      ? ''
      : `<p class="inline-subtext mtg-devicetype-caveat">Heads up: the "type" categories above (Laptop/Desktop/Server/...) haven't been confirmed against this account's real live Datto data yet -- treat the breakdown as a rough guide until someone checks a real device payload against it.</p>`;
    return `
      ${kpis}
      <div class="mtg-widget-grid">${typeWidget}${freshnessWidget}</div>
      ${caveat}
      ${deviceListTableHtml(component)}
    `;
  }

  function autotaskTicketsWidgetsHtml(component) {
    if (component.resolveStatus === 'not-found') {
      return `<p class="status">This search didn't match exactly one Autotask company, so there's no ticket data to show -- try a more specific client/site name.</p>`;
    }
    if (component.resolveStatus === 'ambiguous') {
      const names = component.matches.map((m) => escapeHtml(m.companyName)).join(', ');
      return `<p class="status">This search matches more than one Autotask company (${names}) -- narrow the search to see ticket counts.</p>`;
    }
    const s = component.stats;
    const kpis = kpiTileRow([
      { label: 'Open Tickets', value: s.openCount },
      { label: `Opened in ${component.monthLabel}`, value: s.openedThisMonth },
      { label: `Closed in ${component.monthLabel}`, value: s.closedThisMonth, tier: 'good' },
    ]);
    const max = Math.max(1, ...component.byPriority.map((p) => p.count));
    const priorityRows =
      component.byPriority.length > 0
        ? component.byPriority
            .map(
              (p) => `
        <div class="mtg-bar-row">
          <span class="mtg-bar-label">${escapeHtml(p.label)}</span>
          <div class="mtg-bar-track"><div class="mtg-bar-fill" style="width:${(p.count / max) * 100}%; background:#2563eb"></div></div>
          <span class="mtg-bar-pct">${p.count}</span>
        </div>`
            )
            .join('')
        : '<p class="inline-subtext">No open tickets right now.</p>';
    return `
      ${kpis}
      <div class="mtg-widget"><p class="mtg-widget-title">Open Tickets by Priority</p>${priorityRows}</div>
      <p class="inline-subtext">First pass only, to be elaborated on. "Open" = no completion date yet (same definition Tickets Dashboard uses -- a Billing-Contract ticket sitting in billing still counts as open). "Opened"/"Closed in ${escapeHtml(
        component.monthLabel
      )}" count every non-monitoring-alert ticket created/closed this AEST calendar month, regardless of its current status.</p>
    `;
  }

  function executiveSummaryHtml(component) {
    const summarySection = component.sections.find((s) => s.kind === 'summary') || { services: {} };
    const overviewRows = Object.entries(summarySection.services || {})
      .map(([name, score]) => `<tr><td>${escapeHtml(name)}</td><td>${scoreBadge(score)}</td></tr>`)
      .join('');
    let html = `
      <table>
        <thead><tr class="shaded-row"><th>Category</th><th>Score</th></tr></thead>
        <tbody>${overviewRows}</tbody>
      </table>
    `;
    for (const section of component.sections) {
      if (section.kind === 'summary') continue;
      html += `<div class="mtg-report-section"><h3>${escapeHtml(section.title)} ${scoreBadge(section.score)}</h3>`;
      if (section.kind === 'asset-management') {
        html += `
          <table>
            <thead><tr class="shaded-row"><th>Device Type</th><th>Total Managed</th><th>Added Last 30 Days</th></tr></thead>
            <tbody>${(section.deviceTypes || [])
              .map((d) => `<tr><td>${escapeHtml(d.type)}</td><td>${d.totalManaged}</td><td>${d.addedLast30Days}</td></tr>`)
              .join('')}</tbody>
          </table>
          <table>
            <thead><tr class="shaded-row"><th>Health Check</th><th>Passed</th><th>Failed</th><th>Score</th></tr></thead>
            <tbody>${(section.healthChecks || [])
              .map(
                (c) => `
              <tr>
                <td>${escapeHtml(c.check)}</td>
                <td class="cell-flag-green">${c.passed}</td>
                <td class="${c.failed ? 'cell-flag-red' : ''}">${c.failed}</td>
                <td>${c.score}%</td>
              </tr>`
              )
              .join('')}</tbody>
          </table>
        `;
      } else if (section.kind === 'monitoring') {
        html += monitoringSectionHtml(section);
      } else if (section.kind === 'proactive-maintenance') {
        html += proactiveMaintenanceSectionHtml(section);
      } else {
        // Patch Management / Software Management / Antivirus all share the
        // same Server + Workstation donut shape -- a policy/agent status
        // legend, not a literal compliance percentage (validated against
        // the real report; the same legend labels genuinely do repeat
        // across all three sections).
        html += ['server', 'workstation']
          .map((who) => {
            const d = section[who];
            if (!d || d.total === 0) return '';
            const legendRows = Object.entries(d.legend || {})
              .map(([label, count]) => `<tr><td>${escapeHtml(label)}</td><td>${count}</td></tr>`)
              .join('');
            return `
              <p class="inline-subtext mtg-report-subhead">${who === 'server' ? 'Server' : 'Workstation'} (${d.total} device${d.total === 1 ? '' : 's'}, ${scoreBadge(d.score)})</p>
              <table>
                <thead><tr class="shaded-row"><th>Status</th><th>Count</th></tr></thead>
                <tbody>${legendRows}</tbody>
              </table>
            `;
          })
          .join('');
      }
      html += `</div>`;
    }
    return html;
  }

  // Monitoring's own table shapes (alert priority/device-type breakdowns,
  // plus the two "Top 5" device tables) -- genuinely missing from this
  // dashboard until now, across every client, not just a Fairway Capital
  // gap (see this file's own commit history: Blake Sign Co's original
  // executive-summary.json never had a "monitoring" section at all,
  // despite the source PDF always having one). "No data" is shown as its
  // own row rather than an empty table when a Top 5 list has nothing in
  // it, matching the PDF's own "No Data" placeholder.
  function monitoringSectionHtml(section) {
    const priorityRows = (section.alertsByPriority || [])
      .map((a) => `<tr><td>${escapeHtml(a.priority)}</td><td>${a.raised}</td><td>${a.resolved}</td><td>${a.unresolved}</td><td>${scoreBadge(a.score)}</td></tr>`)
      .join('');
    const deviceTypeRows = (section.alertsByDeviceType || [])
      .map((d) => `<tr><td>${escapeHtml(d.type)}</td><td>${d.raised}</td><td>${d.resolved}</td><td>${d.unresolved}</td></tr>`)
      .join('');
    const deviceAlertRows = (list) =>
      list.length === 0
        ? '<tr><td colspan="7" class="status">No data</td></tr>'
        : list
            .map(
              (d) => `<tr><td>${escapeHtml(d.device)}</td><td>${escapeHtml(d.description)}</td><td>${d.critical}</td><td>${d.high}</td><td>${d.moderate}</td><td>${d.low}</td><td>${d.information}</td></tr>`
            )
            .join('');
    return `
      <table>
        <thead><tr class="shaded-row"><th>Alert Priority</th><th>Raised</th><th>Resolved</th><th>Unresolved</th><th>Score</th></tr></thead>
        <tbody>${priorityRows}</tbody>
      </table>
      <table>
        <thead><tr class="shaded-row"><th>Device Type</th><th>Raised</th><th>Resolved</th><th>Unresolved</th></tr></thead>
        <tbody>${deviceTypeRows}</tbody>
      </table>
      <p class="inline-subtext mtg-report-subhead">Top 5 Servers by Alerts</p>
      <table>
        <thead><tr class="shaded-row"><th>Device</th><th>Description</th><th>Critical</th><th>High</th><th>Moderate</th><th>Low</th><th>Information</th></tr></thead>
        <tbody>${deviceAlertRows(section.topServersByAlerts || [])}</tbody>
      </table>
      <p class="inline-subtext mtg-report-subhead">Top 5 Other Devices by Alerts</p>
      <table>
        <thead><tr class="shaded-row"><th>Device</th><th>Description</th><th>Critical</th><th>High</th><th>Moderate</th><th>Low</th><th>Information</th></tr></thead>
        <tbody>${deviceAlertRows(section.topOtherDevicesByAlerts || [])}</tbody>
      </table>
    `;
  }

  // Proactive Maintenance -- the PDF's own scheduled-jobs list, no score
  // (its own description: "No score is calculated based on these
  // activities"), so scoreBadge(section.score) upstream already renders
  // nothing for this one rather than needing a special case there too.
  function proactiveMaintenanceSectionHtml(section) {
    const rows = (section.scheduledJobs || []).map((j) => `<tr><td>${escapeHtml(j.job)}</td><td>${escapeHtml(j.schedule)}</td><td>${j.components}</td></tr>`).join('');
    return `
      <table>
        <thead><tr class="shaded-row"><th>Scheduled Recurring Job</th><th>Schedule</th><th>Number of Components</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  function deviceStorageHtml(component) {
    const rows = component.drives
      .map((d) => {
        const pctClass = d.usedPercent != null && d.usedPercent >= 90 ? 'cell-flag-red' : '';
        const sub = d.description && d.description !== d.device ? ` <span class="inline-subtext">(${escapeHtml(d.description)})</span>` : '';
        return `
        <tr>
          <td>${escapeHtml(d.device)}${sub}</td>
          <td>${escapeHtml(d.drive)}</td>
          <td>${escapeHtml(d.driveType)}</td>
          <td>${escapeHtml(d.size)}</td>
          <td>${escapeHtml(d.free)}</td>
          <td class="${pctClass}">${d.usedPercent != null ? d.usedPercent + '%' : ''}</td>
        </tr>`;
      })
      .join('');
    return `
      <table>
        <thead><tr class="shaded-row"><th>Device</th><th>Drive</th><th>Type</th><th>Size</th><th>Free</th><th>Used</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  function networkAuditHtml(component) {
    const rows = component.devices
      .map(
        (d) => `
      <tr>
        <td>${escapeHtml(d.device)}</td>
        <td>${escapeHtml(d.description)}</td>
        <td>${escapeHtml(d.ipAddress)}</td>
        <td>${escapeHtml(d.vendor)}</td>
        <td>${escapeHtml(d.created)}</td>
      </tr>`
      )
      .join('');
    return `
      <table>
        <thead><tr class="shaded-row"><th>Device</th><th>Description</th><th>IP Address</th><th>Vendor</th><th>Created</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  // Nicely formatted, by request -- worst-first ordering (most open alerts
  // at the top, so the devices worth actually looking at aren't buried
  // among a page of zeroes), numeric columns centred rather than left-
  // hung, non-zero counts colour-flagged by the same priority colours the
  // rest of this page already uses (Critical red, High amber -- no
  // dashboard-wide .cell-flag-amber utility exists yet, so High gets an
  // inline colour rather than inventing one for a single caller), and the
  // device's description folded under its name the same way Device
  // Storage's own table already does, instead of its own column.
  function openMonitorAlertsHtml(component) {
    const sorted = component.devices.slice().sort((a, b) => b.total - a.total);
    const rows = sorted
      .map((d) => {
        const sub = d.description && d.description !== d.device ? ` <span class="inline-subtext">(${escapeHtml(d.description)})</span>` : '';
        return `
      <tr>
        <td>${escapeHtml(d.device)}${sub}</td>
        <td class="col-center">${d.total ? `<strong>${d.total}</strong>` : d.total}</td>
        <td class="col-center ${d.critical ? 'cell-flag-red' : ''}">${d.critical}</td>
        <td class="col-center" style="${d.high ? 'color:#f59e0b;font-weight:700;' : ''}">${d.high}</td>
        <td class="col-center">${d.moderate}</td>
        <td class="col-center">${d.low}</td>
        <td class="col-center">${d.information}</td>
      </tr>`;
      })
      .join('');
    return `
      <table>
        <thead><tr class="shaded-row"><th>Device</th><th class="col-center">Total</th><th class="col-center">Critical</th><th class="col-center">High</th><th class="col-center">Moderate</th><th class="col-center">Low</th><th class="col-center">Info</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  // Site-wide software+instance-count table -- the report's own SUMMARY
  // page, not the huge per-device version listing that follows it in the
  // source PDF (deliberately dropped, see buildReportComponent()).
  function softwareSummaryHtml(component) {
    const titles = (component.summary || {}).titles || [];
    const rows = titles.map((t) => `<tr><td>${escapeHtml(t.name)}</td><td>${t.instances}</td></tr>`).join('');
    return `
      <table>
        <thead><tr class="shaded-row"><th>Software</th><th>Instances Found</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  // Flat key/value fallback for the summary-only kinds whose `summary`
  // shape is just a handful of named counts (Device Activity, Device
  // Monitor Status, Patch Management Activity/Details) -- one level of
  // nesting (e.g. `byPriority`/`byStatus`) is flattened into the same
  // cell rather than needing its own bespoke table per kind.
  function genericSummaryHtml(summary) {
    const rows = Object.entries(summary || {})
      .map(([key, value]) => {
        const display = value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value).map(([k, v]) => `${k}: ${v}`).join(', ') : String(value);
        return `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(display)}</td></tr>`;
      })
      .join('');
    return `
      <table>
        <thead><tr class="shaded-row"><th>Metric</th><th>Value</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  function patchManagementSummaryHtml(component) {
    const legendRows = Object.entries(component.summary || {})
      .map(([label, count]) => `<tr><td>${escapeHtml(label)}</td><td>${count}</td></tr>`)
      .join('');
    const deviceRows = component.devices
      .map((d) => {
        const statusClass = d.patchStatus === 'Fully Patched' ? 'cell-flag-green' : d.patchStatus === 'Install Error' ? 'cell-flag-red' : '';
        return `
        <tr>
          <td>${escapeHtml(d.device)}</td>
          <td>${escapeHtml(d.lastReboot)}</td>
          <td>${d.installed}</td>
          <td>${d.approvedPending}</td>
          <td>${d.notApproved}</td>
          <td class="${statusClass}">${escapeHtml(d.patchStatus)}</td>
        </tr>`;
      })
      .join('');
    return `
      <table>
        <thead><tr class="shaded-row"><th>Status</th><th>Devices</th></tr></thead>
        <tbody>${legendRows}</tbody>
      </table>
      <table>
        <thead><tr class="shaded-row"><th>Device</th><th>Last Reboot</th><th>Installed</th><th>Approved Pending</th><th>Not Approved</th><th>Status</th></tr></thead>
        <tbody>${deviceRows}</tbody>
      </table>
    `;
  }

  // Fixed column order for both icon-grid reports, same order Datto prints
  // them in -- the parser feeding this data preserves whichever columns a
  // given report actually has data for, so a missing column here just
  // means that check wasn't applicable on this report, not a bug.
  const HEALTH_COLS = [
    'Disk Space',
    'RAM Quantity',
    'Software Compliant',
    'Fully Patched',
    'Antivirus Up to Date',
    'Under Warranty',
    'Online Within Last 30 Days',
    'No Open Alerts',
  ];
  const LIFECYCLE_COLS = ['OS Support', 'Disk Space', 'RAM Quantity', 'Under Warranty', 'Online Within Last 30 Days'];

  function checkCell(status) {
    return `<td class="mtg-check-cell">${checkIconSvg(status)}</td>`;
  }

  function deviceHealthSummaryHtml(component) {
    const header = HEALTH_COLS.map((c) => `<th>${escapeHtml(c)}</th>`).join('');
    const rows = component.devices
      .map((d) => `<tr><td>${escapeHtml(d.device)}</td>${HEALTH_COLS.map((c) => checkCell(d.checks[c])).join('')}</tr>`)
      .join('');
    return `
      <table>
        <thead><tr class="shaded-row"><th>Device</th>${header}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  function hardwareLifecycleHtml(component) {
    return component.bands
      .filter((band) => band.devices.length > 0)
      .map((band) => {
        const header = LIFECYCLE_COLS.map((c) => `<th>${escapeHtml(c)}</th>`).join('');
        const rows = band.devices
          .map(
            (d) => `
          <tr>
            <td>${escapeHtml(d.device)}</td>
            <td>${escapeHtml(d.operatingSystem)}</td>
            <td>${escapeHtml(d.lastUser)}</td>
            <td>${escapeHtml(d.buildDate || '')}</td>
            ${LIFECYCLE_COLS.map((c) => checkCell(d.checks[c])).join('')}
          </tr>`
          )
          .join('');
        return `
        <div class="mtg-report-section">
          <h3>${escapeHtml(band.label)} <span class="inline-subtext">(${band.devices.length})</span></h3>
          <table>
            <thead><tr class="shaded-row"><th>Device</th><th>OS</th><th>Last User</th><th>Build Date</th>${header}</tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
      })
      .join('');
  }

  function darkWebMonitoringHtml(component) {
    const s = component.summary || {};
    const b = component.benchmark || {};
    const m = component.monitoring || {};

    const summaryRows = (s.byCategory || [])
      .map((c) => `<tr><td>${escapeHtml(c.category)}</td><td>${c.count}</td><td>${c.change > 0 ? '+' : ''}${c.change}</td></tr>`)
      .join('');
    const monitoredRows = Object.entries(s.monitored || {})
      .map(([label, value]) => `<tr><td>${escapeHtml(label)}</td><td>${value}</td></tr>`)
      .join('');

    return `
      <div class="mtg-report-section">
        <h3>Summary</h3>
        <table>
          <thead><tr class="shaded-row"><th>Category</th><th>Compromises</th><th>Change vs Last Period</th></tr></thead>
          <tbody>${summaryRows}</tbody>
        </table>
        <p class="mtg-report-subhead">Monitored Scope</p>
        <table>
          <thead><tr class="shaded-row"><th>Type</th><th>Count Monitored</th></tr></thead>
          <tbody>${monitoredRows}</tbody>
        </table>
      </div>
      <div class="mtg-report-section">
        <h3>Benchmark Averages</h3>
        <table>
          <thead><tr class="shaded-row"><th>Your Multiplier</th><th>Customer Average Compromises</th></tr></thead>
          <tbody><tr><td>${escapeHtml(b.yourMultiplier || '')}</td><td>${b.customerAverageCompromises ?? ''}</td></tr></tbody>
        </table>
      </div>
      <div class="mtg-report-section">
        <h3>Monitoring</h3>
        <table>
          <thead><tr class="shaded-row"><th>Last Information Found</th><th>Compromises / Breaches Added</th></tr></thead>
          <tbody><tr><td>${escapeHtml(m.lastInformationFoundDate || '')}</td><td>${m.compromisesOrBreachesAdded ?? 0}</td></tr></tbody>
        </table>
        ${top5ByCategoryHtml(m.top5ByCategory || {})}
      </div>
      <div class="mtg-report-section">
        <h3>Organizational Compromises <span class="inline-subtext">(${(component.organizationalCompromises || []).length})</span></h3>
        ${organizationalCompromisesHtml(component.organizationalCompromises || [])}
      </div>
      <div class="mtg-report-section">
        <h3>Breaches <span class="inline-subtext">(${(component.breaches || {}).totalCompromises || 0})</span></h3>
        ${breachesHtml((component.breaches || {}).breaches || [])}
      </div>
    `;
  }

  // Dark Web ID's own template lists a Top 5 table per monitored category
  // even when empty ("No data") -- the parser already drops "No data"
  // placeholder rows, so an empty list here just means genuinely nothing
  // to show for that category this period.
  function top5ByCategoryHtml(top5) {
    const entries = Object.entries(top5);
    if (entries.length === 0) return '<p class="status">No category breakdown on this report.</p>';
    return entries
      .map(([category, rows]) => {
        const body = rows.length > 0 ? rows.map((r) => `<tr><td>${escapeHtml(r)}</td></tr>`).join('') : '<tr><td class="status">No data</td></tr>';
        return `
        <p class="mtg-report-subhead">Top 5 -- ${escapeHtml(category)}</p>
        <table>
          <tbody>${body}</tbody>
        </table>
      `;
      })
      .join('');
  }

  // Structurally reasonable against Dark Web ID's own template but, as of
  // this build, only ever validated against a clean-month sample with no
  // rows -- worth a second look the first time a real compromise comes
  // through (see data/README.md).
  function organizationalCompromisesHtml(rows) {
    if (rows.length === 0) return '<p class="status">No data -- no organisational compromises recorded this period.</p>';
    const body = rows
      .map(
        (r) => `
      <tr>
        <td>${escapeHtml(r.status)}</td>
        <td>${escapeHtml(r.addedFound)}</td>
        <td>${escapeHtml(r.monitoredValue)}</td>
        <td>${escapeHtml(r.source)}</td>
        <td>${escapeHtml(r.piiValue)}</td>
      </tr>`
      )
      .join('');
    return `
      <table>
        <thead><tr class="shaded-row"><th>Status</th><th>Added / Found</th><th>Monitored Value</th><th>Source</th><th>PII</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    `;
  }

  // Same caveat as organizationalCompromisesHtml() -- shape is right, real
  // data hasn't exercised it yet.
  function breachesHtml(rows) {
    if (rows.length === 0) return '<p class="status">No data -- no breaches recorded this period.</p>';
    const body = rows
      .map(
        (r) => `
      <tr>
        <td>${escapeHtml(r.breach)}</td>
        <td>${escapeHtml(r.description)}</td>
        <td>${escapeHtml(r.dates)}</td>
        <td>${escapeHtml(r.aboutMatchingCompromises)}</td>
      </tr>`
      )
      .join('');
    return `
      <table>
        <thead><tr class="shaded-row"><th>Breach</th><th>Description</th><th>Dates</th><th>About / Matching Compromises</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    `;
  }

  // -- Recommendations summary ---------------------------------------------
  // A rules-based read of whatever report components are currently loaded,
  // cross-referencing across report kinds the same way a TAM would by eye
  // before a client meeting (which devices are due for replacement AND
  // already causing trouble, whether the reports even agree on a device
  // count, and so on) -- by request ("can you add a button at the top to
  // produce the summary"). Deliberately NOT an LLM call -- there's no AI
  // backend wired into this dashboard, so this is a fixed set of checks
  // against the JSON shapes buildReportComponent() already produces, each
  // one degrading gracefully when its report kind isn't loaded for this
  // client. It's a starting point for the meeting, not a replacement for
  // actually reading the reports -- says so in its own output.

  // The actual rules now live in the shared, page-agnostic
  // meeting-prep-recommendations.js module (imported above) -- Service
  // Actions runs the exact same computeFindings() across every client at
  // once, so the checks themselves can't drift between the two pages.
  // This page keeps only its own presentation of the findings.
  function buildRecommendationsSummary(components, siteTerm) {
    const findings = computeFindings(components);
    return renderRecommendationsHtml(siteTerm, components, findings);
  }

  function renderRecommendationsHtml(siteTerm, components, findings) {
    const tierMeta = {
      action: { label: 'Fix before you present', className: 'mtg-rec-group--action' },
      gather: { label: 'Find out before you present', className: 'mtg-rec-group--gather' },
      watch: { label: 'Worth mentioning in the meeting', className: 'mtg-rec-group--watch' },
      good: { label: 'Good news to lead with', className: 'mtg-rec-group--good' },
    };
    const groups = ['action', 'gather', 'watch', 'good']
      .map((tier) => ({ tier, meta: tierMeta[tier], items: findings.filter((f) => f.tier === tier) }))
      .filter((g) => g.items.length > 0);

    const intro = `
      <p class="inline-subtext">Generated from the ${components.length} report component${components.length === 1 ? '' : 's'} currently loaded for "${escapeHtml(siteTerm)}" -- a rules-based read of what's here, not a substitute for actually opening each report.</p>
    `;

    if (groups.length === 0) {
      return `<div class="mtg-rec-panel">${intro}<p class="status">No notable issues surfaced from the loaded reports.</p></div>`;
    }

    const sections = groups
      .map(
        (g) => `
        <div class="mtg-rec-group ${g.meta.className}">
          <h3>${escapeHtml(g.meta.label)}</h3>
          ${g.items
            .map(
              (f) => `
            <div class="mtg-rec-item">
              <p class="mtg-rec-item-title">${escapeHtml(f.title)}</p>
              <p class="mtg-rec-item-detail">${escapeHtml(f.detail)}</p>
            </div>`
            )
            .join('')}
        </div>`
      )
      .join('');

    return `<div class="mtg-rec-panel">${intro}${sections}</div>`;
  }

  function formatDateTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString();
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
