export const id = "my-strety-tasks";
export const label = "My Strety Tasks";

// Module-scope, not inside mount() -- the shell fully tears down and re-mounts a
// page's DOM on every navigation away and back, but the dynamically-imported
// module itself is cached by the browser and stays alive for the session, so a
// module-level variable survives across re-mounts and lets the last result
// restore instantly instead of coming back blank.
let lastData = null;

// Used by formatShortDate() (below, inside mount()) -- a fixed 3-letter
// table, not toLocaleDateString's own month: 'short' (that option's actual
// output length isn't guaranteed 3 characters across every locale/browser).
// Deliberately at true MODULE scope, not declared inside mount() itself --
// confirmed the hard way: a `const` declared inside mount() sat AFTER the
// synchronous "restore from cache on revisit" call
// (`if (lastData) render(lastData)` below), which itself calls into
// formatShortDate() -- a real `ReferenceError: Cannot access 'MONTH_SHORT'
// before initialization` on every SECOND-OR-LATER visit to this page
// within the same browser session (not the first visit, since lastData is
// still null then and that line does nothing) -- a `const`'s temporal
// dead zone applies to its whole enclosing scope, not just "before this
// line textually", and mount() re-runs top-to-bottom on every navigation
// back to this page, hitting that early call before ever reaching the
// `const` line again each time. Module scope sidesteps this entirely --
// it's fully initialized once, before mount() is ever called the first
// time.
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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
      // This page's own PERSONAL Strety connection (see
      // @dashboard/strety-client's getPersonalClient()) -- deliberately a
      // different connect link from What's On's shared-connection banner
      // (/auth/strety/connect): this one connects as the SIGNED-IN USER
      // themselves, which is what lets this page see their own todos at
      // all (a shared/limited account has confirmed-real zero visibility
      // into anyone's personal Strety data).
      statusEl.hidden = false;
      statusEl.className = 'status error';
      statusEl.innerHTML = `Your Strety account isn't connected yet. <a href="/auth/strety-personal/connect">Connect Strety</a>, then come back and refresh.`;
      resultsEl.innerHTML = '';
      return;
    }
    if (data.status === 'reauth-required') {
      const who = data.connectedAs ? ` (currently connected as ${escapeHtml(data.connectedAs)})` : '';
      statusEl.hidden = false;
      statusEl.className = 'status error';
      statusEl.innerHTML = `Your Strety connection${who} has stopped working and needs to be reconnected. <a href="/auth/strety-personal/connect">Reconnect Strety</a>.`;
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
    const tomorrowKey = tomorrowAestKey();

    // Re-bucketed into Today -> Tomorrow -> Overdue -> Future -> no due
    // date, by request -- overrides the server's own plain date-ascending
    // order (fetchOpenTasksFor() in server.js), which put overdue tasks
    // BEFORE today's own (an overdue date is chronologically earliest, so
    // a pure ascending sort puts it first -- not what's wanted here). A
    // STABLE sort (guaranteed since ES2019, both in browsers and Node)
    // preserves each bucket's existing date-ascending relative order, so
    // this only changes which BUCKET comes first, not the order within
    // one -- Overdue still reads oldest-overdue-first, Future still reads
    // soonest-first.
    function taskCategory(t) {
      if (!t.dueDate) return 4;
      if (t.dueDate === todayKey) return 0;
      if (t.dueDate === tomorrowKey) return 1;
      if (t.dueDate < todayKey) return 2; // overdue
      return 3; // future
    }
    const orderedTasks = [...data.tasks].sort((a, b) => taskCategory(a) - taskCategory(b));

    // Grouped by Team (a task's `space` -- Personal, a real team, or a
    // project, see server.js), each group internally in the same Today ->
    // Tomorrow -> Overdue -> Future order as orderedTasks above (for free,
    // via filter() preserving relative order). Groups themselves are NOT
    // alphabetical -- they're emitted in the order their first task
    // appears in orderedTasks, by request -- since Today/Tomorrow tasks
    // are now first in that list regardless of which team they belong to,
    // this naturally puts every team with a Today or Tomorrow task ahead
    // of every team that only has overdue/future/no-date ones, without
    // needing any separate team-level sort of its own.
    const groupNames = [];
    const seen = new Set();
    for (const t of orderedTasks) {
      const name = t.space ? t.space.name : 'Unknown';
      if (!seen.has(name)) {
        seen.add(name);
        groupNames.push(name);
      }
    }

    for (const name of groupNames) {
      const rows = orderedTasks.filter((t) => (t.space ? t.space.name : 'Unknown') === name);
      resultsEl.appendChild(group(name, rows, todayKey, tomorrowKey));
    }
  }

  function group(name, rows, todayKey, tomorrowKey) {
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
        ${rows.map((t) => taskRowHtml(t, todayKey, tomorrowKey)).join('')}
      </tbody>
    `;
    groupEl.appendChild(table);
    return groupEl;
  }

  function taskRowHtml(t, todayKey, tomorrowKey) {
    return `
      <tr>
        <td>${dueDateTagHtml(t, todayKey, tomorrowKey)}</td>
        <td>${escapeHtml(t.title)}</td>
        <td>${escapeHtml(capitalize(t.priority))}</td>
        <td>${escapeHtml(t.description || '')}</td>
      </tr>`;
  }

  // Same coloured Today/Tomorrow/date-pill look as What's On's own My
  // Strety Tasks column (ttDayTag() in whats-on/client.js), by request --
  // reused here rather than the plain locale-formatted date this column
  // used to show. Today = green, Tomorrow = amber, genuinely overdue (due
  // before today) = red with just the short date (no "Overdue" text label
  // -- the colour already says that). Unlike What's On's own version,
  // this page shows EVERY open task regardless of due date, not just
  // today/tomorrow/overdue -- a due date further out than tomorrow gets
  // the same pill shape with no colour modifier at all (plain text colour),
  // since it isn't today, tomorrow, OR overdue. No due date at all renders
  // nothing.
  //
  // The tag ITSELF is the link to Strety (when t.todoUrl resolved), not
  // the title text -- tried linking the title first, by request reverted
  // (looked bad) in favour of matching What's On's own href-on-the-tag
  // convention exactly.
  function dueDateTagHtml(t, todayKey, tomorrowKey) {
    if (!t.dueDate) return '';
    let colorClass;
    let label;
    if (t.dueDate === todayKey) {
      colorClass = 'tt-tag--today';
      label = 'Today';
    } else if (t.dueDate === tomorrowKey) {
      colorClass = 'tt-tag--tomorrow';
      label = 'Tomorrow';
    } else if (t.dueDate < todayKey) {
      colorClass = 'tt-tag--overdue';
      label = formatShortDate(t.dueDate);
    } else {
      colorClass = '';
      label = formatShortDate(t.dueDate);
    }
    const cls = `tt-tag${colorClass ? ` ${colorClass}` : ''}`;
    if (!t.todoUrl) return `<span class="${cls}">${escapeHtml(label)}</span>`;
    return `<a class="${cls}" href="${escapeHtml(t.todoUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
  }

  if (lastData) render(lastData);

  // AEST (UTC+10, no DST in Queensland) "today", same convention as every
  // other date-scoped page on this dashboard, computed client-side here
  // since this page has no server-side date logic of its own to anchor to.
  function todayAestKey() {
    return new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  function tomorrowAestKey() {
    return new Date(Date.now() + 10 * 60 * 60 * 1000 + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  function capitalize(str) {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  // Day + month only, no year -- same as What's On's own formatShortDate()
  // (ttDayTag()'s overdue-date label), for consistency now that this
  // column uses the identical tag component. MONTH_SHORT itself lives at
  // module scope (top of file) -- see its own comment there for why (a
  // real TDZ crash on page revisit, confirmed the hard way, when it was
  // declared here instead).
  function formatShortDate(dateKey) {
    if (!dateKey) return '';
    const d = new Date(`${dateKey}T00:00:00`);
    return `${d.getDate()} ${MONTH_SHORT[d.getMonth()]}`;
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
