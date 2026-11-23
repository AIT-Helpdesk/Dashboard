export const id = "classification-summary";
export const label = "Clients by Classification";

// Module-scope, not inside mount() -- same "survives a shell re-mount"
// convention every other page's client.js on this dashboard already uses.
let activeDimension = 'classification';
let lastDataByDimension = {
  classification: null,
  marketSegment: null,
  referrer: null,
  contractName: null,
  service: null,
};

// Which group names are currently expanded, PER DIMENSION -- by request
// ("each minimized and expand only if required") -- a Set of group names,
// reset whenever that dimension's own data is freshly loaded (a stale name
// from a previous load could otherwise "expand" a same-named group that
// happens to still exist, which is actually fine/harmless, but cleared
// anyway for a predictable "everything starts collapsed on a fresh load"
// experience). Survives a tab switch and back, same "stay how you left it"
// convention this dashboard already follows elsewhere.
let expandedByDimension = {
  classification: new Set(),
  marketSegment: new Set(),
  referrer: new Set(),
  contractName: new Set(),
  service: new Set(),
};

let activeRender = null;

// "Show Inactive Clients" checkbox, default unticked -- module scope so it
// survives a re-mount like activeDimension does. Toggling it clears every
// dimension's cached data, since each was loaded under the old setting.
let showInactive = false;

const TABS = [
  { key: 'classification', label: 'By Classification' },
  { key: 'marketSegment', label: 'By Market Segment' },
  { key: 'referrer', label: 'By Referrer' },
  { key: 'contractName', label: 'By Contract Name' },
  { key: 'service', label: 'By Service' },
];

// Local re-implementation of @dashboard/autotask-client's own parseWildcard()/
// matchesWildcard() -- that module is server-only (Node), so the exact same
// leading/trailing "*" convention is duplicated here for CLIENT-SIDE
// filtering, same "small shared logic copied rather than shared across a
// browser/server boundary" convention this dashboard already follows
// elsewhere (e.g. meeting-prep-report-render.js/report-widgets.js's own
// duplicated donutSvg()). An empty term matches everything -- this is what
// makes "leave it blank to retrieve all" work, not a separate code path.
function matchesWildcard(value, term) {
  const t = (term || '').trim();
  if (!t) return true;
  const v = (value || '').toLowerCase();
  const startsWithStar = t.startsWith('*');
  const endsWithStar = t.endsWith('*') && t.length > 1;
  const needle = t.replace(/^\*/, '').replace(/\*$/, '').toLowerCase();
  if (!needle) return true;
  if (endsWithStar && !startsWithStar) return v.startsWith(needle);
  if (startsWithStar && !endsWithStar) return v.endsWith(needle);
  return v.includes(needle);
}

