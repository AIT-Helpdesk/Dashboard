export const id = "data-matching";
export const label = "Data Matching";

// Module-scope, not inside mount() -- same "survives a shell re-mount"
// convention every other page's client.js already uses (see
// @dashboard/subscriptions-expiring/client.js's own comment for the full
// reasoning).
let lastConcept = 'tpp-domains-unmatched';
let lastDataByConcept = { 'tpp-domains-unmatched': null, 'ingram-clients-unmatched': null, 'datto-sites-unmatched': null };

// One entry per "concept" this page checks -- by request, a page for
// "various data matching concepts" generally, not just this first one.
// Adding a second concept later means adding one more entry here, one more
// route in server.js, and one more render function below.
const CONCEPT_OPTIONS = [
  { value: 'tpp-domains-unmatched', label: 'TPP Domains Without an Autotask Match' },
  { value: 'ingram-clients-unmatched', label: 'Ingram Client Names Not Matching Autotask' },
  { value: 'datto-sites-unmatched', label: 'Datto RMM Sites Not Matching Autotask' },
];

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>Data Matching</h1>
      <form id="filter-form" class="date-form">
        <label for="concept-input">Check</label>
        <select id="concept-input" name="concept">
          ${CONCEPT_OPTIONS.map((o) => `<option value="${o.value}">${o.label}</option>`).join('')}
        </select>
        <button type="submit" id="load-button">Load</button>
      </form>
    </header>
    <p id="status" class="status">Pick a check, then click Load.</p>
    <div id="summary" class="summary" hidden></div>
    <div id="results" class="results"></div>
  `;

  const form = container.querySelector('#filter-form');
  const conceptInput = container.querySelector('#concept-input');
  const loadButton = container.querySelector('#load-button');
  const statusEl = container.querySelector('#status');
  const summaryEl = container.querySelector('#summary');
  const resultsEl = container.querySelector('#results');

  conceptInput.value = lastConcept;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    load(conceptInput.value);
  });

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
      summaryEl.hidden = false;
      summaryEl.innerHTML = `<strong>${data.totalCount}</strong> Ingram client${data.totalCount === 1 ? '' : 's'} not matching an Autotask company exactly<span class="inline-subtext"> -- as of ${formatDateTime(data.asOf)}</span>`;
      if (data.totalCount === 0) {
        resultsEl.innerHTML = `<p class="status">Nothing unmatched -- every active Ingram Micro subscription's client name exactly matches an Autotask company.</p>`;
        return;
      }
      resultsEl.appendChild(
        nameMismatchTable(data.rows, [
          { label: 'Ingram Client', cell: (r) => escapeHtml(r.clientName) },
          { label: 'Active Subscriptions', className: 'ticket-number', cell: (r) => r.activeSubscriptionCount },
          { label: 'Possible Matches', cell: (r) => suggestionsHtml(r.suggestions) },
        ])
      );
      return;
    }

    if (data.concept === 'datto-sites-unmatched') {
      if (data.configured === false) {
        summaryEl.hidden = true;
        resultsEl.innerHTML = `<p class="status">Datto RMM isn't configured on this dashboard.</p>`;
        return;
      }
      summaryEl.hidden = false;
      summaryEl.innerHTML = `<strong>${data.totalCount}</strong> Datto RMM site${data.totalCount === 1 ? '' : 's'} not matching an Autotask company exactly<span class="inline-subtext"> -- as of ${formatDateTime(data.asOf)}</span>`;
      if (data.totalCount === 0) {
        resultsEl.innerHTML = `<p class="status">Nothing unmatched -- every Datto RMM site's name exactly matches an Autotask company.</p>`;
        return;
      }
      resultsEl.appendChild(
        nameMismatchTable(data.rows, [
          { label: 'Datto Site', cell: (r) => escapeHtml(r.siteName) },
          { label: 'Devices', className: 'ticket-number', cell: (r) => r.deviceCount },
          { label: 'Possible Matches', cell: (r) => suggestionsHtml(r.suggestions) },
        ])
      );
    }
  }

  function renderSummary(data) {
    summaryEl.hidden = false;
    summaryEl.innerHTML = `<strong>${data.totalCount}</strong> unmatched domain${data.totalCount === 1 ? '' : 's'} across ${data.byClient.length} TPP client${data.byClient.length === 1 ? '' : 's'}<span class="inline-subtext"> -- as of ${formatDateTime(data.asOf)}</span>`;
  }

  // Shared plain-list rendering for Ingram Client Names / Datto RMM Sites
  // -- unlike TPP's own clientGroupTable() above, these two concepts are
  // read-only (no Update control, by request -- just "provide a list" for
  // both), so one simple `<table>` per concept is enough; `columns` picks
  // what each one actually shows.
  function nameMismatchTable(rows, columns) {
    const groupEl = document.createElement('div');
    groupEl.className = 'resource-group';
    const table = document.createElement('table');
    table.innerHTML = `
      <thead><tr>${columns.map((c) => `<th>${escapeHtml(c.label)}</th>`).join('')}</tr></thead>
      <tbody>
        ${rows
          .map((r) => `<tr>${columns.map((c) => `<td${c.className ? ` class="${c.className}"` : ''}>${c.cell(r)}</td>`).join('')}</tr>`)
          .join('')}
      </tbody>
    `;
    groupEl.appendChild(table);
    return groupEl;
  }

  // Plain muted text, not clickable chips -- unlike TPP's own
  // renderSuggestions() in clientGroupTable(), there's no input field here
  // to fill (no write action for these two concepts), so a suggestion is
  // just a hint for a human to go act on, not an interactive control.
  function suggestionsHtml(suggestions) {
    if (!suggestions || suggestions.length === 0) return '<span class="inline-subtext">No close match found</span>';
    return suggestions.map((s) => escapeHtml(s.companyName)).join(', ');
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

    const header = document.createElement('div');
    header.className = 'resource-group-header';
    header.innerHTML = `
      <span class="resource-group-header-title">
        <span>${escapeHtml(clientGroup.accountReference)}</span>
        <span class="count">${clientGroup.count} domain${clientGroup.count === 1 ? '' : 's'}</span>
      </span>
      <span class="dm-match-control">
        <input type="text" class="dm-match-input" placeholder="Exact Autotask client name" autocomplete="off" title="Must exactly match the Autotask company name -- no partial match." />
        <button type="button" class="button-link button-link--small dm-match-button">Update</button>
      </span>
    `;
    groupEl.appendChild(header);

    const statusLine = document.createElement('p');
    statusLine.className = 'status dm-match-status';
    statusLine.hidden = true;
    groupEl.appendChild(statusLine);

    // Fuzzy suggestions for a failed exact match -- by request, when the
    // typed name doesn't exactly match any real Autotask company (e.g.
    // "Cloudking" for the real "Cloud King Hosting"), the server's own
    // close-match guesses (see server.js's own findFuzzySuggestions) show
    // up here as clickable chips. Clicking one just fills the EXACT real
    // name into the input -- it does not auto-submit -- so the strict
    // exact-match write path is never bypassed; Update still has to be
    // clicked again to confirm.
    const suggestionsEl = document.createElement('div');
    suggestionsEl.className = 'dm-match-suggestions';
    suggestionsEl.hidden = true;
    groupEl.appendChild(suggestionsEl);

    function renderSuggestions(suggestions) {
      if (!suggestions || suggestions.length === 0) {
        suggestionsEl.hidden = true;
        suggestionsEl.innerHTML = '';
        return;
      }
      suggestionsEl.hidden = false;
      suggestionsEl.innerHTML = `
        <span class="inline-subtext">Did you mean:</span>
        ${suggestions.map((s) => `<button type="button" class="button-link button-link--small dm-suggestion-chip">${escapeHtml(s.companyName)}</button>`).join('')}
      `;
      suggestionsEl.querySelectorAll('.dm-suggestion-chip').forEach((btn, i) => {
        btn.addEventListener('click', () => {
          input.value = suggestions[i].companyName;
          input.focus();
          renderSuggestions(null);
        });
      });
    }

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

    const input = header.querySelector('.dm-match-input');
    const matchButton = header.querySelector('.dm-match-button');

    async function submitMatch() {
      const companyName = input.value.trim();
      if (!companyName) {
        statusLine.hidden = false;
        statusLine.className = 'status error dm-match-status';
        statusLine.textContent = 'Enter an Autotask client name first.';
        return;
      }
      matchButton.disabled = true;
      input.disabled = true;
      statusLine.hidden = false;
      statusLine.className = 'status loading dm-match-status';
      statusLine.textContent = 'Updating...';
      renderSuggestions(null);
      try {
        const res = await fetch('/api/data-matching/match-tpp-client', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accountReference: clientGroup.accountReference, companyName }),
        });
        const result = await res.json();
        if (!res.ok) {
          statusLine.className = 'status error dm-match-status';
          statusLine.textContent = result.error || `Request failed (${res.status})`;
          renderSuggestions(result.suggestions);
          matchButton.disabled = false;
          input.disabled = false;
          return;
        }
        groupEl.remove();
        removeMatchedGroup(data, clientGroup.accountReference);
      } catch (err) {
        matchButton.disabled = false;
        input.disabled = false;
        statusLine.className = 'status error dm-match-status';
        statusLine.textContent = err.message;
      }
    }

    matchButton.addEventListener('click', submitMatch);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitMatch();
      }
    });

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
