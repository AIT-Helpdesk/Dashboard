export const id = "m365-environment";
export const label = "M365 Environment";

// Module-scope, not inside mount() -- the shell fully tears down and re-mounts a
// page's DOM on every navigation away and back, but the dynamically-imported
// module itself is cached by the browser and stays alive for the session, so a
// module-level variable survives across re-mounts and lets the last result
// restore instantly instead of coming back blank.
let lastQuery = null; // { client }
let lastData = null;

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>M365 Environment</h1>
      <form id="filter-form" class="date-form">
        <label for="client-input">Client</label>
        <input type="text" id="client-input" name="client" placeholder="e.g. Redlands Sporting Club" required />
        <button type="submit" id="search-button">Search</button>
      </form>
    </header>
    <p id="status" class="status">Type a client name (wildcards with *) and click Search. Pulled from IT Glue's "MS365 Environment (auto)" asset -- a Microsoft 365 tenant snapshot synced in by an automation, not a live query against the tenant itself, so it reflects whenever IT Glue last synced, not necessarily right now.</p>
    <div id="results" class="results"></div>
  `;

  const form = container.querySelector('#filter-form');
  const clientInput = container.querySelector('#client-input');
  const searchButton = container.querySelector('#search-button');
  const statusEl = container.querySelector('#status');
  const resultsEl = container.querySelector('#results');

  if (lastQuery) clientInput.value = lastQuery.client;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    load(clientInput.value);
  });

  async function load(clientName, companyId) {
    searchButton.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = 'Loading...';
    resultsEl.innerHTML = '';

    try {
      const params = new URLSearchParams({ client: clientName });
      if (companyId) params.set('companyId', companyId);
      const res = await fetch(`/api/m365-environment?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastQuery = { client: clientName };
      lastData = data;
      if (data.status === 'ok') clientInput.value = data.companyName;
      render(data);
    } catch (err) {
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      searchButton.disabled = false;
    }
  }

  function render(data) {
    if (data.status === 'not-found') {
      statusEl.hidden = false;
      statusEl.className = 'status error';
      statusEl.textContent = `No client found matching "${data.client}".`;
      resultsEl.innerHTML = '';
      return;
    }
    if (data.status === 'ambiguous') {
      statusEl.hidden = false;
      statusEl.className = 'status';
      statusEl.textContent = `"${data.client}" matched ${data.matches.length} clients -- pick one:`;
      resultsEl.innerHTML = '';

      const list = document.createElement('div');
      list.className = 'resource-group';
      list.innerHTML = `
        <table>
          <tbody>
            ${data.matches
              .map((m) => `<tr><td><button type="button" class="link-button" data-company-id="${m.id}">${escapeHtml(m.companyName)}</button></td></tr>`)
              .join('')}
          </tbody>
        </table>
      `;
      list.querySelectorAll('button[data-company-id]').forEach((btn) => {
        btn.addEventListener('click', () => load(data.client, btn.dataset.companyId));
      });
      resultsEl.appendChild(list);
      return;
    }

    statusEl.hidden = true;
    resultsEl.innerHTML = '';

    const heading = document.createElement('div');
    heading.className = 'summary';
    heading.innerHTML = `<strong>${companyLink(data)}</strong>`;
    resultsEl.appendChild(heading);

    if (!data.itglueLinked) {
      resultsEl.insertAdjacentHTML('beforeend', '<p class="status">This client isn\'t linked to an IT Glue organization (no matching PSA sync record).</p>');
      return;
    }
    if (!data.hasM365Asset) {
      resultsEl.insertAdjacentHTML(
        'beforeend',
        `<p class="status">${data.error ? escapeHtml(data.error) : 'No "MS365 Environment (auto)" record found for this client in IT Glue.'}</p>`
      );
      return;
    }

    const infoWrap = document.createElement('div');
    infoWrap.className = 'resource-group';
    infoWrap.innerHTML = `
      <div class="resource-group-header">
        <span>${escapeHtml(data.tenantDisplayName || data.companyName)}${data.defaultDomainName ? ` -- ${escapeHtml(data.defaultDomainName)}` : ''}</span>
      </div>
      <p class="inline-subtext" style="margin: 0.5rem 0.75rem;">
        Synced into IT Glue ${formatDateTime(data.updatedAt)} --
        <a href="${escapeHtml(data.itglueResourceUrl)}" target="_blank" rel="noopener noreferrer" onclick="window.open(this.href, '_blank', 'noopener,noreferrer,width=1200,height=900'); return false;">View in IT Glue</a>
      </p>
    `;
    resultsEl.appendChild(infoWrap);

    resultsEl.appendChild(tableSection('Overview', data.overview, { vertical: true, compact: true }));
    resultsEl.appendChild(tableSection('Domains', data.domains, { compact: true }));
    resultsEl.appendChild(tableSection('Privileged Group Membership', data.privilegedGroupMembership));
    resultsEl.appendChild(tableSection('Licences', data.licences));
    resultsEl.appendChild(userLicenceAssignmentSection(data.userLicenceAssignment, data.itglueResourceUrl));
  }

  // User Licence Assignment gets its own renderer, not the generic
  // tableSection() below -- by request. Rewst truncates this specific
  // field to the first 10 (alphabetical) users and appends a plain-text
  // note pointing at a full-list attachment instead (parseTraitTable() in
  // server.js already extracts that note; see its own comment there for
  // the real example it was confirmed against). When that note is
  // present, the table it's attached to is genuinely partial -- showing
  // it as if it were the complete list would be misleading, so this shows
  // ONLY the heading plus a link straight to the IT Glue asset (where the
  // real attachment lives -- IT Glue's API doesn't expose a direct
  // attachment-file URL, so the asset's own resource-url is the closest
  // real link available) instead. No note means the table Rewst captured
  // genuinely is the complete list, so it renders normally, same as every
  // other section on this page.
  function userLicenceAssignmentSection(table, itglueResourceUrl) {
    const title = 'User Licence Assignment';
    const section = document.createElement('div');
    if (!table || !table.headers) {
      section.innerHTML = `<h2 class="client-summary-section-heading">${escapeHtml(title)}</h2><p class="status">No data.</p>`;
      return section;
    }
    section.innerHTML = `<h2 class="client-summary-section-heading">${escapeHtml(title)}</h2>`;

    const wrap = document.createElement('div');
    wrap.className = 'resource-group';

    if (table.note) {
      wrap.innerHTML = `
        <p class="inline-subtext" style="margin: 0.75rem;">
          ${escapeHtml(table.note)} --
          <a href="${escapeHtml(itglueResourceUrl)}" target="_blank" rel="noopener noreferrer" onclick="window.open(this.href, '_blank', 'noopener,noreferrer,width=1200,height=900'); return false;">View attachment in IT Glue</a>
        </p>
      `;
      section.appendChild(wrap);
      return section;
    }

    wrap.innerHTML = `
      <table>
        <thead>
          <tr class="shaded-row">${table.headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr>
        </thead>
        <tbody>
          ${table.rows.length === 0
            ? `<tr><td colspan="${table.headers.length}">None</td></tr>`
            : table.rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}
        </tbody>
      </table>
    `;
    section.appendChild(wrap);
    return section;
  }

  function tableSection(title, table, opts) {
    const { vertical = false, wide = false, compact = false } = opts || {};
    const section = document.createElement('div');
    if (!table || !table.headers) {
      section.innerHTML = `<h2 class="client-summary-section-heading">${escapeHtml(title)}</h2><p class="status">No data.</p>`;
      return section;
    }
    section.innerHTML = `<h2 class="client-summary-section-heading">${escapeHtml(title)}</h2>`;

    const wrap = document.createElement('div');
    // Overview and Domains are short, narrow tables (a handful of stats, or
    // a domain name + a Yes/No flag) -- by request, sized to their own
    // content instead of stretching to the full page width like every other
    // table on this dashboard does by default.
    wrap.className = compact ? 'resource-group m365-table-compact' : 'resource-group';

    // Overview's own source data is a single row of many columns (Total
    // Users, Total Enabled Users, ...) -- by request, shown as a vertical
    // Field/Value table (one label+value per row) instead of one wide row,
    // which reads better for a handful of headline stats. Every other
    // section here (Domains, Licences, etc.) genuinely has multiple rows,
    // so those stay in their natural horizontal shape.
    if (vertical) {
      wrap.innerHTML = `
        <table>
          <tbody>
            ${table.headers.map((h, i) => `<tr><td>${escapeHtml(h)}</td><td class="ticket-number">${escapeHtml(table.rows[0]?.[i] ?? '')}</td></tr>`).join('')}
          </tbody>
        </table>
        ${table.note ? `<p class="inline-subtext" style="margin: 0.5rem 0.75rem;">${escapeHtml(table.note)}</p>` : ''}
      `;
      section.appendChild(wrap);
      return section;
    }

    if (wide) wrap.style.overflowX = 'auto';
    wrap.innerHTML = `
      <table>
        <thead>
          <tr class="shaded-row">${table.headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr>
        </thead>
        <tbody>
          ${table.rows.length === 0
            ? `<tr><td colspan="${table.headers.length}">None</td></tr>`
            : table.rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}
        </tbody>
      </table>
      ${table.note ? `<p class="inline-subtext" style="margin: 0.5rem 0.75rem;">${escapeHtml(table.note)}</p>` : ''}
    `;
    section.appendChild(wrap);
    return section;
  }

  if (lastData) render(lastData);

  function companyLink(data) {
    const label = escapeHtml(data.companyName);
    if (!data.companyUrl) return label;
    // Real popup window, not just a new tab -- same convention every other
    // Autotask/IT Glue link on this dashboard uses.
    return `<a href="${escapeHtml(data.companyUrl)}" target="_blank" rel="noopener noreferrer" onclick="window.open(this.href, '_blank', 'noopener,noreferrer,width=1200,height=900'); return false;">${label}</a>`;
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
