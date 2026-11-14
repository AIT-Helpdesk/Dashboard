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

// Which of the three view buttons' own results are CURRENTLY on screen --
// 'unmatched' | 'udf-matches' | 'exact-match' | null (nothing run yet).
// By request: the dark-blue "active" look should follow whichever view is
// actually showing, not always sit on Show Unmatched just because it
// happens to be a plain <button> (this dashboard's own default solid-blue
// look) while the other two use the lighter .button-link--small pill.
let lastActiveView = null;

// One entry per "concept" this page checks -- by request, a page for
// "various data matching concepts" generally, not just this first one.
// Adding a second concept later means adding one more entry here, one more
// route in server.js, and one more render function below.
// `udfName` here is only for "Show UDF Matches" (see loadUdfMatches below)
// -- each report already carries its own `data.udfName` once loaded, this
// is just so the button works even before a Load (reading straight off
// whichever concept is currently selected in the dropdown).
// `hasReport`/`hasExactMatch` drive updateViewButtonsAvailability() below
// -- every one of these 5 has a real Unmatched report; only TPP has no
// "matched without a UDF" case (its own account-reference code never
// equals a real company name, see server.js's own comment on
// buildTppDomainsUnmatchedReport). The OTHER-UDF entries appended onto
// the end of this same array once /other-udf-concepts resolves (see
// mount() below) have neither -- there's no known external system to
// compare names against for a UDF this dashboard doesn't otherwise
// recognize, so only "Show UDF Matches" works for those.
const CONCEPT_OPTIONS = [
  { value: 'tpp-domains-unmatched', label: 'TPP Domains', udfName: 'Name:TPP', hasReport: true, hasExactMatch: false },
  { value: 'ingram-clients-unmatched', label: 'Ingram Client Names', udfName: 'Name:Ingram Micro', hasReport: true, hasExactMatch: true },
  { value: 'datto-sites-unmatched', label: 'Datto RMM Sites', udfName: 'Name:Datto RMM', hasReport: true, hasExactMatch: true },
  { value: 'saas-protection-clients-unmatched', label: 'SaaS Protection Clients', udfName: 'Name:SaaS Backups', hasReport: true, hasExactMatch: true },
  { value: 'microsoft365-clients-unmatched', label: 'Microsoft 365 (CSP) Clients', udfName: 'Name:Microsoft 365', hasReport: true, hasExactMatch: true },
];

// Set true the moment a GET /other-udf-concepts request is kicked off (not
// when it resolves) -- module-scope, survives a remount, so a quick
// navigate-away-and-back before the first request finishes can't kick off
// a second overlapping one that would double-push entries onto
// CONCEPT_OPTIONS above. Reset back to false on a genuine failure so a
// later remount gets to retry.
let extraConceptsFetched = false;

function findConceptMeta(value) {
  return CONCEPT_OPTIONS.find((o) => o.value === value) || null;
}

