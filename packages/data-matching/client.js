export const id = "data-matching";
export const label = "Data Matching";

// Module-scope, not inside mount() -- same "survives a shell re-mount"
// convention every other page's client.js already uses (see
// @dashboard/subscriptions-expiring/client.js's own comment for the full
// reasoning).
let lastConcept = 'tpp-domains-unmatched';
let lastDataByConcept = {
  'tpp-domains-unmatched': null,
  'ingram-clients-unmatched': null,
  'datto-sites-unmatched': null,
  'saas-protection-clients-unmatched': null,
  'microsoft365-clients-unmatched': null,
};

// One entry per "concept" this page checks -- by request, a page for
// "various data matching concepts" generally, not just this first one.
// Adding a second concept later means adding one more entry here, one more
// route in server.js, and one more render function below.
// `udfName` here is only for "Show UDF Matches" (see loadUdfMatches below)
// -- each report already carries its own `data.udfName` once loaded, this
// is just so the button works even before a Load (reading straight off
// whichever concept is currently selected in the dropdown).
const CONCEPT_OPTIONS = [
  { value: 'tpp-domains-unmatched', label: 'TPP Domains (No Autotask Match)', udfName: 'Name:TPP' },
  { value: 'ingram-clients-unmatched', label: 'Ingram Client Names (No Autotask Match)', udfName: 'Name:Ingram Micro' },
  { value: 'datto-sites-unmatched', label: 'Datto RMM Sites (No Autotask Match)', udfName: 'Name:Datto RMM' },
  { value: 'saas-protection-clients-unmatched', label: 'SaaS Protection Clients (No Autotask Match)', udfName: 'Name:SaaS Backups' },
  { value: 'microsoft365-clients-unmatched', label: 'Microsoft 365 (CSP) Clients (No Autotask Match)', udfName: 'Name:Microsoft 365' },
];