export function mount(container) {
  container.classList.add('classification-summary-page');
  container.innerHTML = `
    <header class="page-header">
      <h1>Clients by Classification</h1>
      <button type="button" id="refresh-button" class="button-link button-link--small">Refresh</button>
    </header>
    <div id="dimension-tabs" class="rmmf-tabs rmmf-tabs--primary"></div>
    <div class="date-form">
      <label for="search-input">Search (wildcard, e.g. "Tech*" -- blank for all)</label>
      <input type="text" id="search-input" placeholder="Leave blank for all" autocomplete="off" />
      <label class="inline-checkbox-label">
        <input type="checkbox" id="show-inactive-input" /> Show Inactive Clients
      </label>
    </div>
    <p id="status" class="status">Loading...</p>
    <div id="summary" class="summary" hidden></div>
    <div id="results" class="results"></div>
  `;

  const refreshButton = container.querySelector('#refresh-button');
  const dimensionTabsEl = container.querySelector('#dimension-tabs');
  const searchInput = container.querySelector('#search-input');
  const showInactiveInput = container.querySelector('#show-inactive-input');
  showInactiveInput.checked = showInactive;
  const statusEl = container.querySelector('#status');
  const summaryEl = container.querySelector('#summary');
  const resultsEl = container.querySelector('#results');

  function renderTabs() {
    dimensionTabsEl.innerHTML = TABS.map(
      (t) => `<button type="button" class="rmmf-tab${t.key === activeDimension ? ' rmmf-tab--active' : ''}" data-dimension="${t.key}">${escapeHtml(t.label)}</button>`
    ).join('');
    dimensionTabsEl.querySelectorAll('.rmmf-tab').forEach((btn) => {
      btn.addEventListener('click', () => switchDimension(btn.dataset.dimension));
    });
  }

  function switchDimension(dimension) {
    if (dimension === activeDimension) return;
    activeDimension = dimension;
    searchInput.value = '';
    renderTabs();
    const cached = lastDataByDimension[activeDimension];
    if (cached) render(cached);
    else load();
  }

  // Live client-side filtering, by request ("allow wildcard entry to limit
  // search or retrieve all") -- every group for this dimension is already
  // in memory once loaded, so narrowing by a typed wildcard needs no extra
  // round trip; it just re-renders from the same cached data.
  searchInput.addEventListener('input', () => {
    const cached = lastDataByDimension[activeDimension];
    if (cached) render(cached);
  });

  showInactiveInput.addEventListener('change', () => {
    showInactive = showInactiveInput.checked;
    for (const key of Object.keys(lastDataByDimension)) lastDataByDimension[key] = null;
    load();
  });

  refreshButton.addEventListener('click', () => load(true));

  async function load(force) {
    refreshButton.disabled = true;
    statusEl.hidden = false;
    statusEl.className = force ? 'status loading' : 'status';
    statusEl.textContent = force ? 'Refreshing...' : 'Loading...';
    summaryEl.hidden = true;
    resultsEl.innerHTML = '';

    try {
      const res = await fetch(`/api/classification-summary?dimension=${encodeURIComponent(activeDimension)}${showInactive ? '&showInactive=true' : ''}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastDataByDimension[data.dimension] = data;
      expandedByDimension[data.dimension] = new Set();
      activeRender(data);
    } catch (err) {
      statusEl.hidden = false;
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      refreshButton.disabled = false;
    }
  }

  function render(data) {
    statusEl.hidden = true;
    const term = searchInput.value;
    const groups = data.groups.filter((g) => matchesWildcard(g.name, term));
    const expanded = expandedByDimension[data.dimension];

    summaryEl.hidden = false;
    summaryEl.innerHTML = `<strong>${data.totalCompanies}</strong> ${data.showInactive ? '' : 'active '}client${data.totalCompanies === 1 ? '' : 's'}${data.showInactive ? ' (including inactive)' : ''} across ${groups.length} group${groups.length === 1 ? '' : 's'}${term.trim() ? ` matching "${escapeHtml(term.trim())}"` : ''}`;

    if (groups.length === 0) {
      resultsEl.innerHTML = '<p class="status">No groups match.</p>';
      return;
    }

    resultsEl.innerHTML = '';
    for (const g of groups) {
      resultsEl.appendChild(groupEl(g, expanded));
    }
  }

  // Each group starts collapsed, by request ("each minimized and expand
  // only if required") -- same real .resource-group-header--toggle/
  // .toggle-arrow collapsible convention Check Client's own Datto device-
  // type breakdown (and Completed Tickets/Ticket Times' resource groups)
  // already use, reused here rather than invented fresh. The client list
  // is only rendered into the DOM once a group's actually expanded (cheap
  // either way at this scale, but avoids building table HTML for every
  // group up front on a dimension with many of them).
  function groupEl(group, expanded) {
    const wrap = document.createElement('div');
    wrap.className = 'resource-group';

    const isOpen = expanded.has(group.name);
    const header = document.createElement('div');
    header.className = 'resource-group-header resource-group-header--toggle';
    header.innerHTML = `<span><span class="toggle-arrow">${isOpen ? '▾' : '▸'}</span>${escapeHtml(group.name)}</span><span class="count">${group.count} client${group.count === 1 ? '' : 's'}</span>`;
    wrap.appendChild(header);

    const body = document.createElement('div');
    body.hidden = !isOpen;
    if (isOpen) body.innerHTML = clientsTableHtml(group.companies);
    wrap.appendChild(body);

    const arrow = header.querySelector('.toggle-arrow');
    header.addEventListener('click', () => {
      const nowOpen = body.hidden;
      body.hidden = !nowOpen;
      arrow.textContent = nowOpen ? '▾' : '▸';
      if (nowOpen) {
        expanded.add(group.name);
        if (!body.innerHTML) body.innerHTML = clientsTableHtml(group.companies);
      } else {
        expanded.delete(group.name);
      }
    });

    return wrap;
  }

  // Client Name, Classification, Market Segment, Primary Contact -- by
  // request, the SAME 4 columns on every tab regardless of which dimension
  // it's grouped by (so e.g. "By Classification" still shows each client's
  // own Classification column, even though that's also the grouping key).
  function clientsTableHtml(companies) {
    return `
      <table>
        <thead>
          <tr><th>Client Name</th><th>Classification</th><th>Market Segment</th><th>Primary Contact</th></tr>
        </thead>
        <tbody>
          ${companies
            .map(
              (c) => `
            <tr>
              <td>${companyLink(c)}${c.isActive === false ? ' <span class="muted">(inactive)</span>' : ''}</td>
              <td>${escapeHtml(c.classification)}</td>
              <td>${escapeHtml(c.marketSegment)}</td>
              <td>${escapeHtml(c.primaryContactName)}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
    `;
  }

  function companyLink(c) {
    const label = escapeHtml(c.companyName);
    if (!c.companyUrl) return label;
    // Real popup window, not just a new tab -- same convention every other
    // Autotask link on this dashboard uses.
    return `<a href="${escapeHtml(c.companyUrl)}" target="_blank" rel="noopener noreferrer" onclick="window.open(this.href, '_blank', 'noopener,noreferrer,width=1200,height=900'); return false;">${label}</a>`;
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // This mount is now the active one -- see activeRender's own comment
  // in other pages' client.js for the fuller "fixes a stale re-mount race"
  // reasoning.
  activeRender = render;

  renderTabs();
  const cached = lastDataByDimension[activeDimension];
  if (cached) render(cached);
  else load();
}
