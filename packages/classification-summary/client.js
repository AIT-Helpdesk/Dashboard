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

  function render(data) {
    statusEl.hidden = true;

    summaryEl.hidden = false;
    summaryEl.innerHTML = `<strong>${data.totalCount}</strong> active client${data.totalCount === 1 ? '' : 's'} across <strong>${data.groups.length}</strong> classification${data.groups.length === 1 ? '' : 's'}`;

    if (data.groups.length === 0) {
      resultsEl.innerHTML = '<p class="status">No active clients found.</p>';
      return;
    }

    const maxCount = Math.max(...data.groups.map((g) => g.count));

    const chart = document.createElement('div');
    chart.className = 'bar-chart';
    chart.innerHTML = data.groups
      .map(
        (g, i) => `
      <button type="button" class="bar-row" data-index="${i}" aria-expanded="false">
        <span class="bar-label">${escapeHtml(g.classification)}</span>
        <span class="bar-track"><span class="bar-fill" style="width: ${(g.count / maxCount) * 100}%"></span></span>
        <span class="bar-value">${g.count.toLocaleString()}</span>
      </button>`
      )
      .join('');

    resultsEl.innerHTML = '';
    resultsEl.appendChild(chart);

    chart.querySelectorAll('.bar-row').forEach((row) => {
      row.addEventListener('click', () => {
        const alreadyOpen = row.getAttribute('aria-expanded') === 'true';
        chart.querySelectorAll('.bar-row').forEach((r) => r.setAttribute('aria-expanded', 'false'));
        if (alreadyOpen) {
          drilldownEl.hidden = true;
          drilldownEl.innerHTML = '';
          return;
        }
        row.setAttribute('aria-expanded', 'true');
        const group = data.groups[Number(row.dataset.index)];
        renderDrilldown(group);
      });
    });
  }

  function renderDrilldown(group) {
    drilldownEl.hidden = false;
    drilldownEl.innerHTML = `
      <div class="resource-group-header">
        <span>${escapeHtml(group.classification)}</span>
        <span class="count">${group.count} client${group.count === 1 ? '' : 's'}</span>
      </div>
      <table>
        <thead>
          <tr><th>Company Name</th><th>State</th><th>Phone</th></tr>
        </thead>
        <tbody>
          ${group.companies
            .map(
              (c) => `
            <tr>
              <td>${companyLink(c)}</td>
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
