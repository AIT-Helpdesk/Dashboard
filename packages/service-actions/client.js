import { computeFindings } from '/meeting-prep-recommendations.js';

export const id = 'service-actions';
export const label = 'Service Actions';

// Runs Meeting Prep's own rules-based recommendations engine (shared via
// meeting-prep-recommendations.js -- see that file's header) across every
// client at once, instead of one client at a time, and presents the
// result as a combined action list for the service team rather than a
// one-client meeting aid (by request: "have a look at the 'Generate
// Recommendations Summary' button. Can we have a page where we generate
// these recommendations for all sites and display as an action list for
// the service team"). Grouped by urgency tier FIRST, then by client
// within a tier -- a service team triaging across the whole client base
// wants "what's most urgent, everywhere" before "what's going on with one
// client", the opposite ordering from Meeting Prep's own per-client view.
//
// Data comes from Meeting Prep's own /all-file-components endpoint
// (packages/meeting-prep/server.js, this page's server.js is literally
// that same router, mounted under this page's own /api/service-actions --
// see package.json), which is file-based only, same as every check this
// engine runs -- no live Datto/Autotask calls fanned out across every
// client (see that route's own comment on the Autotask rate-limit
// incident this deliberately avoids repeating at higher volume).

let lastResult = null; // { asOf, clients: [{ client, components }] } -- last successful fetch, kept so a filter change can re-render without a re-fetch
let clientFilter = '';
let titleFilter = '';

