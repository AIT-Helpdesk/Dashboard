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

const FREQUENCIES = ['daily', 'weekly', 'monthly'];
const FREQUENCY_LABELS = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>What's On</h1>
      <div class="date-form">
        <button type="button" id="refresh-button">Refresh</button>
      </div>
    </header>
    <p id="status" class="status">Helpdesk Task Tracker's scorecards, followed by your own personal scorecards -- up to the last 8 real check-in periods, most recent first. Hover a value for its check-in note.</p>
    <div id="summary" class="summary" hidden></div>
    <div id="results" class="results"></div>
  `;

  const refreshButton = container.querySelector('#refresh-button');
  const statusEl = container.querySelector('#status');
  const summaryEl = container.querySelector('#summary');
  const resultsEl = container.querySelector('#results');

  refreshButton.addEventListener('click', load);

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
      statusEl.hidden = false;
      statusEl.className = 'status error';
      statusEl.innerHTML = `Strety isn't connected yet.<br><a class="button-link" href="/auth/strety/connect">Connect Strety</a>`;
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
      statusEl.innerHTML = `Strety's connection${who} has stopped working and needs to be reconnected.<br><a class="button-link" href="/auth/strety/connect">Reconnect Strety</a>`;
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
    summaryEl.innerHTML = `<strong>Helpdesk Scorecards</strong><span class="inline-subtext"> -- as at ${formatDateTime(data.asOf)}</span>`;

    resultsEl.innerHTML = '';
    data.groups.forEach((group, i) => {
      // The Personal group is always second (see server.js -- Helpdesk is
      // pushed first, unconditionally) -- a fresh heading here marks the
      // shift from Helpdesk's scorecards to the signed-in user's own,
      // since summaryEl above only introduces the Helpdesk half.
      if (i === 1) {
        const personalHeading = document.createElement('p');
        personalHeading.className = 'summary';
        personalHeading.innerHTML = `<strong>Your Personal Scorecards</strong><span class="inline-subtext"> -- as at ${formatDateTime(data.asOf)}</span>`;
        resultsEl.appendChild(personalHeading);
      }
      if (group.notFound) {
        resultsEl.appendChild(notice(`"${group.label}" wasn't found in Strety -- it may have been renamed or removed.`));
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

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
