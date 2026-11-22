export const id = "admin";
export const label = "Admin";

// Tabs look/behave like RMM Filter Checks' own top row, by request ("tabs
// like RMM Filter Checks has") -- same .rmmf-tabs/.rmmf-tab classes (the
// "real browser tab" look), reused rather than a new tab system, same
// convention @dashboard/tc-elite-services' own client.js already follows
// for an identical one-row tab strip.

let lastData = null; // module-scope, survives the shell's teardown/re-mount, same convention every other page here uses
let activeTabIndex = 0;

export function mount(container) {
  container.innerHTML = `
    <div class="admin-page">
      <header class="page-header">
        <h1>Admin</h1>
        <div class="date-form">
          <button type="button" id="refresh-button">Refresh</button>
        </div>
      </header>
      <p id="status" class="status">Loading...</p>
      <div id="as-of" class="inline-subtext" hidden></div>
      <div id="tabs" class="rmmf-tabs rmmf-tabs--primary" hidden></div>
      <div id="results"></div>
    </div>
  `;

  const refreshButton = container.querySelector('#refresh-button');
  const statusEl = container.querySelector('#status');
  const asOfEl = container.querySelector('#as-of');
  const tabsEl = container.querySelector('#tabs');
  const resultsEl = container.querySelector('#results');

  refreshButton.addEventListener('click', () => load());

  if (lastData) render(lastData);
  else load();

  async function load() {
    refreshButton.disabled = true;
    resultsEl.innerHTML = '';
    try {
      const res = await fetch('/api/admin');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastData = data;
      render(data);
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
    asOfEl.hidden = false;
    asOfEl.textContent = `As of ${new Date(data.asOf).toLocaleString()}`;

    if (activeTabIndex >= data.tabs.length) activeTabIndex = 0;

    tabsEl.hidden = false;
    tabsEl.innerHTML = data.tabs
      .map((t, i) => `<button type="button" class="rmmf-tab${i === activeTabIndex ? ' rmmf-tab--active' : ''}" data-tab-index="${i}">${escapeHtml(t.label)} (${t.rows.length})</button>`)
      .join('');
    tabsEl.querySelectorAll('.rmmf-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeTabIndex = Number(btn.dataset.tabIndex);
        render(lastData);
      });
    });

    renderTab(data.tabs[activeTabIndex]);
  }

  function renderTab(tab) {
    resultsEl.innerHTML = '';
    if (!tab || tab.key === 'scheduled-tasks') {
      resultsEl.appendChild(renderScheduledTasksTable(tab ? tab.rows : []));
    } else if (tab.key === 'udf-name-mapping') {
      resultsEl.appendChild(renderUdfNameMappingTable(tab.rows));
    }
  }

  // UDF Name, System, Matches Field, Notes -- the documented set from
  // @dashboard/shell/udf-system-matches-db.js's own reference table
  // (server.js's own comment). A row with no systemLabel is a REAL live
  // "Name:*" UDF on Companies that isn't documented there yet -- flagged
  // in red rather than silently shown as if it were a normal row, since
  // it means that reference table needs a new entry added by hand.
  function renderUdfNameMappingTable(rows) {
    const wrap = document.createElement('div');
    wrap.className = 'resource-group';
    if (rows.length === 0) {
      wrap.innerHTML = '<p class="status" style="margin: 0.75rem;">No "Name:*" UDFs found on Companies.</p>';
      return wrap;
    }
    wrap.innerHTML = `
      <table>
        <thead><tr><th>UDF Name</th><th>System</th><th>Matches Field</th><th>Notes</th></tr></thead>
        <tbody>
          ${rows
            .map((r) =>
              r.documented
                ? `<tr>
                    <td>${escapeHtml(r.udfName)}</td>
                    <td>${escapeHtml(r.systemLabel || '')}</td>
                    <td>${escapeHtml(r.matchesField || '')}</td>
                    <td>${escapeHtml(r.notes || '')}</td>
                  </tr>`
                : `<tr>
                    <td>${escapeHtml(r.udfName)}</td>
                    <td colspan="3"><span class="cell-flag-red">Not yet documented -- add it to udf-system-matches-db.js's own SEED_ROWS</span></td>
                  </tr>`
            )
            .join('')}
        </tbody>
      </table>
    `;
    return wrap;
  }

  // Name and Schedule, by request -- State/Last run/Next run are shown as
  // hover detail on the row (title attribute), not their own columns, to
  // keep the table to exactly what was asked for.
  function renderScheduledTasksTable(rows) {
    const wrap = document.createElement('div');
    wrap.className = 'resource-group';
    if (rows.length === 0) {
      wrap.innerHTML = '<p class="status" style="margin: 0.75rem;">No scheduled tasks found (looked for "Ambient*").</p>';
      return wrap;
    }
    wrap.innerHTML = `
      <table>
        <thead><tr><th>Name</th><th>Schedule</th></tr></thead>
        <tbody>
          ${rows
            .map((r) => {
              const detail = [
                `State: ${r.state}`,
                r.lastRunTime ? `Last run: ${new Date(r.lastRunTime).toLocaleString()} (result ${r.lastTaskResult === 0 ? 'success' : r.lastTaskResult})` : 'Last run: never',
                r.nextRunTime ? `Next run: ${new Date(r.nextRunTime).toLocaleString()}` : null,
              ]
                .filter(Boolean)
                .join(' -- ');
              return `
            <tr title="${escapeHtml(detail)}">
              <td>${escapeHtml(r.name)}</td>
              <td>${escapeHtml(r.schedule)}</td>
            </tr>`;
            })
            .join('')}
        </tbody>
      </table>
    `;
    return wrap;
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
