export const id = "domain-itglue-gap";
export const label = "Domain / IT Glue Gaps";

// Module-scope, not inside mount() -- same "survives a shell re-mount"
// convention every other page's client.js already uses.
let lastData = null;

export function mount(container) {
  // Scopes the narrower-row/smaller-text table style below (styles.css)
  // without touching the shared dashboard-wide table default, same
  // "add a page-scoped class to the container" convention
  // @dashboard/data-matching's own client.js already uses.
  container.classList.add('domain-itglue-gap-page');
  container.innerHTML = `
    <header class="page-header">
      <h1>Domain / IT Glue Gaps</h1>
      <button type="button" id="refresh-button" class="button-link button-link--small">Refresh</button>
    </header>
    <p id="status" class="status">Loading...</p>
    <div id="last-run" class="inline-subtext" hidden></div>
    <div id="summary" class="summary" hidden></div>
    <div id="results" class="results"></div>
  `;

  const refreshButton = container.querySelector('#refresh-button');
  const statusEl = container.querySelector('#status');
  const lastRunEl = container.querySelector('#last-run');
  const summaryEl = container.querySelector('#summary');
  const resultsEl = container.querySelector('#results');

  // Refresh button = a real LIVE pull (force=true -- same query-param
  // convention @dashboard/tc-elite-services's own GET / already uses),
  // which only ever adds a small "what's been fixed" note to an already-
  // open ticket, never a new ticket or a full rewrite -- that's the
  // scheduled/manual job's job alone (see job.js's own refreshLive()
  // comment). The initial page load (no button click) stays a plain, fast
  // read of the last stored state.
  refreshButton.addEventListener('click', () => load(true));

  async function load(force) {
    refreshButton.disabled = true;
    statusEl.hidden = false;
    // The live-refresh message gets the dashboard-wide orange "in progress"
    // status treatment (.status.loading, by request) -- a plain load stays
    // the default/neutral status styling.
    statusEl.className = force ? 'status loading' : 'status';
    statusEl.textContent = force ? 'Refreshing live data (TPP, IT Glue, Autotask) -- this can take up to 30 seconds...' : 'Loading...';
    try {
      const res = await fetch(`/api/domain-itglue-gap${force ? '?force=true' : ''}`);
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

  function renderLastRun(lastRun) {
    if (!lastRun) {
      lastRunEl.hidden = true;
      return;
    }
    lastRunEl.hidden = false;
    const when = formatDateTime(lastRun.timestamp);
    if (!lastRun.ok) {
      lastRunEl.className = 'cell-flag-red';
      lastRunEl.textContent = `Last run FAILED ${when}: ${lastRun.error}`;
      return;
    }
    lastRunEl.className = 'inline-subtext';
    const dryRunNote = lastRun.dryRun ? ' (dry run -- not written to Autotask)' : '';
    const ticketPart = lastRun.ticketNumber ? `, ticket ${lastRun.ticketNumber}` : '';
    lastRunEl.textContent = `Last run ${when}${dryRunNote} -- ${lastRun.gapCount} gap(s), ${lastRun.unmatchedCount} unmatched${ticketPart}.`;
  }

  // One emphasis per summary line, by request (same convention every other
  // page's own summary line follows) -- the total open gap count is
  // bolded; the per-category/ticked breakdown sits alongside it unbolded.
  function renderSummary(summary) {
    summaryEl.hidden = false;
    const total = summary.gapCount + summary.unmatchedCount;
    summaryEl.innerHTML = `<strong>${total}</strong> currently open item${total === 1 ? '' : 's'} -- ${summary.gapCount} missing from IT Glue (${summary.gapTickedCount} ticked), ${summary.unmatchedCount} with no matching Autotask Client (${summary.unmatchedTickedCount} ticked)`;
  }

  function render(data) {
    statusEl.hidden = true;
    renderLastRun(data.lastRun);
    renderSummary(data.summary);
    resultsEl.innerHTML = '';

    const gapRows = data.rows.filter((r) => r.category === 'missing_from_itglue');
    const unmatchedRows = data.rows.filter((r) => r.category === 'unmatched_client');

    resultsEl.appendChild(
      sectionTable('Missing from IT Glue', gapRows, [
        { key: 'domain', label: 'Domain', cell: (r) => escapeHtml(r.domainName), sort: (r) => r.domainName || '' },
        { key: 'expiry', label: 'Expiry Date', className: 'ticket-number', cell: (r) => formatDate(r.expiryDate), sort: (r) => r.expiryDate || '' },
        { key: 'tppAcc', label: 'TPP Acc', cell: (r) => escapeHtml(r.tppAccountReference || ''), sort: (r) => r.tppAccountReference || '' },
        {
          key: 'client',
          label: 'IT Glue Client Name',
          cell: (r) =>
            r.autotaskClientName && r.itglueOrgUrl
              ? `<a href="${escapeHtml(r.itglueOrgUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(r.autotaskClientName)}</a>`
              : escapeHtml(r.autotaskClientName || ''),
          sort: (r) => r.autotaskClientName || '',
        },
      ], 'expiry')
    );
    resultsEl.appendChild(
      sectionTable('No matching Autotask Client', unmatchedRows, [
        { key: 'domain', label: 'Domain', cell: (r) => escapeHtml(r.domainName), sort: (r) => r.domainName || '' },
        { key: 'expiry', label: 'Expiry Date', className: 'ticket-number', cell: (r) => formatDate(r.expiryDate), sort: (r) => r.expiryDate || '' },
        { key: 'tppAcc', label: 'TPP Account Reference', cell: (r) => escapeHtml(r.tppAccountReference || ''), sort: (r) => r.tppAccountReference || '' },
      ], 'expiry')
    );
  }

  // Click-to-sort on every column (by request), plus the Done checkbox --
  // same "header built once, only tbody replaced on sort" convention
  // @dashboard/contact-search's own results table already established, so
  // a sort click never disturbs any other row's checkbox mid-interaction.
  function sectionTable(heading, rows, columns, defaultSortKey) {
    const groupEl = document.createElement('div');
    groupEl.className = 'resource-group';
    const headerEl = document.createElement('div');
    headerEl.className = 'resource-group-header';
    headerEl.innerHTML = `<span>${escapeHtml(heading)}</span><span class="count">${rows.length}</span>`;
    groupEl.appendChild(headerEl);

    if (rows.length === 0) {
      const p = document.createElement('p');
      p.className = 'status';
      p.textContent = 'Nothing currently open.';
      groupEl.appendChild(p);
      return groupEl;
    }

    let sortState = { key: defaultSortKey || columns[0].key, direction: 'asc' };

    const table = document.createElement('table');
    table.innerHTML = `
      <thead>
        <tr>
          ${columns.map((c) => `<th><button type="button" class="dig-sort-btn" data-key="${c.key}">${escapeHtml(c.label)}</button></th>`).join('')}
          <th><button type="button" class="dig-sort-btn" data-key="ticked">Done</button></th>
        </tr>
      </thead>
      <tbody></tbody>
    `;
    groupEl.appendChild(table);

    const tbody = table.querySelector('tbody');
    const sortButtons = [...table.querySelectorAll('.dig-sort-btn')];

    function updateSortButtonStyles() {
      for (const btn of sortButtons) {
        const isActive = sortState.key === btn.dataset.key;
        const label = btn.dataset.key === 'ticked' ? 'Done' : columns.find((c) => c.key === btn.dataset.key).label;
        btn.textContent = `${label}${isActive ? (sortState.direction === 'asc' ? ' ▲' : ' ▼') : ''}`;
        btn.classList.toggle('dig-sort-btn--active', isActive);
      }
    }

    function renderRows() {
      const sortValue = sortState.key === 'ticked' ? (r) => (r.ticked ? 1 : 0) : columns.find((c) => c.key === sortState.key).sort;
      const sorted = [...rows].sort((a, b) => {
        const av = sortValue(a);
        const bv = sortValue(b);
        const cmp = typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
        return sortState.direction === 'asc' ? cmp : -cmp;
      });
      tbody.innerHTML = sorted
        .map((r) => {
          // Ticked but STILL present means it didn't actually get fixed --
          // flagged rather than hidden, by request ("keep it ticked, but
          // flag it").
          const stillMissingFlag = r.ticked ? '<span class="cell-flag-red"> still showing as missing</span>' : '';
          return `
        <tr>
          ${columns.map((c) => `<td${c.className ? ` class="${c.className}"` : ''}>${c.cell(r)}</td>`).join('')}
          <td><label class="inline-checkbox-label" title="${r.ticked ? `Marked done${r.tickedByName ? ` by ${escapeHtml(r.tickedByName)}` : ''}${r.tickedAt ? ` on ${formatDateTime(r.tickedAt)}` : ''}` : 'Mark as handled'}">
            <input type="checkbox" class="gap-tick-input" data-domain="${escapeHtml(r.domainName)}" ${r.ticked ? 'checked' : ''} />
          </label>${stillMissingFlag}</td>
        </tr>`;
        })
        .join('');
      tbody.querySelectorAll('.gap-tick-input').forEach((input) => {
        input.addEventListener('change', () => toggleTick(input.dataset.domain, input.checked, input, renderRows));
      });
    }

    for (const btn of sortButtons) {
      btn.addEventListener('click', () => {
        const key = btn.dataset.key;
        sortState = { key, direction: sortState.key === key && sortState.direction === 'asc' ? 'desc' : 'asc' };
        updateSortButtonStyles();
        renderRows();
      });
    }

    updateSortButtonStyles();
    renderRows();
    return groupEl;
  }

  async function toggleTick(domainName, ticked, input, onSuccess) {
    input.disabled = true;
    try {
      const res = await fetch(`/api/domain-itglue-gap/${encodeURIComponent(domainName)}/tick`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticked }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      // Update in place rather than a full reload -- keeps scroll position
      // and every other row's own just-clicked state intact.
      const row = lastData.rows.find((r) => r.domainName === domainName);
      if (row) Object.assign(row, data);
      onSuccess(); // re-renders this table's own tbody so the "still showing as missing" flag/tooltip reflect the new state immediately
    } catch (err) {
      input.checked = !ticked; // revert the checkbox on failure
      statusEl.hidden = false;
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      input.disabled = false;
    }
  }

  if (lastData) render(lastData);
  else load(false);

  function formatDate(isoDateOnly) {
    if (!isoDateOnly) return '';
    return new Date(`${isoDateOnly}T00:00:00.000Z`).toLocaleDateString(undefined, { timeZone: 'Australia/Brisbane' });
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
