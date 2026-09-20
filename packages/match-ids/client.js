export const id = "match-ids";
export const label = "Match IDs";

// Module-scope, not inside mount() -- same "survives a re-mount, comes back
// instantly" convention every other page on this dashboard uses (the shell
// tears down and re-mounts a page's DOM on every navigation away and back,
// but the dynamically-imported module itself stays alive for the session).
let lastData = null;
let lastFilter = '';
let lastBucketFilter = 'all';

// Same four buckets the server's matchRewstCustomer() returns, plus "all" --
// used both for the filter chips and the Match column's own pill, so the
// wording is identical in both places.
const BUCKET_ORDER = ['all', 'exact', 'fuzzy', 'ambiguous', 'none'];
const BUCKET_CHIP_LABEL = { all: 'All', exact: 'Matched', fuzzy: 'Fuzzy Match', ambiguous: 'Ambiguous', none: 'No Match' };

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>Match IDs</h1>
      <div class="date-form">
        <label for="filter-input">Filter</label>
        <input type="text" id="filter-input" placeholder="type to filter by client name..." />
        <button type="button" id="refresh-button">Refresh</button>
      </div>
    </header>
    <div id="bucket-filters" class="mid-filter-row"></div>
    <p id="status" class="status">Loading...</p>
    <div id="summary" class="summary" hidden></div>
    <div id="results" class="results"></div>
  `;

  const filterInput = container.querySelector('#filter-input');
  const refreshButton = container.querySelector('#refresh-button');
  const bucketFiltersEl = container.querySelector('#bucket-filters');
  const statusEl = container.querySelector('#status');
  const summaryEl = container.querySelector('#summary');
  const resultsEl = container.querySelector('#results');

  filterInput.value = lastFilter;

  // Whole list is already in memory client-side (it's one build server-side,
  // not a per-row expensive lookup), same convention CSP Customers' own
  // client.js uses -- filtering as you type is instant, no round trip.
  filterInput.addEventListener('input', () => {
    lastFilter = filterInput.value;
    if (lastData) renderResults(lastData.rows);
  });

  refreshButton.addEventListener('click', () => load(true));

  async function load(force) {
    refreshButton.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = force
      ? 'Refreshing... this re-checks every client’s Microsoft tenant ID against Ingram, which can take a minute or two.'
      : 'Loading...';
    summaryEl.hidden = true;
    resultsEl.innerHTML = '';

    try {
      const res = await fetch(`/api/match-ids${force ? '?force=true' : ''}`);
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
    const counts = data.matchCounts || {};
    const matchBreakdown = ['exact', 'fuzzy', 'ambiguous', 'none']
      .filter((b) => counts[b])
      .map((b) => `${counts[b]} ${matchBucketLabel(b)}`)
      .join(', ');
    summaryEl.innerHTML = `<strong>${data.totalCount}</strong> client${data.totalCount === 1 ? '' : 's'} with a Microsoft subscription through Ingram Micro (${matchBreakdown})<span class="inline-subtext"> -- as of ${formatDateTime(data.asOf)}</span>`;
    renderBucketFilters(counts);
    renderResults(data.rows);
  }

  function matchBucketLabel(bucket) {
    if (bucket === 'exact') return 'matched';
    if (bucket === 'fuzzy') return 'fuzzy match';
    if (bucket === 'ambiguous') return 'ambiguous';
    return 'no Rewst match';
  }

  // One chip per bucket (+ "All"), each showing its own count -- clicking
  // one filters the table down to just that bucket, same idea as the
  // published Ingram x Rewst Matchup artifact's own summary chips, adapted
  // to this page's four distinct buckets rather than that page's combined
  // "Ambiguous / No match" chip.
  function renderBucketFilters(counts) {
    const totalAll = (counts.exact || 0) + (counts.fuzzy || 0) + (counts.ambiguous || 0) + (counts.none || 0);
    bucketFiltersEl.innerHTML = BUCKET_ORDER.map((b) => {
      const n = b === 'all' ? totalAll : counts[b] || 0;
      return `<button type="button" class="mid-filter-chip${lastBucketFilter === b ? ' active' : ''}" data-bucket="${b}">${BUCKET_CHIP_LABEL[b]} <span class="count">${n}</span></button>`;
    }).join('');
    bucketFiltersEl.querySelectorAll('.mid-filter-chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        lastBucketFilter = btn.dataset.bucket;
        renderBucketFilters(counts);
        if (lastData) renderResults(lastData.rows);
      });
    });
  }

  function renderResults(rows) {
    const term = lastFilter.trim().toLowerCase();
    const filtered = rows.filter((r) => {
      if (lastBucketFilter !== 'all' && r.matchBucket !== lastBucketFilter) return false;
      if (term && !r.ingramClientName.toLowerCase().includes(term) && !(r.rewstClientName || '').toLowerCase().includes(term)) return false;
      return true;
    });

    resultsEl.innerHTML = '';
    if (filtered.length === 0) {
      resultsEl.innerHTML = '<p class="status">No matching clients.</p>';
      return;
    }

    const group = document.createElement('div');
    group.className = 'resource-group';
    group.innerHTML = `
      <table>
        <thead>
          <tr class="shaded-row">
            <th>Ingram Client Name</th>
            <th>Ingram Customer ID</th>
            <th>Subs</th>
            <th>Tenant ID</th>
            <th>Rewst Client Name</th>
            <th>Organisation ID</th>
            <th>Match</th>
            <th>Match Detail</th>
          </tr>
        </thead>
        <tbody>${filtered.map(rowHtml).join('')}</tbody>
      </table>
    `;
    resultsEl.appendChild(group);
  }

  function rowHtml(r) {
    return `
      <tr>
        <td>${escapeHtml(r.ingramClientName)}</td>
        <td class="ticket-number">${escapeHtml(r.ingramCustomerId)}</td>
        <td class="ticket-number">${r.subscriptionCount}</td>
        <td class="ticket-number">${r.tenantId ? escapeHtml(r.tenantId) : '<span class="inline-subtext">(none)</span>'}</td>
        <td>${r.rewstClientName ? escapeHtml(r.rewstClientName) : ''}</td>
        <td class="ticket-number">${r.rewstOrganisationId ? escapeHtml(r.rewstOrganisationId) : ''}</td>
        <td>${matchBadgeHtml(r)}</td>
        <td class="inline-subtext">${escapeHtml(matchDetailText(r))}</td>
      </tr>`;
  }

  function matchBadgeHtml(r) {
    return `<span class="mid-badge mid-badge--${r.matchBucket}">${escapeHtml(BUCKET_CHIP_LABEL[r.matchBucket] || r.matchBucket)}</span>`;
  }

  // The bit of matchQualityLabel beyond the plain bucket word -- e.g.
  // "exact (matched via linked org name)" -> "matched via linked org name",
  // plain "exact"/"NO MATCH" -> blank (nothing more to say). Ambiguous rows
  // carry no parenthetical of their own (matchQualityLabel is just
  // "AMBIGUOUS"), so their candidate list is spelled out here instead.
  function matchDetailText(r) {
    if (r.matchBucket === 'ambiguous' && r.matchCandidates) {
      return `${r.matchCandidates.length} possible matches: ${r.matchCandidates.map((c) => c.rewstClientName).join(', ')}`;
    }
    const m = /\(([^)]+)\)/.exec(r.matchQualityLabel || '');
    return m ? m[1] : '';
  }

  if (lastData) render(lastData);
  else load(false);

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
