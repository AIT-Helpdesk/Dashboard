export const id = "check-up";
export const label = "Check Up";

// Module-scope, not inside mount() -- same "restore instantly, survive a
// remount" convention every other page here uses. handlerOptions rarely
// changes (department membership), so it's cached across remounts same as
// the other two; handler/weeklyHoursPct are small and cheap enough that a
// fresh fetch every mount is fine, but still kept here so an in-flight
// fetch from a torn-down mount can't leave the CURRENT one stuck (see
// activeRender's own comment below).
let lastHandlerOptions = null;
let lastHandler = null;
let lastWeeklyHoursPct = null;
// Separate from lastHandler itself -- "no handler set yet" (a real,
// legitimate value readHandler() can return) and "haven't fetched at all
// yet this session" are two different things, and lastHandler alone can't
// tell them apart once it's legitimately null.
let hasLoadedOnce = false;

// Whichever mount() is CURRENTLY on screen registers its own render
// functions here, overwriting whatever the previous mount left behind.
// Fixes a real bug (see check-client/client.js's own activeRenderers for
// the fuller writeup): an in-flight fetch from an OLD, torn-down mount
// would otherwise call its own (now detached, invisible) render function.
let activeRender = {};

export function mount(container) {
  container.innerHTML = `
    <header class="page-header check-up-header">
      <div class="date-form">
        <button type="button" id="refresh-button">Refresh</button>
      </div>
    </header>
    <p id="status" class="status">Loading...</p>
    <div id="handler-section" class="check-up-handler-banner" hidden>
      <div class="check-up-handler-banner-row">
        <label for="handler-select" class="check-up-handler-banner-text">Helpdesk Handler:</label>
        <select id="handler-select" class="check-up-handler-select"></select>
      </div>
      <div id="handler-meta" class="check-up-handler-meta"></div>
    </div>
    <div id="weekly-hours-pct-grid" class="check-up-pct-grid" hidden></div>
    <div id="widget-notes" class="wsp-usage-box check-up-notes" hidden>
      <div class="wsp-usage-box-title">About This Page</div>
      <ul>
        <li><strong>Helpdesk Handler</strong> -- who's fielding the helpdesk right now. Chosen from Support Desk; Professional Services and Leadership Team are shown but greyed out (still selectable, just discouraged). Shared with everyone who opens this page, and survives a server restart, until someone changes it.</li>
        <li id="hours-pct-criteria-item" hidden></li>
      </ul>
    </div>
  `;

  const refreshButton = container.querySelector('#refresh-button');
  const statusEl = container.querySelector('#status');
  const handlerSectionEl = container.querySelector('#handler-section');
  const handlerSelectEl = container.querySelector('#handler-select');
  const handlerMetaEl = container.querySelector('#handler-meta');
  const notesEl = container.querySelector('#widget-notes');
  const weeklyHoursPctGridEl = container.querySelector('#weekly-hours-pct-grid');
  const hoursPctCriteriaItemEl = container.querySelector('#hours-pct-criteria-item');

  refreshButton.addEventListener('click', () => load());

  handlerSelectEl.addEventListener('change', async () => {
    const resourceId = handlerSelectEl.value;
    if (!resourceId) return;
    handlerSelectEl.disabled = true;
    try {
      const res = await fetch('/api/check-up/handler', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resourceId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastHandler = data.handler;
      activeRender.handler(data.handler);
    } catch (err) {
      alert(`Error setting Helpdesk Handler: ${err.message}`);
      activeRender.handler(lastHandler);
    } finally {
      handlerSelectEl.disabled = false;
    }
  });

  async function load() {
    refreshButton.disabled = true;
    // By request -- the Handler shown mid-refresh is still the OLD value
    // (lastHandler doesn't update until the fetch below resolves), so
    // picking a new one before then would be changing it based on stale
    // context. Re-enabled in `finally`, same as refreshButton itself.
    handlerSelectEl.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = 'Loading...';
    try {
      const [optionsRes, handlerRes, hoursRes] = await Promise.all([
        lastHandlerOptions ? null : fetch('/api/check-up/handler-options'),
        fetch('/api/check-up/handler', { cache: 'no-store' }),
        fetch('/api/check-up/weekly-hours-pct'),
      ]);
      if (optionsRes) {
        const optionsData = await optionsRes.json();
        if (!optionsRes.ok) throw new Error(optionsData.error || `Request failed (${optionsRes.status})`);
        lastHandlerOptions = optionsData;
      }
      const handlerData = await handlerRes.json();
      if (!handlerRes.ok) throw new Error(handlerData.error || `Request failed (${handlerRes.status})`);
      lastHandler = handlerData.handler;
      const hoursData = await hoursRes.json();
      if (!hoursRes.ok) throw new Error(hoursData.error || `Request failed (${hoursRes.status})`);
      lastWeeklyHoursPct = hoursData.weeklyHoursPct;

      hasLoadedOnce = true;
      statusEl.hidden = true;
      activeRender.handlerOptions(lastHandlerOptions);
      activeRender.handler(lastHandler);
      activeRender.weeklyHoursPct(lastWeeklyHoursPct);
      notesEl.hidden = false;
    } catch (err) {
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      refreshButton.disabled = false;
      handlerSelectEl.disabled = false;
    }
  }

  // Rebuilds the dropdown's own options (optgroups) -- called once on load
  // (handlerOptions rarely changes within a session) and again whenever
  // renderHandler() needs to reflect a newly-picked value as `selected`.
  function renderHandlerOptions(options) {
    if (!options) return;
    handlerSectionEl.hidden = false;
    handlerSelectEl.innerHTML = buildHandlerSelectOptionsHtml(options, lastHandler?.resourceId ?? null);
  }

  // Professional Services/Leadership options are greyed out via a plain
  // CSS class (.check-up-handler-option--other, styles.css), NOT
  // `disabled` -- by request ("I want them still clickable"), so they
  // read as discouraged without actually blocking a genuine pick from
  // either group.
  function buildHandlerSelectOptionsHtml(options, currentId) {
    const optionHtml = (r, discouraged) =>
      `<option value="${r.id}"${discouraged ? ' class="check-up-handler-option--other"' : ''}${r.id === currentId ? ' selected' : ''}>${escapeHtml(r.name)}</option>`;
    const placeholder = `<option value="" disabled${currentId ? '' : ' selected'}>Not yet set</option>`;
    return `
      ${placeholder}
      <optgroup label="Support Desk">${options.serviceDesk.map((r) => optionHtml(r, false)).join('')}</optgroup>
      <optgroup label="Professional Services">${options.professionalServices.map((r) => optionHtml(r, true)).join('')}</optgroup>
      <optgroup label="Leadership Team">${options.leadership.map((r) => optionHtml(r, true)).join('')}</optgroup>
    `;
  }

  function renderHandler(handler) {
    // The dropdown's own selected option IS the name display now, by
    // request ("can the content of the dropdown be used as the display of
    // the name instead of having it twice?") -- no separate name element
    // to keep in sync any more. Rebuilding the <select>'s own options
    // (rather than just setting .value) is what actually moves the
    // visible "selected" text, same "one place builds this markup"
    // reasoning renderHandlerOptions() above already follows.
    if (lastHandlerOptions) handlerSelectEl.innerHTML = buildHandlerSelectOptionsHtml(lastHandlerOptions, handler?.resourceId ?? null);
    handlerMetaEl.textContent =
      handler && handler.updatedAt ? `Last changed ${formatDateTime(handler.updatedAt)}${handler.updatedByName ? ` by ${handler.updatedByName}` : ''}` : '';
  }

  // Moved verbatim from @dashboard/tickets-dashboard's own client.js, by
  // request ("Move the 2 Client Hours and Billable hours over to the new
  // page from Tickets Dashboard") -- see that package's git history for
  // the fuller original comment on every choice here (why `null` hides
  // both tiles rather than showing an error, why the date sub-line is
  // shown once per tile rather than only in the criteria box, etc.).
  function renderWeeklyHoursPct(weeklyHoursPct) {
    if (!weeklyHoursPct) {
      weeklyHoursPctGridEl.hidden = true;
      hoursPctCriteriaItemEl.hidden = true;
      return;
    }
    weeklyHoursPctGridEl.hidden = false;
    const dateSub = escapeHtml(formatWeekRange(weeklyHoursPct.weekFrom, weeklyHoursPct.weekTo));
    weeklyHoursPctGridEl.innerHTML = `
      <div class="datto-card ${pctColorClass(weeklyHoursPct.clientHoursPct)}">
        <div class="check-up-pct-number">${formatPct(weeklyHoursPct.clientHoursPct)}</div>
        <div class="datto-card-label">Client Hours</div>
        <div class="datto-card-sub">${dateSub}</div>
      </div>
      <div class="datto-card ${pctColorClass(weeklyHoursPct.billableHoursPct)}">
        <div class="check-up-pct-number">${formatPct(weeklyHoursPct.billableHoursPct)}</div>
        <div class="datto-card-label">Billable Hours</div>
        <div class="datto-card-sub">${dateSub}</div>
      </div>
    `;
    hoursPctCriteriaItemEl.hidden = false;
    hoursPctCriteriaItemEl.innerHTML = `<strong>Hours %</strong> -- ${escapeHtml(formatWeekRange(weeklyHoursPct.weekFrom, weeklyHoursPct.weekTo))} -- Support Desk`;
  }

  function formatPct(n) {
    return `${Math.round(n)}%`;
  }

  function pctColorClass(pct) {
    if (pct >= 75) return 'check-up-pct-tile--green';
    if (pct >= 40) return 'check-up-pct-tile--orange';
    return 'check-up-pct-tile--red';
  }

  function formatWeekRange(fromKey, toKey) {
    const [fy, fm, fd] = fromKey.split('-').map(Number);
    const [ty, tm, td] = toKey.split('-').map(Number);
    const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const from = `${fd} ${MONTH_ABBR[fm - 1]}`;
    const to = `${td} ${MONTH_ABBR[tm - 1]}`;
    return fy !== ty ? `${from} ${fy} - ${to} ${ty}` : `${from} - ${to}`;
  }

  function formatDateTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // This mount is now the active one -- see activeRender's own comment up
  // top.
  activeRender = { handlerOptions: renderHandlerOptions, handler: renderHandler, weeklyHoursPct: renderWeeklyHoursPct };

  if (hasLoadedOnce) {
    statusEl.hidden = true;
    renderHandlerOptions(lastHandlerOptions);
    renderHandler(lastHandler);
    renderWeeklyHoursPct(lastWeeklyHoursPct);
    notesEl.hidden = false;
    // Still refreshes in the background -- cached values restore instantly
    // so the page never flashes blank on a remount, but every value here
    // (especially the Handler, which another tab may have changed) can be
    // stale, so a real fetch still runs right after.
    load();
  } else {
    load();
  }
}
