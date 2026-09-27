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
let phraseFilter = ''; // selected phrase-key from the dropdown below ('' = All)

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
      <label for="sa-phrase-filter-select">Filter by phrase</label>
      <select id="sa-phrase-filter-select">
        <option value="">All recommendations</option>
      </select>
    </div>
    <div id="sa-status" class="status"></div>
    <div id="sa-results"></div>
  `;

  const refreshButton = container.querySelector('#sa-refresh-button');
  const clientFilterInput = container.querySelector('#sa-client-filter-input');
  const titleFilterInput = container.querySelector('#sa-title-filter-input');
  const phraseFilterSelect = container.querySelector('#sa-phrase-filter-select');
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
  phraseFilterSelect.addEventListener('change', () => {
    phraseFilter = phraseFilterSelect.value;
    resultsEl.innerHTML = renderResults(lastResult, clientFilter, titleFilter, phraseFilter);
  });

  // Rebuilds the phrase dropdown's own OPTIONS from whatever the current
  // (client-filtered) findings actually say right now -- never a fixed
  // list scanned once and hard-coded, so it stays correct automatically
  // if the rules engine's wording changes or a brand-new rule appears.
  // Ignores the free-text title filter (that's a separate, complementary
  // filter -- this dropdown's own option set should stay stable while
  // someone types into that box, not shrink out from under them).
  // Counts descending (most common issue first, useful for triage), then
  // alphabetical. Preserves the current selection across a rebuild
  // (e.g. typing in the client filter) unless that phrase no longer has
  // any matching findings at all (e.g. after a Refresh resolved it), in
  // which case it resets to "All".
  function updatePhraseFilterOptions() {
    const clientTerm = clientFilter.trim();
    const clients = clientTerm ? lastResult.clients.filter((c) => matchesWildcard(c.client, clientTerm)) : lastResult.clients;
    const counts = new Map();
    for (const c of clients) {
      for (const f of computeFindings(c.components)) {
        const key = phraseKeyForTitle(f.title);
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
    const sortedKeys = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a) || a.localeCompare(b));
    const previousValue = phraseFilterSelect.value;
    phraseFilterSelect.innerHTML =
      '<option value="">All recommendations</option>' + sortedKeys.map((key) => `<option value="${escapeHtml(key)}">${escapeHtml(key)} (${counts.get(key)})</option>`).join('');
    if (sortedKeys.includes(previousValue)) {
      phraseFilterSelect.value = previousValue;
    } else {
      phraseFilterSelect.value = '';
      phraseFilter = '';
    }
  }

  function render() {
    if (!lastResult) return;
    updatePhraseFilterOptions();
    resultsEl.innerHTML = renderResults(lastResult, clientFilter, titleFilter, phraseFilter);
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

function renderResults(data, clientFilterValue, titleFilterValue, phraseFilterValue) {
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
      if (phraseFilterValue && phraseKeyForTitle(f.title) !== phraseFilterValue) continue;
      allFindings.push({ client: c.client, ...f });
    }
  }

  const filterDescriptions = [
    clientTerm && `client matching "${escapeHtml(clientTerm)}"`,
    titleTerm && `recommendation matching "${escapeHtml(titleTerm)}"`,
    phraseFilterValue && `phrase "${escapeHtml(phraseFilterValue)}"`,
  ].filter(Boolean);
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

// Normalizes a finding's raw title (e.g. "7 devices have no patch policy
// assigned at all") into a short, count-and-tense-independent "phrase key"
// (e.g. "no patch policy assigned") the dropdown above groups and counts
// by. By request, this MUST be computed fresh from whatever the current
// findings actually say, never a fixed list of phrases scanned once and
// hard-coded -- so it stays correct automatically if
// meeting-prep-recommendations.js's own wording ever changes, or a
// brand-new rule appears, with no code change here needed either way.
//
// Purely mechanical, and deliberately generic rather than tied to any
// specific rule's own wording -- three structural passes, each aimed at a
// different shape of "specific" this rules engine's titles carry, by
// request ("leave out counts, percentages, and specifics"):
//
// 1. Nearly every countable finding title follows the shape "<N>
//    device(s) [has/have/is/are/hasn't/haven't] <rest>" (subject-verb
//    agreement varying only with N) -- strips exactly that leading
//    count+noun, then an immediately-following verb if there is one, so
//    "1 device has X"/"7 devices have X" and "1 device is X"/"3 devices
//    are X" all collapse to the same key.
// 2. A trailing ", and ..." clause is always EXTRA per-instance detail
//    appended onto an otherwise-plain topic (e.g. hardware-lifecycle's
//    "...due for replacement within 12 months, and 3 of them are also
//    currently causing trouble") -- cut at the first one, keeping only
//    the plain topic before it.
// 3. A percentage is always a per-instance METRIC in this rules engine's
//    own titles, never a fixed rule threshold -- unlike a bare number
//    (e.g. "30 days"/"12 months", a genuinely fixed part of that rule's
//    own definition, deliberately left alone) -- so "Software Management
//    is scoring 33%, the weakest category on this report" drops the
//    short verb phrase leading into the percentage AND everything after
//    it, leaving just the topic: "Software Management".
//
// A short, generic list of trailing filler phrases (currently just "at
// all") is trimmed too, by request -- confirmed against the real "no
// patch policy assigned at all" title. A title with none of these shapes
// (a fully static one, e.g. "No servers, printers, or mobiles show up in
// any report") has no specifics to strip in the first place and passes
// through unchanged.
const TITLE_FILLER_SUFFIXES = [/\s+at all$/i];
function phraseKeyForTitle(title) {
  let key = (title || '').replace(/^\d+\s+\S+\s+/, ''); // drop "<N> device(s) "
  key = key.replace(/^(?:has|have|is|are|hasn't|haven't)\s+/i, ''); // drop an immediately-following verb, if any
  key = key.replace(/,\s+and\s+.*$/i, ''); // drop a trailing ", and ..." appended clause
  key = key.replace(/\s+(?:is|are)\s+\S+\s+\d+%.*$/i, ''); // drop "<verb> <word> <N>%" onward (a percentage metric, not a fixed threshold)
  for (const re of TITLE_FILLER_SUFFIXES) key = key.replace(re, '');
  return key.trim();
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
