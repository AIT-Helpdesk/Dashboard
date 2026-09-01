export const id = "ticket-dashboards-test";
export const label = "Ticket Dashboards (Test)";

// Module-scope, not inside mount() -- see classification-summary/client.js's
// own comment for why this survives the shell's teardown/re-mount cycle.
let lastData = null;

const TREND_TRACK_HEIGHT_PX = 140;

// Same palette Datto RMM's own donut cards use (STATUS_COLORS there) --
// only the two shades this page's single critical-tickets donut actually
// needs.
const DONUT_COLORS = { danger: '#dc3545', healthy: '#28a745' };

// Fixed denominator for the Critical Open Tickets donut's own ring sweep,
// by request -- NOT the open-ticket total (see renderCriticalDonut()'s own
// comment). 6 critical tickets (or more) fills the ring completely.
const CRITICAL_DONUT_SCALE = 6;

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>Ticket Dashboards (Test)</h1>
      <div class="date-form">
        <button type="button" id="refresh-button">Refresh</button>
      </div>
    </header>
    <p class="status">Experimental -- Autotask has no API for its own visual
      Dashboard widgets, so this rebuilds a rough equivalent from live ticket
      data instead. Only visible on your account while this is being tried
      out.</p>
    <p id="status" class="status">Loading...</p>
    <div id="summary" class="summary" hidden></div>
    <div id="trend-chart" class="resource-group" hidden></div>
    <div id="critical-chart" class="resource-group" hidden></div>
    <div id="status-chart" class="resource-group" hidden></div>
    <div id="queue-chart" class="resource-group" hidden></div>
    <div id="priority-chart" class="resource-group" hidden></div>
  `;

  const refreshButton = container.querySelector('#refresh-button');
  const statusEl = container.querySelector('#status');
  const summaryEl = container.querySelector('#summary');
  const trendChartEl = container.querySelector('#trend-chart');
  const criticalChartEl = container.querySelector('#critical-chart');
  const statusChartEl = container.querySelector('#status-chart');
  const queueChartEl = container.querySelector('#queue-chart');
  const priorityChartEl = container.querySelector('#priority-chart');

  refreshButton.addEventListener('click', load);

  async function load() {
    refreshButton.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = 'Loading...';
    summaryEl.hidden = true;
    trendChartEl.hidden = true;
    criticalChartEl.hidden = true;
    statusChartEl.hidden = true;
    queueChartEl.hidden = true;
    priorityChartEl.hidden = true;

    try {
      const res = await fetch('/api/ticket-dashboards-test');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastData = data;
      render(data);
    } catch (err) {
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      refreshButton.disabled = false;
    }
  }

  function render(data) {
    statusEl.hidden = true;

    summaryEl.hidden = false;
    summaryEl.innerHTML = `<strong>${data.openCount.toLocaleString()}</strong> ticket${data.openCount === 1 ? '' : 's'} currently open`;

    renderTrend(data.trend);
    renderCriticalSection(data.criticalOpenCount, data.criticalTickets);
    renderBarSection(statusChartEl, 'Open Tickets by Status', data.byStatus);
    renderBarSection(queueChartEl, 'Open Tickets by Queue', data.byQueue);
    renderBarSection(priorityChartEl, 'Open Tickets by Priority', data.byPriority);
  }

  // One vertical stacked bar per day (created stacked on closed), same
  // "column-reverse track + 2px gap between segments" shape as Security
  // Alerts' own weekly chart -- see styles.css's .vbar-chart comment.
  function renderTrend(trend) {
    const days = trend?.days || [];
    trendChartEl.hidden = days.length === 0;
    trendChartEl.innerHTML = '';
    if (days.length === 0) return;

    const header = document.createElement('div');
    header.className = 'resource-group-header';
    header.innerHTML = `<span>Created vs Closed -- last ${days.length} days</span><span class="count">${trend.totalCreated} created / ${trend.totalClosed} closed</span>`;
    trendChartEl.appendChild(header);

    const wrap = document.createElement('div');
    wrap.style.padding = '0.75rem 1rem';

    const legend = document.createElement('div');
    legend.className = 'chart-legend';
    legend.innerHTML = `
      <span class="legend-item"><span class="legend-swatch legend-swatch--created"></span>Created</span>
      <span class="legend-item"><span class="legend-swatch legend-swatch--closed"></span>Closed</span>
    `;
    wrap.appendChild(legend);

    const maxTotal = Math.max(1, ...days.map((d) => Math.max(d.created, d.closed)));

    const chart = document.createElement('div');
    chart.className = 'vbar-chart';
    chart.innerHTML = days
      .map((d) => {
        const createdPx = (d.created / maxTotal) * TREND_TRACK_HEIGHT_PX;
        const closedPx = (d.closed / maxTotal) * TREND_TRACK_HEIGHT_PX;
        return `
      <div class="vbar-col" title="${escapeHtml(d.label)}: ${d.created} created, ${d.closed} closed">
        <span class="vbar-value">${d.created}/${d.closed}</span>
        <span class="vbar-track">
          <span class="vbar-fill--created" style="height: ${createdPx}px"></span>
          <span class="vbar-fill--closed" style="height: ${closedPx}px"></span>
        </span>
        <span class="vbar-label">${escapeHtml(d.label)}</span>
      </div>`;
      })
      .join('');
    wrap.appendChild(chart);
    trendChartEl.appendChild(wrap);
  }

  // A single donut-ring widget for open tickets at priority "P1 - CRITICAL"
  // (confirmed live -- see server.js's own CRITICAL_PRIORITY_VALUE comment
  // for why this is priority, not the similarly-named-but-narrower status
  // 58 "License Update (CRITICAL)"), by request. Reuses Datto RMM's own
  // .datto-card/.datto-donut-* classes and donut-arc drawing (styles.css's
  // own comment already notes these are plain, page-agnostic SVG, not
  // actually Datto-specific despite the name) -- duplicated here rather
  // than imported, same "separate page package" reasoning every other
  // small shared UI helper on this dashboard already follows.
  //
  // The ring's sweep is against a FIXED denominator (CRITICAL_DONUT_SCALE),
  // not the open-ticket total -- by request: this reads as "how full is
  // the critical bucket," not "what share of the whole backlog is
  // critical." donutSvg()'s own Math.min(1, count/total) already caps the
  // sweep at a full ring once count reaches the scale, so anything at or
  // above it (6, 10, 50...) all look identically full -- the number in the
  // middle is still the real, uncapped count either way.
  //
  // The ticket list sits beside the donut, by request --
  // .critical-tickets-layout (styles.css) is a plain flex row, donut card
  // first then the list, stacking on narrow screens. The donut's own ring
  // size (180, up from the default 120) is 50% bigger than Datto RMM's own
  // default, by request -- see .critical-donut-wrap--large in styles.css
  // for the matching CSS-side size bump.
  function renderCriticalSection(criticalCount, criticalTickets) {
    criticalChartEl.hidden = false;
    criticalChartEl.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'resource-group-header';
    header.innerHTML = `<span>Critical Open Tickets</span><span class="count">P1 - CRITICAL</span>`;
    criticalChartEl.appendChild(header);

    const layout = document.createElement('div');
    layout.className = 'critical-tickets-layout';

    const donutWrap = document.createElement('div');
    donutWrap.className = 'datto-card-grid critical-donut-grid';
    const color = criticalCount > 0 ? DONUT_COLORS.danger : DONUT_COLORS.healthy;
    const card = document.createElement('div');
    card.className = 'datto-card';
    card.innerHTML = `
      <div class="datto-donut-wrap critical-donut-wrap--large">
        ${donutSvg(criticalCount, CRITICAL_DONUT_SCALE, color, 180)}
        <div class="datto-donut-center"><span class="datto-donut-count">${criticalCount}</span></div>
      </div>
      <div class="datto-card-label">Critical (P1)</div>
      <div class="datto-card-sub">Critical/Urgent/Licenses</div>
    `;
    donutWrap.appendChild(card);
    layout.appendChild(donutWrap);

    const listWrap = document.createElement('div');
    listWrap.className = 'critical-tickets-list';
    listWrap.innerHTML = criticalTicketsTableHtml(criticalTickets);
    layout.appendChild(listWrap);

    criticalChartEl.appendChild(layout);
  }

  // Plain <table> (no page-specific width class -- the generic base
  // table/th/td styling in styles.css already looks right for a simple
  // list like this), by request: Status, Ticket Number, Client Name,
  // Ticket Title, Resource (last) for every currently-critical open
  // ticket. No header row, by request -- just the widget and items.
  function criticalTicketsTableHtml(criticalTickets) {
    if (!criticalTickets || criticalTickets.length === 0) {
      return '<p class="status">No critical tickets currently open.</p>';
    }
    return `
      <table>
        <tbody>
          ${criticalTickets
            .map(
              (t) => `
            <tr>
              <td>${escapeHtml(t.status)}</td>
              <td class="ticket-number">${ticketLink(t)}</td>
              <td>${escapeHtml(t.clientName)}</td>
              <td>${escapeHtml(t.title)}</td>
              <td>${resourceCellHtml(t.resourceName)}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
    `;
  }

  // Red, by request, when a critical ticket has no resource assigned --
  // reuses .text-highlight-red, the SAME class (and same "Unallocated"
  // concept) Service Calls' own client.js already uses for an unstaffed
  // call, rather than a new one-off class.
  function resourceCellHtml(resourceName) {
    const label = escapeHtml(resourceName);
    return resourceName === 'Unassigned' ? `<span class="text-highlight-red">${label}</span>` : label;
  }

  // Real popup window, not just a new tab -- same convention every other
  // ticket link on this dashboard uses (see e.g. Tickets Created Today's
  // own ticketLink()).
  function ticketLink(t) {
    const label = escapeHtml(t.ticketNumber);
    if (!t.ticketUrl) return label;
    return `<a href="${escapeHtml(t.ticketUrl)}" target="_blank" rel="noopener noreferrer" onclick="window.open(this.href, '_blank', 'noopener,noreferrer,width=1200,height=900'); return false;">${label}</a>`;
  }

  // Plain horizontal bar list -- same markup/classes as
  // classification-summary's own bar chart, minus the click-to-drilldown
  // behaviour (there's no per-bar detail to show here, just the count), via
  // .bar-row--static (see styles.css).
  function renderBarSection(el, title, groups) {
    el.hidden = !groups || groups.length === 0;
    el.innerHTML = '';
    if (!groups || groups.length === 0) return;

    const header = document.createElement('div');
    header.className = 'resource-group-header';
    header.innerHTML = `<span>${escapeHtml(title)}</span><span class="count">${groups.length} group${groups.length === 1 ? '' : 's'}</span>`;
    el.appendChild(header);

    const wrap = document.createElement('div');
    wrap.style.padding = '0.75rem 1rem';

    const maxCount = Math.max(...groups.map((g) => g.count));
    const chart = document.createElement('div');
    chart.className = 'bar-chart';
    chart.innerHTML = groups
      .map(
        (g) => `
      <div class="bar-row bar-row--static">
        <span class="bar-label">${escapeHtml(g.label)}</span>
        <span class="bar-track"><span class="bar-fill" style="width: ${(g.count / maxCount) * 100}%"></span></span>
        <span class="bar-value">${g.count.toLocaleString()}</span>
      </div>`
      )
      .join('');
    wrap.appendChild(chart);
    el.appendChild(wrap);
  }

  // A single-arc donut ring (count/total as one colored sweep over a plain
  // background ring) -- same arc math as Datto RMM's own donutSvg()
  // (packages/datto-rmm/client.js), duplicated here rather than imported,
  // same "separate page package" reasoning every other small shared UI
  // helper on this dashboard already follows.
  function donutSvg(count, total, color, size = 120) {
    const cx = size / 2;
    const cy = size / 2;
    const r = size * 0.4;
    const stroke = size * 0.14;
    const pct = total > 0 ? Math.min(1, count / total) : 0;
    const sweep = pct * 360;
    const bg = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--border)" stroke-width="${stroke}" />`;
    const arc = sweep > 0 ? `<path d="${describeArc(cx, cy, r, 0, sweep)}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="butt" />` : '';
    return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${bg}${arc}</svg>`;
  }

  function polarToCartesian(cx, cy, r, angleDeg) {
    const rad = ((angleDeg - 90) * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  }

  function describeArc(cx, cy, r, startAngle, endAngle) {
    const start = polarToCartesian(cx, cy, r, endAngle);
    const end = polarToCartesian(cx, cy, r, startAngle);
    const largeArc = endAngle - startAngle <= 180 ? '0' : '1';
    return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 0 ${end.x} ${end.y}`;
  }

  if (lastData) {
    render(lastData);
  } else {
    load();
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
