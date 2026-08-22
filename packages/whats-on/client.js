export const id = "whats-on";
export const label = "What's On";

// Module-scope, not inside mount() -- the shell tears down and re-mounts a
// page's DOM on every navigation, but the imported module itself stays
// alive for the browser tab's session, so this survives across re-mounts.
// Unlike My Strety Tasks (which uses the same module-scope pattern just to
// avoid a blank flash before an always-live re-fetch), this page actually
// SKIPS re-fetching entirely when lastData is already set, by request --
// see mount() below.
let lastData = null;

// Team Shifts excerpt's own state, deliberately separate from lastData
// above -- it's a wholly separate fetch (see server.js's dedicated /shifts
// route) so paging a week forward/back never touches the Strety scorecard
// data or re-triggers its own rate-limited fetch.
let lastShiftsWeekStart = null; // "YYYY-MM-DD" Monday key, or null before the first load (server defaults to the current week)
let lastShiftsData = null;

// "Today & Tomorrow" section's own state, same wholly-separate-fetch
// reasoning as the shifts excerpt above -- its own /today-tomorrow route,
// so its own Refresh never touches the Strety scorecard fetch or the
// shifts excerpt.
let lastTodayTomorrowData = null;

const FREQUENCIES = ['daily', 'weekly', 'monthly'];
const FREQUENCY_LABELS = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };

// Fixed legend, by request -- matched against each entry's own `displayName`
// (case-insensitive), which for a regular shift is the shift's own label and
// for a time-off entry is its RESOLVED timeOffReason name (see
// @dashboard/teams-shifts/lib.js's getResolvedShifts() -- both kinds share
// this one field in the resolved row shape, so one match function covers
// both without the caller needing to know which `kind` it's looking at).
//
// Order here is the order the legend renders in. Confirmed against real
// data: "On Call" and "Helpdesk Handler" are exact real /shifts labels; the
// holiday patterns cover 7 real label variants seen across 2026's real
// shifts ("Public Holiday", "Pub Hol", "Sri Lanka - Pub Hol", "Australia
// Day", "Good Friday", "Easter Monday", "Labour Day" -- Graph's own `theme`
// field was NOT consistent across these, so matching is on the label text,
// never the theme). Vacation/Unpaid/Sick-Other-Leave/RDO-Time-in-Lieu are
// real timeOffReason names, NOT shift labels -- confirmed against real data
// this account has 11 real reasons configured, several spelling their own
// intended legend color directly in the name (e.g. "Vacation (green)",
// "Sick/Other Leave (purple)", "RDO / Time in Lieu (grey)"), a strong
// confirmation this category list matches real intent, not a guessed
// taxonomy. This was found (and fixed) after a real report that a real
// booked Vacation wasn't showing -- root cause was /shifts and /timesOff
// being two entirely separate Graph resources, and this page originally
// only ever queried /shifts; not a matching-logic bug at all.
const SHIFT_CATEGORIES = [
  { key: 'onCall', label: 'On Call', color: '#eab308', match: (dn) => /^on\s*call/i.test(dn) },
  { key: 'helpdesk', label: 'Helpdesk Handler', color: '#3b82f6', match: (dn) => /helpdesk\s*handler/i.test(dn) },
  { key: 'vacation', label: 'Vacation', color: '#22c55e', match: (dn) => /vacation/i.test(dn) },
  // "leave" is NOT required in the match -- confirmed against real data the
  // actual timeOffReason is spelled literally "Unpaid" (see
  // @dashboard/teams-shifts/lib.js's fetchTimeOffReasonNames() -- these
  // reason names are the real source of Vacation/Unpaid/Sick-Other/RDO-TIL
  // categories, not a shift's own displayName; matching stays on
  // displayName either way since both shifts and time-off entries share
  // that field name in the resolved row shape).
  { key: 'unpaidLeave', label: 'Unpaid leave', color: '#dc2626', match: (dn) => /unpaid/i.test(dn) },
  { key: 'sickOther', label: 'Sick/Other Leave', color: '#8b5cf6', match: (dn) => /\bsick\b|other\s*leave/i.test(dn) },
  { key: 'rdoTil', label: 'RDO/Time in Lieu', color: '#9ca3af', match: (dn) => /\brdo\b|time\s*in\s*lieu/i.test(dn) },
  {
    key: 'publicHoliday',
    label: 'Public Holiday',
    color: '#ffffff',
    match: (dn) => /pub(lic)?\s*hol|australia\s*day|good\s*friday|easter\s*monday|labour\s*day|christmas|boxing\s*day|anzac\s*day|new\s*year/i.test(dn),
  },
];

