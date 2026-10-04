export const id = "db-schema";
export const label = "Database Schema";

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>Database Schema</h1>
    </header>
    <div class="resource-group dbs-picker">
      <div class="dbs-picker-row">
        <label for="db-select">Database</label>
        <select id="db-select">
          <option value="">Select a database...</option>
        </select>
      </div>
      <p id="db-cache-note" class="inline-subtext dbs-cache-note"></p>
    </div>
    <p id="status" class="status">Loading database list...</p>
    <div id="schema-results"></div>
  `;

  const selectEl = container.querySelector('#db-select');
  const cacheNoteEl = container.querySelector('#db-cache-note');
  const statusEl = container.querySelector('#status');
  const resultsEl = container.querySelector('#schema-results');
  // The currently-selected database's id -- Show Data buttons (wired
  // after every renderSchema() call) read this to know which database
  // their own /tables/:table/rows request should hit.
  let currentDbId = null;

  loadDatabaseList();

  async function loadDatabaseList() {
    try {
      const data = await fetchJson('/api/db-schema/databases');
      renderDatabaseOptions(data.databases);
      renderCacheNote(data.scannedAt);
      statusEl.hidden = true;
      resultsEl.innerHTML = '<p class="status">Select a database above to view its schema.</p>';
    } catch (err) {
      statusEl.className = 'status error';
      statusEl.textContent = `Error loading database list: ${err.message}`;
    }
  }

  // Grouped by package (<optgroup> per package), by request -- one pass
  // over the already-sorted (packageDir, then relativePath) flat list
  // from the server, opening a new optgroup each time packageDir
  // changes rather than building a separate grouped structure first.
  // Labeled by relativePath (path relative to the PACKAGE folder, e.g.
  // "data/reports.db"), not the full id (relative to packages/ itself,
  // e.g. "contract-checks/data/reports.db") -- by request, so the
  // package name (already the optgroup's own label) isn't repeated
  // inside every option too.
  function renderDatabaseOptions(databases) {
    const parts = ['<option value="">Select a database...</option>'];
    let currentGroup = null;
    for (const db of databases) {
      if (db.packageDir !== currentGroup) {
        if (currentGroup !== null) parts.push('</optgroup>');
        parts.push(`<optgroup label="${escapeHtml(db.packageDir)}">`);
        currentGroup = db.packageDir;
      }
      parts.push(`<option value="${escapeHtml(db.id)}">${escapeHtml(db.relativePath)}</option>`);
    }
    if (currentGroup !== null) parts.push('</optgroup>');
    selectEl.innerHTML = parts.join('');
  }

  // Viewer's own local time zone, by request -- a plain toLocaleString()
  // on the server's ISO timestamp, deliberately NOT this dashboard's
  // usual AEST-pinned formatting (that convention is for THIS business's
  // own operational data -- shift times, ticket dates -- where every
  // real viewer is in the same office; a cache-scan timestamp has no
  // such assumption built in, and the request specifically said "the
  // viewer's local time zone").
  function renderCacheNote(scannedAtIso) {
    const when = scannedAtIso ? new Date(scannedAtIso).toLocaleString() : 'unknown';
    cacheNoteEl.textContent = `Database list is cached for 10 minutes. Last scanned: ${when}. New databases may take up to 10 minutes to appear.`;
  }

  selectEl.addEventListener('change', () => {
    const dbId = selectEl.value;
    currentDbId = dbId || null;
    if (!dbId) {
      resultsEl.innerHTML = '<p class="status">Select a database above to view its schema.</p>';
      return;
    }
    loadSchema(dbId);
  });

  // Lazy-load, by request ("Only when a database is selected, fetch and
  // display its schema") -- nothing is extracted up front for every
  // database the scan found, just the one picked. Never cached client or
  // server-side ("Schema results are not cached; always read fresh on
  // selection") -- every selection, including re-picking the SAME
  // database again, is a fresh fetch.
  async function loadSchema(dbId) {
    resultsEl.innerHTML = '<p class="status">Loading schema...</p>';
    try {
      const data = await fetchJson(`/api/db-schema/databases/${encodeURIComponent(dbId)}/schema`);
      renderSchema(data);
    } catch (err) {
      resultsEl.innerHTML = `<p class="status error">Error loading schema: ${escapeHtml(err.message)}</p>`;
    }
  }

  function renderSchema(data) {
    if (data.tables.length === 0 && data.views.length === 0) {
      resultsEl.innerHTML = '<p class="status">This database has no tables or views.</p>';
      return;
    }
    resultsEl.innerHTML = `
      ${data.tables.map(tableHtml).join('')}
      ${data.views.length ? `<div class="section-heading section-heading--nav">Views (${data.views.length})</div>${data.views.map(viewHtml).join('')}` : ''}
    `;
    wireShowDataButtons();
  }

  // Lazy-load, by request ("a show data button for each table") -- row
  // data for a table is only ever fetched the moment its own Show Data
  // button is actually clicked, never up front alongside the schema.
  // Toggles Show/Hide without re-fetching on repeat clicks of the SAME
  // table, same convention Check Client's own "Show Users" button
  // already uses; picking a different database and coming back still
  // means a genuinely fresh fetch, since each table's dataset lives in
  // its own freshly-rendered <div>, discarded with the rest of the old
  // schema markup.
  function wireShowDataButtons() {
    resultsEl.querySelectorAll('.dbs-show-data-button').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const tableName = btn.dataset.table;
        const dataEl = btn.parentElement.querySelector('.dbs-table-data');
        if (dataEl.dataset.loaded === '1') {
          const hidden = dataEl.hidden;
          dataEl.hidden = !hidden;
          btn.textContent = hidden ? 'Hide Data' : 'Show Data';
          return;
        }
        btn.disabled = true;
        dataEl.hidden = false;
        dataEl.innerHTML = '<p class="status">Loading data...</p>';
        try {
          const result = await fetchJson(`/api/db-schema/databases/${encodeURIComponent(currentDbId)}/tables/${encodeURIComponent(tableName)}/rows`);
          dataEl.innerHTML = rowDataHtml(result);
          dataEl.dataset.loaded = '1';
          btn.textContent = 'Hide Data';
        } catch (err) {
          dataEl.innerHTML = `<p class="status error">Error loading data: ${escapeHtml(err.message)}</p>`;
        } finally {
          btn.disabled = false;
        }
      });
    });
  }

  function rowDataHtml(result) {
    if (result.rows.length === 0) return '<p class="status">This table has no rows.</p>';
    const columns = Object.keys(result.rows[0]);
    const note =
      result.totalCount > result.rows.length
        ? `<p class="inline-subtext dbs-row-count-note">Showing first ${result.rows.length} of ${result.totalCount} rows.</p>`
        : `<p class="inline-subtext dbs-row-count-note">${result.rows.length} row${result.rows.length === 1 ? '' : 's'}.</p>`;
    return `
      ${note}
      <div class="dbs-row-data-scroll">
        <table class="dbs-columns-table">
          <thead>
            <tr class="shaded-row">${columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr>
          </thead>
          <tbody>
            ${result.rows
              .map(
                (row) =>
                  `<tr>${columns.map((c) => `<td>${row[c] === null || row[c] === undefined ? '<span class="inline-subtext">NULL</span>' : escapeHtml(String(row[c]))}</td>`).join('')}</tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  // One collapsible card per table -- native <details>/<summary>, same
  // "no JS state to manage, collapsed by default costs nothing" reasoning
  // Meeting Prep's own detailsBlock() already uses elsewhere on this
  // dashboard, just with its own dbs- prefixed classes here rather than
  // that page's mtg- ones.
  function tableHtml(table) {
    const pkNames = new Set(table.columns.filter((c) => c.primaryKey).map((c) => c.name));
    const columnsHtml = `
      <table class="dbs-columns-table">
        <thead>
          <tr class="shaded-row"><th>Column</th><th>Type</th><th>Not Null</th><th>Default</th><th>Primary Key</th></tr>
        </thead>
        <tbody>
          ${table.columns
            .map(
              (c) => `
            <tr>
              <td>${escapeHtml(c.name)}</td>
              <td>${escapeHtml(c.type || '')}</td>
              <td>${c.notNull ? 'Yes' : ''}</td>
              <td>${c.defaultValue === null || c.defaultValue === undefined ? '' : escapeHtml(String(c.defaultValue))}</td>
              <td>${pkNames.has(c.name) ? 'Yes' : ''}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
    `;
    const fkHtml = table.foreignKeys.length
      ? `
        <div class="dbs-subsection-heading">Foreign Keys</div>
        <ul class="dbs-plain-list">
          ${table.foreignKeys.map((fk) => `<li>${escapeHtml(fk.from)} &rarr; ${escapeHtml(fk.table)}(${escapeHtml(fk.to)})${fk.onDelete && fk.onDelete !== 'NO ACTION' ? ` <span class="inline-subtext">ON DELETE ${escapeHtml(fk.onDelete)}</span>` : ''}</li>`).join('')}
        </ul>`
      : '';
    const indexHtml = table.indexes.length
      ? `
        <div class="dbs-subsection-heading">Indexes</div>
        <ul class="dbs-plain-list">
          ${table.indexes.map((idx) => `<li>${escapeHtml(idx.name)}${idx.unique ? ' <span class="inline-subtext">(unique)</span>' : ''} -- ${escapeHtml(idx.columns.join(', '))}</li>`).join('')}
        </ul>`
      : '';
    return `
      <details class="dbs-table-details resource-group">
        <summary>${escapeHtml(table.name)} <span class="inline-subtext">(${table.columns.length} column${table.columns.length === 1 ? '' : 's'})</span></summary>
        <div class="dbs-table-body">
          ${columnsHtml}
          ${fkHtml}
          ${indexHtml}
          <div class="dbs-show-data-row">
            <button type="button" class="link-button dbs-show-data-button" data-table="${escapeHtml(table.name)}">Show Data</button>
            <div class="dbs-table-data" hidden></div>
          </div>
        </div>
      </details>
    `;
  }

  function viewHtml(view) {
    return `
      <details class="dbs-table-details resource-group">
        <summary>${escapeHtml(view.name)}</summary>
        <div class="dbs-table-body">
          <pre class="dbs-view-sql">${escapeHtml(view.sql || '')}</pre>
        </div>
      </details>
    `;
  }

  async function fetchJson(url) {
    const res = await fetch(url);
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
    return data;
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
