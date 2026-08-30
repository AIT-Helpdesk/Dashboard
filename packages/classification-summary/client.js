export const id = "classification-summary";
export const label = "Clients by Classification";

// Module-scope, not inside mount() -- the shell fully tears down and re-mounts a
// page's DOM on every navigation away and back, but the dynamically-imported
// module itself is cached by the browser and stays alive for the session, so a
// module-level variable survives across re-mounts and lets the last result
// restore instantly instead of coming back blank.
let lastData = null;

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>Clients by Classification</h1>
      <div class="date-form">
        <button type="button" id="refresh-button">Refresh</button>
      </div>
    </header>
    <p id="status" class="status">Loading...</p>
    <div id="summary" class="summary" hidden></div>
    <div id="results" class="results"></div>
    <div id="drilldown" class="resource-group" hidden></div>
  `;

  const refreshButton = container.querySelector('#refresh-button');
  const statusEl = container.querySelector('#status');
  const summaryEl = container.querySelector('#summary');
  const resultsEl = container.querySelector('#results');
  const drilldownEl = container.querySelector('#drilldown');

  refreshButton.addEventListener('click', load);

  async function load() {
    refreshButton.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = 'Loading...';
    summaryEl.hidden = true;
    resultsEl.innerHTML = '';
    drilldownEl.hidden = true;
    drilldownEl.innerHTML = '';

    try {
      const res = await fetch('/api/classification-summary');
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

  // Which (row, filter) the drilldown is currently showing, so a second
  // click on the exact same target closes it (same toggle behaviour as
  // before), while clicking a DIFFERENT segment on an already-open row
  // switches straight to that filter instead of needing a close-then-
  // reopen. filter is 'all' (the row's title was clicked) | 'no-parent' |
  // 'parent' (one of the bar's own two segments was clicked).
  let openKey = null;

  function render(data) {
    statusEl.hidden = true;

    summaryEl.hidden = false;
    summaryEl.innerHTML = `<strong>${data.totalCount}</strong> active client${data.totalCount === 1 ? '' : 's'} across <strong>${data.groups.length}</strong> classification${data.groups.length === 1 ? '' : 's'}`;

    if (data.groups.length === 0) {
      resultsEl.innerHTML = '<p class="status">No active clients found.</p>';
      return;
    }

    openKey = null;
    drilldownEl.hidden = true;
    drilldownEl.innerHTML = '';

    const maxCount = Math.max(...data.groups.map((g) => g.count));

    // Legend for the bar's own two colours -- by request, each classification's
    // bar is now a stack of two segments (no parent company / has a parent
    // company) on the one line, not a single solid colour.
    const legend = document.createElement('div');
    legend.className = 'chart-legend';
    legend.innerHTML = `
      <span class="legend-item"><span class="legend-swatch cs-legend-swatch--no-parent"></span>No parent company</span>
      <span class="legend-item"><span class="legend-swatch cs-legend-swatch--parent"></span>Has a parent company</span>
    `;

    const chart = document.createElement('div');
    chart.className = 'bar-chart';
    // By request: clicking a bar's own coloured segment shows only that
    // segment's clients (no-parent or has-parent); clicking anywhere else on
    // the row (its title, the count, the row's own padding) shows the whole
    // classification, same as before this change. .bar-row stays a plain
    // wrapper div, not a <button>, since it now needs to tell those two
    // cases apart via ONE delegated click listener below (checking where
    // within the row the click actually landed) rather than being one
    // single clickable thing itself; each segment is still its own real
    // <button> so it's individually focusable/keyboard-reachable and gets
    // its own hover/title tooltip. A zero-count segment is left out of the
    // markup entirely, rather than rendered as an unclickable sliver.
    chart.innerHTML = data.groups
      .map((g, i) => {
        const noParentPct = (g.noParentCount / maxCount) * 100;
        const parentPct = (g.parentCount / maxCount) * 100;
        // A visible 2px gap between the two segments, same convention
        // Security Alerts' own stacked weekly chart uses -- only when both
        // are actually present; a single-segment bar needs no gap.
        const gapStyle = g.noParentCount > 0 && g.parentCount > 0 ? ' margin-right: 2px' : '';
        const noParentSeg =
          g.noParentCount > 0
            ? `<button type="button" class="cs-bar-fill cs-bar-fill--no-parent" style="width: ${noParentPct}%;${gapStyle}" data-filter="no-parent" title="${g.noParentCount} with no parent company"></button>`
            : '';
        const parentSeg =
          g.parentCount > 0
            ? `<button type="button" class="cs-bar-fill cs-bar-fill--parent" style="width: ${parentPct}%" data-filter="parent" title="${g.parentCount} with a parent company"></button>`
            : '';
        return `
      <div class="bar-row" data-index="${i}" aria-expanded="false">
        <span class="bar-label">${escapeHtml(g.classification)}</span>
        <span class="bar-track">${noParentSeg}${parentSeg}</span>
        <span class="bar-value">${g.count.toLocaleString()}</span>
      </div>`;
      })
      .join('');

    resultsEl.innerHTML = '';
    resultsEl.appendChild(legend);
    resultsEl.appendChild(chart);

    chart.querySelectorAll('.bar-row').forEach((row) => {
      row.addEventListener('click', (e) => {
        const segment = e.target.closest('.cs-bar-fill');
        const filter = segment ? segment.dataset.filter : 'all';
        const index = Number(row.dataset.index);
        const key = `${index}:${filter}`;
        const alreadyOpen = openKey === key;
        chart.querySelectorAll('.bar-row').forEach((r) => r.setAttribute('aria-expanded', 'false'));
        if (alreadyOpen) {
          openKey = null;
          drilldownEl.hidden = true;
          drilldownEl.innerHTML = '';
          return;
        }
        openKey = key;
        row.setAttribute('aria-expanded', 'true');
        renderDrilldown(data.groups[index], filter);
      });
    });
  }

  function renderDrilldown(group, filter) {
    const companies =
      filter === 'no-parent'
        ? group.companies.filter((c) => !c.hasParent)
        : filter === 'parent'
          ? group.companies.filter((c) => c.hasParent)
          : group.companies;
    const filterSuffix = filter === 'no-parent' ? ' -- No Parent Company' : filter === 'parent' ? ' -- Has Parent Company' : '';
    // By request: the Parent Name column only makes sense when the list can
    // actually contain a parent-having client -- the row's own title (every
    // client) and the "Has Parent" segment both can; the "No Parent"
    // segment's own list never has one, so that column is left out there
    // rather than showing an always-empty column.
    const showParentColumn = filter === 'all' || filter === 'parent';

    drilldownEl.hidden = false;
    drilldownEl.innerHTML = `
      <div class="resource-group-header">
        <span>${escapeHtml(group.classification)}${escapeHtml(filterSuffix)}</span>
        <span class="count">${companies.length} client${companies.length === 1 ? '' : 's'}</span>
      </div>
      <table>
        <thead>
          <tr><th>Client</th>${showParentColumn ? '<th>Parent Name</th>' : ''}<th>State</th><th>Phone</th></tr>
        </thead>
        <tbody>
          ${companies
            .map(
              (c) => `
            <tr>
              <td>${companyLink(c)}</td>
              ${showParentColumn ? `<td>${escapeHtml(c.parentCompanyName)}</td>` : ''}
              <td>${escapeHtml(c.state)}</td>
              <td class="ticket-number">${escapeHtml(c.phone)}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
    `;
    drilldownEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function companyLink(c) {
    const label = escapeHtml(c.companyName);
    if (!c.companyUrl) return label;
    // Real popup window, not just a new tab -- same convention every other
    // Autotask/IT Glue link on this dashboard uses.
    return `<a href="${escapeHtml(c.companyUrl)}" target="_blank" rel="noopener noreferrer" onclick="window.open(this.href, '_blank', 'noopener,noreferrer,width=1200,height=900'); return false;">${label}</a>`;
  }

  if (lastData) {
    render(lastData);
  } else {
    load();
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
