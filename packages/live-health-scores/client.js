import { scoreBadge } from '/meeting-prep-report-render.js';

export const id = 'live-health-scores';
export const label = 'Live Health Scores';

// Every current TC Elite client with its own live Overall Health Score,
// by request -- the same formula/data source Live Reports uses for one
// client at a time (see live-health-scores/server.js's own header), just
// listed for every TC Elite client at once. Sorted worst-first by
// default so the clients that most need attention surface at the top,
// unmatched clients last (nothing to act on there without first fixing
// the name match).

let lastData = null; // module-scope, survives the shell's teardown/re-mount, same convention every other page here uses

// Persists across re-mounts/refreshes too, same convention SaaS Alerts
// Customers' own sortState uses -- defaults to this page's original
// worst-first-by-score ordering, so a plain load (never having clicked a
// header) still looks exactly like it did before this got sortable.
let sortState = { key: 'overallScore', direction: 'asc' };

const SORTABLE_COLUMNS = [
  { key: 'companyName', label: 'Client' },
  { key: 'overallScore', label: 'Overall Health Score' },
  { key: 'totalDevices', label: 'Devices' },
  { key: 'workstationScore', label: 'Workstations' },
  { key: 'serverScore', label: 'Servers' },
];

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>Live Health Scores</h1>
      <div class="date-form">
        <button type="button" id="refresh-button">Refresh</button>
      </div>
    </header>
    <p id="status" class="status">Loading...</p>
    <div id="summary" class="summary" hidden></div>
    <div id="results"></div>
  `;

  const refreshButton = container.querySelector('#refresh-button');
  const statusEl = container.querySelector('#status');
  const summaryEl = container.querySelector('#summary');
  const resultsEl = container.querySelector('#results');

  refreshButton.addEventListener('click', () => load(true));

  if (lastData) render(lastData);
  else load(false);

  async function load(force) {
    refreshButton.disabled = true;
    resultsEl.innerHTML = '';
    summaryEl.hidden = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = 'Loading...';
    try {
      const res = await fetch(`/api/live-health-scores${force ? '?force=true' : ''}`);
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
    if (!data.connected) {
      statusEl.className = 'status error';
      statusEl.textContent = 'Datto RMM is not connected -- check DATTO_API_KEY in .env.';
      return;
    }
    statusEl.hidden = true;

    const matchedRows = data.rows.filter((r) => r.matched);
    const unmatchedRows = data.rows.filter((r) => !r.matched);
    // Defaults to worst-first-by-score -- the whole point of one list is
    // spotting who needs attention without opening each client
    // individually -- but any column header can be clicked to re-sort
    // (see renderTable()'s own sortableHeaderHtml()/compareForSort()).
    matchedRows.sort((a, b) => compareForSort(a, b, sortState.key, sortState.direction));
    unmatchedRows.sort((a, b) => a.companyName.localeCompare(b.companyName));

    summaryEl.hidden = false;
    summaryEl.innerHTML = `<strong>${matchedRows.length}</strong> TC Elite client${matchedRows.length === 1 ? '' : 's'} with a live score <span class="inline-subtext">(as of ${new Date(data.asOf).toLocaleString()})</span>`;

    resultsEl.innerHTML = '';

    if (data.rows.length === 0) {
      resultsEl.innerHTML = '<p class="status">No active "Tech Cover Elite" clients found.</p>';
      return;
    }

    resultsEl.appendChild(renderTable(matchedRows));

    if (unmatchedRows.length > 0) {
      const section = document.createElement('div');
      section.innerHTML = `
        <h2 class="client-summary-section-heading">No Datto RMM Match <span class="inline-subtext">(${unmatchedRows.length})</span></h2>
        <p class="inline-subtext">These TC Elite clients' names didn't match any Datto RMM site name automatically -- check the client's actual Datto site name on the Live Reports page.</p>
      `;
      section.appendChild(renderUnmatchedTable(unmatchedRows));
      resultsEl.appendChild(section);
    }
  }

  function renderTable(rows) {
    const wrap = document.createElement('div');
    wrap.className = 'resource-group';
    if (rows.length === 0) {
      wrap.innerHTML = '<p class="status" style="margin: 0.75rem;">No clients.</p>';
      return wrap;
    }
    wrap.innerHTML = `
      <table>
        <thead><tr>${SORTABLE_COLUMNS.map((col) => sortableHeaderHtml(col)).join('')}</tr></thead>
        <tbody>
          ${rows
            .map(
              (r) => `
            <tr>
              <td>${companyLink(r)}</td>
              <td>${scoreBadge(r.overallScore)}</td>
              <td>${r.totalDevices}</td>
              <td>${r.workstationScore === null ? '--' : scoreBadge(r.workstationScore)}</td>
              <td>${r.serverScore === null ? '--' : scoreBadge(r.serverScore)}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
    `;

    // Click-to-sort, click-again-to-reverse -- same convention SaaS Alerts
    // Customers' own sortableHeaderHtml()/sortState already use. The whole
    // table is re-derived from lastData on every click rather than
    // resorted in place, same reasoning as that page's own renderResults().
    wrap.querySelectorAll('.lhs-sort-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.sortKey;
        if (sortState.key === key) {
          sortState.direction = sortState.direction === 'asc' ? 'desc' : 'asc';
        } else {
          sortState = { key, direction: 'asc' };
        }
        render(lastData);
      });
    });

    return wrap;
  }

  function sortableHeaderHtml(col) {
    const isActive = sortState.key === col.key;
    const arrow = isActive ? (sortState.direction === 'asc' ? ' ▲' : ' ▼') : '';
    return `<th><button type="button" class="lhs-sort-btn${isActive ? ' lhs-sort-btn--active' : ''}" data-sort-key="${col.key}">${escapeHtml(col.label)}${arrow}</button></th>`;
  }

  // Nulls (workstationScore/serverScore are both genuinely absent for a
  // client with only the other device type) always sort to the end,
  // regardless of direction -- so reversing the sort doesn't make
  // "no servers" jump to the top, which would read as more surprising
  // than useful. Same shape as SaaS Alerts Customers' own compareForSort().
  function compareForSort(a, b, key, direction) {
    const av = a[key];
    const bv = b[key];
    const aMissing = av === null || av === undefined;
    const bMissing = bv === null || bv === undefined;
    if (aMissing || bMissing) return aMissing && bMissing ? 0 : aMissing ? 1 : -1;
    const cmp =
      typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
    return direction === 'asc' ? cmp : -cmp;
  }

  function renderUnmatchedTable(rows) {
    const wrap = document.createElement('div');
    wrap.className = 'resource-group';
    wrap.innerHTML = `
      <table>
        <thead><tr><th>Client</th></tr></thead>
        <tbody>
          ${rows.map((r) => `<tr><td>${companyLink(r)}</td></tr>`).join('')}
        </tbody>
      </table>
    `;
    return wrap;
  }

  // Same real popup-window convention every other Autotask link on this
  // dashboard uses. A grouped row (server.js's own groupBySharedSite(),
  // several TC Elite companies sharing one real Datto site with no
  // per-location data of its own -- see that function's own comment)
  // gets a tooltip listing every company folded into it, so it's clear
  // "(13 locations)" isn't just one client's own name.
  function companyLink(r) {
    const label = escapeHtml(r.companyName);
    const title = r.groupedCompanyNames ? escapeHtml(`Shares one Datto RMM site across: ${r.groupedCompanyNames.join(', ')}`) : '';
    const titleAttr = title ? ` title="${title}"` : '';
    if (!r.companyUrl) return `<span${titleAttr}>${label}</span>`;
    return `<a href="${escapeHtml(r.companyUrl)}" target="_blank" rel="noopener noreferrer"${titleAttr} onclick="window.open(this.href, '_blank', 'noopener,noreferrer,width=1200,height=900'); return false;">${label}</a>`;
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