const TIER_ORDER = ['action', 'gather', 'watch', 'good'];
const TIER_META = {
  action: { label: 'Needs action', className: 'mtg-rec-group--action' },
  gather: { label: 'Needs investigation', className: 'mtg-rec-group--gather' },
  watch: { label: 'Worth keeping an eye on', className: 'mtg-rec-group--watch' },
  good: { label: 'Good news', className: 'mtg-rec-group--good' },
};

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <div class="mtg-title-row">
        <h1>Service Actions</h1>
        <button type="button" id="sa-refresh-button" class="button-link button-link--small">Refresh</button>
      </div>
    </header>
    <p class="inline-subtext">
      Runs Meeting Prep's rules-based recommendations across every client at once, grouped by how urgently each
      finding needs attention. Same checks as the "Generate Recommendations Summary" button on Meeting Prep's own
      page, just across the whole client base rather than one client at a time -- a starting point for the service
      team, not a replacement for actually opening a report.
    </p>
    <div class="mtg-sa-filter-row">
      <label for="sa-client-filter-input">Filter by client</label>
      <input type="text" id="sa-client-filter-input" placeholder="e.g. Kraftur* (wildcards with *)" value="${escapeHtml(clientFilter)}" />
      <label for="sa-title-filter-input">Filter by recommendation</label>
      <input type="text" id="sa-title-filter-input" placeholder="e.g. *patch* (wildcards with *)" value="${escapeHtml(titleFilter)}" />
    </div>
    <div id="sa-status" class="status"></div>
    <div id="sa-results"></div>
  `;

  const refreshButton = container.querySelector('#sa-refresh-button');
  const clientFilterInput = container.querySelector('#sa-client-filter-input');
  const titleFilterInput = container.querySelector('#sa-title-filter-input');
  const statusEl = container.querySelector('#sa-status');
  const resultsEl = container.querySelector('#sa-results');

  refreshButton.addEventListener('click', () => load());
  clientFilterInput.addEventListener('input', () => {
    clientFilter = clientFilterInput.value;
    render();
  });
  titleFilterInput.addEventListener('input', () => {
    titleFilter = titleFilterInput.value;
    render();
  });

  function render() {
    if (!lastResult) return;
    resultsEl.innerHTML = renderResults(lastResult, clientFilter, titleFilter);
  }

  async function load() {
    statusEl.textContent = 'Loading...';
    resultsEl.innerHTML = '';
    refreshButton.disabled = true;
    try {
      const res = await fetch('/api/service-actions/all-file-components', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastResult = data;
      statusEl.textContent = '';
      render();
    } catch (err) {
      statusEl.textContent = `Failed to load: ${err.message}`;
    } finally {
      refreshButton.disabled = false;
    }
  }

  load();
}

function renderResults(data, clientFilterValue, titleFilterValue) {
  const clientTerm = clientFilterValue.trim();
  const clients = clientTerm ? data.clients.filter((c) => matchesWildcard(c.client, clientTerm)) : data.clients;

  if (data.clients.length === 0) {
    return `<p class="status">No report data found for any client yet.</p>`;
  }

  // Flatten every client's findings into one list, each carrying its own
  // client name, before regrouping by tier -- deliberately not reusing
  // Meeting Prep's own renderRecommendationsHtml() (which groups a SINGLE
  // client's findings and has no client label to show), since the
  // grouping axis itself is different here.
  const titleTerm = titleFilterValue.trim();
  const allFindings = [];
  for (const c of clients) {
    for (const f of computeFindings(c.components)) {
      if (titleTerm && !matchesWildcard(f.title, titleTerm)) continue;
      allFindings.push({ client: c.client, ...f });
    }
  }

  const filterDescriptions = [clientTerm && `client matching "${escapeHtml(clientTerm)}"`, titleTerm && `recommendation matching "${escapeHtml(titleTerm)}"`].filter(Boolean);
  const filterSuffix = filterDescriptions.length ? ` (filtered by ${filterDescriptions.join(', ')})` : '';
  const summary = `<p class="inline-subtext">${clients.length} client${clients.length === 1 ? '' : 's'} loaded, as of ${formatDateTime(data.asOf)}. ${allFindings.length} finding${
    allFindings.length === 1 ? '' : 's'
  } shown${filterSuffix}.</p>`;

  const groups = TIER_ORDER.map((tier) => ({
    tier,
    meta: TIER_META[tier],
    items: allFindings.filter((f) => f.tier === tier).sort((a, b) => a.client.localeCompare(b.client)),
  })).filter((g) => g.items.length > 0);

  if (groups.length === 0) {
    return `<div class="mtg-rec-panel">${summary}<p class="status">No matching findings.</p></div>`;
  }

  const sections = groups
    .map(
      (g) => `
      <div class="mtg-rec-group ${g.meta.className}">
        <h3>${escapeHtml(g.meta.label)} (${g.items.length})</h3>
        ${g.items
          .map(
            (f) => `
          <div class="mtg-rec-item">
            <p class="mtg-rec-item-title"><span class="mtg-rec-item-client">${escapeHtml(f.client)}</span>${escapeHtml(f.title)}</p>
            <p class="mtg-rec-item-detail">${escapeHtml(f.detail)}</p>
          </div>`
          )
          .join('')}
      </div>`
    )
    .join('');

  return `<div class="mtg-rec-panel">${summary}${sections}</div>`;
}

// Browser-side counterpart to @dashboard/autotask-client's own
// parseWildcard()/matchesWildcard() (a Node package, not loadable here) --
// same dashboard-wide convention, copied rather than shared since it's a
// few lines of pure string logic: 'Patch*' -> begins with, '*Patch' ->
// ends with, '*Patch*' or no stars at all -> contains. Case-insensitive.
function matchesWildcard(value, term) {
  if (!term) return true;
  const startsWithStar = term.startsWith('*');
  const endsWithStar = term.endsWith('*');
  let needle = term;
  if (startsWithStar) needle = needle.slice(1);
  if (endsWithStar) needle = needle.slice(0, -1);
  needle = needle.trim().toLowerCase();
  if (!needle) return true;
  const v = (value || '').toLowerCase();
  if (endsWithStar && !startsWithStar) return v.startsWith(needle);
  if (startsWithStar && !endsWithStar) return v.endsWith(needle);
  return v.includes(needle);
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
