export const id = "saasalerts-alerts";
export const label = "Security Alerts";

// Module-scope, not inside mount() -- the shell fully tears down and re-mounts a
// page's DOM on every navigation away and back, but the dynamically-imported
// module itself is cached by the browser and stays alive for the session, so a
// module-level variable survives across re-mounts and lets the last result
// restore instantly instead of coming back blank.
let lastDate = null;
let lastPeriod = "1d";
let lastFilter = '';
let lastData = null;

// Keys and labels mirror PERIODS in server.js exactly -- kept in sync
// manually (same pattern as WINDOW_OPTIONS on Subscriptions Expiring), since
// the dropdown needs to render before any request to the server.
const PERIOD_OPTIONS = [
  { value: "1d", label: "1 day" },
  { value: "1w", label: "1 week" },
  { value: "1m", label: "1 month" },
  { value: "3m", label: "3 months" },
];

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>Security Alerts</h1>
      <form id="filter-form" class="date-form">
        <label for="date-input">Date</label>
        <input type="date" id="date-input" name="date" required />
        <label for="period-input">Period</label>
        <select id="period-input" name="period">
          ${PERIOD_OPTIONS.map((o) => `<option value="${o.value}">${o.label}</option>`).join('')}
        </select>
        <label for="client-input">Client</label>
        <input type="text" id="client-input" name="client" placeholder="optional, e.g. Acme* (wildcards with *)" />
        <button type="submit">Load</button>
      </form>
    </header>
    <p id="status" class="status">Pick a date, period, and click Load. Date is the start point; Period is how far forward from it the report runs. Shows medium and critical severity alerts only -- routine low-severity activity (sign-ins etc.) is left out by design.</p>
    <div id="summary" class="summary" hidden></div>
    <div id="week-chart" class="resource-group" hidden></div>
    <div id="alert-summary" hidden></div>
    <div id="results" class="results"></div>
  `;

  const form = container.querySelector('#filter-form');
  const dateInput = container.querySelector('#date-input');
  const periodInput = container.querySelector('#period-input');
  const clientInput = container.querySelector('#client-input');
  const statusEl = container.querySelector('#status');
  const summaryEl = container.querySelector('#summary');
  const weekChartEl = container.querySelector('#week-chart');
  const alertSummaryEl = container.querySelector('#alert-summary');
  const resultsEl = container.querySelector('#results');

  // AEST (UTC+10, no DST in Queensland) "today", not the browser's own local
  // timezone -- same convention as every other date-scoped page.
  function todayISO() {
    return new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }
  dateInput.value = lastDate || todayISO();
  periodInput.value = lastPeriod;
  clientInput.value = lastFilter;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    load(dateInput.value, periodInput.value, clientInput.value);
  });

  async function load(date, period, clientFilter) {
    const button = form.querySelector('button');
    button.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = `Loading alerts for ${date}...`;
    summaryEl.hidden = true;
    weekChartEl.hidden = true;
    weekChartEl.innerHTML = '';
    alertSummaryEl.hidden = true;
    alertSummaryEl.innerHTML = '';
    resultsEl.innerHTML = '';

    try {
      const params = new URLSearchParams({ date, period });
      if (clientFilter) params.set('client', clientFilter);
      const res = await fetch(`/api/saasalerts-alerts?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastDate = date;
      lastPeriod = period;
      lastFilter = clientFilter;
      lastData = data;
      render(data);
    } catch (err) {
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      button.disabled = false;
    }
  }

  function render(data) {
    statusEl.hidden = true;

    const filterSuffix = data.filterTerm ? ` matching "${escapeHtml(data.filterTerm)}"` : '';
    // "on {date}" for the 1-day period (reads the same as before Period
    // existed); "from {date} to {lastIncludedDate}" for anything longer --
    // periodEnd from the server is EXCLUSIVE, so the last included day is
    // one day before it.
    const periodPhrase = data.period === '1d' ? `on ${data.date}` : `from ${data.date} to ${subtractOneDay(data.periodEnd)}`;
    // Summed from the same chart data rendered below rather than a separate
    // server field -- it's already the exact (filter-consistent) total for
    // the chart's date range, so re-deriving it here can't drift out of sync
    // with what the chart itself shows. Day count comes from the chart
    // array's own length rather than a hardcoded "28", so this stays correct
    // if CHART_WEEKS (server.js) is ever retuned. Note this chart total is
    // for the CHART's own always-28-day window, separate from the Period
    // range above it -- the two can differ once Period is more than a day.
    const chartDays = data.chart || [];
    const chartTotal = chartDays.reduce((sum, d) => sum + d.total, 0);
    summaryEl.hidden = false;
    summaryEl.innerHTML = `<strong>${data.totalCount}</strong> alert${data.totalCount === 1 ? '' : 's'} ${periodPhrase}${filterSuffix} (${chartTotal} in the last ${chartDays.length} days)`;

    renderWeekChart(data);
    renderAlertSummary(data);

    resultsEl.innerHTML = '';
    if (data.totalCount === 0) {
      resultsEl.innerHTML = `<p class="status">No medium/critical alerts${filterSuffix} ${periodPhrase}.</p>`;
      return;
    }

    const group = document.createElement('div');
    group.className = 'resource-group';

    // Collapsible, starting minimized -- the Alert Summary above already
    // gives the at-a-glance view; this full list is the "show me everything"
    // detail underneath it, so it doesn't need to be open by default.
    const header = document.createElement('div');
    header.className = 'resource-group-header resource-group-header--toggle';
    header.innerHTML = `<span><span class="toggle-arrow">▸</span>All Alerts</span><span class="count">${data.totalCount} alert${data.totalCount === 1 ? '' : 's'}</span>`;
    group.appendChild(header);

    const tableWrap = document.createElement('div');
    tableWrap.hidden = true;
    tableWrap.innerHTML = `
      <table>
        <thead>
          <tr class="shaded-row"><th>Time</th><th>Client</th><th>Severity</th><th>Event</th><th>User</th><th>Ticket</th></tr>
        </thead>
        <tbody>
          ${data.rows
            .map(
              (r) => `
            <tr>
              <td class="ticket-number">${formatTime(r.time)}</td>
              <td>${customerLink(r)}</td>
              <td class="${r.severity === 'critical' ? 'cell-flag-red' : 'cell-flag-blue'}">${escapeHtml(capitalize(r.severity))}</td>
              <td>${escapeHtml(r.event)}${r.detail ? `<span class="cell-subtext">${escapeHtml(r.detail)}</span>` : ''}</td>
              <td>${escapeHtml(r.user)}</td>
              <td class="ticket-number">${ticketLink(r)}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
    `;
    group.appendChild(tableWrap);

    const arrow = header.querySelector('.toggle-arrow');
    header.addEventListener('click', () => {
      tableWrap.hidden = !tableWrap.hidden;
      arrow.textContent = tableWrap.hidden ? '▸' : '▾';
    });

    resultsEl.appendChild(group);
  }

  // Two-week-at-a-glance chart: one vertical stacked bar per day (14 days,
  // by request -- the selected date's Monday-Sunday week, plus the full
  // week immediately before it), critical stacked on medium, each column
  // scaled to the busiest day across BOTH weeks so every bar is comparable
  // on a shared scale. Renders even on a day with zero alerts -- a quiet day
  // is still meaningful context, not something to hide.
  function renderWeekChart(data) {
    const chartDays = data.chart || [];
    weekChartEl.hidden = chartDays.length === 0;
    weekChartEl.innerHTML = '';
    if (chartDays.length === 0) return;

    const maxTotal = Math.max(1, ...chartDays.map((d) => d.total)); // floor of 1 avoids a divide-by-zero when both weeks are empty
    const TRACK_HEIGHT_PX = 140;

    const header = document.createElement('div');
    header.className = 'resource-group-header';
    header.innerHTML = `<span>${formatDate(data.chartStart)} - ${formatDate(data.chartEnd)}</span>`;
    weekChartEl.appendChild(header);

    const wrap = document.createElement('div');
    wrap.style.padding = '0.75rem 1rem';

    const legend = document.createElement('div');
    legend.className = 'chart-legend';
    legend.innerHTML = `
      <span class="legend-item"><span class="legend-swatch legend-swatch--critical"></span>Critical</span>
      <span class="legend-item"><span class="legend-swatch legend-swatch--medium"></span>Medium</span>
    `;
    wrap.appendChild(legend);

    const chart = document.createElement('div');
    chart.className = 'vbar-chart';
    chart.innerHTML = chartDays
      .map((d, i) => {
        const criticalPx = (d.critical / maxTotal) * TRACK_HEIGHT_PX;
        const mediumPx = (d.medium / maxTotal) * TRACK_HEIGHT_PX;
        const gap = d.critical > 0 && d.medium > 0 ? '2px' : '0';
        const isSelected = d.date === data.date;
        // Visually separates each week's 7 columns from the next -- with
        // several weeks of unbroken columns, plain Mon..Sun repeated reads
        // as one ambiguous block without a boundary marker. Every Monday
        // after the very first column gets the plain divider; the boundary
        // of the SELECTED week specifically (data.currentWeekStart) gets a
        // stronger, accent-colored one instead, so it stands out among the
        // others.
        const isCurrentWeekStart = d.date === data.currentWeekStart;
        const isWeekStart = i > 0 && d.label === 'Monday' && !isCurrentWeekStart;
        const classes = [
          'vbar-col',
          isSelected ? 'active' : '',
          isWeekStart ? 'vbar-col--week-start' : '',
          isCurrentWeekStart ? 'vbar-col--current-week-start' : '',
        ]
          .filter(Boolean)
          .join(' ');
        return `
      <button type="button" class="${classes}" data-date="${escapeHtml(d.date)}" title="${escapeHtml(d.label)} ${escapeHtml(formatDate(d.date))}: ${d.critical} critical, ${d.medium} medium (${d.total} total)">
        <span class="vbar-value">${d.total.toLocaleString()}</span>
        <span class="vbar-track"><span class="vbar-fill--medium" style="height: ${mediumPx}px; margin-top: ${gap}"></span><span class="vbar-fill--critical" style="height: ${criticalPx}px"></span></span>
        <span class="vbar-label">${escapeHtml(d.label.slice(0, 3))}<br>${escapeHtml(formatDate(d.date))}</span>
      </button>`;
      })
      .join('');
    wrap.appendChild(chart);
    weekChartEl.appendChild(wrap);

    chart.querySelectorAll('.vbar-col').forEach((col) => {
      col.addEventListener('click', () => {
        const date = col.dataset.date;
        // Clicking a single day's bar means "show me that one day" -- resets
        // Period back to 1 day regardless of whatever was selected before,
        // rather than reusing e.g. a 3-month period starting from the
        // clicked day, which isn't what clicking one bar implies.
        dateInput.value = date;
        periodInput.value = '1d';
        load(date, '1d', clientInput.value);
      });
    });
  }

  // Summary of the SELECTED PERIOD's alerts (same scope as the detail table
  // below, not the chart's always-28-day window), grouped by alert name --
  // each group lists which client+user combinations triggered that alert and
  // how many times, sorted busiest-first. Built entirely from data.rows
  // already in hand, no extra request -- the period's rows are the same data
  // the detail table renders. Alert names with only one occurrence still get
  // their own group (a one-off alert is exactly as much "a group" as a
  // repeated one), and a client+user combo that recurs for the same alert
  // within the period is counted once with count > 1, not listed as separate
  // rows.
  function renderAlertSummary(data) {
    const rows = data.rows || [];
    alertSummaryEl.hidden = rows.length === 0;
    alertSummaryEl.innerHTML = '';
    if (rows.length === 0) return;

    const byEvent = new Map(); // event name -> Map("client user" -> {customerName, autotaskUrl, user, count})
    for (const r of rows) {
      if (!byEvent.has(r.event)) byEvent.set(r.event, new Map());
      const byComboKey = byEvent.get(r.event);
      const userLabel = r.user || 'Unknown';
      const key = `${r.customerName} ${userLabel}`;
      if (!byComboKey.has(key)) {
        byComboKey.set(key, { customerName: r.customerName, autotaskUrl: r.autotaskUrl, user: userLabel, count: 0 });
      }
      byComboKey.get(key).count += 1;
    }

    const eventGroups = [...byEvent.entries()]
      .map(([event, byComboKey]) => {
        const combos = [...byComboKey.values()].sort(
          (a, b) => b.count - a.count || a.customerName.localeCompare(b.customerName) || a.user.localeCompare(b.user)
        );
        const total = combos.reduce((sum, c) => sum + c.count, 0);
        return { event, combos, total };
      })
      .sort((a, b) => b.total - a.total || a.event.localeCompare(b.event));

    const heading = document.createElement('h2');
    heading.textContent = `Alert Summary (${eventGroups.length} alert type${eventGroups.length === 1 ? '' : 's'})`;
    heading.style.fontSize = '1.1rem';
    heading.style.margin = '1.5rem 0 0.75rem';
    alertSummaryEl.appendChild(heading);

    for (const g of eventGroups) {
      const groupEl = document.createElement('div');
      groupEl.className = 'resource-group';

      const header = document.createElement('div');
      header.className = 'resource-group-header';
      header.innerHTML = `<span>${escapeHtml(g.event)}</span><span class="count">${g.total} time${g.total === 1 ? '' : 's'}</span>`;
      groupEl.appendChild(header);

      const table = document.createElement('table');
      table.innerHTML = `
        <thead>
          <tr><th>Client</th><th>User</th><th>Count</th></tr>
        </thead>
        <tbody>
          ${g.combos
            .map(
              (c) => `
            <tr>
              <td>${comboClientLink(c)}</td>
              <td>${escapeHtml(c.user)}</td>
              <td class="ticket-number">${c.count}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      `;
      groupEl.appendChild(table);
      alertSummaryEl.appendChild(groupEl);
    }
  }

  function comboClientLink(c) {
    const label = escapeHtml(c.customerName);
    if (!c.autotaskUrl) return label;
    return `<a href="${escapeHtml(c.autotaskUrl)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  }

  if (lastData) render(lastData);

  function customerLink(r) {
    const label = escapeHtml(r.customerName);
    if (!r.autotaskUrl) return label;
    return `<a href="${escapeHtml(r.autotaskUrl)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  }

  function ticketLink(r) {
    if (!r.ticketUrl) return '';
    return `<a href="${escapeHtml(r.ticketUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(r.ticketNumber)}</a>`;
  }

  function capitalize(str) {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  // Local (browser) time-of-day, same convention as Tickets Created's
  // formatTime() -- this is a same-day view, so only the time-of-day matters,
  // not the date.
  function formatTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // Plain "YYYY-MM-DD" calendar date -> short display date, AEST-anchored --
  // same pattern used across the dashboard for date-only values (e.g. Ingram
  // Subscriptions' formatDate()).
  function formatDate(isoDateOnly) {
    if (!isoDateOnly) return '';
    return new Date(`${isoDateOnly}T00:00:00.000Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'Australia/Brisbane' });
  }

  // Plain calendar-date arithmetic (no timezone conversion needed -- these
  // are already AEST calendar dates as plain "YYYY-MM-DD" strings) -- turns
  // the server's EXCLUSIVE periodEnd into the last day actually included in
  // the period, for display.
  function subtractOneDay(isoDateOnly) {
    const [y, m, d] = isoDateOnly.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
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
