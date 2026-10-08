export const id = "tickets-dashboard";
export const label = "Tickets Dashboard";

// Module-scope, not inside mount() -- see classification-summary/client.js's
// own comment (or Ticket Dashboards (Test)'s own copy of the same) for why
// this survives the shell's teardown/re-mount cycle.
let lastData = null;

// Whichever mount() is CURRENTLY on screen registers its own render()
// function here, overwriting whatever the previous mount left behind.
// Fixes a real bug (see check-client/client.js's own activeRenderers for
// the fuller writeup): load() below is a closure over ITS OWN mount()'s
// local DOM elements, so if you navigate away before a refresh finishes
// and come back before it actually resolves, the in-flight fetch's own
// render call was writing into the OLD, torn-down mount's detached
// elements -- invisible, so nothing ever seemed to happen. Routing load()'s
// render call through this instead of calling its own closed-over render()
// directly means whichever mount is actually visible always receives the
// update, even when the fetch that produced it was kicked off by a mount
// that no longer exists.
let activeRender = null;

// Same palette Datto RMM's own donut cards use (STATUS_COLORS there) --
// danger/healthy are the two shades Critical (P1)/Triage Now/DO TODAY use
// (genuinely urgent widgets -- any count at all is bad news, 0 is healthy).
// `informational`, by request, is for Scheduled Me/Client Updates instead --
// same #eab308 yellow .text-highlight-yellow already uses elsewhere on this
// dashboard -- neither of those is inherently a bad-news count the way the
// other three are, so forcing them red/green was misleading (reported as
// "no colour" since a 0 count there drew a plain uncoloured ring).
const DONUT_COLORS = { danger: '#dc3545', healthy: '#28a745', informational: '#eab308' };

// Fixed denominator for each ring's own sweep -- NOT the open-ticket total
// (see renderTicketWidget()'s own comment). 6 open tickets (or more) fills
// a ring completely. Same value as Ticket Dashboards (Test)'s own copy of
// the original Critical widget -- reused as-is for Triage Now/DO TODAY too,
// absent any reason to pick a different fullness point for them.
const WIDGET_DONUT_SCALE = 6;

// Scheduled Me/Client Updates' own scale, by request -- "0-10 with 10 as
// the whole circle filled", wider than the other three widgets' /6 scale
// since these two aren't bad-news counts that should look "full" quite as
// early.
const INFORMATIONAL_DONUT_SCALE = 10;

