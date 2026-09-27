export const id = "tickets-dashboard";
export const label = "Tickets Dashboard";

// Module-scope, not inside mount() -- see classification-summary/client.js's
// own comment (or Ticket Dashboards (Test)'s own copy of the same) for why
// this survives the shell's teardown/re-mount cycle.
let lastData = null;

// Same palette Datto RMM's own donut cards use (STATUS_COLORS there) --
// only the two shades this page's donut widgets actually need, shared by
// both Critical (P1) and Triage Now.
const DONUT_COLORS = { danger: '#dc3545', healthy: '#28a745' };

// Fixed denominator for each ring's own sweep -- NOT the open-ticket total
// (see renderTicketWidget()'s own comment). 6 open tickets (or more) fills
// a ring completely. Same value as Ticket Dashboards (Test)'s own copy of
// the original Critical widget -- reused as-is for Triage Now too, absent
// any reason to pick a different fullness point for it.
const WIDGET_DONUT_SCALE = 6;

export function mount(container) {
  container.innerHTML = `
    <header class="page-header tickets-dashboard-header">
      <div class="date-form">
        <button type="button" id="refresh-button">Refresh</button>
      </div>
    </header>
    <p id="status" class="status">Loading...</p>
    <div id="critical-chart" class="resource-group" hidden></div>
    <div id="triage-chart" class="resource-group" hidden></div>
    <div id="weekly-hours-pct-grid" class="tickets-dashboard-pct-grid" hidden></div>
    <div id="widget-notes" class="wsp-usage-box tickets-dashboard-notes" hidden>
      <div class="wsp-usage-box-title">Autotask Selection Criteria</div>
      <ul>
        <li><strong>Critical (P1)</strong> -- open tickets (no Completed Date) with Priority = "P1 - CRITICAL", excluding monitoring alerts.</li>
        <li><strong>Triage Now</strong> -- open tickets (no Completed Date) with Priority = "!! TO BE SCHEDULED", excluding monitoring alerts.</li>
        <li id="hours-pct-criteria-item" hidden></li>
      </ul>
    </div>
  `;

  const refreshButton = container.querySelector('#refresh-button');
  const statusEl = container.querySelector('#status');
  const criticalChartEl = container.querySelector('#critical-chart');
  const triageChartEl = container.querySelector('#triage-chart');
  const notesEl = container.querySelector('#widget-notes');
  const weeklyHoursPctGridEl = container.querySelector('#weekly-hours-pct-grid');
  const hoursPctCriteriaItemEl = container.querySelector('#hours-pct-criteria-item');

  refreshButton.addEventListener('click', load);

  async function load() {
    refreshButton.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = 'Loading...';
    criticalChartEl.hidden = true;
    triageChartEl.hidden = true;
    notesEl.hidden = true;
    weeklyHoursPctGridEl.hidden = true;

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
    renderTicketWidget(criticalChartEl, data.criticalOpenCount, data.criticalTickets, {
      label: 'Critical (P1)',
      sub: 'Critical/Urgent/Licenses',
      statusColored: true, // every ticket here IS critical -- see statusCellHtml()'s own comment
    });
    renderTicketWidget(triageChartEl, data.triageOpenCount, data.triageTickets, {
      label: 'Triage Now',
      // Display text only, by request -- the real Autotask priority name
      // ("!! TO BE SCHEDULED") stays exactly as-is in the Notes area's own
      // selection-criteria text below and in TRIAGE_PRIORITY_VALUE's own
      // comment in server.js; this is purely the human-friendlier sub-line
      // shown under the widget's own label, same role Critical (P1)'s own
      // "Critical/Urgent/Licenses" sub-line plays.
      sub: 'Might be Urgent !',
      statusColored: false, // not inherently critical -- forcing red here would be misleading
    });
    // Notes area shown alongside the widgets, EXCEPT while Rotate is
    // running -- by request. Pure CSS (html[data-rotate-active="true"]
    // #widget-notes, styles.css), same attribute app.js's own
    // renderRotateControls() already toggles on <html> for every other
    // Rotate-aware page on this dashboard -- no extra JS/event listener
    // needed here, this element just isn't hidden/shown by anything but
    // the normal load()/error flow above.
    notesEl.hidden = false;
    renderWeeklyHoursPct(data.weeklyHoursPct);
  }

  // Two small stat tiles, side by side, centered under the widgets above --
  // by request: what % of this week's Total Tech Hours (at work) landed as
  // Total Tech Client Hours, and what % of THAT was actually Billable, both
  // scoped to Team: Support Desk (server.js's own fetchWeeklyHoursPct(),
  // which reuses Time Summaries' own computeOverallTotals() rather than
  // recomputing these from scratch). `null` (that fetch failed, or is
  // still mid-flight the first time this page loads before server.js's own
  // best-effort computation resolves) hides both tiles entirely rather
  // than showing a broken widget on a page that's otherwise fine. The
  // from/to/team criteria itself is shown once, as a 3rd bullet in the
  // "Autotask Selection Criteria" box above, by request -- NOT repeated
  // per tile the way it originally was.
  function renderWeeklyHoursPct(weeklyHoursPct) {
    if (!weeklyHoursPct) {
      weeklyHoursPctGridEl.hidden = true;
      hoursPctCriteriaItemEl.hidden = true;
      return;
    }
    weeklyHoursPctGridEl.hidden = false;
    weeklyHoursPctGridEl.innerHTML = `
      <div class="datto-card ${pctColorClass(weeklyHoursPct.clientHoursPct)}">
        <div class="tickets-dashboard-pct-number">${formatPct(weeklyHoursPct.clientHoursPct)}</div>
        <div class="datto-card-label">Client Hours</div>
      </div>
      <div class="datto-card ${pctColorClass(weeklyHoursPct.billableHoursPct)}">
        <div class="tickets-dashboard-pct-number">${formatPct(weeklyHoursPct.billableHoursPct)}</div>
        <div class="datto-card-label">Billable Hours</div>
      </div>
    `;
    hoursPctCriteriaItemEl.hidden = false;
    hoursPctCriteriaItemEl.innerHTML = `<strong>Hours %</strong> -- ${escapeHtml(formatWeekRange(weeklyHoursPct.weekFrom, weeklyHoursPct.weekTo))} -- Support Desk`;
  }

  function formatPct(n) {
    return `${Math.round(n)}%`;
  }

  // Red by default, Orange 40-74%, Green 75%+ -- by request. Same red/
  // orange/green already used dashboard-wide (.cell-flag-red's #dc2626,
  // this page's own "Loading..." orange #f59e0b, .chk-section-heading's
  // #16a34a), not new one-off shades -- see the matching CSS classes in
  // styles.css.
  function pctColorClass(pct) {
    if (pct >= 75) return 'tickets-dashboard-pct-tile--green';
    if (pct >= 40) return 'tickets-dashboard-pct-tile--orange';
    return 'tickets-dashboard-pct-tile--red';
  }

  // "17 Aug - 23 Aug", same day+month-only shape (no year, unless this
  // week genuinely straddles a year boundary) other week-range labels on
  // this dashboard already use (e.g. What's On's own shiftsRangeLabel()) --
  // duplicated here rather than imported, same "each page keeps its own
  // small copy of shared boilerplate" convention this dashboard already
  // follows elsewhere.
  function formatWeekRange(fromKey, toKey) {
    const [fy, fm, fd] = fromKey.split('-').map(Number);
    const [ty, tm, td] = toKey.split('-').map(Number);
    const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const from = `${fd} ${MONTH_ABBR[fm - 1]}`;
    const to = `${td} ${MONTH_ABBR[tm - 1]}`;
    return fy !== ty ? `${from} ${fy} - ${to} ${ty}` : `${from} - ${to}`;
  }

  // Originally copied from Ticket Dashboards (Test) as one single-purpose
  // function for the Critical (P1) widget alone; generalized once Triage
  // Now needed the exact same layout with just a different priority/
  // label/count -- see that page's own client.js for the fuller reasoning
  // behind every choice here (fixed WIDGET_DONUT_SCALE denominator rather
  // than the open-ticket total; reuses Datto RMM's own .datto-card/
  // .datto-donut-* classes and donut-arc drawing, duplicated rather than
  // imported, same "separate page package" convention every small shared
  // UI helper on this dashboard already follows). The ticket list sits
  // beside the donut, by request -- .critical-tickets-layout (styles.css,
  // a generic class despite the name -- predates Triage Now, kept as-is
  // rather than renamed) is a plain flex row, donut card first then the
  // list, stacking on narrow screens. The donut's own ring size (180, up
  // from the default 120 -- see .critical-donut-wrap--large in
  // styles.css, same reused-name reasoning, for the matching CSS-side
  // size bump) is 50% bigger than Datto RMM's own default, by request.
  // `statusColored` is the one real behavioural difference between the
  // two widgets -- see statusCellHtml()'s own comment for why Critical
  // (P1) forces every status red but Triage Now doesn't.
  function renderTicketWidget(containerEl, count, tickets, { label, sub, statusColored }) {
    containerEl.hidden = false;
    containerEl.innerHTML = '';

    const layout = document.createElement('div');
    layout.className = 'critical-tickets-layout';

    const donutWrap = document.createElement('div');
    donutWrap.className = 'datto-card-grid critical-donut-grid';
    const color = count > 0 ? DONUT_COLORS.danger : DONUT_COLORS.healthy;
    const card = document.createElement('div');
    card.className = 'datto-card';
    card.innerHTML = `
      <div class="datto-donut-wrap critical-donut-wrap--large">
        ${donutSvg(count, WIDGET_DONUT_SCALE, color, 180)}
        <div class="datto-donut-center"><span class="datto-donut-count">${count}</span></div>
      </div>
      <div class="datto-card-label">${escapeHtml(label)}</div>
      <div class="datto-card-sub">${escapeHtml(sub)}</div>
    `;
    donutWrap.appendChild(card);
    layout.appendChild(donutWrap);

    const listWrap = document.createElement('div');
    listWrap.className = 'critical-tickets-list';
    listWrap.innerHTML = ticketsTableHtml(tickets, statusColored);
    layout.appendChild(listWrap);

    containerEl.appendChild(layout);
  }

  // Plain <table> (no page-specific width class -- the generic base
  // table/th/td styling in styles.css already looks right for a simple
  // list like this), by request: Status, Ticket Number, Client Name,
  // Ticket Title, Resource (last) for every currently-matching ticket. No
  // header row, by request -- just the widget and items.
  function ticketsTableHtml(tickets, statusColored) {
    if (!tickets || tickets.length === 0) {
      return '<p class="status">No tickets currently open.</p>';
    }
    return `
      <table>
        <tbody>
          ${tickets
            .map(
              (t) => `
            <tr>
              <td>${statusCellHtml(t.status, statusColored)}</td>
              <td class="ticket-number">${ticketLink(t)}<br><span class="inline-subtext">${formatCreateDate(t.createDate)}</span></td>
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
  //
  // `statusColored` (Critical (P1) only, by request) forces every OTHER
  // status red -- every ticket in THAT widget is already critical, so red
  // is the "needs attention" default and License Update is the one
  // deliberate exception (already flagged yellow instead) rather than the
  // other way round. Triage Now's tickets aren't inherently critical the
  // same way, so its own statuses render plain -- forcing them all red
  // too would misrepresent them.
  function statusCellHtml(status, statusColored) {
    if (status === 'License Update (CRITICAL)') {
      return `<span class="text-highlight-yellow">License Update</span>`;
    }
    if (!statusColored) return escapeHtml(status);
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

  // Small grey text under the Ticket # (.inline-subtext), by request --
  // "put the time of creation of the ticket in small grey text under the
  // Ticket number". Same real Tickets.createDate field and same plain
  // browser-local toLocaleTimeString() formatting Tickets Created Today's
  // own formatTime() already uses for this exact field -- unlike this
  // page's Autotask date-only fields elsewhere, createDate is a genuine
  // timestamp, so no AEST-anchored date-string handling applies here.
  function formatCreateDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
