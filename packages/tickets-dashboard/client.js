export const id = "tickets-dashboard";
export const label = "Tickets Dashboard";

// Module-scope, not inside mount() -- see classification-summary/client.js's
// own comment (or Ticket Dashboards (Test)'s own copy of the same) for why
// this survives the shell's teardown/re-mount cycle.
let lastData = null;

// Same palette Datto RMM's own donut cards use (STATUS_COLORS there) --
// only the two shades this page's single critical-tickets donut actually
// needs.
const DONUT_COLORS = { danger: '#dc3545', healthy: '#28a745' };

// Fixed denominator for the ring's own sweep -- NOT the open-ticket total
// (see renderCriticalDonut()'s own comment). 6 critical tickets (or more)
// fills the ring completely. Same value as Ticket Dashboards (Test)'s own
// copy of this widget.
const CRITICAL_DONUT_SCALE = 6;

export function mount(container) {
  container.innerHTML = `
    <header class="page-header tickets-dashboard-header">
      <div class="date-form">
        <button type="button" id="refresh-button">Refresh</button>
      </div>
    </header>
    <p id="status" class="status">Loading...</p>
    <div id="critical-chart" class="resource-group" hidden></div>
  `;

  const refreshButton = container.querySelector('#refresh-button');
  const statusEl = container.querySelector('#status');
  const criticalChartEl = container.querySelector('#critical-chart');

  refreshButton.addEventListener('click', load);

  async function load() {
    refreshButton.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = 'Loading...';
    criticalChartEl.hidden = true;

    try {
      const res = await fetch('/api/tickets-dashboard');
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
    renderCriticalSection(data.criticalOpenCount, data.criticalTickets);
  }

  // Copied from Ticket Dashboards (Test) -- see that page's own client.js
  // for the fuller reasoning behind every choice here (fixed
  // CRITICAL_DONUT_SCALE denominator rather than the open-ticket total;
  // reuses Datto RMM's own .datto-card/.datto-donut-* classes and
  // donut-arc drawing, duplicated rather than imported, same "separate
  // page package" convention every small shared UI helper on this
  // dashboard already follows). The ticket list sits beside the donut, by
  // request -- .critical-tickets-layout (styles.css) is a plain flex row,
  // donut card first then the list, stacking on narrow screens. The
  // donut's own ring size (180, up from the default 120 -- see
  // .critical-donut-wrap--large in styles.css for the matching CSS-side
  // size bump) is 50% bigger than Datto RMM's own default, by request.
  function renderCriticalSection(criticalCount, criticalTickets) {
    criticalChartEl.hidden = false;
    criticalChartEl.innerHTML = '';

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
              <td>${statusCellHtml(t.status)}</td>
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

  // "License Update (CRITICAL)" shown as just "License Update", in yellow,
  // by request -- the "(CRITICAL)" suffix is redundant on a page that's
  // already scoped to critical tickets only, and yellow flags it apart
  // from the statuses around it. Exact-string match (not a wildcard/prefix
  // check) -- the one real status label with its own display-text swap.
  // Every OTHER status on this list is red, by request -- every ticket
  // here is already critical, so red is the "needs attention" default and
  // License Update is the one deliberate exception (already flagged
  // yellow instead) rather than the other way round.
  function statusCellHtml(status) {
    if (status === 'License Update (CRITICAL)') {
      return `<span class="text-highlight-yellow">License Update</span>`;
    }
    return `<span class="text-highlight-red">${escapeHtml(status)}</span>`;
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

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
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
}