export function mount(container) {
  container.innerHTML = `
    <header class="page-header tickets-dashboard-header">
      <div class="date-form">
        <button type="button" id="refresh-button">Refresh</button>
      </div>
    </header>
    <p id="status" class="status">Loading...</p>
    <div id="overdue-banner" class="tickets-dashboard-overdue-banner" hidden></div>
    <div id="critical-chart" class="resource-group" hidden></div>
    <div id="triage-chart" class="resource-group" hidden></div>
    <div id="new-widgets-row" class="tickets-dashboard-widgets-row" hidden>
      <div id="do-today-chart" class="resource-group tickets-dashboard-widgets-row-item" hidden></div>
      <div id="scheduled-me-chart" class="resource-group tickets-dashboard-widgets-row-item" hidden></div>
      <div id="client-updates-chart" class="resource-group tickets-dashboard-widgets-row-item" hidden></div>
    </div>
  `;

  const refreshButton = container.querySelector('#refresh-button');
  const statusEl = container.querySelector('#status');
  const overdueBannerEl = container.querySelector('#overdue-banner');
  const criticalChartEl = container.querySelector('#critical-chart');
  const triageChartEl = container.querySelector('#triage-chart');
  const newWidgetsRowEl = container.querySelector('#new-widgets-row');
  const doTodayChartEl = container.querySelector('#do-today-chart');
  const scheduledMeChartEl = container.querySelector('#scheduled-me-chart');
  const clientUpdatesChartEl = container.querySelector('#client-updates-chart');

  refreshButton.addEventListener('click', load);

  async function load() {
    refreshButton.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = 'Loading...';
    overdueBannerEl.hidden = true;
    criticalChartEl.hidden = true;
    triageChartEl.hidden = true;
    newWidgetsRowEl.hidden = true;
    doTodayChartEl.hidden = true;
    scheduledMeChartEl.hidden = true;
    clientUpdatesChartEl.hidden = true;

    try {
      const res = await fetch('/api/tickets-dashboard');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastData = data;
      activeRender(data);
    } catch (err) {
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      refreshButton.disabled = false;
    }
  }

  function render(data) {
    statusEl.hidden = true;
    renderOverdueBanner(data.overdueCount);
    renderTicketWidget(criticalChartEl, data.criticalOpenCount, data.criticalTickets, {
      label: 'Critical (P1)',
      sub: 'Critical/Urgent/Licenses',
      statusColored: true, // every ticket here IS critical -- see statusCellHtml()'s own comment
    });
    renderTicketWidget(triageChartEl, data.triageOpenCount, data.triageTickets, {
      label: 'Triage Now',
      // Display text only, by request -- the real Autotask priority name
      // ("!! SET PRIORITY") stays exactly as-is in the Notes area's own
      // selection-criteria text below and in TRIAGE_PRIORITY_VALUE's own
      // comment in server.js; this is purely the human-friendlier sub-line
      // shown under the widget's own label, same role Critical (P1)'s own
      // "Critical/Urgent/Licenses" sub-line plays.
      sub: 'Might be Urgent !',
      statusColored: false, // not inherently critical -- forcing red here would be misleading
    });
    // The 3 new widgets, by request, sit on one row underneath Triage Now
    // -- same renderTicketWidget() layout as Critical (P1)/Triage Now
    // above, just 3 narrower columns side by side (.tickets-dashboard-
    // widgets-row in styles.css) instead of one full-width row each,
    // wrapping to fewer per row on a narrow screen.
    newWidgetsRowEl.hidden = false;
    renderTicketWidget(doTodayChartEl, data.doTodayOpenCount, data.doTodayTickets, {
      label: 'DO TODAY',
      sub: 'P1 - Cannot Be Moved',
      statusColored: true, // every ticket here IS a must-do-today item, same reasoning as Critical (P1)
      showList: false, // widget + count only, by request -- no ticket list here
    });
    renderTicketWidget(scheduledMeChartEl, data.scheduledMeOpenCount, data.scheduledMeTickets, {
      label: 'Scheduled Me',
      sub: 'To Be Scheduled',
      statusColored: false, // not inherently critical, same reasoning as Triage Now
      showList: false,
      donutColor: DONUT_COLORS.informational, // yellow, by request -- not a bad-news count
      donutScale: INFORMATIONAL_DONUT_SCALE, // 0-10, by request
    });
    renderTicketWidget(clientUpdatesChartEl, data.clientUpdatesOpenCount, data.clientUpdatesTickets, {
      label: 'Client Updates',
      sub: 'Customer Note Added',
      statusColored: false, // informational, not inherently urgent
      showList: false,
      donutColor: DONUT_COLORS.informational, // yellow, by request -- not a bad-news count
      donutScale: INFORMATIONAL_DONUT_SCALE, // 0-10, by request
    });
  }

  // "Overdue tickets" -- a count-only red banner, by request, not a widget
  // of its own (no donut, no ticket list) -- centred at the top of the
  // page. Shown even at 0, same "silent isn't the point, the count always
  // reads clearly" reasoning every other always-visible count on this
  // dashboard follows -- there's no ambiguity about whether it's still
  // loading once the page itself has rendered.
  function renderOverdueBanner(count) {
    overdueBannerEl.hidden = false;
    overdueBannerEl.textContent = `Overdue tickets: ${count}`;
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
  function renderTicketWidget(containerEl, count, tickets, { label, sub, statusColored, showList = true, donutColor, donutScale = WIDGET_DONUT_SCALE }) {
    containerEl.hidden = false;
    containerEl.innerHTML = '';

    const layout = document.createElement('div');
    layout.className = 'critical-tickets-layout';

    const donutWrap = document.createElement('div');
    donutWrap.className = 'datto-card-grid critical-donut-grid';
    // Fixed yellow (donutColor), not count-dependent red/healthy-green, for
    // the two widgets that pass one in -- see DONUT_COLORS.informational's
    // own comment above for why.
    const color = donutColor || (count > 0 ? DONUT_COLORS.danger : DONUT_COLORS.healthy);
    const card = document.createElement('div');
    card.className = 'datto-card';
    card.innerHTML = `
      <div class="datto-donut-wrap critical-donut-wrap--large">
        ${donutSvg(count, donutScale, color, 180)}
        <div class="datto-donut-center"><span class="datto-donut-count">${count}</span></div>
      </div>
      <div class="datto-card-label">${escapeHtml(label)}</div>
      <div class="datto-card-sub">${escapeHtml(sub)}</div>
    `;
    donutWrap.appendChild(card);
    layout.appendChild(donutWrap);

    // DO TODAY/Scheduled Me/Client Updates show just the widget and count,
    // by request -- no ticket list, and no "No tickets currently open."
    // filler either, unlike Critical (P1)/Triage Now (unchanged, still
    // showList: true, their default).
    if (showList) {
      const listWrap = document.createElement('div');
      listWrap.className = 'critical-tickets-list';
      listWrap.innerHTML = ticketsTableHtml(tickets, statusColored);
      layout.appendChild(listWrap);
    }

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

  // This mount is now the active one -- see activeRender's own comment up
  // top.
  activeRender = render;

  if (lastData) {
    render(lastData);
  } else {
    load();
  }
}
