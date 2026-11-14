export const id = "client-contacts";
export const label = "Client Contacts";

// Module-scope, not inside mount() -- the shell fully tears down and re-mounts a
// page's DOM on every navigation away and back, but the dynamically-imported
// module itself is cached by the browser and stays alive for the session, so a
// module-level variable survives across re-mounts and lets the last result
// restore instantly instead of coming back blank.
let lastQuery = null; // { contactType, client, contract, classification, showInactive }
let lastData = null;

// Which contacts the Resolve Duplicates modal has ticked for elimination
// from the mailing-list export (contactKey() values -- see below). Reset
// on every new search, same lifetime as lastData itself.
let eliminatedKeys = new Set();

// Whichever mount() is CURRENTLY on screen registers its own render()
// here. Fixes a real bug: load()'s render(data) call is a closure over
// THAT mount's own statusEl/resultsEl -- if you navigate away before a
// search resolves and come back before it actually finishes, the old
// mount's load() still runs to completion and would otherwise call its
// own (now detached, invisible) render(), so the currently-visible new
// mount never shows the result. Routing load()'s render call through this
// instead means whichever mount is actually visible always receives it.
let activeRender = null;

const CONTACT_TYPE_OPTIONS = [
  { value: "primary", label: "Primary contacts" },
  { value: "billing", label: "Main billing contacts" },
  { value: "both", label: "Both" },
  { value: "all", label: "All active contacts" },
];

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>Client Contacts</h1>
      <form id="filter-form" class="date-form date-form--stacked">
        <div class="clc-filter-grid">
          <div class="clc-filter-col">
            <div class="date-form-row">
              <label for="client-input">Client</label>
              <input type="text" id="client-input" name="client" placeholder="e.g. Cloud* or *IT*" />
            </div>
            <div class="date-form-row">
              <label for="contract-input">Contracts</label>
              <input type="text" id="contract-input" name="contract" placeholder="e.g. Tech Cover* or *Elite*" />
            </div>
            <div class="date-form-row">
              <label for="classification-input">Classification</label>
              <input type="text" id="classification-input" name="classification" placeholder="e.g. Tech* or *Elite*" />
            </div>
          </div>
          <div class="clc-filter-col">
            <div class="date-form-row">
              <label for="contact-type-input">Show</label>
              <select id="contact-type-input" name="contactType">
                ${CONTACT_TYPE_OPTIONS.map((o) => `<option value="${o.value}">${o.label}</option>`).join('')}
              </select>
            </div>
            <div class="date-form-row">
              <label class="inline-checkbox-label">
                <input type="checkbox" id="show-inactive-input" /> Show Inactive Clients
              </label>
            </div>
          </div>
        </div>
        <div class="date-form-row">
          <button type="submit" id="search-button" class="button-link button-link--small clc-resolve-dup-btn">Search</button>
          <button type="button" id="export-button" class="button-link button-link--small clc-resolve-dup-btn">Export CSV</button>
          <button type="button" id="resolve-duplicates-button" class="button-link button-link--small clc-resolve-dup-btn">Resolve Duplicates for Mailing List</button>
        </div>
      </form>
    </header>
    <p id="status" class="status">Pick which contacts to show, optionally filter by Client / Contracts / Classification (wildcards with *), then click Search. Inactive clients are excluded unless "Show Inactive Clients" is ticked.</p>
    <div id="summary" class="summary" hidden></div>
    <div id="results" class="results"></div>
  `;

  const form = container.querySelector('#filter-form');
  const clientInput = container.querySelector('#client-input');
  const contactTypeInput = container.querySelector('#contact-type-input');
  const contractInput = container.querySelector('#contract-input');
  const classificationInput = container.querySelector('#classification-input');
  const showInactiveInput = container.querySelector('#show-inactive-input');
  const searchButton = container.querySelector('#search-button');
  const exportButton = container.querySelector('#export-button');
  const resolveDuplicatesButton = container.querySelector('#resolve-duplicates-button');
  const statusEl = container.querySelector('#status');
  const summaryEl = container.querySelector('#summary');
  const resultsEl = container.querySelector('#results');

  if (lastQuery) {
    contactTypeInput.value = lastQuery.contactType;
    clientInput.value = lastQuery.client;
    contractInput.value = lastQuery.contract;
    classificationInput.value = lastQuery.classification;
    showInactiveInput.checked = lastQuery.showInactive;
  }

  // This mount is now the active one -- see activeRender's own comment
  // up top.
  activeRender = render;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    load(contactTypeInput.value, clientInput.value, contractInput.value, classificationInput.value, showInactiveInput.checked);
  });

  async function load(contactType, clientName, contractName, classification, showInactive) {
    searchButton.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = 'Loading...';
    summaryEl.hidden = true;
    resultsEl.innerHTML = '';

    try {
      const params = new URLSearchParams({ contactType });
      if (clientName) params.set('client', clientName);
      if (contractName) params.set('contract', contractName);
      if (classification) params.set('classification', classification);
      if (showInactive) params.set('showInactive', 'true');
      const res = await fetch(`/api/client-contacts?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastQuery = { contactType, client: clientName, contract: contractName, classification, showInactive };
      lastData = data;
      eliminatedKeys = new Set(); // fresh search -- forget any previous duplicate-resolution ticks
      activeRender(data);
    } catch (err) {
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      searchButton.disabled = false;
    }
  }

  exportButton.addEventListener('click', () => {
    if (!lastData || lastData.totalCount === 0) {
      statusEl.hidden = false;
      statusEl.className = 'status error';
      statusEl.textContent = 'Nothing to export -- run a search with results first.';
      return;
    }
    downloadCsv(lastData.contacts, lastData.contactType);
  });

  resolveDuplicatesButton.addEventListener('click', () => {
    if (!lastData || lastData.totalCount === 0) {
      statusEl.hidden = false;
      statusEl.className = 'status error';
      statusEl.textContent = 'Nothing to resolve -- run a search with results first.';
      return;
    }
    openDuplicatesModal();
  });

  const CSV_COLUMNS = [
    { header: 'Company Name', value: (c) => c.companyName },
    { header: 'First Name', value: (c) => c.firstName },
    { header: 'Last Name', value: (c) => c.lastName },
    { header: 'Email', value: (c) => c.email },
    { header: 'Phone', value: (c) => c.phone },
    { header: 'Mobile', value: (c) => c.mobilePhone },
  ];

  function csvField(value) {
    const str = value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  }

  function downloadCsv(contacts, filenameSuffix) {
    const lines = [CSV_COLUMNS.map((col) => csvField(col.header)).join(',')];
    for (const c of contacts) {
      lines.push(CSV_COLUMNS.map((col) => csvField(col.value(c))).join(','));
    }
    const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const today = new Date().toISOString().slice(0, 10);
    const a = document.createElement('a');
    a.href = url;
    a.download = `client-contacts-${filenameSuffix}-${today}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Identifies one contact row across renders/modals -- contactId (the
  // real Autotask Contacts.id) when the server supplied one, falling back
  // to a composite of displayed fields for older cached lastData that
  // predates contactId being added to the response.
  function contactKey(c) {
    return c.contactId !== null && c.contactId !== undefined
      ? `id:${c.contactId}`
      : `fallback:${c.companyId}|${c.firstName}|${c.lastName}|${c.email}`;
  }

  // First Name + Last Name, trimmed/case-insensitive -- the identity a
  // "duplicate incident" is grouped on.
  function nameKey(c) {
    return `${(c.firstName || '').trim().toLowerCase()}|${(c.lastName || '').trim().toLowerCase()}`;
  }

  // Groups the current result set by nameKey() and returns only the
  // groups with more than one contact, each group's own contacts sorted
  // next to each other -- the "duplicate incidents" the Resolve
  // Duplicates modal lists. A contact with no name at all can't usefully
  // be grouped, so it's skipped rather than lumped into one giant "blank"
  // group.
  function findDuplicateGroups(contacts) {
    const groups = new Map();
    for (const c of contacts) {
      const key = nameKey(c);
      if (key === '|') continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    return [...groups.values()]
      .filter((g) => g.length > 1)
      .sort((a, b) => `${a[0].firstName} ${a[0].lastName}`.localeCompare(`${b[0].firstName} ${b[0].lastName}`));
  }

  // Resolve Duplicates for Mailing List -- one compact list (not a table
  // per name) of every First Name/Last Name duplicate in the current
  // results, each row with a checkbox ("tick to leave this one out of the
  // mailing-list export"). Exporting from here takes every contact in the
  // full result set EXCEPT whichever lines got ticked -- unique (non-
  // duplicate) contacts pass straight through since they never had a row
  // here to tick.
  function openDuplicatesModal() {
    // Flat array, not grouped sub-arrays -- findDuplicateGroups() still
    // does the grouping/sorting, this just flattens its output into one
    // ordered list for the single compact table below.
    let rows = findDuplicateGroups(lastData.contacts).flat();

    // Per-column filter text, by request -- display-only (narrows which of
    // `rows` renderRows() shows), never touches `rows`/eliminatedKeys/the
    // export itself, so typing a filter can't accidentally change what
    // gets exported or un-tick/re-tick anything.
    const filters = { company: '', firstName: '', lastName: '', email: '' };

    const overlay = document.createElement('div');
    overlay.className = 'history-modal-overlay';
    overlay.innerHTML = `
      <div class="history-modal-panel clc-dup-modal-panel">
        <div class="history-modal-panel-header">
          <span>Resolve Duplicates for Mailing List</span>
          <button type="button" class="history-modal-close" aria-label="Close">✕</button>
        </div>
        <div class="history-modal-body">
          <p class="inline-subtext">Tick a line to leave it out of the mailing list export -- everything left unticked is included, duplicates and all.</p>
          <div class="clc-dup-filter-row">
            <input type="text" class="clc-dup-filter-input" data-filter="firstName" placeholder="Filter First Name..." />
            <input type="text" class="clc-dup-filter-input" data-filter="lastName" placeholder="Filter Last Name..." />
            <input type="text" class="clc-dup-filter-input" data-filter="company" placeholder="Filter Company Name..." />
            <input type="text" class="clc-dup-filter-input" data-filter="email" placeholder="Filter Email..." />
          </div>
          <div class="clc-dup-list-wrap"></div>
          <div class="clc-dup-modal-footer">
            <button type="button" class="button-link clc-dup-export-button">Export Mailing List CSV</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const listWrapEl = overlay.querySelector('.clc-dup-list-wrap');

    overlay.querySelectorAll('.clc-dup-filter-input').forEach((input) => {
      input.addEventListener('input', () => {
        filters[input.dataset.filter] = input.value.trim().toLowerCase();
        renderRows();
      });
    });

    function matchesFilters(c) {
      if (filters.firstName && !(c.firstName || '').toLowerCase().includes(filters.firstName)) return false;
      if (filters.lastName && !(c.lastName || '').toLowerCase().includes(filters.lastName)) return false;
      if (filters.company && !(c.companyName || '').toLowerCase().includes(filters.company)) return false;
      if (filters.email && !(c.email || '').toLowerCase().includes(filters.email)) return false;
      return true;
    }

    function renderRows() {
      if (rows.length === 0) {
        listWrapEl.innerHTML = '<p class="status">No duplicate First Name / Last Name combinations left in the current results.</p>';
        return;
      }
      const visibleRows = rows.filter(matchesFilters);
      if (visibleRows.length === 0) {
        listWrapEl.innerHTML = '<p class="status">No rows match the current filters.</p>';
        return;
      }
      listWrapEl.innerHTML = `
        <table class="clc-dup-table">
          <thead>
            <tr><th>Eliminate</th><th>First Name</th><th>Last Name</th><th>Company Name</th><th>Email</th><th>Phone</th><th>Mobile</th></tr>
          </thead>
          <tbody>
            ${visibleRows
              .map((c, i) => {
                const key = contactKey(c);
                const checked = eliminatedKeys.has(key) ? 'checked' : '';
                // A new group starts wherever the name differs from the row
                // immediately above -- rows stay in the grouped/sorted order
                // findDuplicateGroups() produced, and filtering only ever
                // removes rows (never reorders them), so remaining same-
                // group rows are still adjacent in visibleRows -- a cheap,
                // always-correct way to tell groups apart visually without
                // tracking group membership separately.
                const isGroupStart = i === 0 || nameKey(visibleRows[i - 1]) !== nameKey(c);
                return `
              <tr class="${isGroupStart ? 'clc-dup-row--group-start' : ''}" data-key="${escapeHtml(key)}">
                <td><input type="checkbox" class="clc-dup-checkbox" title="Leave out of the mailing list export" ${checked} /></td>
                <td class="clc-dup-nowrap">${escapeHtml(c.firstName)}</td>
                <td class="clc-dup-nowrap">${escapeHtml(c.lastName)}</td>
                <td class="clc-dup-nowrap">${companyLink(c)}</td>
                <td>${escapeHtml(c.email)}</td>
                <td class="ticket-number">${escapeHtml(c.phone)}</td>
                <td class="ticket-number">${escapeHtml(c.mobilePhone)}</td>
              </tr>`;
              })
              .join('')}
          </tbody>
        </table>
      `;

      listWrapEl.querySelectorAll('.clc-dup-checkbox').forEach((cb) => {
        cb.addEventListener('change', () => {
          const key = cb.closest('tr').dataset.key;
          if (cb.checked) eliminatedKeys.add(key);
          else eliminatedKeys.delete(key);
        });
      });

    }

    renderRows();

    const close = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKeydown);
    };
    function onKeydown(e) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('keydown', onKeydown);
    overlay.querySelector('.history-modal-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    overlay.querySelector('.clc-dup-export-button').addEventListener('click', () => {
      const filtered = lastData.contacts.filter((c) => !eliminatedKeys.has(contactKey(c)));
      if (filtered.length === 0) {
        alert('Nothing to export -- every contact has been eliminated.');
        return;
      }
      downloadCsv(filtered, `${lastData.contactType}-mailing-list`);
      close();
    });
  }

  function render(data) {
    statusEl.hidden = true;

    summaryEl.hidden = false;
    const contactTypeLabel = CONTACT_TYPE_OPTIONS.find((o) => o.value === data.contactType)?.label || data.contactType;
    const filters = [];
    if (data.client) filters.push(`Client "${escapeHtml(data.client)}"`);
    if (data.contract) filters.push(`Contract "${escapeHtml(data.contract)}"`);
    if (data.classification) filters.push(`Classification "${escapeHtml(data.classification)}"`);
    const filterLabel = filters.length ? ` matching ${filters.join(' and ')}` : '';
    const inactiveLabel = data.showInactive ? ' (including inactive clients)' : '';
    summaryEl.innerHTML = `<strong>${data.totalCount}</strong> contact${data.totalCount === 1 ? '' : 's'} -- ${escapeHtml(contactTypeLabel)}${filterLabel}${inactiveLabel}`;

    if (data.totalCount === 0) {
      resultsEl.innerHTML = '<p class="status">No matching contacts.</p>';
      return;
    }

    const groupEl = document.createElement('div');
    groupEl.className = 'resource-group';

    const table = document.createElement('table');
    table.innerHTML = `
      <thead>
        <tr><th>Company Name</th><th>First Name</th><th>Last Name</th><th>Email</th><th>Phone</th><th>Mobile</th></tr>
      </thead>
      <tbody>
        ${data.contacts
          .map(
            (c) => `
          <tr>
            <td>${companyLink(c)}</td>
            <td>${escapeHtml(c.firstName)}</td>
            <td>${escapeHtml(c.lastName)}</td>
            <td>${escapeHtml(c.email)}</td>
            <td class="ticket-number">${escapeHtml(c.phone)}</td>
            <td class="ticket-number">${escapeHtml(c.mobilePhone)}</td>
          </tr>`
          )
          .join('')}
      </tbody>
    `;
    groupEl.appendChild(table);

    resultsEl.innerHTML = '';
    resultsEl.appendChild(groupEl);
  }

  if (lastData) render(lastData);

  function companyLink(c) {
    const label = escapeHtml(c.companyName);
    if (!c.companyUrl) return label;
    // Real popup window, not just a new tab -- same convention every other
    // Autotask/IT Glue link on this dashboard uses (explicit window.open
    // size features are what make browsers treat it as a window).
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
}
