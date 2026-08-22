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

// Microsoft Teams Shifts' own fixed theme enum (confirmed against real data:
// yellow/purple/darkPink/pink all seen on one team's real August shifts) --
// mapped to concrete colors here since Graph only ever returns the theme
// NAME, never a hex value. "White"/no theme falls back to the shared
// calendar-entry--allocated look (a plain accent tint) rather than
// rendering literally white-on-white.
const THEME_COLORS = {
  blue: '#3b82f6',
  green: '#22c55e',
  purple: '#8b5cf6',
  pink: '#ec4899',
  yellow: '#eab308',
  gray: '#9ca3af',
  darkBlue: '#1e3a8a',
  darkGreen: '#166534',
  darkPurple: '#5b21b6',
  darkPink: '#9d174d',
  darkYellow: '#854d0e',
  darkGray: '#4b5563',
};

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>Shifts and Schedules</h1>
      <div class="date-form calendar-nav">
        <button type="button" id="prev-button" aria-label="Previous month">&lsaquo;</button>
        <span id="month-label" class="calendar-month-label"></span>
        <button type="button" id="next-button" aria-label="Next month">&rsaquo;</button>
        <button type="button" id="today-button">Today</button>
        <button type="button" id="refresh-button">Refresh</button>
      </div>
    </header>
    <p id="status" class="status">Loading...</p>
    <div id="summary" class="summary" hidden></div>
    <div id="calendar" class="results"></div>
  `;

  const prevButton = container.querySelector('#prev-button');
  const nextButton = container.querySelector('#next-button');
  const todayButton = container.querySelector('#today-button');
  const refreshButton = container.querySelector('#refresh-button');
  const monthLabelEl = container.querySelector('#month-label');
  const statusEl = container.querySelector('#status');
  const summaryEl = container.querySelector('#summary');
  const calendarEl = container.querySelector('#calendar');

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

  function entryHtml(e) {
    const line1 = `${formatTime(e.startDateTime)}-${formatTime(e.endDateTime)}`;
    const line2 = e.userName || '(Open shift)';
    const line3 = e.displayName || e.schedulingGroupName || '';
    const inner = `<span class="calendar-entry-line1">${escapeHtml(line1)}</span><span class="calendar-entry-line2">${escapeHtml(line2)}</span>${
      line3 ? `<span class="calendar-entry-line2">${escapeHtml(line3)}</span>` : ''
    }`;
    const titleLines = [
      `${formatDateTime(e.startDateTime)} - ${formatDateTime(e.endDateTime)}`,
      `Assigned: ${e.userName || 'Open shift (unassigned)'}`,
    ];
    if (e.displayName) titleLines.push(`Label: ${e.displayName}`);
    if (e.schedulingGroupName) titleLines.push(`Group: ${e.schedulingGroupName}`);
    if (e.notes) titleLines.push(`Notes: ${e.notes}`);
    if (!e.published) titleLines.push('Not yet published (draft)');
    const title = escapeHtml(titleLines.join('\n'));

    const color = e.theme && THEME_COLORS[e.theme];
    const style = color ? `style="background: color-mix(in srgb, ${color} 22%, transparent); border-left-color: ${color};"` : '';
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
    const time = `${formatTime(e.startDateTime)} - ${formatTime(e.endDateTime)}`;
    const activitiesHtml = e.activities.length
      ? `<dt>Activities</dt><dd>${e.activities
          .map((a) => `${escapeHtml(a.code || '')} (${formatTime(a.startDateTime)} - ${formatTime(a.endDateTime)})`)
          .join(', ')}</dd>`
      : '';
    return `
      <div class="card">
        <h2>${escapeHtml(time)} -- ${escapeHtml(e.userName || 'Open shift')}${!e.published ? '<span class="badge">Draft</span>' : ''}</h2>
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