function categorizeShift(entry) {
  const dn = (entry.displayName || '').trim();
  if (!dn) return null;
  return SHIFT_CATEGORIES.find((cat) => cat.match(dn)) || null;
}

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>What's On</h1>
    </header>
    <p id="status" class="status">Helpdesk Task Tracker's scorecards, followed by your own personal scorecards -- up to the last 8 real check-in periods, most recent first. Hover a value for its check-in note.</p>
    <div id="summary" class="section-heading section-heading--nav section-heading-row" hidden>
      <span id="summary-text"></span>
      <div class="date-form">
        <button type="button" id="refresh-button">Refresh Scorecards</button>
      </div>
    </div>
    <div id="results" class="results"></div>

    <div class="tt-section">
      <div class="section-heading section-heading--nav section-heading-row">
        <span>Today &amp; Tomorrow</span>
        <div class="date-form">
          <button type="button" id="tt-refresh-button">Refresh</button>
        </div>
      </div>
      <p id="tt-status" class="status">Loading...</p>
      <div id="tt-columns" class="tt-columns"></div>
    </div>

    <div class="section-heading section-heading--nav section-heading-row">
      <span>Team Shifts -- General</span>
      <div class="date-form calendar-nav">
        <button type="button" id="shifts-prev-button" aria-label="Previous week">&lsaquo;</button>
        <span id="shifts-week-label" class="calendar-month-label"></span>
        <button type="button" id="shifts-next-button" aria-label="Next week">&rsaquo;</button>
        <button type="button" id="shifts-today-button">This Week</button>
        <button type="button" id="shifts-refresh-button">Refresh</button>
      </div>
    </div>
    <p id="shifts-status" class="status">Loading...</p>
    <div id="shifts-calendar" class="results"></div>
    <div id="shifts-legend" class="shifts-legend"></div>
  `;

  const refreshButton = container.querySelector('#refresh-button');
  const statusEl = container.querySelector('#status');
  const summaryEl = container.querySelector('#summary');
  const summaryTextEl = container.querySelector('#summary-text');
  const resultsEl = container.querySelector('#results');

  const ttRefreshButton = container.querySelector('#tt-refresh-button');
  const ttStatusEl = container.querySelector('#tt-status');
  const ttColumnsEl = container.querySelector('#tt-columns');

  const shiftsPrevButton = container.querySelector('#shifts-prev-button');
  const shiftsNextButton = container.querySelector('#shifts-next-button');
  const shiftsTodayButton = container.querySelector('#shifts-today-button');
  const shiftsRefreshButton = container.querySelector('#shifts-refresh-button');
  const shiftsWeekLabelEl = container.querySelector('#shifts-week-label');
  const shiftsStatusEl = container.querySelector('#shifts-status');
  const shiftsCalendarEl = container.querySelector('#shifts-calendar');
  const shiftsLegendEl = container.querySelector('#shifts-legend');

  refreshButton.addEventListener('click', load);

  ttRefreshButton.addEventListener('click', () => loadTodayTomorrow(true));
  if (lastTodayTomorrowData) renderTodayTomorrow(lastTodayTomorrowData);
  else loadTodayTomorrow(false);

  async function loadTodayTomorrow(force) {
    ttRefreshButton.disabled = true;
    ttStatusEl.hidden = false;
    ttStatusEl.className = 'status';
    ttStatusEl.textContent = 'Loading...';
    ttColumnsEl.innerHTML = '';

    try {
      const res = await fetch(`/api/whats-on/today-tomorrow${force ? '?force=true' : ''}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastTodayTomorrowData = data;
      renderTodayTomorrow(data);
    } catch (err) {
      ttStatusEl.hidden = false;
      ttStatusEl.className = 'status error';
      ttStatusEl.textContent = `Error: ${err.message}`;
    } finally {
      ttRefreshButton.disabled = false;
    }
  }

  function renderTodayTomorrow(data) {
    if (data.status === 'no-session-email') {
      ttStatusEl.hidden = false;
      ttStatusEl.className = 'status error';
      ttStatusEl.textContent = 'Could not determine your signed-in email.';
      ttColumnsEl.innerHTML = '';
      return;
    }

    ttStatusEl.hidden = true;
    ttColumnsEl.innerHTML = '';
    ttColumnsEl.appendChild(
      ttColumn('Service Calls', data.serviceCalls, (row) => serviceCallRowHtml(row, data.today, data.tomorrow))
    );
    ttColumnsEl.appendChild(
      ttColumn('Subscriptions Expiring', data.subscriptionsExpiring, (row) => subscriptionRowHtml(row, data.today, data.tomorrow))
    );
    // My Strety Tasks' own connection states -- distinct from the shared
    // Strety connection's page-level banner elsewhere on this page (this
    // column depends on the SIGNED-IN USER'S OWN personal connection, see
    // @dashboard/strety-client's getPersonalClient(); the shared one can be
    // perfectly healthy while this signed-in user just hasn't connected
    // their own yet). Checked before the generic personFound-false message
    // below, since "not connected at all" and "connected, but no matching
    // person" are different situations worth telling apart.
    let stretyOverrideHtml = null;
    if (data.stretyTasks.personalNotConnected) {
      stretyOverrideHtml = `Your Strety account isn't connected yet. <a class="button-link" href="/auth/strety-personal/connect">Connect Strety</a>`;
    } else if (data.stretyTasks.personalReauthRequired) {
      const who = data.stretyTasks.personalConnectedAs ? ` (currently connected as ${escapeHtml(data.stretyTasks.personalConnectedAs)})` : '';
      stretyOverrideHtml = `Your Strety connection${who} has stopped working and needs to be reconnected. <a class="button-link" href="/auth/strety-personal/connect">Reconnect Strety</a>`;
    }
    ttColumnsEl.appendChild(
      ttColumn(
        'My Strety Tasks',
        data.stretyTasks,
        (row) => stretyTaskRowHtml(row, data.today, data.tomorrow),
        data.stretyTasks.personFound === false ? `No Strety account found for you.` : null,
        stretyOverrideHtml
      )
    );
  }

  // One column's card -- shared shell for all three (heading, then either
  // an error, a "nothing" notice, or the real rows) so the three sources'
  // very different real failure/empty states all read consistently rather
  // than each column inventing its own look. `overrideEmptyHtml`, when
  // given, takes priority over the escaped-text `overrideEmptyMessage` --
  // only ever passed a trusted, hardcoded connect/reconnect link, never
  // anything from the API response itself.
  function ttColumn(title, column, rowHtmlFn, overrideEmptyMessage, overrideEmptyHtml) {
    const div = document.createElement('div');
    div.className = 'resource-group tt-column';
    let body;
    if (!column.ok) {
      body = `<p class="status error">${escapeHtml(column.error)}</p>`;
    } else if (overrideEmptyHtml) {
      body = `<p class="status error">${overrideEmptyHtml}</p>`;
    } else if (overrideEmptyMessage) {
      body = `<p class="status">${escapeHtml(overrideEmptyMessage)}</p>`;
    } else if (column.rows.length === 0) {
      body = `<p class="status">Nothing today or tomorrow.</p>`;
    } else {
      body = `<ul class="tt-list">${column.rows.map(rowHtmlFn).join('')}</ul>`;
    }
    // Count in brackets next to the heading -- only when the column loaded
    // successfully (an error state has no real row count to show).
    const heading = column.ok ? `${title} (${column.rows.length})` : title;
    div.innerHTML = `<div class="section-heading">${escapeHtml(heading)}</div>${body}`;
    return div;
  }

  // "Today"/"Tomorrow"/"Overdue" tag shared by all three row renderers --
  // green for today (most immediate), amber for tomorrow, same status-color
  // convention (not a new one) used elsewhere on this dashboard. Anything
  // that's neither today nor tomorrow (Strety's own overdue to-dos, and
  // Service Calls' past-scheduled-and-still-incomplete rows) is the overdue
  // case -- shown red with just its actual date (no "Overdue" text label,
  // by request -- the red already says that on its own). `href`, when given,
  // renders the tag itself as a link (service call -> its ticket) instead of
  // a plain span -- opened as a real popup window, same explicit
  // window.open(..., 'width=1200,height=900') convention every other ticket
  // link on this dashboard uses (see e.g. service-calls/client.js), not just
  // target="_blank" (which only opens a new tab).
  function ttDayTag(dateKey, today, tomorrow, href) {
    let cls;
    let label;
    if (dateKey === today) {
      cls = 'tt-tag--today';
      label = 'Today';
    } else if (dateKey === tomorrow) {
      cls = 'tt-tag--tomorrow';
      label = 'Tomorrow';
    } else {
      cls = 'tt-tag--overdue';
      // By request: just the date, no "Overdue" prefix -- the red
      // .tt-tag--overdue color already says that on its own.
      label = formatShortDate(dateKey);
    }
    if (href) {
      return `<a class="tt-tag ${cls}" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" onclick="window.open(this.href, '_blank', 'noopener,noreferrer,width=1200,height=900'); return false;">${label}</a>`;
    }
    return `<span class="tt-tag ${cls}">${label}</span>`;
  }

  function formatShortDate(dateKey) {
    if (!dateKey) return '';
    return new Date(`${dateKey}T00:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short' });
  }

  function serviceCallRowHtml(row, today, tomorrow) {
    const allocation = row.allocated
      ? escapeHtml(row.resourceNames.join(', '))
      : '<span class="text-highlight-red">Unallocated</span>';
    return `
      <li>
        ${ttDayTag(row.dayKey, today, tomorrow, row.ticketUrl)}
        <span class="tt-time">${formatTime(row.startDateTime)}</span>
        <strong>${escapeHtml(row.companyName)}</strong>
        <span class="cell-subtext">${allocation}${row.description ? ` -- ${escapeHtml(row.description)}` : ''}</span>
      </li>`;
  }

  function subscriptionRowHtml(row, today, tomorrow) {
    const renew = row.autoRenews
      ? '<span class="text-highlight-green">auto-renews</span>'
      : '<span class="text-highlight-red">NOT renewing</span>';
    return `
      <li>
        ${ttDayTag(row.expirationDate, today, tomorrow)}
        <strong>${escapeHtml(row.clientName)}</strong>
        <span class="cell-subtext">${escapeHtml(row.name)} -- ${renew}</span>
      </li>`;
  }

  function stretyTaskRowHtml(row, today, tomorrow) {
    return `
      <li>
        ${ttDayTag(row.dueDate, today, tomorrow)}
        ${escapeHtml(row.title)}
      </li>`;
  }

  renderShiftsLegend();

  function addDaysKey(dateKey, delta) {
    const [y, m, d] = dateKey.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
  }

  shiftsPrevButton.addEventListener('click', () => loadShifts(addDaysKey(lastShiftsWeekStart, -7)));
  shiftsNextButton.addEventListener('click', () => loadShifts(addDaysKey(lastShiftsWeekStart, 7)));
  shiftsTodayButton.addEventListener('click', () => loadShifts(null)); // null -- let the server default to the current AEST week, same as the very first load
  shiftsRefreshButton.addEventListener('click', () => loadShifts(lastShiftsWeekStart, true));

  if (lastShiftsData) renderShifts(lastShiftsData);
  else loadShifts(null);

  async function loadShifts(weekKey, force) {
    shiftsPrevButton.disabled = true;
    shiftsNextButton.disabled = true;
    shiftsTodayButton.disabled = true;
    shiftsRefreshButton.disabled = true;
    shiftsStatusEl.hidden = false;
    shiftsStatusEl.className = 'status';
    shiftsStatusEl.textContent = 'Loading...';
    shiftsCalendarEl.innerHTML = '';

    try {
      const params = new URLSearchParams();
      if (weekKey) params.set('week', weekKey);
      if (force) params.set('force', 'true');
      const qs = params.toString();
      const res = await fetch(`/api/whats-on/shifts${qs ? `?${qs}` : ''}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastShiftsWeekStart = data.weekStart;
      lastShiftsData = data;
      renderShifts(data);
    } catch (err) {
      shiftsStatusEl.hidden = false;
      shiftsStatusEl.className = 'status error';
      shiftsStatusEl.textContent = `Error: ${err.message}`;
    } finally {
      shiftsPrevButton.disabled = false;
      shiftsNextButton.disabled = false;
      shiftsTodayButton.disabled = false;
      shiftsRefreshButton.disabled = false;
    }
  }

  function renderShifts(data) {
    shiftsWeekLabelEl.textContent = shiftsRangeLabel(data.days[0], data.days[data.days.length - 1]);

    if (data.notFound) {
      shiftsStatusEl.hidden = false;
      shiftsStatusEl.className = 'status error';
      shiftsStatusEl.textContent = `"${data.teamName}" wasn't found in Teams -- it may have been renamed or removed.`;
      shiftsCalendarEl.innerHTML = '';
      return;
    }

    shiftsStatusEl.hidden = true;
    shiftsCalendarEl.innerHTML = '';

    const table = document.createElement('table');
    table.className = 'calendar-table';
    const tbody = document.createElement('tbody');
    for (let i = 0; i < data.days.length; i += 7) {
      const week = data.days.slice(i, i + 7);
      const tr = document.createElement('tr');
      for (const dayKey of week) {
        const isToday = dayKey === data.todayKey;
        const td = document.createElement('td');
        td.className = 'calendar-cell' + (isToday ? ' calendar-cell--today' : '');
        const entries = data.byDay[dayKey] || [];
        // Day+month, not a bare day number -- unlike a single-month
        // calendar, this 14-day window routinely spans two different
        // months (sometimes two different years), so the month has to be
        // shown on every cell, not just implied by a shared header.
        const dayLabel = shiftsDayNumLabel(dayKey);
        td.innerHTML = `
          <span class="calendar-cell-daynum" style="cursor: default;">${dayLabel}</span>
          <div class="calendar-cell-entries">${entries.map((e) => shiftEntryHtml(e)).join('')}</div>
        `;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    shiftsCalendarEl.appendChild(table);
  }

  function shiftEntryHtml(e) {
    const cat = categorizeShift(e);
    const line1 = `${formatTime(e.startDateTime)}-${formatTime(e.endDateTime)}`;
    const line2 = e.userName || '(Open shift)';
    // Type -- the matched legend category's own clean label when there is
    // one (e.g. "Vacation", not the raw underlying reason text "Vacation
    // (green)"), otherwise the raw displayName so an uncategorized entry
    // still shows something rather than nothing. By request -- previously
    // this was tooltip-only ("Type: ..."); now shown directly on the entry
    // itself, one line taller.
    const line3 = cat ? cat.label : e.displayName || '(unlabeled)';
    const inner = `<span class="calendar-entry-line1">${escapeHtml(line1)}</span><span class="calendar-entry-line2">${escapeHtml(line2)}</span><span class="calendar-entry-line2">${escapeHtml(line3)}</span>`;
    const titleLines = [
      `${formatDateTime(e.startDateTime)} - ${formatDateTime(e.endDateTime)}`,
      `Assigned: ${e.userName || 'Open shift (unassigned)'}`,
      `Type: ${e.displayName || '(unlabeled)'}${cat ? ` -- ${cat.label}` : ''}`,
    ];
    if (e.notes) titleLines.push(`Notes: ${e.notes}`);
    if (!e.published) titleLines.push('Not yet published (draft)');
    const title = escapeHtml(titleLines.join('\n'));

    // Public Holiday's box is white -- a translucent color-mix tint (the
    // convention every other category uses) would be indistinguishable
    // from an empty cell on a light background, so it gets a solid fill
    // plus a visible border instead, same special-case as the legend swatch
    // below.
    const style = !cat
      ? '' // unmatched label (e.g. real data's "Working ", or an unlabeled shift) -- plain default look, not falsely colored
      : cat.key === 'publicHoliday'
        ? `background: #ffffff; color: #1a1a1a; border: 1px solid var(--border); border-left: 4.5px solid #9ca3af;`
        : `background: color-mix(in srgb, ${cat.color} 22%, transparent); border-left-color: ${cat.color};`;
    return `<div class="calendar-entry calendar-entry--allocated" style="${style}" title="${title}">${inner}</div>`;
  }

  function renderShiftsLegend() {
    shiftsLegendEl.innerHTML = SHIFT_CATEGORIES.map((cat) => {
      const swatchStyle =
        cat.key === 'publicHoliday'
          ? `background: #ffffff; border: 1px solid var(--border);`
          : `background: ${cat.color}; border: 1px solid color-mix(in srgb, ${cat.color} 60%, black);`;
      return `<span class="shifts-legend-item"><span class="shifts-legend-swatch" style="${swatchStyle}"></span>${escapeHtml(cat.label)}</span>`;
    }).join('');
  }

  function shiftsDayNumLabel(dayKey) {
    const [, m, d] = dayKey.split('-').map(Number);
    const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${d} ${MONTH_ABBR[m - 1]}`;
  }

  function shiftsRangeLabel(startKey, endKey) {
    const [sy] = startKey.split('-').map(Number);
    const [ey] = endKey.split('-').map(Number);
    const start = shiftsDayNumLabel(startKey);
    const end = shiftsDayNumLabel(endKey);
    // Only shows a year at all when the window's end year differs from the
    // browser's current year -- keeps the common case ("17 Aug - 30 Aug")
    // short, without hiding the year in the rarer case a window straddles a
    // real year boundary (sy !== ey) or is being viewed well into another year.
    const showYear = sy !== ey || sy !== new Date().getFullYear();
    return showYear ? `${start} ${sy} - ${end} ${ey}` : `${start} - ${end}`;
  }

  // Auto-loads on mount only when there's nothing to show yet -- by
  // request. Unlike My Strety Tasks/SaaS Alerts Customers (which re-fetch
  // live every time the page is opened), navigating back to a page that
  // already has real scorecard data just restores it instantly with no
  // new request at all; only a genuinely first visit this tab session, or
  // an explicit click of Refresh, hits the API.
  if (lastData) {
    render(lastData);
  } else {
    load();
  }

  async function load() {
    refreshButton.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = 'Loading...';
    summaryEl.hidden = true;
    resultsEl.innerHTML = '';

    try {
      const res = await fetch('/api/whats-on');
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
    if (data.status === 'not-connected') {
      // The SIGNED-IN USER'S OWN Strety connection now (both the Helpdesk
      // team group and Personal group use it, by request -- see
      // server.js), not the old shared one -- points at
      // /auth/strety-personal/connect, which authorizes as whoever's
      // currently signed into the dashboard.
      statusEl.hidden = false;
      statusEl.className = 'status error';
      statusEl.innerHTML = `Your Strety account isn't connected yet.<br><a class="button-link" href="/auth/strety-personal/connect">Connect Strety</a>`;
      resultsEl.innerHTML = '';
      return;
    }
    if (data.status === 'reauth-required') {
      // Distinct message from 'not-connected' -- this was working and its
      // stored refresh token has gone stale/revoked (confirmed this
      // happens periodically, see @dashboard/strety-client's README). Same
      // fix (redo the browser login), but says so plainly rather than
      // surfacing as a raw error someone has to go dig into. Names WHICH
      // Strety account needs reconnecting, when known (see server.js --
      // recorded at connect time, since a broken connection can no longer
      // ask Strety who it belongs to).
      const who = data.connectedAs ? ` (currently connected as ${escapeHtml(data.connectedAs)})` : '';
      statusEl.hidden = false;
      statusEl.className = 'status error';
      statusEl.innerHTML = `Your Strety connection${who} has stopped working and needs to be reconnected.<br><a class="button-link" href="/auth/strety-personal/connect">Reconnect Strety</a>`;
      resultsEl.innerHTML = '';
      return;
    }
    if (data.status === 'person-not-found') {
      statusEl.hidden = false;
      statusEl.className = 'status error';
      statusEl.textContent = `No Strety account found matching "${data.email}".`;
      resultsEl.innerHTML = '';
      return;
    }
    if (data.status === 'no-session-email') {
      statusEl.hidden = false;
      statusEl.className = 'status error';
      statusEl.textContent = 'Could not determine your signed-in email.';
      resultsEl.innerHTML = '';
      return;
    }

    statusEl.hidden = true;
    summaryEl.hidden = false;
    // Only the text span is replaced here, not summaryEl's whole innerHTML
    // -- the Refresh Scorecards button lives as a static sibling inside
    // #summary (set up once in mount()'s own skeleton, not rebuilt on every
    // render()), so overwriting the outer element's innerHTML on every
    // render would silently detach its click listener (a fresh <button>
    // node each time, not the one addEventListener() was ever called on).
    summaryTextEl.innerHTML = `Helpdesk Scorecards<span class="inline-subtext"> -- as at ${formatDateTime(data.asOf)}</span>`;

    resultsEl.innerHTML = '';

    // The Autotask -> Strety automation's own health, distinct from THIS
    // page's own (main) Strety connection above -- reported purely from a
    // status file the automation writes after each run (see
    // @dashboard/strety-autotask-sync's status.js), no extra live API call
    // needed to check it. Only shown when something's actually wrong --
    // a healthy/current automation is silent, same as the main connection's
    // own not-connected/reauth-required messages only showing on a real
    // problem.
    if (data.automationStatus && !data.automationStatus.ok) {
      const banner = document.createElement('p');
      banner.className = 'status error';
      banner.innerHTML = `${escapeHtml(data.automationStatus.message)}<br><a class="button-link" href="/auth/strety-automation/connect">Reconnect automation</a>`;
      resultsEl.appendChild(banner);
    }

    data.groups.forEach((group, i) => {
      // The Personal group is always second (see server.js -- Helpdesk is
      // pushed first, unconditionally) -- a fresh heading here marks the
      // shift from Helpdesk's scorecards to the signed-in user's own,
      // since summaryEl above only introduces the Helpdesk half.
      if (i === 1) {
        const personalHeading = document.createElement('div'); // was <p class="summary"> -- section-heading is styled as a block div elsewhere on this dashboard (Start Here's, Ticket Times', Team Shifts' own heading above)
        personalHeading.className = 'section-heading section-heading--nav';
        personalHeading.innerHTML = `Your Personal Scorecards<span class="inline-subtext"> -- as at ${formatDateTime(data.asOf)}</span>`;
        resultsEl.appendChild(personalHeading);
      }
      if (group.notFound) {
        resultsEl.appendChild(notice(`"${group.label}" wasn't found in Strety -- it may have been renamed or removed.`));
        return;
      }
      // The connected-but-no-matching-Strety-person case -- unlike a
      // not-yet-connected/broken connection (both handled at the page
      // level above, since both groups share one connection now), this can
      // only be known once fetchPersonByEmail() actually runs.
      if (group.personNotFound) {
        resultsEl.appendChild(notice(`No Strety account found matching your signed-in email.`));
        return;
      }
      // group.byFrequency[f] is { columns, rows } (see server.js), NOT an
      // array -- checking .rows.length here, not .length on the object
      // itself, which was always undefined regardless of real data and
      // made every group show "No scorecards" even when it had some.
      const frequenciesPresent = FREQUENCIES.filter((f) => group.byFrequency[f]?.rows?.length);
      if (frequenciesPresent.length === 0) {
        resultsEl.appendChild(notice(`No scorecards for ${group.label}.`));
        return;
      }
      for (const freq of frequenciesPresent) {
        const { columns, rows } = group.byFrequency[freq];
        resultsEl.appendChild(scorecardTable(group.label, FREQUENCY_LABELS[freq], columns, rows));
      }
    });
  }

  function notice(text) {
    const p = document.createElement('p');
    p.className = 'status';
    p.textContent = text;
    return p;
  }

  function scorecardTable(prefix, suffix, columns, rows) {
    const groupEl = document.createElement('div');
    groupEl.className = 'resource-group';

    // Only the part after "--" (the cadence: Daily/Weekly/Monthly) is
    // bold+green, by request -- the rest of the heading (the team/person
    // name) stays plain .section-heading styling. Built from the prefix/
    // suffix passed in separately, not by splitting the combined text on
    // "--" after the fact -- Personal's own group.label already contains
    // its own "--" (e.g. "Personal -- Amber Worth"), so string-splitting
    // would be ambiguous about which "--" is meant.
    const headingEl = document.createElement('div');
    headingEl.className = 'section-heading';
    headingEl.innerHTML = `${escapeHtml(prefix)} -- <span class="text-highlight-green">${escapeHtml(suffix)}</span>`;
    groupEl.appendChild(headingEl);

    if (columns.length === 0) {
      // Metrics exist for this cadence, but none has ever been checked in --
      // still list them (so they're not silently invisible), just without
      // any period columns to hang values on.
      const table = document.createElement('table');
      table.innerHTML = `
        <thead>
          <tr class="shaded-row"><th>Metric</th><th>Target</th><th>Check-ins</th></tr>
        </thead>
        <tbody>
          ${rows.map((m) => `<tr><td>${titleHtml(m.title, Boolean(m.cells[0]))}</td><td class="ticket-number">${escapeHtml(m.target)}</td><td>No check-ins yet</td></tr>`).join('')}
        </tbody>
      `;
      groupEl.appendChild(table);
      return groupEl;
    }

    // Columns are real shared periods (the most recent ones ANY metric in
    // this cadence actually has a check-in for, see server.js) -- every row
    // lines up against the exact same dates, not its own independent
    // "last 8" -- so the header can show a real date per column instead of
    // a generic "last 8" label.
    const table = document.createElement('table');
    table.innerHTML = `
      <thead>
        <tr class="shaded-row">
          <th>Metric</th>
          <th>Target</th>
          ${columns.map((label) => `<th class="checkin-cell">${escapeHtml(label)}</th>`).join('')}
        </tr>
      </thead>
      <tbody>
        ${rows.map((m) => metricRowHtml(m, columns.length)).join('')}
      </tbody>
    `;
    groupEl.appendChild(table);
    return groupEl;
  }

  function metricRowHtml(m, columnCount) {
    const cells = [];
    for (let i = 0; i < columnCount; i++) {
      const c = m.cells[i];
      cells.push(c ? checkinCellHtml(c) : '<td></td>');
    }
    return `
      <tr>
        <td>${titleHtml(m.title, Boolean(m.cells[0]))}</td>
        <td class="ticket-number">${escapeHtml(m.target)}</td>
        ${cells.join('')}
      </tr>`;
  }

  // Bold+green/red for a title's own leading "PREFIX:" convention (e.g.
  // "THURSDAY: Check for Errors..."), up to and including the first colon.
  // By request: green if the metric's most recent column (cells[0] --
  // columns are always most-recent-first, see server.js) has a real value,
  // red if that most recent column is empty -- a quick "is this metric
  // current" signal at a glance, not just decoration. A title with no
  // colon at all still renders unstyled either way, as before.
  function titleHtml(title, hasRecentData) {
    const colonIndex = title.indexOf(':');
    if (colonIndex === -1) return escapeHtml(title);
    const prefix = title.slice(0, colonIndex + 1);
    const rest = title.slice(colonIndex + 1);
    const cls = hasRecentData ? 'text-highlight-green' : 'text-highlight-red';
    return `<span class="${cls}">${escapeHtml(prefix)}</span>${escapeHtml(rest)}`;
  }

  function checkinCellHtml(c) {
    // Pass/fail flagged the same "needs attention" red / on-track green used
    // elsewhere on this dashboard (e.g. Subscriptions Expiring's
    // Auto-Renews column) -- no flag at all when there's no target to judge
    // against (pass === null).
    const flagClass = c.pass === true ? ' cell-flag-green' : c.pass === false ? ' cell-flag-red' : '';
    const titleAttr = c.context ? ` title="${escapeHtml(c.context)}"` : '';
    return `<td class="checkin-cell${flagClass}"${titleAttr}>${escapeHtml(c.displayValue)}</td>`;
  }

  function formatDateTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString();
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