export function mount(container) {
  // Scopes this page's own .summary strong override below without
  // touching the shared dashboard-wide rule every other page relies on.
  container.classList.add('data-matching-page');
  container.innerHTML = `
    <header class="page-header">
      <form id="filter-form" class="date-form">
        <label for="concept-input">Data Match Checker</label>
        <select id="concept-input" name="concept">
          ${CONCEPT_OPTIONS.map((o) => `<option value="${o.value}">${o.label}</option>`).join('')}
        </select>
        <button type="submit" id="load-button">Show Unmatched</button>
        <button type="button" id="show-udf-matches-button" class="button-link button-link--small">Show UDF Matches</button>
      </form>
      <h1>Data Matching</h1>
    </header>
    <p id="status" class="status">Pick a check, then click Show Unmatched.</p>
    <div id="summary" class="summary" hidden></div>
    <div id="results" class="results"></div>
  `;

  const form = container.querySelector('#filter-form');
  const conceptInput = container.querySelector('#concept-input');
  const loadButton = container.querySelector('#load-button');
  const showUdfMatchesButton = container.querySelector('#show-udf-matches-button');
  const statusEl = container.querySelector('#status');
  const summaryEl = container.querySelector('#summary');
  const resultsEl = container.querySelector('#results');

  conceptInput.value = lastConcept;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    load(conceptInput.value);
  });

  showUdfMatchesButton.addEventListener('click', () => loadUdfMatches(conceptInput.value));

  async function load(concept) {
    loadButton.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = 'Loading...';
    summaryEl.hidden = true;
    resultsEl.innerHTML = '';

    try {
      // Not forced -- the server caches each concept for 20 min, same
      // convention as Coming Soon, so a repeat Load is instant.
      const res = await fetch(`/api/data-matching/${concept}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastConcept = concept;
      lastDataByConcept[concept] = data;
      render(data);
    } catch (err) {
      statusEl.hidden = false;
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      loadButton.disabled = false;
    }
  }

  // "Show UDF Matches" -- by request, the reverse of this page's own
  // unmatched reports: every Autotask company that ALREADY has a value in
  // the currently-selected concept's own UDF, so an existing match can be
  // reviewed (and cleared, if wrong) rather than only ever seeing the gaps
  // still needing one. Reads straight off the dropdown's current selection
  // -- works even before a Load.
  async function loadUdfMatches(concept) {
    const option = CONCEPT_OPTIONS.find((o) => o.value === concept);
    if (!option) return;
    showUdfMatchesButton.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = 'Loading...';
    summaryEl.hidden = true;
    resultsEl.innerHTML = '';

    try {
      const res = await fetch(`/api/data-matching/udf-matches?udfName=${encodeURIComponent(option.udfName)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      renderUdfMatches(data.udfName, data.matches);
    } catch (err) {
      statusEl.hidden = false;
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      showUdfMatchesButton.disabled = false;
    }
  }

  // Clear only, never an edit, by request -- a wrong value is corrected by
  // clearing it here and re-matching it through the normal Update/
  // Possible-Match flow (which re-checks the UDF is blank first anyway),
  // not by typing over it directly here.
  function renderUdfMatches(udfName, matches) {
    statusEl.hidden = true;
    summaryEl.hidden = false;
    summaryEl.innerHTML = `${udfFieldLineHtml(udfName)}<div><strong>${matches.length}</strong> Autotask client${matches.length === 1 ? '' : 's'} currently matched</div>`;
    resultsEl.innerHTML = '';

    if (matches.length === 0) {
      resultsEl.innerHTML = `<p class="status">No Autotask companies currently have a value in ${escapeHtml(udfName)}.</p>`;
      return;
    }

    const groupEl = document.createElement('div');
    // Compact (shrink-to-content), by request -- same convention
    // @dashboard/dns-check's own .dns-check-compact-table uses, since this
    // table is just 3 narrow columns and no reason to stretch full width.
    groupEl.className = 'resource-group dm-compact-table';
    const table = document.createElement('table');
    // "UDF:TPP"/"UDF:Ingram Micro"/etc. for the column header, by request
    // -- display only, never sent anywhere; every real request (the Clear
    // button below, the confirm() prompt) still uses the real UDF name.
    const udfColumnLabel = udfName.replace(/^Name:/i, 'UDF:');
    table.innerHTML = `<thead><tr><th>Autotask Client</th><th>${escapeHtml(udfColumnLabel)}</th><th></th></tr></thead><tbody></tbody>`;
    const tbody = table.querySelector('tbody');

    for (const m of matches) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${escapeHtml(m.companyName)}</td><td>${escapeHtml(m.value)}</td>`;
      const actionTd = document.createElement('td');
      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'button-link button-link--small dm-udf-clear-btn';
      clearBtn.textContent = 'Clear';
      clearBtn.addEventListener('click', async () => {
        if (!confirm(`Clear ${udfName} on Autotask company "${m.companyName}" (currently "${m.value}")?`)) return;
        clearBtn.disabled = true;
        try {
          const res = await fetch('/api/data-matching/clear-udf-match', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ udfName, companyId: m.id }),
          });
          const result = await res.json();
          if (!res.ok) throw new Error(result.error || `Request failed (${res.status})`);
          tr.remove();
          const index = matches.indexOf(m);
          if (index !== -1) matches.splice(index, 1);
          summaryEl.querySelector('strong').textContent = matches.length;
          if (matches.length === 0) {
            resultsEl.innerHTML = `<p class="status">No Autotask companies currently have a value in ${escapeHtml(udfName)}.</p>`;
          }
        } catch (err) {
          alert(`Clear failed: ${err.message}`);
          clearBtn.disabled = false;
        }
      });
      actionTd.appendChild(clearBtn);
      tr.appendChild(actionTd);
      tbody.appendChild(tr);
    }

    groupEl.appendChild(table);
    resultsEl.appendChild(groupEl);
  }

  function render(data) {
    statusEl.hidden = true;
    resultsEl.innerHTML = '';

    if (data.concept === 'tpp-domains-unmatched') {
      renderSummary(data);
      if (data.byClient.length === 0) {
        resultsEl.innerHTML = `<p class="status">Nothing unmatched -- every active TPP domain's account reference has a Name:TPP match.</p>`;
        return;
      }
      for (const clientGroup of data.byClient) resultsEl.appendChild(clientGroupTable(data, clientGroup));
      return;
    }

    if (data.concept === 'ingram-clients-unmatched') {
      renderNameMismatchSection(
        data,
        'Ingram client',
        `every active Ingram Micro subscription's client name exactly matches an Autotask company`,
        [
          { label: 'Ingram Client', cell: (r) => escapeHtml(r.clientName) },
          { label: 'Active Subscriptions', className: 'ticket-number', cell: (r) => r.activeSubscriptionCount },
        ],
        {
          endpoint: '/api/data-matching/match-ingram-client',
          udfName: data.udfName,
          extraBodyFor: (r) => ({ clientName: r.clientName }),
          writeValueLabelFor: (r) => r.clientName,
          rowKeyFor: (r) => r.clientName,
        }
      );
      return;
    }

    if (data.concept === 'datto-sites-unmatched') {
      if (data.configured === false) {
        summaryEl.hidden = true;
        resultsEl.innerHTML = `<p class="status">Datto RMM isn't configured on this dashboard.</p>`;
        return;
      }
      renderNameMismatchSection(
        data,
        'Datto RMM site',
        `every Datto RMM site's name exactly matches an Autotask company`,
        [
          { label: 'Datto Site', cell: (r) => escapeHtml(r.siteName) },
          { label: 'Devices', className: 'ticket-number', cell: (r) => r.deviceCount },
        ],
        {
          endpoint: '/api/data-matching/match-datto-site',
          udfName: data.udfName,
          extraBodyFor: (r) => ({ siteName: r.siteName }),
          writeValueLabelFor: (r) => r.siteName,
          rowKeyFor: (r) => r.siteName,
        }
      );
      return;
    }

    if (data.concept === 'saas-protection-clients-unmatched') {
      renderNameMismatchSection(
        data,
        'SaaS Protection client',
        `every Datto SaaS Protection client's name exactly matches an Autotask company`,
        [
          { label: 'SaaS Protection Client', cell: (r) => escapeHtml(r.clientName) },
          { label: 'Seats Used', className: 'ticket-number', cell: (r) => (r.seatsUsed === null ? '' : r.seatsUsed) },
        ],
        {
          endpoint: '/api/data-matching/match-saas-protection-client',
          udfName: data.udfName,
          extraBodyFor: (r) => ({ clientName: r.clientName }),
          writeValueLabelFor: (r) => r.clientName,
          rowKeyFor: (r) => r.clientName,
        }
      );
      return;
    }

    if (data.concept === 'microsoft365-clients-unmatched') {
      renderNameMismatchSection(
        data,
        'Microsoft 365 (CSP) client',
        `every Microsoft CSP tenant's name exactly matches an Autotask company`,
        [
          { label: 'CSP Tenant', cell: (r) => escapeHtml(r.clientName) },
          { label: 'Tenant ID', className: 'ticket-number', cell: (r) => escapeHtml(r.tenantId || '') },
        ],
        {
          endpoint: '/api/data-matching/match-microsoft365-client',
          udfName: data.udfName,
          extraBodyFor: (r) => ({ clientName: r.clientName }),
          writeValueLabelFor: (r) => r.clientName,
          rowKeyFor: (r) => r.clientName,
        }
      );
    }
  }

  // "UDF Field Name:X", shown above the item-count line, by request -- so
  // it's always obvious which Autotask UDF a concept is checking/writing
  // before reading the count underneath it. Omitted entirely when a concept
  // has no UDF of its own (Datto RMM, until "Name:Datto RMM" exists).
  function udfFieldLineHtml(udfName) {
    if (!udfName) return '';
    return `<div class="dm-udf-label">UDF Field ${escapeHtml(udfName)}</div>`;
  }

  function renderSummary(data) {
    summaryEl.hidden = false;
    summaryEl.innerHTML = `${udfFieldLineHtml(data.udfName)}<div><strong>${data.totalCount}</strong> unmatched domain${data.totalCount === 1 ? '' : 's'} across ${data.byClient.length} TPP client${data.byClient.length === 1 ? '' : 's'}<span class="inline-subtext"> -- as of ${formatDateTime(data.asOf)}</span></div>`;
  }

  // Shared summary + "Show Ignored Lines" toggle + table for Ingram Client
  // Names / Datto RMM Sites. A row's own `ignored` flag (see server.js --
  // Ingram's "Ambient iT - W365 (...)" internal naming convention, Datto's
  // own " - On Demand" suffix) means it's never actually a real unmatched
  // gap worth chasing, so it's hidden by default -- but still shown on
  // request (unticked by default, by request: "on pages/searches where we
  // ignore lines have a tick box ... default to unticked") rather than
  // dropped outright, so nothing's silently invisible. `data.totalCount`
  // (the headline number) only ever counts non-ignored rows; the checkbox's
  // own label carries the ignored count separately.
  function renderNameMismatchSection(data, itemLabel, nothingUnmatchedText, columns, matchConfig) {
    summaryEl.hidden = false;
    summaryEl.innerHTML = `${udfFieldLineHtml(data.udfName)}<div><strong>${data.totalCount}</strong> ${itemLabel}${data.totalCount === 1 ? '' : 's'} not matching an Autotask company exactly<span class="inline-subtext"> -- as of ${formatDateTime(data.asOf)}</span></div>`;

    const ignoredCount = data.ignoredCount || 0;
    if (data.totalCount === 0 && ignoredCount === 0) {
      resultsEl.innerHTML = `<p class="status">Nothing unmatched -- ${nothingUnmatchedText}.</p>`;
      return;
    }

    resultsEl.innerHTML = '';
    let showIgnored = false;

    if (ignoredCount > 0) {
      const toggleLabel = document.createElement('label');
      toggleLabel.className = 'inline-checkbox-label dm-show-ignored-label';
      toggleLabel.innerHTML = `<input type="checkbox" class="dm-show-ignored-input" /> Show Ignored Lines (${ignoredCount})`;
      resultsEl.appendChild(toggleLabel);
      toggleLabel.querySelector('.dm-show-ignored-input').addEventListener('change', (e) => {
        showIgnored = e.target.checked;
        renderTable();
      });
    }

    const tableContainer = document.createElement('div');
    resultsEl.appendChild(tableContainer);

    function renderTable() {
      tableContainer.innerHTML = '';
      const visibleRows = showIgnored ? data.rows : data.rows.filter((r) => !r.ignored);
      if (visibleRows.length === 0) {
        tableContainer.innerHTML = `<p class="status">Nothing unmatched -- ${nothingUnmatchedText}.</p>`;
        return;
      }
      tableContainer.appendChild(nameMismatchTable(data, visibleRows, columns, matchConfig));
    }
    renderTable();
  }

  // `rows` is whatever subset renderNameMismatchSection above decided to
  // show (ignored rows included or not) -- `columns` picks what each one
  // shows about itself; `matchConfig` (present for both concepts now that
  // each has a real UDF -- see server.js) adds one more column with a full
  // match widget (possible-match buttons + a free-text fallback), same
  // write-with-confirm interaction as TPP's own group header, just once per
  // ROW instead of once per group. An ignored row gets no widget at all --
  // there's nothing real to match it against.
  function nameMismatchTable(data, rows, columns, matchConfig) {
    const groupEl = document.createElement('div');
    groupEl.className = 'resource-group';
    const table = document.createElement('table');
    const headerCells = columns.map((c) => `<th>${escapeHtml(c.label)}</th>`).join('') + (matchConfig ? '<th>Possible Autotask Matches</th>' : '');
    table.innerHTML = `<thead><tr>${headerCells}</tr></thead><tbody></tbody>`;
    const tbody = table.querySelector('tbody');

    function buildRow(row) {
      const tr = document.createElement('tr');
      tr.innerHTML = columns.map((c) => `<td${c.className ? ` class="${c.className}"` : ''}>${c.cell(row)}</td>`).join('');
      if (matchConfig) {
        const matchCell = document.createElement('td');
        if (row.ignored) {
          matchCell.innerHTML = '<span class="inline-subtext">Ignored</span>';
        } else {
          const widget = buildMatchWidget({
            endpoint: matchConfig.endpoint,
            extraBody: matchConfig.extraBodyFor(row),
            udfName: matchConfig.udfName,
            writeValueLabel: matchConfig.writeValueLabelFor(row),
            suggestions: row.suggestions,
            onSuccess: () => {
              tr.remove();
              removeMatchedRow(data, matchConfig.rowKeyFor(row));
            },
          });
          // Suggestions + the free-text input/Update button on one flowing
          // row, by request -- the input used to always drop to its own
          // line below the suggestion chips, even when there was plenty of
          // room beside them.
          const matchRow = document.createElement('div');
          matchRow.className = 'dm-match-row';
          matchRow.appendChild(widget.suggestionsEl);
          matchRow.appendChild(widget.controlEl);
          matchCell.appendChild(matchRow);
          matchCell.appendChild(widget.statusEl);
        }
        tr.appendChild(matchCell);
      }
      tbody.appendChild(tr);
    }

    rows.forEach(buildRow);
    groupEl.appendChild(table);
    return groupEl;
  }

  // A row just got matched (its write succeeded) -- drops it out of the
  // in-memory `data.rows` (so revisiting this concept without a fresh Load
  // doesn't show it again) and refreshes the count line in place (the row
  // itself was already removed from the DOM by the caller).
  function removeMatchedRow(data, rowKey) {
    const keyField = data.concept === 'datto-sites-unmatched' ? 'siteName' : 'clientName';
    const index = data.rows.findIndex((r) => r[keyField] === rowKey);
    if (index === -1) return;
    data.rows.splice(index, 1);
    data.totalCount -= 1;
    summaryEl.querySelector('strong').textContent = data.totalCount;
  }

  // Shared "write this match into Autotask" widget -- one free-text input +
  // Update button, plus (when there's upfront fuzzy-match data -- Ingram and
  // Datto rows always have it; TPP's own group has none, there's no real
  // name to fuzzy-match its short account-reference code against) a set of
  // "Possible Match" buttons, one per suggestion, that write directly on
  // click. By request: EVERY write -- whichever button triggers it --
  // confirms with the person first, naming exactly what's about to be
  // written and where. The server's own already-set-UDF guard (see
  // writeNameMatchUdf in server.js) is what actually prevents overwriting a
  // real value; this widget just surfaces whatever it says.
  function buildMatchWidget({ endpoint, extraBody, udfName, writeValueLabel, suggestions, onSuccess }) {
    const controlEl = document.createElement('span');
    controlEl.className = 'dm-match-control';
    controlEl.innerHTML = `
      <input type="text" class="dm-match-input" placeholder="Exact Autotask client name" autocomplete="off" title="Must exactly match the Autotask company name -- no partial match." />
      <button type="button" class="button-link button-link--small dm-match-button">Update</button>
    `;
    const input = controlEl.querySelector('.dm-match-input');
    const matchButton = controlEl.querySelector('.dm-match-button');

    const suggestionsEl = document.createElement('div');
    suggestionsEl.className = 'dm-match-suggestions';

    const statusEl = document.createElement('p');
    statusEl.className = 'status dm-match-status';
    statusEl.hidden = true;

    function setBusy(busy) {
      matchButton.disabled = busy;
      input.disabled = busy;
      suggestionsEl.querySelectorAll('button').forEach((b) => (b.disabled = busy));
    }

    // `undefined`/`null` (TPP's own group -- nothing fuzzy-matched yet,
    // since nothing's been tried) renders nothing at all; a real (possibly
    // empty) array (every row on Ingram/Datto, or TPP after a failed
    // attempt) renders either the suggestion buttons or an explicit "no
    // close match" note, so it's clear a check actually ran.
    function renderSuggestions(list) {
      if (list === undefined || list === null) {
        suggestionsEl.hidden = true;
        suggestionsEl.innerHTML = '';
        return;
      }
      suggestionsEl.hidden = false;
      if (list.length === 0) {
        suggestionsEl.innerHTML = '<span class="inline-subtext">No close match found</span>';
        return;
      }
      suggestionsEl.innerHTML = `
        <span class="inline-subtext">Possible matches:</span>
        ${list.map((s, i) => `<button type="button" class="button-link button-link--small dm-suggestion-chip" data-i="${i}">${escapeHtml(s.companyName)}</button>`).join('')}
      `;
      suggestionsEl.querySelectorAll('.dm-suggestion-chip').forEach((btn, i) => {
        btn.addEventListener('click', () => doWrite(list[i].companyName));
      });
    }
    renderSuggestions(suggestions);

    async function doWrite(companyName) {
      const trimmed = (companyName || '').trim();
      if (!trimmed) {
        statusEl.hidden = false;
        statusEl.className = 'status error dm-match-status';
        statusEl.textContent = 'Enter an Autotask client name first.';
        return;
      }
      if (!confirm(`Write "${writeValueLabel}" into ${udfName} on Autotask company "${trimmed}"?`)) return;

      setBusy(true);
      statusEl.hidden = false;
      statusEl.className = 'status loading dm-match-status';
      statusEl.textContent = 'Updating...';

      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...extraBody, companyName: trimmed }),
        });
        const result = await res.json();
        if (!res.ok) {
          statusEl.className = 'status error dm-match-status';
          statusEl.textContent = result.error || `Request failed (${res.status})`;
          renderSuggestions(result.suggestions);
          setBusy(false);
          return;
        }
        onSuccess(result);
      } catch (err) {
        statusEl.className = 'status error dm-match-status';
        statusEl.textContent = err.message;
        setBusy(false);
      }
    }

    matchButton.addEventListener('click', () => doWrite(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        doWrite(input.value);
      }
    });

    return { controlEl, suggestionsEl, statusEl };
  }

  // A group just got matched (its "Update" button succeeded) -- drops it
  // out of the in-memory `data` (so revisiting this concept without a
  // fresh Load doesn't show it again) and refreshes the summary line/empty
  // state in place, without re-fetching.
  function removeMatchedGroup(data, accountReference) {
    const index = data.byClient.findIndex((g) => g.accountReference === accountReference);
    if (index === -1) return;
    data.totalCount -= data.byClient[index].count;
    data.byClient.splice(index, 1);
    renderSummary(data);
    if (data.byClient.length === 0) {
      resultsEl.innerHTML = `<p class="status">Nothing unmatched -- every active TPP domain's account reference has a Name:TPP match.</p>`;
    }
  }

  // Grouped by TPP Client -- by request, so each client's own account
  // reference appears once (as the group header), with its domains listed
  // underneath. Same "resource-group" per-client convention
  // @dashboard/ingram-subscriptions already uses. No Autotask Client column
  // here -- every domain on this page is unmatched by definition, so the
  // group itself (its TPP Client code) IS the "not matched" information;
  // repeating that on every row/group would just be noise.
  //
  // The group header also carries the actual fix for that gap, by request:
  // a text field for the real Autotask client name + an Update button that
  // writes this TPP account reference into that company's "Name:TPP" UDF.
  // Only ever offered here because every group on this page is, by
  // definition, currently unmatched -- the server re-checks the UDF is
  // still blank right before writing (see server.js's own comment), so
  // this can never silently overwrite a real value.
  function clientGroupTable(data, clientGroup) {
    const groupEl = document.createElement('div');
    groupEl.className = 'resource-group';

    // No upfront `suggestions` -- unlike Ingram/Datto rows, there's no real
    // name to fuzzy-match a TPP account-reference CODE ("SHE-696") against;
    // suggestions only show up reactively, once a typed company name
    // actually fails to resolve (see buildMatchWidget's own renderSuggestions).
    const widget = buildMatchWidget({
      endpoint: '/api/data-matching/match-tpp-client',
      extraBody: { accountReference: clientGroup.accountReference },
      udfName: data.udfName,
      writeValueLabel: clientGroup.accountReference,
      suggestions: undefined,
      onSuccess: () => {
        groupEl.remove();
        removeMatchedGroup(data, clientGroup.accountReference);
      },
    });

    const header = document.createElement('div');
    header.className = 'resource-group-header';
    const titleSpan = document.createElement('span');
    titleSpan.className = 'resource-group-header-title';
    titleSpan.innerHTML = `
      <span>${escapeHtml(clientGroup.accountReference)}</span>
      <span class="count">${clientGroup.count} domain${clientGroup.count === 1 ? '' : 's'}</span>
    `;
    header.appendChild(titleSpan);
    header.appendChild(widget.controlEl);
    groupEl.appendChild(header);

    groupEl.appendChild(widget.suggestionsEl);
    groupEl.appendChild(widget.statusEl);

    const table = document.createElement('table');
    table.innerHTML = `
      <thead>
        <tr><th>Domain</th><th>Category</th><th>Expiry Date</th><th>Days</th><th>Auto-Renews</th></tr>
      </thead>
      <tbody>
        ${clientGroup.domains
          .map(
            (r) => `
          <tr>
            <td>${escapeHtml(r.domainName)}</td>
            <td>${r.category ? escapeHtml(r.category) : ''}</td>
            <td class="ticket-number">${formatDate(r.expiryDate)}</td>
            <td class="ticket-number">${formatDays(r.daysUntilExpiry)}</td>
            <td class="${r.autoRenew ? 'cell-flag-green' : 'cell-flag-red'}">${r.autoRenew ? 'Yes' : 'No'}</td>
          </tr>`
          )
          .join('')}
      </tbody>
    `;
    groupEl.appendChild(table);

    return groupEl;
  }

  if (lastDataByConcept[lastConcept]) render(lastDataByConcept[lastConcept]);

  function formatDate(isoDateOnly) {
    if (!isoDateOnly) return '';
    return new Date(`${isoDateOnly}T00:00:00.000Z`).toLocaleDateString(undefined, { timeZone: 'Australia/Brisbane' });
  }

  function formatDateTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString();
  }

  function formatDays(days) {
    if (days === null || days === undefined) return '';
    if (days === 0) return 'Today';
    if (days > 0) return `in ${days} day${days === 1 ? '' : 's'}`;
    return `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago`;
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
