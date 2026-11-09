export const id = "at-status";
export const label = "AT Status";

// Module-scope, not inside mount() -- see Clients by Classification's own
// client.js for why (the shell tears down/re-mounts the DOM on every nav,
// but this module stays alive for the session).
let lastData = null;
let activeRender = null;

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>AT Status</h1>
      <div class="date-form">
        <label for="active-filter">Active?</label>
        <select id="active-filter">
          <option value="yes" selected>Yes</option>
          <option value="no">No</option>
          <option value="all">All</option>
        </select>
        <button type="button" id="refresh-button">Refresh</button>
      </div>
    </header>
    <p id="status" class="status">Loading...</p>
    <p id="summary" class="summary" hidden></p>
    <div id="results" class="results"></div>
  `;

  const refreshButton = container.querySelector('#refresh-button');
  const activeFilterEl = container.querySelector('#active-filter');
  const statusEl = container.querySelector('#status');
  const summaryEl = container.querySelector('#summary');
  const resultsEl = container.querySelector('#results');

  refreshButton.addEventListener('click', load);
  // Filters the already-loaded data in place -- no need to re-fetch from
  // Autotask just to change which rows are shown.
  activeFilterEl.addEventListener('change', () => {
    if (lastData) render(lastData);
  });

  async function load() {
    refreshButton.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = 'Loading...';
    summaryEl.hidden = true;
    resultsEl.innerHTML = '';

    try {
      const res = await fetch('/api/at-status');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastData = data;
      activeRender(data);
    } catch (err) {
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      refreshButton.disabled = false;
    }
  }

  function render(data) {
    statusEl.hidden = true;

    const allStatuses = [...data.statuses].sort((a, b) => a.value - b.value);
    const activeCount = allStatuses.filter((s) => s.isActive).length;
    const inactiveCount = allStatuses.length - activeCount;

    const filter = activeFilterEl.value; // 'yes' | 'no' | 'all'
    const statuses =
      filter === 'all' ? allStatuses : allStatuses.filter((s) => s.isActive === (filter === 'yes'));

    summaryEl.hidden = false;
    summaryEl.textContent =
      filter === 'all'
        ? `${allStatuses.length} ticket statuses (${activeCount} active, ${inactiveCount} inactive).`
        : `${statuses.length} of ${allStatuses.length} ticket statuses shown (Active? = ${filter === 'yes' ? 'Yes' : 'No'}).`;

    if (statuses.length === 0) {
      resultsEl.innerHTML = '<p class="status">No statuses match this filter.</p>';
      return;
    }

    resultsEl.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Status</th>
            <th>Active?</th>
            <th>Default?</th>
            <th>System?</th>
            <th>Sort Order</th>
          </tr>
        </thead>
        <tbody>
          ${statuses
            .map(
              (s) => `
            <tr${s.isActive ? '' : ' class="at-status-inactive-row"'}>
              <td>${s.value}</td>
              <td>${escapeHtml(s.label)}</td>
              <td>${s.isActive ? 'Yes' : 'No'}</td>
              <td>${s.isDefaultValue ? 'Yes' : ''}</td>
              <td>${s.isSystem ? 'Yes' : ''}</td>
              <td>${s.sortOrder ?? ''}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
    `;
  }

  activeRender = render;

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
