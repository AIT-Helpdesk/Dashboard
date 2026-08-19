export const id = "service-calls";
export const label = "Service Calls";

// Module-scope, not inside mount() -- the shell fully tears down and re-mounts a
// page's DOM on every navigation away and back, but the dynamically-imported
// module itself is cached by the browser and stays alive for the session, so a
// module-level variable survives across re-mounts and lets the last result
// restore instantly instead of coming back blank.
let lastMonth = null; // "YYYY-MM"
let lastData = null;
// Filter is purely a display concern (the server always returns everything
// for the month), so it's applied client-side and doesn't trigger a
// refetch -- toggling it re-renders the already-loaded data instantly.
// Module-scope so it survives a same-session re-mount too, same as
// lastMonth/lastData.
let showUnallocatedOnly = false;
// Same client-side-only filtering rationale as showUnallocatedOnly above --
// off by default, so a completed call (nothing left to staff or review)
// doesn't clutter the calendar unless specifically asked for.
let showCompleted = false;

const MONTH_LABELS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAY_HEADERS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>Service Calls</h1>
      <div class="date-form calendar-nav">
        <button type="button" id="prev-button" aria-label="Previous month">&lsaquo;</button>
        <span id="month-label" class="calendar-month-label"></span>
        <button type="button" id="next-button" aria-label="Next month">&rsaquo;</button>
        <button type="button" id="today-button">Today</button>
        <button type="button" id="refresh-button">Refresh</button>
        <button type="button" id="allocation-toggle" class="link-button"></button>
        <label for="show-completed-input" class="inline-checkbox-label">
          <input type="checkbox" id="show-completed-input" /> Show Completed
        </label>
      </div>
    </header>
    <p id="status" class="status">Every Autotask Service Call, with the resource(s) assigned to it (if any) -- "To Do" items aren't included (Autotask's REST API doesn't expose them; see the README).</p>
    <div id="summary" class="summary" hidden></div>
    <div id="calendar" class="results"></div>
  `;

  const prevButton = container.querySelector('#prev-button');
  const nextButton = container.querySelector('#next-button');
  const todayButton = container.querySelector('#today-button');
  const refreshButton = container.querySelector('#refresh-button');
  const allocationToggle = container.querySelector('#allocation-toggle');
  const showCompletedInput = container.querySelector('#show-completed-input');
  const monthLabelEl = container.querySelector('#month-label');
  const statusEl = container.querySelector('#status');
  const summaryEl = container.querySelector('#summary');
  const calendarEl = container.querySelector('#calendar');

  function renderToggleLabel() {
    // The label names the ACTION a click performs, not the current state --
    // default (showing all) reads "Show Unallocated Only" (what clicking
    // does), and once filtered it flips to "Show All" (what clicking does
    // from there), by request.
    allocationToggle.textContent = showUnallocatedOnly ? 'Show All' : 'Show Unallocated Only';
  }
  renderToggleLabel();

  allocationToggle.addEventListener('click', () => {
    showUnallocatedOnly = !showUnallocatedOnly;
    renderToggleLabel();
    if (lastData) render(lastData);
  });

  showCompletedInput.checked = showCompleted;
  showCompletedInput.addEventListener('change', () => {
    showCompleted = showCompletedInput.checked;
    if (lastData) render(lastData);
  });

  // Browser-local "today" for the initial guess, before the server's own
  // AEST todayKey comes back on first load -- close enough purely to decide
  // which month to open on (our users are all in Queensland, so this is
  // AEST in practice anyway); every actual "today" highlight and the Today
  // button both switch to using the server's todayKey once a response
  // arrives, same reasoning Ingram Orders' defaultSinceISO() uses.
  function defaultMonthKey() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  function addMonths(monthKey, delta) {
    const [y, m] = monthKey.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  prevButton.addEventListener('click', () => load(addMonths(lastMonth || defaultMonthKey(), -1)));
  nextButton.addEventListener('click', () => load(addMonths(lastMonth || defaultMonthKey(), 1)));
  todayButton.addEventListener('click', () => load(lastData ? lastData.todayKey.slice(0, 7) : defaultMonthKey()));
  // Refresh always bypasses the 10-min cache for whichever month is
  // currently shown -- everything else (prev/next/today) is happy to serve
  // a recent cached view, this is the explicit "no, check again right now"
  // button for when a staffing gap might have just been fixed.
  refreshButton.addEventListener('click', () => load(lastMonth || defaultMonthKey(), true));

  async function load(monthKey, force) {
    prevButton.disabled = true;
    nextButton.disabled = true;
    todayButton.disabled = true;
    refreshButton.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = `Loading ${monthLabelFor(monthKey)}...`;
    summaryEl.hidden = true;
    calendarEl.innerHTML = '';
    monthLabelEl.textContent = monthLabelFor(monthKey);

    try {
      const params = new URLSearchParams({ month: monthKey });
      if (force) params.set('force', 'true');
      const res = await fetch(`/api/service-calls?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastMonth = monthKey;
      lastData = data;
      render(data);
    } catch (err) {
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      prevButton.disabled = false;
      nextButton.disabled = false;
      todayButton.disabled = false;
      refreshButton.disabled = false;
    }
  }

  function monthLabelFor(monthKey) {
    const [y, m] = monthKey.split('-').map(Number);
    return `${MONTH_LABELS[m - 1]} ${y}`;
  }

  // Both toggles are pure client-side filters over the same already-loaded
  // month, combined with AND (e.g. "Show Unallocated Only" + completed
  // hidden shows only still-unallocated, not-yet-complete calls). Used both
  // per-day (for what actually renders in each cell) and across the whole
  // month (so the summary line's counts always match what's on screen,
  // rather than the server's raw totals which may include calls the current
  // filters are hiding).
  function visibleEntries(entries) {
    let result = entries;
    if (showUnallocatedOnly) result = result.filter((e) => !e.allocated);
    if (!showCompleted) result = result.filter((e) => !e.isComplete);
    return result;
  }

  function render(data) {
    statusEl.hidden = true;
    monthLabelEl.textContent = monthLabelFor(data.month);

    const allEntries = Object.values(data.byDay).flat();
    const visible = visibleEntries(allEntries);
    const visibleUnallocatedCount = visible.filter((e) => !e.allocated).length;

    summaryEl.hidden = false;
    summaryEl.innerHTML = showUnallocatedOnly
      ? `<strong>${visibleUnallocatedCount}</strong> unallocated service call${visibleUnallocatedCount === 1 ? '' : 's'} in ${escapeHtml(monthLabelFor(data.month))} <span class="inline-subtext">(${data.totalCount} total, ${data.unallocatedCount} unallocated${showCompleted ? '' : ' -- completed hidden'})</span>`
      : `<strong>${visible.length}</strong> service call${visible.length === 1 ? '' : 's'} in ${escapeHtml(monthLabelFor(data.month))} <span class="inline-subtext">(${visibleUnallocatedCount} unallocated${showCompleted ? '' : `, ${data.totalCount} total -- completed hidden`})</span>`;

    calendarEl.innerHTML = '';
    const table = document.createElement('table');
    table.className = 'calendar-table';

    const thead = document.createElement('thead');
    thead.innerHTML = `<tr>${WEEKDAY_HEADERS.map((w) => `<th>${w}</th>`).join('')}</tr>`;
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    const [y, m] = data.month.split('-').map(Number);
    for (let i = 0; i < data.gridDates.length; i += 7) {
      const week = data.gridDates.slice(i, i + 7);
      const tr = document.createElement('tr');
      for (const dayKey of week) {
        const [dy, dm, dd] = dayKey.split('-').map(Number);
        const inMonth = dm === m && dy === y;
        const isToday = dayKey === data.todayKey;
        const td = document.createElement('td');
        td.className = 'calendar-cell' + (inMonth ? '' : ' calendar-cell--outside') + (isToday ? ' calendar-cell--today' : '');
        const entries = visibleEntries(data.byDay[dayKey] || []);
        td.innerHTML = `
          <div class="calendar-cell-daynum">${dd}</div>
          <div class="calendar-cell-entries">${entries.map((e) => entryHtml(e)).join('')}</div>
        `;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    calendarEl.appendChild(table);
  }

  function entryHtml(e) {
    // Two lines per entry, by request -- the first is the call's time and
    // company (as before), the second is specifically the allocation state
    // (the resource name(s), or "Unallocated") so it's visible on the
    // calendar itself without needing to hover for the tooltip.
    const line1 = `${formatTime(e.startDateTime)} ${escapeHtml(e.companyName)}`;
    const line2 = e.allocated ? e.resourceNames.map(escapeHtml).join(', ') : 'Unallocated';
    const inner = `<span class="calendar-entry-line1">${line1}</span><span class="calendar-entry-line2">${line2}</span>`;
    const ticket = e.tickets[0]; // linked ticket is the first one -- see README for the rare multi-ticket case
    // Ticket line(s) and the call's own description are shown together, not
    // one-or-the-other -- a call can have both (a description explaining
    // the work, plus a real linked ticket for it), and hiding the
    // description just because a ticket happened to be linked was losing
    // real information.
    const titleLines = e.tickets.flatMap((t) => [`${t.ticketNumber}: ${t.title}`, `  Status: ${t.status}`]);
    if (e.description) titleLines.push(e.description);
    titleLines.push(e.allocated ? `Allocated: ${e.resourceNames.join(', ')}` : 'Unallocated');
    if (e.isComplete) titleLines.push('Complete');
    titleLines.push(`Service call status: ${e.serviceCallStatus}`);
    if (e.isMine) titleLines.push('You are an allocated resource on this call');
    const title = escapeHtml(titleLines.join('\n'));
    // Priority order: complete wins regardless of allocation (green --
    // nothing left to staff or review), then allocated-but-not-complete
    // (blue -- staffed, still upcoming/in progress), then unallocated (red
    // -- the staffing gap this page originally existed to surface).
    const colorClass = e.isComplete ? ' calendar-entry--completed' : e.allocated ? ' calendar-entry--allocated' : ' calendar-entry--unallocated';
    // A left-border accent, independent of the background fill above, for
    // the two "Onsite" service call statuses specifically -- gold for
    // Onsite Arranged, red for Onsite TBA (Autotask's own newer statuses,
    // added after this page was first built; confirmed against real data
    // via the live picklist, not any cached/stale copy of it).
    const accentClass =
      e.serviceCallStatus === 'Onsite Arranged' ? ' calendar-entry--onsite-arranged' : e.serviceCallStatus === 'Onsite TBA' ? ' calendar-entry--onsite-tba' : '';
    // A full green outline, independent of both the fill and the left-
    // border accent above, when the signed-in user is one of the call's
    // allocated resources -- by request, so "mine" stands out regardless of
    // whatever other state the entry is already showing.
    const mineClass = e.isMine ? ' calendar-entry--mine' : '';
    if (ticket) {
      // A real popup window, not just a new tab -- specifying window
      // features (width/height/etc.) is what signals that to the browser.
      // Reads `this.href` rather than re-embedding the URL in the onclick
      // string, so there's only one place the URL needs escaping. Same
      // pattern as Client Financials'/Client Details' invoice links.
      return `<a class="calendar-entry${colorClass}${accentClass}${mineClass}" href="${escapeHtml(ticket.ticketUrl)}" target="_blank" rel="noopener noreferrer" title="${title}" onclick="window.open(this.href, '_blank', 'noopener,noreferrer,width=1200,height=900'); return false;">${inner}</a>`;
    }
    return `<div class="calendar-entry calendar-entry--no-ticket${colorClass}${accentClass}${mineClass}" title="${title}">${inner}</div>`;
  }

  if (lastData) {
    render(lastData);
  } else {
    load(defaultMonthKey());
  }

  function formatTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
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
