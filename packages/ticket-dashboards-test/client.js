export const id = "ticket-dashboards-test";
export const label = "Ticket Dashboards (Test)";

// Module-scope, not inside mount() -- see classification-summary/client.js's
// own comment for why this survives the shell's teardown/re-mount cycle.
let lastData = null;

const TREND_TRACK_HEIGHT_PX = 140;

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
    <div id="status-chart" class="resource-group" hidden></div>
    <div id="queue-chart" class="resource-group" hidden></div>
    <div id="priority-chart" class="resource-group" hidden></div>
  `;

  const refreshButton = container.querySelector('#refresh-button');
  const statusEl = container.querySelector('#status');
  const summaryEl = container.querySelector('#summary');
  const trendChartEl = container.querySelector('#trend-chart');
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
