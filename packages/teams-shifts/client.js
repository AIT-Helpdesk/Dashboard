export const id = 'teams-shifts';
export const label = 'Shifts and Schedules';

// Module-scope, not inside mount() -- the shell fully tears down and re-mounts a
// page's DOM on every navigation away and back, but the dynamically-imported
// module itself is cached by the browser and stays alive for the session, so a
// module-level variable survives across re-mounts and lets the last result
// restore instantly instead of coming back blank. Same pattern as CSP
// Customers/Service Calls.
let lastTeamId = ''; // resolved automatically now -- see resolveTeamId() -- no longer a user-facing dropdown selection
let lastMonth = null; // "YYYY-MM"
let lastData = null;

// Locked to "General", by request -- no team picker anymore. Resolved by
// NAME against the same GET /api/teams-shifts/teams endpoint the old
// dropdown used to populate, not a hardcoded team id -- same
// not-a-hardcoded-id convention What's On's own Team Shifts excerpt uses
// for this same team (see packages/whats-on/server.js's SHIFTS_TEAM_NAME),
// so a rename in Teams still surfaces as a clear error here instead of
// silently showing nothing.
const TEAM_NAME = 'General';

const MONTH_LABELS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAY_HEADERS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// Same fixed legend/category list @dashboard/whats-on's own client.js
// defines for its Team Shifts excerpt (see that file's own long comment
// for the full real-data confirmation story behind every pattern here) --
// duplicated, not imported, same "separate page package" convention every
// other small shared UI piece on this dashboard already follows. Replaces
// this page's own previous THEME_COLORS (Microsoft Teams' raw theme enum
// mapped to hex, with no real-world meaning attached), by request ("Apply
// this colouring also to the 'Shifts and Schedules' page") -- the same
// meaningful On Call/Helpdesk Handler/Vacation/etc. categories now colour
// entries here too, not just What's On's own excerpt.
const SHIFT_CATEGORIES = [
  { key: 'onCall', label: 'On Call', color: '#eab308', match: (dn) => /^on\s*call/i.test(dn) },
  { key: 'helpdesk', label: 'Helpdesk Handler', color: '#3b82f6', match: (dn) => /helpdesk\s*handler/i.test(dn) },
  { key: 'vacation', label: 'Vacation', color: '#22c55e', match: (dn) => /vacation/i.test(dn) },
  { key: 'unpaidLeave', label: 'Unpaid leave', color: '#dc2626', match: (dn) => /unpaid/i.test(dn) },
  { key: 'sickOther', label: 'Sick/Other Leave', color: '#8b5cf6', match: (dn) => /\bsick\b|other\s*leave/i.test(dn) },
  // "floating holiday" folded in here, not into publicHoliday below --
  // confirmed against real data this tenant's real Autotask Leave billing
  // code is spelled literally "Floating Holiday" (see fetchLeaveEntries()
  // in server.js), and it doesn't say "public" so publicHoliday's own
  // regex wouldn't have caught it anyway; a floating/discretionary day
  // off is conceptually closer to RDO/Time in Lieu (an individually-
  // earned day off) than to an actual gazetted, company-wide Public
  // Holiday, so it's bucketed here rather than guessed into that one.
  { key: 'rdoTil', label: 'RDO/Time in Lieu', color: '#9ca3af', match: (dn) => /\brdo\b|time\s*in\s*lieu|floating\s*holiday/i.test(dn) },
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
      <h1>Shifts and Schedules</h1>
      <div class="date-form calendar-nav">
        <button type="button" id="prev-button" aria-label="Previous month">&lsaquo;</button>
        <span id="month-label" class="calendar-month-label"></span>
        <button type="button" id="next-button" aria-label="Next month">&rsaquo;</button>
        <button type="button" id="today-button">Today</button>
        <button type="button" id="refresh-button" class="refresh-button--emphasis">Refresh</button>
      </div>
    </header>
    <p id="status" class="status">Loading...</p>
    <div id="summary" class="summary" hidden></div>
    <div id="calendar" class="results"></div>
    <div id="shifts-legend" class="shifts-legend"></div>
  `;

  const prevButton = container.querySelector('#prev-button');
  const nextButton = container.querySelector('#next-button');
  const todayButton = container.querySelector('#today-button');
  const refreshButton = container.querySelector('#refresh-button');
  const monthLabelEl = container.querySelector('#month-label');
  const statusEl = container.querySelector('#status');
  const summaryEl = container.querySelector('#summary');
  const calendarEl = container.querySelector('#calendar');
  const shiftsLegendEl = container.querySelector('#shifts-legend');

  // Static (doesn't depend on loaded data), so rendered once here rather
  // than re-rendered on every load() -- same convention What's On's own
  // Team Shifts excerpt uses for its identical legend.
  renderShiftsLegend();
  function renderShiftsLegend() {
    shiftsLegendEl.innerHTML = SHIFT_CATEGORIES.map((cat) => {
      const swatchStyle =
        cat.key === 'publicHoliday'
          ? `background: #ffffff; border: 1px solid var(--border);`
          : `background: ${cat.color}; border: 1px solid color-mix(in srgb, ${cat.color} 60%, black);`;
      return `<span class="shifts-legend-item"><span class="shifts-legend-swatch" style="${swatchStyle}"></span>${escapeHtml(cat.label)}</span>`;
    }).join('');
  }

  function defaultMonthKey() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  function addMonths(monthKey, delta) {
    const [y, m] = monthKey.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  function monthLabelFor(monthKey) {
    const [y, m] = monthKey.split('-').map(Number);
    return `${MONTH_LABELS[m - 1]} ${y}`;
  }

  prevButton.addEventListener('click', () => load(addMonths(lastMonth || defaultMonthKey(), -1)));
  nextButton.addEventListener('click', () => load(addMonths(lastMonth || defaultMonthKey(), 1)));
  todayButton.addEventListener('click', () => load(lastData ? lastData.todayKey.slice(0, 7) : defaultMonthKey()));
  refreshButton.addEventListener('click', () => load(lastMonth || defaultMonthKey(), true));

  // Resolves TEAM_NAME's real id via the same GET /api/teams-shifts/teams
  // endpoint the old dropdown used to populate -- just filtered to one team
  // client-side instead of listing all of them for a human to pick. Only
  // hits the network once per browser tab session (module-scope lastTeamId
  // survives a re-mount, same restore-instantly reasoning as lastData).
  async function resolveTeamId() {
    if (lastTeamId) {
      if (lastData) render(lastData);
      else load(lastMonth || defaultMonthKey());
      return;
    }
    try {
      const res = await fetch('/api/teams-shifts/teams');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      const team = data.teams.find((t) => t.name === TEAM_NAME);
      if (!team) {
        // Surfaced rather than silently showing an empty calendar -- same
        // notFound convention What's On's own Team Shifts excerpt uses for
        // this same team.
        statusEl.className = 'status error';
        statusEl.textContent = `"${TEAM_NAME}" wasn't found in Teams -- it may have been renamed or removed.`;
        return;
      }
      lastTeamId = team.id;
      load(defaultMonthKey());
    } catch (err) {
      statusEl.className = 'status error';
      statusEl.textContent = `Error resolving "${TEAM_NAME}": ${err.message}`;
    }
  }

  async function load(monthKey, force) {
    if (!lastTeamId) return;
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
      const res = await fetch(`/api/teams-shifts/${encodeURIComponent(lastTeamId)}/month?${params}`);
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

  function render(data) {
    statusEl.hidden = true;
    monthLabelEl.textContent = monthLabelFor(data.month);

    summaryEl.hidden = false;
    summaryEl.innerHTML = `<strong>${data.totalCount}</strong> shift${data.totalCount === 1 ? '' : 's'} in ${escapeHtml(monthLabelFor(data.month))}`;

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
        const entries = data.byDay[dayKey] || [];
        td.innerHTML = `
          <button type="button" class="calendar-cell-daynum" ${entries.length === 0 ? 'disabled' : ''}>${dd}</button>
          <div class="calendar-cell-entries">${entries.map((e) => entryHtml(e)).join('')}</div>
        `;
        if (entries.length > 0) {
          td.querySelector('.calendar-cell-daynum').addEventListener('click', () => openDayPopup(dayKey, entries));
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    calendarEl.appendChild(table);
  }

  // Not-yet-approved real Leave (kind: 'leave', approved: false -- a real
  // TimeOffRequests row still at Submitted/Partially Approved, see
  // fetchLeaveEntries() in server.js) renders with a diagonal stripe
  // through its own category colour instead of a flat tint, by request
  // ("can we display the Unapproved data with the right colour but with
  // stripes or something so that it's obviously different") -- keeps the
  // same colour identity (still recognisably "Vacation" etc.) while
  // staying visually unmistakable from a confirmed, Approved entry.
  // `approved` is `undefined` for every non-leave kind (shift/timeOff/
  // publicHoliday), which reads as "not false" here -- solid, same as
  // always.
  function categoryBackground(cat, approved) {
    const tint = `color-mix(in srgb, ${cat.color} 22%, white)`;
    if (approved !== false) return `background: ${tint};`;
    return `background: repeating-linear-gradient(45deg, ${tint}, ${tint} 6px, white 6px, white 12px);`;
  }
  function entryHtml(e) {
    const cat = categorizeShift(e);
    // Real Autotask Leave (kind: 'leave', see fetchLeaveEntries() in
    // server.js) has no real start/end time -- it's a whole
    // TimeEntries.dateWorked day with an hoursWorked total, not a Graph
    // shift with real clock times -- so line1 shows that hours total
    // instead of a blank "-" a real formatTime(null) pair would produce.
    // Real Autotask Public Holidays (kind: 'publicHoliday', see
    // fetchPublicHolidayEntries()) have no clock time OR hours figure at
    // all -- line1 shows the real holiday's own short name instead
    // (e.userName/line2 already carries which Holiday Set it's from).
    const line1 = e.kind === 'leave' ? `${formatHours(e.hoursWorked)}h` : e.kind === 'publicHoliday' ? e.holidayName : `${formatTime(e.startDateTime)}-${formatTime(e.endDateTime)}`;
    const line2 = e.userName || '(Open shift)';
    // The matched legend category's own clean label when there is one
    // (e.g. "Vacation", not the raw underlying reason text "Vacation
    // (green)"), otherwise the raw displayName/schedulingGroupName this
    // page already fell back to -- same real convention What's On's own
    // shiftEntryHtml() uses for this identical field, by request ("Apply
    // this colouring also to the 'Shifts and Schedules' page").
    const line3 = cat ? cat.label : e.displayName || e.schedulingGroupName || '';
    // line2's own colour is pinned literal light --muted (not
    // var(--muted), which would follow the page's real theme) only once
    // a matched category has ALSO pinned this entry's own background to
    // its light-mode look below -- same reasoning What's On's own
    // shiftEntryHtml() uses: a dark-theme muted grey would otherwise sit
    // illegibly on top of the now-always-light pastel tint.
    const line2Style = cat ? ' style="color: #6b7280;"' : '';
    const inner = `<span class="calendar-entry-line1">${escapeHtml(line1)}</span><span class="calendar-entry-line2"${line2Style}>${escapeHtml(line2)}</span>${
      line3 ? `<span class="calendar-entry-line2"${line2Style}>${escapeHtml(line3)}</span>` : ''
    }`;
    const titleLines =
      e.kind === 'publicHoliday'
        ? [`Public Holiday: ${e.holidayName}`, `${e.holidaySetName && e.holidaySetName.includes(',') ? 'Holiday Sets' : 'Holiday Set'}: ${e.holidaySetName}`]
        : [
            e.kind === 'leave' ? `${formatHours(e.hoursWorked)}h leave` : `${formatDateTime(e.startDateTime)} - ${formatDateTime(e.endDateTime)}`,
            `Assigned: ${e.userName || 'Open shift (unassigned)'}`,
          ];
    if (e.kind !== 'publicHoliday' && e.displayName) titleLines.push(`Label: ${e.displayName}${cat ? ` -- ${cat.label}` : ''}`);
    if (e.schedulingGroupName) titleLines.push(`Group: ${e.schedulingGroupName}`);
    if (e.notes) titleLines.push(`Notes: ${e.notes}`);
    if (!e.published) titleLines.push('Not yet published (draft)');
    if (e.kind === 'leave' && e.approved === false) titleLines.push('Not yet approved');
    const title = escapeHtml(titleLines.join('\n'));

    // Public Holiday's box is white -- a translucent tint would be
    // indistinguishable from an empty cell on a light background, so it
    // gets a solid fill plus a visible border instead, same special case
    // the legend swatch above and What's On's own shiftEntryHtml() both
    // use. Every matched-category entry is pinned to its light-mode look
    // always (mixing toward opaque white, not transparent), same reason
    // as that page's own version -- an unmatched entry (no cat at all)
    // is untouched and just follows the page's real theme normally, same
    // as this page's own previous THEME_COLORS behaviour did.
    const style = !cat
      ? ''
      : cat.key === 'publicHoliday'
        ? `style="background: #ffffff; color: #1a1a1a; border: 1px solid #e5e7eb; border-left: 4.5px solid #9ca3af;"`
        : `style="${categoryBackground(cat, e.approved)} color: #1a1a1a; border-left-color: ${cat.color};"`;
    const draftClass = e.published ? '' : ' calendar-entry--onsite-tba'; // reuse the existing dashed/red-accent look for "needs attention" -- draft shifts aren't final yet
    return `<div class="calendar-entry calendar-entry--allocated${draftClass}" ${style} title="${title}">${inner}</div>`;
  }

  // Same "real popup window, built client-side from already-loaded data"
  // pattern as Service Calls' openDayPopup() -- every field this page
  // fetches for a shift is shown here, not just the calendar-cell summary.
  function openDayPopup(dayKey, entries) {
    const popup = window.open('', '_blank', 'width=720,height=800,scrollbars=yes');
    if (!popup) return; // genuinely blocked by the browser's popup blocker -- nothing more to do

    const dateLabel = new Date(`${dayKey}T00:00:00`).toLocaleDateString(undefined, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    const isDark =
      document.documentElement.getAttribute('data-theme') === 'dark' ||
      (document.documentElement.getAttribute('data-theme') !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const colors = isDark
      ? { bg: '#14161a', fg: '#eef0f3', muted: '#9aa3af', border: '#2a2e35', card: '#1b1e24', accent: '#5b8def' }
      : { bg: '#ffffff', fg: '#1a1a1a', muted: '#6b7280', border: '#e5e7eb', card: '#f9fafb', accent: '#2563eb' };

    const cardsHtml = entries.map((e) => dayPopupEntryHtml(e, colors)).join('');

    popup.document.open();
    popup.document.write(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Shifts and Schedules -- ${escapeHtml(dateLabel)}</title>
<style>
  body { font-family: system-ui, sans-serif; background: ${colors.bg}; color: ${colors.fg}; margin: 0; padding: 1rem 1.25rem; }
  h1 { font-size: 1.15rem; margin: 0 0 1rem; }
  .card { border: 1px solid ${colors.border}; border-radius: 8px; background: ${colors.card}; padding: 0.75rem 1rem; margin-bottom: 0.75rem; }
  .card h2 { font-size: 1rem; margin: 0 0 0.4rem; }
  .card dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 0.15rem 0.75rem; }
  .card dt { color: ${colors.muted}; }
  .card dd { margin: 0; }
  .badge { display: inline-block; font-size: 0.72rem; padding: 0.1rem 0.45rem; border-radius: 999px; background: color-mix(in srgb, ${colors.accent} 20%, transparent); color: ${colors.accent}; margin-left: 0.4rem; }
  .empty { color: ${colors.muted}; }
</style>
</head>
<body>
<h1>Shifts and Schedules -- ${escapeHtml(dateLabel)}</h1>
${cardsHtml || '<p class="empty">No shifts.</p>'}
</body>
</html>`);
    popup.document.close();
  }

  function dayPopupEntryHtml(e, colors) {
    const time = e.kind === 'leave' ? `${formatHours(e.hoursWorked)}h leave` : e.kind === 'publicHoliday' ? e.holidayName : `${formatTime(e.startDateTime)} - ${formatTime(e.endDateTime)}`;
    const activitiesHtml = e.activities.length
      ? `<dt>Activities</dt><dd>${e.activities
          .map((a) => `${escapeHtml(a.code || '')} (${formatTime(a.startDateTime)} - ${formatTime(a.endDateTime)})`)
          .join(', ')}</dd>`
      : '';
    const notApprovedBadge = e.kind === 'leave' && e.approved === false ? '<span class="badge">Not yet approved</span>' : '';
    return `
      <div class="card">
        <h2>${escapeHtml(time)} -- ${escapeHtml(e.userName || 'Open shift')}${!e.published ? '<span class="badge">Draft</span>' : ''}${notApprovedBadge}</h2>
        <dl>
          ${e.displayName ? `<dt>Label</dt><dd>${escapeHtml(e.displayName)}</dd>` : ''}
          ${e.schedulingGroupName ? `<dt>Group</dt><dd>${escapeHtml(e.schedulingGroupName)}</dd>` : ''}
          ${e.notes ? `<dt>Notes</dt><dd>${escapeHtml(e.notes)}</dd>` : ''}
          ${activitiesHtml}
          <dt>Status</dt><dd>${e.published ? 'Published' : 'Draft (unpublished)'}</dd>
          <dt>Created</dt><dd>${formatDateTime(e.createdDateTime)}</dd>
          <dt>Last modified</dt><dd>${formatDateTime(e.lastModifiedDateTime)}</dd>
        </dl>
      </div>`;
  }

  resolveTeamId();

  function formatTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  // For a real Leave entry's hoursWorked total (e.g. the confirmed real
  // 7.6 full day) -- trims a whole number's trailing ".0" but keeps one
  // decimal place otherwise, same "don't over-precision a round number"
  // reasoning small hour displays elsewhere on this dashboard already use.
  function formatHours(hours) {
    if (hours === null || hours === undefined) return '0';
    const rounded = Math.round(hours * 10) / 10;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  }

  function formatDateTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString();
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
