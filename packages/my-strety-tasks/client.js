export const id = "my-strety-tasks";
export const label = "My Strety Tasks";

// Module-scope, not inside mount() -- the shell fully tears down and re-mounts a
// page's DOM on every navigation away and back, but the dynamically-imported
// module itself is cached by the browser and stays alive for the session, so a
// module-level variable survives across re-mounts and lets the last result
// restore instantly instead of coming back blank.
let lastData = null;

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>My Strety Tasks</h1>
      <div class="date-form">
        <button type="button" id="refresh-button">Refresh</button>
      </div>
    </header>
    <p id="status" class="status">Your open Strety to-dos, sorted by due date (soonest first; no due date shown last).</p>
    <div id="summary" class="summary" hidden></div>
    <div id="results" class="results"></div>
  `;

  const refreshButton = container.querySelector('#refresh-button');
  const statusEl = container.querySelector('#status');
  const summaryEl = container.querySelector('#summary');
  const resultsEl = container.querySelector('#results');

  refreshButton.addEventListener('click', load);

  // Auto-loads on mount, by request -- this is "my" tasks, there's no
  // search/filter input to wait for, same convention as SaaS Alerts
  // Customers' cheap auto-loading list.
  load();

  async function load() {
    refreshButton.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = 'Loading...';
    summaryEl.hidden = true;
    resultsEl.innerHTML = '';

    try {
      const res = await fetch('/api/my-strety-tasks');
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
      statusEl.hidden = false;
      statusEl.className = 'status error';
      statusEl.innerHTML = `Strety isn't connected yet. <a href="/auth/strety/connect">Connect Strety</a>, then come back and refresh.`;
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
    summaryEl.innerHTML = `<strong>${data.totalCount}</strong> open task${data.totalCount === 1 ? '' : 's'} for ${escapeHtml(data.personName)}<span class="inline-subtext"> -- as of ${formatDateTime(data.asOf)}</span>`;

    resultsEl.innerHTML = '';
    if (data.tasks.length === 0) {
      resultsEl.innerHTML = '<p class="status">No open tasks.</p>';
      return;
    }

    const todayKey = todayAestKey();

    // Grouped by Team (a task's `space` -- Personal, a real team, or a
    // project, see server.js), each group internally still sorted by due
    // date -- for free, since data.tasks arrives from the server already
    // sorted that way and a filter() preserves relative order. Groups
    // themselves are NOT alphabetical -- they're emitted in the order their
    // first (soonest-due) task appears in that already-sorted list, so the
    // team with the most urgent task leads, matching this page's overall
    // "soonest first" premise instead of fighting it.
    const groupNames = [];
    const seen = new Set();
    for (const t of data.tasks) {
      const name = t.space ? t.space.name : 'Unknown';
      if (!seen.has(name)) {
        seen.add(name);
        groupNames.push(name);
      }
    }

    for (const name of groupNames) {
      const rows = data.tasks.filter((t) => (t.space ? t.space.name : 'Unknown') === name);
      resultsEl.appendChild(group(name, rows, todayKey));
    }
  }

  function group(name, rows, todayKey) {
    const groupEl = document.createElement('div');
    groupEl.className = 'resource-group';

    const headingEl = document.createElement('div');
    headingEl.className = 'section-heading';
    headingEl.textContent = `${name} (${rows.length})`;
    groupEl.appendChild(headingEl);

    const table = document.createElement('table');
    table.innerHTML = `
      <thead>
        <tr class="shaded-row"><th>Due Date</th><th>Title</th><th>Priority</th><th>Description</th></tr>
      </thead>
      <tbody>
        ${rows.map((t) => taskRowHtml(t, todayKey)).join('')}
      </tbody>
    `;
    groupEl.appendChild(table);
    return groupEl;
  }

  function taskRowHtml(t, todayKey) {
    // Overdue (due before today, still open) flagged red -- same "needs
    // attention" convention used elsewhere on this dashboard. A task due
    // today is NOT flagged -- there's still time left in the day.
    const overdue = t.dueDate && t.dueDate < todayKey;
    return `
      <tr>
        <td class="ticket-number${overdue ? ' cell-flag-red' : ''}">${t.dueDate ? formatDate(t.dueDate) : ''}</td>
        <td>${escapeHtml(t.title)}</td>
        <td>${escapeHtml(capitalize(t.priority))}</td>
        <td>${escapeHtml(t.description || '')}</td>
      </tr>`;
  }

  if (lastData) render(lastData);

  // AEST (UTC+10, no DST in Queensland) "today", same convention as every
  // other date-scoped page on this dashboard, computed client-side here
  // since this page has no server-side date logic of its own to anchor to.
  function todayAestKey() {
    return new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  function capitalize(str) {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  function formatDate(isoDateOnly) {
    if (!isoDateOnly) return '';
    return new Date(`${isoDateOnly}T00:00:00.000Z`).toLocaleDateString(undefined, { timeZone: 'Australia/Brisbane' });
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