export function mount(container) {
  // Scopes this page's own .summary strong override below without
  // touching the shared dashboard-wide rule every other page relies on.
  container.classList.add('data-matching-page');
  container.innerHTML = `
    <header class="page-header">
      <form id="filter-form" class="date-form">
        <label for="concept-input">Data Match Check with Autotask</label>
        <select id="concept-input" name="concept">
          ${CONCEPT_OPTIONS.map((o) => `<option value="${o.value}">${o.label}</option>`).join('')}
        </select>
        <button type="submit" id="load-button" class="button-link button-link--small dm-view-btn">Unmatched</button>
        <button type="button" id="show-udf-matches-button" class="button-link button-link--small dm-view-btn">UDF Matches</button>
        <button type="button" id="show-matched-no-udf-button" class="button-link button-link--small dm-view-btn">Exact Match</button>
      </form>
      <h1>Data Matching</h1>
    </header>
    <p id="status" class="status">Pick a check, then click Unmatched.</p>
    <div id="summary" class="summary" hidden></div>
    <div id="results" class="results"></div>
  `;

  const form = container.querySelector('#filter-form');
  const conceptInput = container.querySelector('#concept-input');
  const loadButton = container.querySelector('#load-button');
  const showUdfMatchesButton = container.querySelector('#show-udf-matches-button');
  const showMatchedNoUdfButton = container.querySelector('#show-matched-no-udf-button');
  const statusEl = container.querySelector('#status');
  const summaryEl = container.querySelector('#summary');
  const resultsEl = container.querySelector('#results');

  conceptInput.value = lastConcept;

  const VIEW_BUTTON_BY_NAME = { 'unmatched': loadButton, 'udf-matches': showUdfMatchesButton, 'exact-match': showMatchedNoUdfButton };

  // Dark-blue "active" look follows whichever view actually succeeded in
  // loading, not any particular button -- called after every successful
  // load() / loadUdfMatches() / loadMatchedWithoutUdf() below, and once at
  // mount to restore it (only ever 'unmatched', see the comment on the
  // mount-time render() call near the bottom of this function -- UDF
  // Matches/Exact Match views aren't themselves cached across remounts,
  // only the plain unmatched report is).
  function setActiveView(view) {
    lastActiveView = view;
    for (const [name, btn] of Object.entries(VIEW_BUTTON_BY_NAME)) {
      btn.classList.toggle('dm-view-btn--active', name === view);
    }
  }

  // Unmatched/Exact Match both need a real report builder behind them
  // (see each concept's own hasReport/hasExactMatch above) -- greyed out
  // with an explanatory tooltip whenever the selected concept has neither,
  // re-checked on every dropdown change rather than just once at mount.
  // Show UDF Matches needs neither -- GET /udf-matches works for any
  // udfName -- so it's never disabled here.
  function updateViewButtonsAvailability() {
    const meta = findConceptMeta(conceptInput.value);
    const hasReport = meta ? !!meta.hasReport : true;
    const hasExactMatch = meta ? !!meta.hasExactMatch : true;
    loadButton.disabled = !hasReport;
    loadButton.title = hasReport ? '' : "This UDF has no Unmatched report of its own -- there's no known external system to compare it against, so only Show UDF Matches works here.";
    showMatchedNoUdfButton.disabled = !hasExactMatch;
    showMatchedNoUdfButton.title = hasExactMatch
      ? ''
      : !hasReport
        ? "This UDF has no Exact Match report of its own -- there's no known external system to compare it against, so only Show UDF Matches works here."
        : "TPP matches only via its own UDF -- there's no \"matched without a UDF\" case for this concept.";
  }
  updateViewButtonsAvailability();
  conceptInput.addEventListener('change', updateViewButtonsAvailability);

  // "Include any UDF Name:{thing} types in the list at the bottom as
  // well" -- any Companies UDF named "Name:*" that doesn't already have
  // one of the 5 concepts above (see server.js's own KNOWN_NAME_UDFS),
  // most likely one created by hand in Autotask after this dashboard was
  // last updated to know its specific name. Appended as plain <option>s
  // (not a full re-render of the <select>, which would lose whatever's
  // currently picked) once this resolves; CONCEPT_OPTIONS itself gets the
  // same entries pushed on so every other lookup in this file
  // (findConceptMeta(), loadUdfMatches()'s own CONCEPT_OPTIONS.find())
  // just works for them with no separate list to keep in sync.
  if (!extraConceptsFetched) {
    extraConceptsFetched = true;
    fetch('/api/data-matching/other-udf-concepts')
      .then((res) => res.json())
      .then((data) => {
        for (const c of data.concepts || []) {
          const option = { value: c.udfName, label: c.label, udfName: c.udfName, hasReport: false, hasExactMatch: false };
          CONCEPT_OPTIONS.push(option);
          conceptInput.appendChild(new Option(option.label, option.value));
        }
      })
      .catch((err) => {
        console.error('Data Matching: failed to load other UDF concepts:', err);
        extraConceptsFetched = false;
      });
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    load(conceptInput.value);
  });

  showUdfMatchesButton.addEventListener('click', () => loadUdfMatches(conceptInput.value));
  showMatchedNoUdfButton.addEventListener('click', () => loadMatchedWithoutUdf(conceptInput.value));

  async function load(concept) {
    // Defensive only -- the button itself is disabled/greyed out for this
    // case (updateViewButtonsAvailability() above), but guard here too in
    // case something else ever calls this directly.
    if (!findConceptMeta(concept)?.hasReport) {
      statusEl.hidden = false;
      statusEl.className = 'status error';
      statusEl.textContent = "This UDF has no Unmatched report of its own -- use Show UDF Matches to see what's already set.";
      return;
    }
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
      setActiveView('unmatched');
    } catch (err) {
      statusEl.hidden = false;
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      loadButton.disabled = false;
    }
  }

  // "Exact Match" -- by request, the OTHER thing every
  // unmatched report has always silently dropped: items whose name already
  // exactly equals an Autotask company's name outright, so no UDF was ever
  // needed to identify the match (see server.js's own matchedWithoutUdf on
  // each report -- the same `continue` branch that used to just discard
  // these now also records them). Not available for TPP (see
  // updateMatchedNoUdfButtonState above). Reuses the SAME cached report
  // endpoint "Show Unmatched" already hits, since matchedWithoutUdf now
  // rides along in that one response -- no separate route needed.
  async function loadMatchedWithoutUdf(concept) {
    // Defensive only -- see the same comment on load() above.
    if (!findConceptMeta(concept)?.hasExactMatch) return;
    showMatchedNoUdfButton.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = 'Loading...';
    summaryEl.hidden = true;
    resultsEl.innerHTML = '';

    try {
      const res = await fetch(`/api/data-matching/${concept}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      renderMatchedWithoutUdf(data);
      setActiveView('exact-match');
    } catch (err) {
      statusEl.hidden = false;
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      showMatchedNoUdfButton.disabled = !findConceptMeta(conceptInput.value)?.hasExactMatch;
    }
  }

  // Per-concept display columns for the matched-without-UDF table --
  // deliberately the SAME column shape each concept's own unmatched table
  // already uses (see the inline column arrays inside render() below), just
  // read directly off each matchedWithoutUdf row instead of an unmatched
  // row, plus one more "Matched Autotask Company" column every concept
  // shares since that's the whole point of this list.
  function matchedWithoutUdfColumns(concept) {
    if (concept === 'ingram-clients-unmatched') {
      return [
        { label: 'Ingram Client', cell: (r) => escapeHtml(r.clientName) },
        { label: 'Active Subscriptions', className: 'ticket-number', cell: (r) => r.activeSubscriptionCount },
      ];
    }
    if (concept === 'datto-sites-unmatched') {
      return [
        { label: 'Datto Site', cell: (r) => escapeHtml(r.siteName) },
        { label: 'Devices', className: 'ticket-number', cell: (r) => r.deviceCount },
      ];
    }
    if (concept === 'saas-protection-clients-unmatched') {
      return [
        { label: 'SaaS Protection Client', cell: (r) => escapeHtml(r.clientName) },
        { label: 'Seats Used', className: 'ticket-number', cell: (r) => (r.seatsUsed === null ? '' : r.seatsUsed) },
      ];
    }
    if (concept === 'microsoft365-clients-unmatched') {
      return [
        { label: 'CSP Tenant', cell: (r) => escapeHtml(r.clientName) },
        { label: 'Tenant ID', className: 'ticket-number', cell: (r) => escapeHtml(r.tenantId || '') },
      ];
    }
    return null; // TPP -- never reached, loadMatchedWithoutUdf() returns early for it above
  }

  function renderMatchedWithoutUdf(data) {
    statusEl.hidden = true;
    summaryEl.hidden = false;
    const rows = data.matchedWithoutUdf || [];
    const count = data.matchedWithoutUdfCount ?? rows.length;
    summaryEl.innerHTML = `<div><strong>${count}</strong> item${count === 1 ? '' : 's'} already matching an Autotask company by name -- no UDF needed<span class="inline-subtext"> -- as of ${formatDateTime(data.asOf)}</span></div>`;
    resultsEl.innerHTML = '';

    const columns = matchedWithoutUdfColumns(data.concept);
    if (!columns || rows.length === 0) {
      resultsEl.innerHTML = `<p class="status">No items currently match an Autotask company by name alone.</p>`;
      return;
    }

    const groupEl = document.createElement('div');
    groupEl.className = 'resource-group';
    const table = document.createElement('table');
    const headerCells = columns.map((c) => `<th>${escapeHtml(c.label)}</th>`).join('') + '<th>Matched Autotask Company</th>';
    table.innerHTML = `
      <thead><tr>${headerCells}</tr></thead>
      <tbody>
        ${rows
          .map(
            (r) => `
          <tr>
            ${columns.map((c) => `<td${c.className ? ` class="${c.className}"` : ''}>${c.cell(r)}</td>`).join('')}
            <td>${escapeHtml(r.companyName)}</td>
          </tr>`
          )
          .join('')}
      </tbody>
    `;
    groupEl.appendChild(table);
    resultsEl.appendChild(groupEl);
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
      setActiveView('udf-matches');
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
      // Red instead of blue, with the current UDF content on hover, when
      // the suggested company already has a value in this concept's own
      // UDF -- by request, so picking a suggestion that's already taken
      // (which the server's own already-set guard above would refuse
      // anyway) is visible BEFORE clicking it, not just after.
      suggestionsEl.innerHTML = `
        <span class="inline-subtext">Possible matches:</span>
        ${list
          .map((s, i) => {
            const taken = !!s.udfValue;
            const title = taken ? `Already set to "${s.udfValue}"` : '';
            return `<button type="button" class="button-link button-link--small dm-suggestion-chip${taken ? ' dm-suggestion-chip--taken' : ''}" data-i="${i}" title="${escapeHtml(title)}">${escapeHtml(s.companyName)}</button>`;
          })
          .join('')}
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

  // Mirrors the restore logic above: a remount only ever re-renders the
  // plain unmatched report (UDF Matches/Exact Match views have no cache of
  // their own to restore from), so that's the only view the highlight can
  // correctly claim here -- 'udf-matches'/'exact-match' would be wrong if
  // the page was last showing one of those before navigating away. Nothing
  // cached at all (a genuinely fresh session) leaves `lastActiveView` at
  // its initial `null`, so setActiveView(null) below just clears every
  // button back to the plain light-blue look, per request ("if nothing has
  // run yet leave them all as the light blue").
  if (lastDataByConcept[lastConcept]) {
    render(lastDataByConcept[lastConcept]);
    setActiveView('unmatched');
  } else {
    setActiveView(lastActiveView);
  }

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
