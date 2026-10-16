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
// Daily Figures per resource -- small/cheap (one day, not 13 weeks), so
// this is fetched alongside weeklyHoursPct in the main load() below, not
// gated behind the trends section's own Show button.
let lastDailyFigures = null;
// This Week (current, in-progress AEST week) per resource -- same
// "small/cheap, auto-load" tier as Daily Figures above, not the trends
// section's own Show-button tier.
let lastThisWeekFigures = null;
// Separate from lastHandler itself -- "no handler set yet" (a real,
// legitimate value readHandler() can return) and "haven't fetched at all
// yet this session" are two different things, and lastHandler alone can't
// tell them apart once it's legitimately null.
let hasLoadedOnce = false;

// 13-Week Trends -- fetched on demand only (one click of its own Show
// button, same convention @dashboard/times' own Work-Type Reconciliation
// section uses), NOT part of the main load() above: a genuinely heavy,
// slow fetch (13 weeks of per-resource TimeEntries/ticket queries, fully
// sequential server-side to stay under Autotask's own rate limit --
// confirmed live at ~90 seconds for 5 resources). Cached at module scope
// like everything else here so navigating away and back restores it
// instantly rather than paying that cost again; unlike weeklyHoursPct,
// there's no background re-fetch behind the cached restore -- the 13
// historical weeks this covers don't meaningfully change within a
// session, so a second ~90s fetch nobody asked for isn't worth it.
let lastResourceTrends = null;

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
    <h2 class="section-heading">Daily Figures (Support Desk)</h2>
    <div id="daily-figures-container" class="check-up-trend-grid"></div>
    <h2 class="section-heading">This Week (Support Desk)</h2>
    <div id="this-week-figures-container" class="check-up-trend-grid"></div>
    <div id="trends-container"></div>
  `;

  const refreshButton = container.querySelector('#refresh-button');
  const statusEl = container.querySelector('#status');
  const handlerSectionEl = container.querySelector('#handler-section');
  const handlerSelectEl = container.querySelector('#handler-select');
  const handlerMetaEl = container.querySelector('#handler-meta');
  const weeklyHoursPctGridEl = container.querySelector('#weekly-hours-pct-grid');
  const dailyFiguresContainerEl = container.querySelector('#daily-figures-container');
  const thisWeekFiguresContainerEl = container.querySelector('#this-week-figures-container');
  const trendsContainerEl = container.querySelector('#trends-container');

  // Sequential, NOT Promise.all/fire-and-forget-in-parallel -- confirmed
  // the hard way ("429 errors everywhere"): load()/loadDailyFigures()/
  // loadThisWeekFigures() each make their own live Autotask calls, and
  // firing all three at once (on every mount AND every Refresh click)
  // roughly tripled this page's concurrent Autotask traffic the moment
  // Daily Figures/This Week shipped, on top of whatever else the account
  // is doing elsewhere at that moment. Each one is already individually
  // fast (a few seconds), so running them one after another instead of
  // all at once costs a little total wall-clock time in exchange for not
  // tripping the account-wide rate limit.
  // 13-Week Trends now loads automatically too, by request ("remove the
  // Show button and do that automatically after everything else is
  // loaded") -- last in the sequence, since it's the heaviest of the
  // four (a ~90s cold computation server-side, though normally served
  // from that 1-hour cache instead). `loadResourceTrends()`'s own guard
  // means this is a no-op once `lastResourceTrends` is set -- same "no
  // background re-fetch, this data doesn't change within a session"
  // reasoning its own comment already documents, so a Refresh click
  // doesn't re-trigger a ~90s fetch every time either.
  async function loadAllFigures() {
    await load();
    await loadDailyFigures();
    await loadThisWeekFigures();
    await loadResourceTrends();
  }

  refreshButton.addEventListener('click', () => loadAllFigures());

  async function loadResourceTrends() {
    if (lastResourceTrends) return;
    trendsContainerEl.innerHTML = '<p class="status loading">Loading 13-week trends...</p>';
    try {
      const res = await fetch('/api/check-up/resource-trends');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastResourceTrends = data;
      renderResourceTrends(data);
    } catch (err) {
      trendsContainerEl.innerHTML = `<p class="status error">Error: ${err.message}</p>`;
    }
  }

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
    } catch (err) {
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      refreshButton.disabled = false;
      handlerSelectEl.disabled = false;
    }
  }

  // Deliberately NOT part of load()'s own Promise.all above -- this is a
  // real (if cheap, one-day-not-13-weeks) live Autotask computation, same
  // kind of call /resource-trends makes, just much smaller. Keeping it
  // separate means a slow/failed daily-figures fetch can't hold up or
  // blank out the rest of the page (Handler/weekly-hours-pct), and a
  // failure here shows inline in its own container rather than taking
  // over the page's main status line.
  async function loadDailyFigures() {
    try {
      const res = await fetch('/api/check-up/daily-figures');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastDailyFigures = data;
      activeRender.dailyFigures(data);
    } catch (err) {
      dailyFiguresContainerEl.innerHTML = `<p class="status error">Error: ${err.message}</p>`;
    }
  }

  // Same reasoning as loadDailyFigures() above -- kept separate from the
  // main load(), own inline error state, never blocks the rest of the
  // page.
  async function loadThisWeekFigures() {
    try {
      const res = await fetch('/api/check-up/this-week-figures');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastThisWeekFigures = data;
      activeRender.thisWeekFigures(data);
    } catch (err) {
      thisWeekFiguresContainerEl.innerHTML = `<p class="status error">Error: ${err.message}</p>`;
    }
  }

  // Resource order/columns come from the same name-sorted Support Desk
  // list /resource-trends itself uses (handlerOptions.serviceDesk,
  // server-side) -- and this reuses .check-up-trend-grid's own grid-
  // template-columns unchanged, so with the same resources in the same
  // order, each card here lands in the exact same column as that
  // resource's own trend-chart card below it, by request ("lined up with
  // the Resources... in the 13 week view").
  // Shared by Daily Figures and This Week below -- identical card shape,
  // just a different resource list and a different date/range sub-text.
  function renderResourceFiguresGrid(containerEl, resources, dateSub) {
    if (!resources.length) {
      containerEl.innerHTML = '<p class="status">No Support Desk resources found.</p>';
      return;
    }
    containerEl.innerHTML = resources
      .map(
        (r) => `
          <div class="check-up-trend-card">
            <div class="check-up-trend-card-title">${escapeHtml(r.name)}</div>
            <div class="check-up-daily-figures-row">
              <div class="datto-card ${pctColorClass(r.billablePct)}">
                <div class="check-up-pct-number">${formatPct(r.billablePct)}</div>
                <div class="check-up-daily-figures-hours">${formatHoursHm(r.billableHours)}</div>
                <div class="datto-card-label">Billable</div>
              </div>
              <div class="datto-card">
                <div class="check-up-pct-number check-up-pct-number--large">${r.ticketsClosed}</div>
                <div class="datto-card-label">Tickets Closed</div>
              </div>
            </div>
            <div class="datto-card-sub">${escapeHtml(dateSub)}</div>
          </div>
        `
      )
      .join('');
  }

  function renderDailyFigures(data) {
    renderResourceFiguresGrid(dailyFiguresContainerEl, data.resources, formatDateKey(data.date));
  }

  function renderThisWeekFigures(data) {
    renderResourceFiguresGrid(thisWeekFiguresContainerEl, data.resources, formatWeekRange(data.from, data.to));
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
  }

  function formatPct(n) {
    return `${Math.round(n)}%`;
  }

  // Same HH:MM convention Time Summaries' own formatHours() uses --
  // round to the nearest minute, rolling over into the next hour rather
  // than ever showing :60. By request, under the Billable % in the Daily
  // Figures/This Week tiles, so the actual hours behind that % are
  // visible too, not just the percentage.
  function formatHoursHm(n) {
    const totalMinutes = Math.round(((n || 0) + Number.EPSILON) * 60);
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  // ONE combined chart per resource, by explicit request (Billable % and
  // Tickets Closed on the same graph, left scale 0-100%, right scale
  // 0-30) -- a deliberate, requested exception to the dataviz skill's own
  // "never dual-axis" default, not an oversight. Both scales are FIXED
  // (not data-driven), by request, so every resource's tile reads off the
  // exact same two scales and stays genuinely comparable tile-to-tile.
  function renderResourceTrends(data) {
    if (!data.resources.length) {
      trendsContainerEl.innerHTML = '<p class="status">No Support Desk resources found.</p>';
      return;
    }
    // EOW = Sundays -- every week here is a full, completed Monday..Sunday
    // week (see last13Weeks() in server.js), by request, so this is
    // genuinely "week by week", never a partial in-progress week.
    const dateRangeSub = escapeHtml(formatWeekRange(data.weeks[0].from, data.weeks[data.weeks.length - 1].to));
    const cards = data.resources.map((r) => trendCardHtml(r.name, r.weeks)).join('');
    trendsContainerEl.innerHTML = `
      <div class="check-up-trend-heading-row">
        <h2 class="section-heading">13 Week Trend (Support Desk) <span class="check-up-trend-range">${dateRangeSub} (EOW = Sundays)</span></h2>
        <div class="check-up-trend-legend">
          <span class="check-up-trend-legend-item"><span class="check-up-trend-legend-swatch check-up-trend-legend-swatch--billable"></span>Billable Time</span>
          <span class="check-up-trend-legend-item"><span class="check-up-trend-legend-swatch check-up-trend-legend-swatch--tickets"></span>Tickets Closed</span>
        </div>
      </div>
      <div class="check-up-trend-grid">${cards}</div>
    `;
  }

  function trendCardHtml(name, weeks) {
    const pointLabels = weeks.map((w) => formatWeekRange(w.from, w.to));
    const billableValues = weeks.map((w) => w.billablePct);
    const ticketValues = weeks.map((w) => w.ticketsClosed);
    return `
      <div class="check-up-trend-card">
        <div class="check-up-trend-card-title">${escapeHtml(name)}</div>
        ${dualLineChartSvg(billableValues, ticketValues, pointLabels)}
      </div>
    `;
  }

  // Identity comes from the shared legend above (blue = Billable Time,
  // green = Tickets Closed), not from a per-chart legend or direct
  // end-labels -- with two lines, a scale on each side, AND per-point
  // tooltips already doing real work in a small tile, stacking direct
  // end-labels on top risked exactly the label collision
  // marks-and-anatomy.md calls out; falling back to legend + tooltip (as
  // it recommends) keeps this one readable. The end-dot on each line still
  // marks "this is the latest week" even without its own text label.
  // Every other week's own real value stays reachable without hovering
  // gated behind nothing -- each point carries a native <title> tooltip
  // (same pragmatic approach SaaS Protection's own 30-day Backup Status
  // chart already uses for compact per-point data, no JS tooltip layer
  // needed).
  function dualLineChartSvg(billableValues, ticketValues, pointLabels) {
    const width = 260;
    // Twice the original 112, by request ("make those charts about twice
    // their current height so the movement stands out better") -- only
    // height grows, width/padding stay the same, so each week-to-week
    // move covers twice the vertical distance without changing the
    // chart's overall shape or point spacing.
    const height = 224;
    const leftPad = 28;
    const rightPad = 28;
    const topPad = 10;
    const bottomPad = 10;
    const plotWidth = width - leftPad - rightPad;
    const plotHeight = height - topPad - bottomPad;
    const n = billableValues.length;
    const xAt = (i) => leftPad + (n > 1 ? (i / (n - 1)) * plotWidth : plotWidth / 2);
    // Fixed scales, by request -- 0-100 for Billable %, 0-30 for Tickets
    // Closed -- not derived from the data, so every tile shares the same
    // two reference scales.
    const yAt = (v, max) => topPad + (1 - Math.max(0, Math.min(1, v / max))) * plotHeight;

    const billablePoints = billableValues.map((v, i) => ({ x: xAt(i), y: yAt(v, 100), v }));
    const ticketPoints = ticketValues.map((v, i) => ({ x: xAt(i), y: yAt(v, 30), v }));
    const pathOf = (points) => points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

    // Three shared horizontal gridlines (baseline/middle/top), each
    // labeled on BOTH sides at the value that scale reads at that height
    // -- one hairline grid serving both axes, rather than two independent
    // sets of gridlines fighting each other.
    const gridLines = [0, 0.5, 1]
      .map((f) => {
        const y = (topPad + (1 - f) * plotHeight).toFixed(1);
        return `
          <line x1="${leftPad}" y1="${y}" x2="${(leftPad + plotWidth).toFixed(1)}" y2="${y}" class="check-up-trend-gridline" />
          <text x="${(leftPad - 4).toFixed(1)}" y="${y}" dy="0.32em" text-anchor="end" class="check-up-trend-axis-label check-up-trend-axis-label--billable">${Math.round(f * 100)}%</text>
          <text x="${(leftPad + plotWidth + 4).toFixed(1)}" y="${y}" dy="0.32em" text-anchor="start" class="check-up-trend-axis-label check-up-trend-axis-label--tickets">${Math.round(f * 30)}</text>
        `;
      })
      .join('');

    const lastBillable = billablePoints[billablePoints.length - 1];
    const lastTicket = ticketPoints[ticketPoints.length - 1];
    const hitCircles = pointLabels
      .map((label, i) => {
        const b = billablePoints[i];
        const t = ticketPoints[i];
        return `
          <circle cx="${b.x.toFixed(1)}" cy="${b.y.toFixed(1)}" r="7" fill="transparent"><title>${escapeHtml(label)} - Billable: ${Math.round(billableValues[i])}%</title></circle>
          <circle cx="${t.x.toFixed(1)}" cy="${t.y.toFixed(1)}" r="7" fill="transparent"><title>${escapeHtml(label)} - Tickets Closed: ${Math.round(ticketValues[i])}</title></circle>
        `;
      })
      .join('');

    return `
      <svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" class="check-up-trend-svg" role="img" aria-label="Billable ${Math.round(lastBillable.v)}%, ${Math.round(lastTicket.v)} tickets closed, week ending ${escapeHtml(pointLabels[pointLabels.length - 1])}">
        ${gridLines}
        <path d="${pathOf(billablePoints)}" class="check-up-trend-line check-up-trend-line--billable" fill="none" />
        <path d="${pathOf(ticketPoints)}" class="check-up-trend-line check-up-trend-line--tickets" fill="none" />
        <circle cx="${lastBillable.x.toFixed(1)}" cy="${lastBillable.y.toFixed(1)}" r="6" class="check-up-trend-end-ring" />
        <circle cx="${lastBillable.x.toFixed(1)}" cy="${lastBillable.y.toFixed(1)}" r="4" class="check-up-trend-end-dot check-up-trend-end-dot--billable" />
        <circle cx="${lastTicket.x.toFixed(1)}" cy="${lastTicket.y.toFixed(1)}" r="6" class="check-up-trend-end-ring" />
        <circle cx="${lastTicket.x.toFixed(1)}" cy="${lastTicket.y.toFixed(1)}" r="4" class="check-up-trend-end-dot check-up-trend-end-dot--tickets" />
        ${hitCircles}
      </svg>
    `;
  }

  function pctColorClass(pct) {
    if (pct >= 75) return 'check-up-pct-tile--green';
    if (pct >= 40) return 'check-up-pct-tile--orange';
    return 'check-up-pct-tile--red';
  }

  const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function formatDateKey(dateKey) {
    const [, m, d] = dateKey.split('-').map(Number);
    return `${d} ${MONTH_ABBR[m - 1]}`;
  }

  function formatWeekRange(fromKey, toKey) {
    const [fy] = fromKey.split('-').map(Number);
    const [ty] = toKey.split('-').map(Number);
    const from = formatDateKey(fromKey);
    const to = formatDateKey(toKey);
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
  activeRender = {
    handlerOptions: renderHandlerOptions,
    handler: renderHandler,
    weeklyHoursPct: renderWeeklyHoursPct,
    dailyFigures: renderDailyFigures,
    thisWeekFigures: renderThisWeekFigures,
  };

  if (lastResourceTrends) {
    renderResourceTrends(lastResourceTrends);
  }

  if (hasLoadedOnce) {
    statusEl.hidden = true;
    renderHandlerOptions(lastHandlerOptions);
    renderHandler(lastHandler);
    renderWeeklyHoursPct(lastWeeklyHoursPct);
    if (lastDailyFigures) renderDailyFigures(lastDailyFigures);
    if (lastThisWeekFigures) renderThisWeekFigures(lastThisWeekFigures);
  }
  // Cached values (above) restore instantly on a remount so the page
  // never flashes blank, but every one of them can be stale (especially
  // the Handler, which another tab may have changed), so a real,
  // sequential refresh (loadAllFigures()) always runs right after either
  // way -- same call whether or not there was anything cached to restore
  // first. Daily Figures/This Week always reload too, by request ("Today
  // does need to reload") -- unlike the 13-week trends above (cached
  // server-side for an hour), neither is ever served stale on purpose.
  loadAllFigures();
}
