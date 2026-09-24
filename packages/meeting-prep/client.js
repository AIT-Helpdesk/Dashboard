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
        <button type="button" id="summary-button" class="button-link button-link--small" hidden>Generate Recommendations Summary</button>
      </div>
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
  function orderedComponents(data) {
    const known = new Set(componentOrder);
    for (const c of data.components) {
      if (!known.has(c.id)) {
        componentOrder.push(c.id);
        known.add(c.id);
      }
    }
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
    return '';
  }

  // The overview tile's own detail: every ticked component's widgets, one
  // after another, in the same fixed order they appear in the grid (server
  // side REPORT_ORDER) -- no full table data underneath any of them, by
  // request ("shows the widgets from all sections"); the individual card
  // is still there to click for that. Nothing ticked yet is treated as a
  // normal, expected starting state, not an error.
  function overviewDetailEl() {
    const group = document.createElement('div');
    group.className = 'resource-group';
    const selected = lastData.components.filter((c) => selectedIds.has(c.id));
    if (selected.length === 0) {
      group.innerHTML = `
        <div class="resource-group-header"><span>Selected Overview</span></div>
        <p class="status">Tick the cards below to build a combined preview of their widgets here.</p>
      `;
      return group;
    }
    const sections = selected
      .map(
        (c) => `
        <div class="mtg-report-section">
          <h3>${escapeHtml(c.source)} -- ${escapeHtml(c.title)}</h3>
          ${widgetsHtmlForComponent(c)}
        </div>`
      )
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
        (s) => `<div class="mtg-donut-legend-row"><span class="mtg-swatch" style="background:${s.color}"></span>${escapeHtml(s.label)}<span class="mtg-donut-val">${s.value}</span></div>`
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
    const donuts = [];
    for (const section of component.sections) {
      if (section.kind === 'summary' || section.kind === 'asset-management') continue;
      for (const who of ['server', 'workstation']) {
        const d = section[who];
        if (!d || d.total === 0) continue;
        const segments = Object.entries(d.legend || {}).map(([label, value]) => ({ label, value, color: donutColors[label] || '#9aa3af' }));
        const whoLabel = who === 'server' ? 'Server' : 'Workstation';
        donuts.push(donutWidget(`${escapeHtml(section.title)} (${whoLabel}, ${d.score}%)`, segments, d.total));
      }
    }
    return `<div class="mtg-widget-grid">${gauge}${donuts.join('')}</div>`;
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

  // Datto's own "DD MON YYYY HH:MM (TZ)" format, and Dark Web Monitoring's
  // "DD-MM-YYYY to DD-MM-YYYY" period range (the range's END date is taken
  // as that component's "as of" date) -- every component's createDate is
  // normalised to one of these two shapes by server.js, so this is the one
  // place that needs to know both.
  function parseReportDate(str) {
    if (!str) return null;
    const rangeMatch = str.match(/\d{2}-\d{2}-\d{4}\s*to\s*(\d{2})-(\d{2})-(\d{4})/);
    if (rangeMatch) {
      const [, d, m, y] = rangeMatch;
      return new Date(Number(y), Number(m) - 1, Number(d));
    }
    const months = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
    const dattoMatch = str.match(/(\d{1,2})\s+([A-Z]{3})\s+(\d{4})/);
    if (dattoMatch && dattoMatch[2] in months) {
      const [, d, mon, y] = dattoMatch;
      return new Date(Number(y), months[mon], Number(d));
    }
    return null;
  }

  function formatShortDate(date) {
    return date.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  // Each report kind exposes its own devices differently (a flat list, a
  // list of drives, or bands of devices) -- not all of them carry the raw
  // `deviceCount` field from the source JSON through to the client, so this
  // counts from whichever device list each kind actually has, per report.
  function deviceCountsByReport(byKind) {
    const counts = {};
    if (byKind['device-health-summary']) counts[byKind['device-health-summary'].title] = byKind['device-health-summary'].devices.length;
    if (byKind['device-storage']) counts[byKind['device-storage'].title] = new Set(byKind['device-storage'].drives.map((d) => d.device)).size;
    if (byKind['patch-management-summary']) counts[byKind['patch-management-summary'].title] = byKind['patch-management-summary'].devices.length;
    if (byKind['hardware-lifecycle']) {
      counts[byKind['hardware-lifecycle'].title] = byKind['hardware-lifecycle'].bands.reduce((n, b) => n + b.devices.length, 0);
    }
    if (byKind['executive-summary']) {
      const assetSection = (byKind['executive-summary'].sections || []).find((s) => s.kind === 'asset-management');
      if (assetSection) {
        counts[byKind['executive-summary'].title] = (assetSection.deviceTypes || []).reduce((n, t) => n + (t.totalManaged || 0), 0);
      }
    }
    return counts;
  }

  function checkDataCurrency(byKind, add) {
    const dated = Object.values(byKind)
      .map((c) => ({ title: c.title, date: parseReportDate(c.createDate) }))
      .filter((d) => d.date);
    if (dated.length >= 2) {
      dated.sort((a, b) => a.date - b.date);
      const oldest = dated[0];
      const newest = dated[dated.length - 1];
      const spreadDays = Math.round((newest.date - oldest.date) / 86400000);
      if (spreadDays > 14) {
        add(
          'action',
          'These reports are not all from the same point in time',
          `${oldest.title} is dated ${formatShortDate(oldest.date)} and ${newest.title} is dated ${formatShortDate(newest.date)} -- a gap of about ${spreadDays} days. Worth refreshing the older reports, or at least flagging the gap to the client, before presenting these together as "current state".`
        );
      }
    }

    const counts = deviceCountsByReport(byKind);
    const distinct = [...new Set(Object.values(counts))];
    if (distinct.length > 1) {
      const detail = Object.entries(counts)
        .map(([title, n]) => `${title}: ${n}`)
        .join('; ');
      add('gather', "Device counts don't agree across reports", `${detail}. Worth confirming whether a device was added or decommissioned between report runs before presenting these as one consistent picture.`);
    }
  }

  function checkPatchManagement(patch, add) {
    const noPolicy = patch.devices.filter((d) => d.patchStatus === 'No Policy');
    if (noPolicy.length > 0) {
      add(
        'action',
        `${noPolicy.length} device${noPolicy.length === 1 ? ' has' : 's have'} no patch policy assigned at all`,
        `${noPolicy.map((d) => d.device).join(', ')} -- not just behind on patching, not covered by any policy. Worth assigning one and letting a cycle run before presenting this as resolved rather than open.`
      );
    }

    const rebootRequired = patch.devices.filter((d) => d.patchStatus === 'Reboot Required');
    if (rebootRequired.length > 0) {
      const reportDate = parseReportDate(patch.createDate);
      const staleNames = rebootRequired
        .map((d) => ({ device: d.device, lastReboot: parseReportDate(d.lastReboot) }))
        .filter((x) => x.lastReboot && reportDate && (reportDate - x.lastReboot) / 86400000 > 30)
        .map((x) => x.device);
      const names = rebootRequired.map((d) => d.device).join(', ');
      add(
        'action',
        `${rebootRequired.length} device${rebootRequired.length === 1 ? '' : 's'} waiting on a reboot to finish applying patches`,
        staleNames.length > 0
          ? `${names}. ${staleNames.join(', ')} ${staleNames.length === 1 ? "hasn't" : "haven't"} rebooted in over a month, so ${staleNames.length === 1 ? 'its' : 'their'} patches are sitting installed but inactive. Worth scheduling a reboot window before the meeting.`
          : `${names}. Worth scheduling reboots before the meeting so this shows as resolved rather than pending.`
      );
    }

    const heavyBacklog = patch.devices.filter((d) => (d.notApproved || 0) >= 20).sort((a, b) => b.notApproved - a.notApproved);
    if (heavyBacklog.length > 0) {
      add(
        'watch',
        `${heavyBacklog.length} device${heavyBacklog.length === 1 ? ' has' : 's have'} a large backlog of unapproved patches`,
        `${heavyBacklog.map((d) => `${d.device} (${d.notApproved})`).join(', ')}. Worth a patch approval review even on devices that do have a policy assigned.`
      );
    }
  }

  function checkStorage(storage, add) {
    const critical = storage.drives.filter((d) => (d.usedPercent ?? 0) >= 90);
    const high = storage.drives.filter((d) => (d.usedPercent ?? 0) >= 80 && (d.usedPercent ?? 0) < 90);
    if (critical.length > 0) {
      add(
        'action',
        `${critical.length} device${critical.length === 1 ? ' is' : 's are'} critically low on disk space`,
        `${critical.map((d) => `${d.device} (${d.usedPercent}% used, ${d.free} free)`).join(', ')}. Worth clearing space or expanding storage before the meeting -- a full system drive risks failed updates, not just a slow machine.`
      );
    }
    if (high.length > 0) {
      add('watch', `${high.length} device${high.length === 1 ? ' is' : 's are'} approaching capacity`, `${high.map((d) => `${d.device} (${d.usedPercent}% used)`).join(', ')}. Not urgent yet, but worth keeping an eye on.`);
    }
  }

  function checkSoftwareCompliance(exec, health, add) {
    const swSection = (exec.sections || []).find((s) => s.kind === 'software-management');
    if (!swSection || typeof swSection.score !== 'number') return;
    const otherScores = (exec.sections || [])
      .filter((s) => s.kind !== 'software-management' && s.kind !== 'summary' && typeof s.score === 'number')
      .map((s) => s.score);
    const isLowest = otherScores.length > 0 && swSection.score < Math.min(...otherScores);
    if (swSection.score >= 90 && !isLowest) return;
    const failingDevices = health ? health.devices.filter((d) => d.checks && d.checks['Software Compliant'] === 'fail').map((d) => d.device) : [];
    add(
      'gather',
      `Software Management is scoring ${swSection.score}%${isLowest ? ', the weakest category on this report' : ''}`,
      failingDevices.length > 0
        ? `${failingDevices.join(', ')} are failing the Software Compliant check, but the report data doesn't say which software or why. Worth pulling up the Software Management module for these devices before the meeting so you can name the actual issue rather than just the score.`
        : `The report data doesn't say which software is driving this down. Worth pulling up the Software Management module before the meeting so you have a specific answer ready.`
    );
  }

  function checkHardwareLifecycle(lifecycle, health, add) {
    const soonBand = (lifecycle.bands || []).find((b) => b.id === 'within-12-months');
    if (!soonBand || soonBand.devices.length === 0) return;
    const healthFailMap = new Map();
    if (health) {
      for (const d of health.devices) {
        const failedChecks = Object.entries(d.checks || {})
          .filter(([, v]) => v === 'fail')
          .map(([k]) => k);
        if (failedChecks.length > 0) healthFailMap.set(d.device, failedChecks);
      }
    }
    const overlap = soonBand.devices.filter((d) => healthFailMap.has(d.device));
    const names = soonBand.devices.map((d) => d.device).join(', ');
    if (overlap.length > 0) {
      add(
        'watch',
        `${soonBand.devices.length} device${soonBand.devices.length === 1 ? ' is' : 's are'} due for replacement within 12 months, and ${overlap.length === soonBand.devices.length ? 'all of them are' : `${overlap.length} of them ${overlap.length === 1 ? 'is' : 'are'}`} also currently causing trouble`,
        `${names}. ${overlap.map((d) => `${d.device} is also failing ${healthFailMap.get(d.device).join(', ')}`).join('; ')}. Worth framing the replacement recommendation together with the issues it would resolve, rather than as two separate line items.`
      );
    } else {
      add('watch', `${soonBand.devices.length} device${soonBand.devices.length === 1 ? ' is' : 's are'} due for replacement within 12 months`, `${names}. Worth having a budget figure ready in case the client asks.`);
    }
  }

  function checkWarrantyData(sourceComponents, add) {
    const allDevices = [];
    for (const c of sourceComponents) {
      if (c.devices) allDevices.push(...c.devices);
      if (c.bands) for (const b of c.bands) allDevices.push(...b.devices);
    }
    const withWarrantyField = allDevices.filter((d) => d.checks && 'Under Warranty' in d.checks);
    if (withWarrantyField.length === 0) return;
    const populated = withWarrantyField.filter((d) => d.checks['Under Warranty'] !== null);
    if (populated.length === 0) {
      add(
        'gather',
        "Warranty status isn't tracked for any device",
        `Every device's "Under Warranty" check comes back empty. If hardware replacement comes up in the meeting, you won't have a warranty answer ready from this data -- worth checking serials against the manufacturer beforehand, or populating this field going forward.`
      );
    }
  }

  function checkStaleDevices(health, add) {
    const stale = health.devices.filter((d) => d.checks && d.checks['Online Within Last 30 Days'] === 'fail');
    if (stale.length > 0) {
      add(
        'watch',
        `${stale.length} device${stale.length === 1 ? " hasn't" : "s haven't"} checked in within the last 30 days`,
        `${stale.map((d) => d.device).join(', ')}. Worth confirming with the client whether these are still active machines (and, if not, whether they should come off monitoring) before presenting them as an open issue.`
      );
    }
  }

  function checkDarkWebScope(darkWeb, add) {
    const summary = darkWeb.summary || {};
    const total = typeof summary.totalCompromises === 'number' ? summary.totalCompromises : 0;
    const monitored = summary.monitored || {};
    const zeroCategories = Object.entries(monitored)
      .filter(([, v]) => v === 0)
      .map(([k]) => k);
    if (total === 0) {
      add('good', 'No dark web compromises found this period', `Customer average is ${(darkWeb.benchmark || {}).customerAverageCompromises ?? 'n/a'}, so this is a strong result worth leading with.`);
    }
    if (zeroCategories.length > 0) {
      add(
        'gather',
        'Dark web monitoring scope is narrower than it could be',
        `${zeroCategories.join(' and ')} ${zeroCategories.length === 1 ? 'has' : 'have'} nothing being monitored at all. A clean result carries more weight when the monitored scope is reasonable -- worth checking with the client whether it should be widened (e.g. staff personal emails) before presenting a clean result as full coverage.`
      );
    }
  }

  function checkDeviceTypeCoverage(health, add) {
    const byType = health ? health.summary.byDeviceType : null;
    if (!byType) return;
    const hasNonWorkstation = Object.entries(byType).some(([type, n]) => type !== 'Workstations' && n > 0);
    if (!hasNonWorkstation) {
      add(
        'gather',
        'No servers, printers, or mobiles show up in any report',
        `Every monitored device is a workstation. If that's genuinely the whole environment, no action needed -- but if the client runs any on-prem servers, worth confirming they're actually covered by monitoring before presenting this as the complete picture.`
      );
    }
  }

  function buildRecommendationsSummary(components, siteTerm) {
    const byKind = {};
    for (const c of components) byKind[c.kind] = c;
    const findings = [];
    const add = (tier, title, detail) => findings.push({ tier, title, detail });

    checkDataCurrency(byKind, add);
    if (byKind['patch-management-summary']) checkPatchManagement(byKind['patch-management-summary'], add);
    if (byKind['device-storage']) checkStorage(byKind['device-storage'], add);
    if (byKind['executive-summary']) checkSoftwareCompliance(byKind['executive-summary'], byKind['device-health-summary'], add);
    if (byKind['hardware-lifecycle']) checkHardwareLifecycle(byKind['hardware-lifecycle'], byKind['device-health-summary'], add);
    checkWarrantyData([byKind['device-health-summary'], byKind['hardware-lifecycle']].filter(Boolean), add);
    if (byKind['device-health-summary']) checkStaleDevices(byKind['device-health-summary'], add);
    if (byKind['dark-web-monitoring']) checkDarkWebScope(byKind['dark-web-monitoring'], add);
    checkDeviceTypeCoverage(byKind['device-health-summary'], add);

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
