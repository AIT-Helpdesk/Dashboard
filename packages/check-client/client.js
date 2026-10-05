export const id = "check-client";
export const label = "Check Client";

// Module-scope, not inside mount() -- the shell fully tears down and
// re-mounts a page's DOM on every navigation away and back, but the
// dynamically-imported module itself is cached by the browser and stays
// alive for the session, so a module-level variable survives across
// re-mounts and lets the last search restore instantly instead of coming
// back blank. Same convention every other page on this dashboard uses.
// Two separate client fields, by request -- Autotask and Ingram sometimes
// carry a different name for the same real client, so one wildcard search
// can't reliably match both systems at once. Ingram Client defaults to
// whatever's typed into Autotask Client (see the 'input' wiring in mount()
// below) until the user directly edits Ingram Client themselves, at which
// point the auto-fill stops for the rest of this page visit --
// lastIngramClientManuallyEdited persists that across a same-session
// remount too, so navigating away and back doesn't silently re-link a
// value the user deliberately diverged.
let lastAutotaskClient = '';
let lastExactClient = false; // off by default -- the normal wildcard/contains search
let lastIngramClient = '';
let lastIngramClientManuallyEdited = false;
// Same one-way-mirror-until-edited pattern as Ingram Client -- Datto's own
// siteName is a third naming system, but in practice tends to track
// Autotask's own client naming more closely than Ingram's catalog-style
// names do (both are this MSP's own internal naming, not a distributor's),
// so Autotask Client is the more useful default to mirror here. Not a
// `required` field, unlike Autotask/Ingram Client -- the Datto RMM section
// is additive, and a client with no matching Datto site shouldn't block
// the rest of the search.
let lastDattoSite = '';
let lastDattoSiteManuallyEdited = false;
let lastSince = null;
let lastMonth = null;
let lastOrdersData = null;
let lastSubscriptionsData = null;
let lastM365Data = null;
let lastServicesData = null;
let lastDattoData = null;
// Only ever set once the "Show Users" button (Microsoft 365 Tenancy's own
// lazy toggle) has actually been clicked -- by request, the Tech Cover
// Elite section's own licensed-users count does NOT trigger that fetch on
// its own, it just reads whatever's already there (or isn't).
let lastM365UsersData = null;

// Whichever mount() is CURRENTLY on screen registers its own section
// render functions here, overwriting whatever the previous mount left
// behind. Fixes a real bug (by request, "if i change pages in the
// dashboard while something is running it stops"): each load*() function
// below is a closure over ITS OWN mount()'s local DOM elements, so if you
// navigate away before a search finishes and come back before it actually
// resolves, the in-flight fetch's own render call was writing into the
// OLD, torn-down mount's detached elements -- invisible, so nothing ever
// seemed to happen, and lastXxxData (which IS module-scope and did update
// correctly) only got picked up by the NEW mount's own one-time "restore
// on remount" check below, which already ran BEFORE that late result came
// in. Routing every load*()'s render call through this dispatch table
// instead of calling its own closed-over render function directly means
// whichever mount is actually visible always receives the update, even
// when the fetch that produced it was kicked off by a mount that no
// longer exists.
let activeRenderers = {};

// Same six checkbox-style fields Contract Checks itself carries -- see
// packages/contract-checks/db.js/README for the schema. Duplicated here
// (not imported -- this is a browser module, contract-checks' db.js is
// server-side) same way every page duplicates small shared enums between
// client and server.
const TOGGLE_COLUMNS = [
  { field: 'checked_contract', atKey: 'checkedContractAt', label: 'Contract' },
  { field: 'm365_ok', atKey: 'm365OkAt', label: 'M365 OK' },
  { field: 'tc_elite', atKey: 'tcEliteAt', label: 'TC ELITE' },
  { field: 'tc_ess', atKey: 'tcEssAt', label: 'TC ESS' },
  { field: 'others', atKey: 'othersAt', label: 'OTHERS' },
  { field: 'all_done', atKey: 'allDoneAt', label: 'DONE' },
];
const FIELD_LABELS = {
  checked_contract: 'Checked Contract',
  m365_ok: 'M365 OK',
  tc_elite: 'TC ELITE',
  tc_ess: 'TC ESS',
  others: 'OTHERS',
  all_done: 'ALL DONE',
  info_question: 'Info Question',
  info_answer: 'Info Answer',
  ticket_note: 'Ticket Note',
};
const TOGGLE_FIELD_SET = new Set(TOGGLE_COLUMNS.map((c) => c.field));

// Same fixed display order/labels Ingram Subscriptions' own client.js uses
// for its status breakdown.
const STATUS_ORDER = ['active', 'pending', 'hold', 'terminated', 'removed'];
const STATUS_LABELS = { active: 'active', pending: 'pending', hold: 'on hold', terminated: 'terminated', removed: 'removed' };

export function mount(container) {
  container.innerHTML = `
    <div class="check-client-page">
    <header class="page-header">
      <div class="chk-title-block">
        <h1>Check Client</h1>
        <p id="client-label" class="chk-client-label" hidden></p>
      </div>
      <form id="filter-form" class="date-form date-form--stacked">
        <div class="date-form-row chk-date-row">
          <label for="since-input">Since</label>
          <input type="date" id="since-input" name="since" required />
          <label for="month-input">Month</label>
          <input type="month" id="month-input" name="month" required />
          <!-- Invisible twin of the real Search button below, by request --
               "right justify Since/Month, but only up to before the Search
               button's position." Reserves exactly the Search button's own
               rendered width (same text/classes, so it's never a guessed
               pixel value) so justify-content: flex-end on this row lands
               Since/Month's right edge at the button's LEFT edge, not the
               far right of the form. -->
          <button type="button" class="chk-search-spacer" aria-hidden="true" tabindex="-1" disabled>Search</button>
        </div>
        <div class="date-form-row">
          <label for="autotask-client-input">Autotask Client</label>
          <input type="text" id="autotask-client-input" name="autotaskClient" placeholder="e.g. Acme* (wildcards with *)" required />
          <label class="inline-checkbox-label chk-exact-client-label" title="Force an exact match on the Autotask Client name (instead of the usual wildcard/contains search)">
            <input type="checkbox" id="exact-client-input" />
          </label>
          <label for="ingram-client-input">Ingram Client</label>
          <input type="text" id="ingram-client-input" name="ingramClient" placeholder="e.g. Acme* (wildcards with *)" required />
          <button type="submit" id="search-button">Search</button>
        </div>
        <div class="date-form-row">
          <label for="datto-site-input">Datto Site</label>
          <input type="text" id="datto-site-input" name="dattoSite" placeholder="e.g. Acme* (wildcards with *, optional)" />
        </div>
      </form>
    </header>
    <div class="chk-summary-box">
      <h2 class="chk-section-heading">Client Check Summary <span id="summary-m365-pending" class="status loading" hidden>Loading Microsoft 365 Tenancy...</span></h2>
      <p id="summary-status" class="status" hidden>Search above to see a combined Ingram Subscriptions / Microsoft 365 Tenancy comparison.</p>
      <div id="summary-results" class="results"></div>
    </div>

    <div class="chk-summary-box">
      <h2 class="chk-section-heading">Orders <span class="inline-subtext">(Ingram Micro)</span></h2>
      <p id="orders-status" class="status" hidden></p>
      <div id="orders-summary" class="summary" hidden></div>
      <div id="orders-results" class="results"></div>

      <hr class="chk-box-divider" />

      <h2 class="chk-section-heading">Subscriptions <span class="inline-subtext">(Ingram Micro)</span></h2>
      <p id="subs-status" class="status" hidden></p>
      <div id="subs-summary" class="summary" hidden></div>
      <p id="subs-current-data-note" class="chk-current-data-note" hidden>Current Data Shown, no historical point in time available.</p>
      <div id="subs-results" class="results"></div>
    </div>

    <h2 class="chk-section-heading">Microsoft 365 Tenancy <span class="inline-subtext">(Ingram tenant ID &rarr; Rewst &rarr; M365)</span></h2>
    <p id="m365-status" class="status" hidden></p>
    <div id="m365-summary" class="summary" hidden></div>
    <p id="m365-current-data-note" class="chk-current-data-note" hidden>Current Data Shown, no historical point in time available.</p>
    <div id="m365-results" class="results"></div>

    <h2 class="chk-section-heading">Contracts <span class="inline-subtext">(Autotask)</span></h2>
    <p id="services-status" class="status" hidden></p>
    <div id="services-summary" class="summary" hidden></div>
    <div id="services-results" class="results"></div>

    <h2 class="chk-section-heading">Datto RMM <span class="inline-subtext">(devices &amp; open alerts)</span></h2>
    <p id="datto-status" class="status" hidden></p>
    <div id="datto-summary" class="summary" hidden></div>
    <p id="datto-current-data-note" class="chk-current-data-note" hidden>Current Data Shown, no historical point in time available.</p>
    <div id="datto-results" class="results"></div>
    </div>
  `;

  const form = container.querySelector('#filter-form');
  const clientLabelEl = container.querySelector('#client-label');
  const autotaskClientInput = container.querySelector('#autotask-client-input');
  const exactClientInput = container.querySelector('#exact-client-input');
  const ingramClientInput = container.querySelector('#ingram-client-input');
  const dattoSiteInput = container.querySelector('#datto-site-input');
  const sinceInput = container.querySelector('#since-input');
  const monthInput = container.querySelector('#month-input');
  const searchButton = container.querySelector('#search-button');

  const summaryStatusEl = container.querySelector('#summary-status');
  const summaryResultsEl = container.querySelector('#summary-results');
  const ordersStatusEl = container.querySelector('#orders-status');
  const ordersSummaryEl = container.querySelector('#orders-summary');
  const ordersResultsEl = container.querySelector('#orders-results');
  const subsStatusEl = container.querySelector('#subs-status');
  const subsSummaryEl = container.querySelector('#subs-summary');
  const subsCurrentDataNoteEl = container.querySelector('#subs-current-data-note');
  const subsResultsEl = container.querySelector('#subs-results');
  const m365StatusEl = container.querySelector('#m365-status');
  // Mirrors m365StatusEl's own current message next to the Client Check
  // Summary heading, by request -- the Summary combines Ingram
  // Subscriptions AND Microsoft 365 Tenancy, so it's otherwise not
  // obvious up there that M365 hasn't finished (or hasn't matched, or
  // errored). ANY message m365StatusEl shows mirrors here now, not just
  // whichever one a specific call site remembered to toggle -- by
  // request ("show any message... not just the last one", after
  // "Waiting for Subscriptions and Contracts..." -- set from
  // loadSubscriptions(), not loadM365Tenancy() itself -- didn't show).
  // syncSummaryM365Pending() below is called right after every single
  // place this file touches m365StatusEl, so this can't drift out of
  // sync with a future call site the way the old hard-coded toggles did.
  const summaryM365PendingEl = container.querySelector('#summary-m365-pending');
  function syncSummaryM365Pending() {
    summaryM365PendingEl.hidden = m365StatusEl.hidden;
    summaryM365PendingEl.className = m365StatusEl.className;
    summaryM365PendingEl.textContent = m365StatusEl.textContent;
  }
  const m365SummaryEl = container.querySelector('#m365-summary');
  const m365CurrentDataNoteEl = container.querySelector('#m365-current-data-note');
  const m365ResultsEl = container.querySelector('#m365-results');
  const servicesStatusEl = container.querySelector('#services-status');
  const servicesSummaryEl = container.querySelector('#services-summary');
  const servicesResultsEl = container.querySelector('#services-results');
  const dattoStatusEl = container.querySelector('#datto-status');
  const dattoSummaryEl = container.querySelector('#datto-summary');
  const dattoCurrentDataNoteEl = container.querySelector('#datto-current-data-note');
  const dattoResultsEl = container.querySelector('#datto-results');

  // AEST (UTC+10, no DST in Queensland) "today", not the browser's own local
  // timezone -- same defaultSinceISO() Contract Checks' own client.js uses.
  // Defaults to the 1st of the current month -- EXCEPT when today is still
  // early in the month (before the 7th), where the 1st of LAST month is the
  // more useful starting point instead.
  function defaultSinceISO() {
    const aestNow = new Date(Date.now() + 10 * 60 * 60 * 1000);
    const year = aestNow.getUTCFullYear();
    const month = aestNow.getUTCMonth();
    const day = aestNow.getUTCDate();
    const targetMonth = day < 7 ? month - 1 : month;
    return new Date(Date.UTC(year, targetMonth, 1)).toISOString().slice(0, 10);
  }

  // Same currentMonthISO() Contract Services' own client.js uses.
  function currentMonthISO() {
    return new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString().slice(0, 7);
  }

  autotaskClientInput.value = lastAutotaskClient;
  exactClientInput.checked = lastExactClient;
  ingramClientInput.value = lastIngramClient;
  dattoSiteInput.value = lastDattoSite;
  sinceInput.value = lastSince || defaultSinceISO();
  monthInput.value = lastMonth || currentMonthISO();

  // "Client: <name>" under the page title, by request -- the REAL resolved
  // client name(s) each system actually matched, not the raw search text
  // typed into the boxes (a wildcard like "Acme*" resolves to whatever
  // real name(s) it matched). Widens to "Client: <Autotask names> /
  // <Ingram names>" the moment the two systems resolve to a different set
  // of names, so a real cross-system name mismatch is obvious at a glance
  // -- the whole reason these two fields were split apart in the first
  // place. Can only be computed from fetched data (not from the input
  // boxes), so this is called from each render*() function below as its
  // own section's data arrives/changes, not live as the fields are typed.
  // Autotask's resolved name(s) come from Contract Services' own
  // byCompany; Ingram's come from Orders' and Subscriptions' own byClient,
  // merged -- either one alone can be empty for a client with no matching
  // rows in that particular section (e.g. a brand new client with active
  // subscriptions but no order history yet), so neither is trusted alone.
  function uniqueNonEmpty(arr) {
    return [...new Set(arr.filter(Boolean))];
  }
  function updateClientLabel() {
    const autotaskNames = uniqueNonEmpty(lastServicesData ? lastServicesData.byCompany.map((c) => c.companyName) : []);
    const ingramNames = uniqueNonEmpty([
      ...(lastOrdersData ? lastOrdersData.byClient.map((c) => c.clientName) : []),
      ...(lastSubscriptionsData ? lastSubscriptionsData.byClient.map((c) => c.clientName) : []),
    ]);
    if (autotaskNames.length === 0 && ingramNames.length === 0) {
      clientLabelEl.hidden = true;
      return;
    }
    // More than one real match, by request, is flagged as "Multiple
    // Matches (<the search text that caused it>)" rather than listing every
    // name -- a wide wildcard matching several real clients isn't the same
    // situation as a genuine single-client name mismatch across systems,
    // and spelling out every match here got noisy fast.
    function nameFor(names, searchInput, notFoundText) {
      if (names.length === 0) return notFoundText;
      if (names.length > 1) return `Multiple Matches (${searchInput.value.trim()})`;
      return names[0];
    }
    const autotaskText = nameFor(autotaskNames, autotaskClientInput, '(no Autotask match)');
    const ingramText = nameFor(ingramNames, ingramClientInput, '(no Ingram match)');
    const sameSet = autotaskNames.length === ingramNames.length && autotaskNames.every((n) => ingramNames.includes(n));
    clientLabelEl.hidden = false;
    clientLabelEl.textContent = sameSet ? `Client: ${autotaskText}` : `Client: ${autotaskText} / ${ingramText}`;
  }

  // Ingram Client mirrors Autotask Client live as it's typed, UNTIL Ingram
  // Client itself receives a real user edit -- programmatic value changes
  // (the mirror below) never fire 'input', only genuine typing does, so
  // this is a clean one-way "linked until diverged" switch, by request.
  let ingramClientManuallyEdited = lastIngramClientManuallyEdited;
  let dattoSiteManuallyEdited = lastDattoSiteManuallyEdited;
  autotaskClientInput.addEventListener('input', () => {
    if (!ingramClientManuallyEdited) ingramClientInput.value = autotaskClientInput.value;
    if (!dattoSiteManuallyEdited) dattoSiteInput.value = autotaskClientInput.value;
  });
  ingramClientInput.addEventListener('input', () => {
    ingramClientManuallyEdited = true;
  });
  dattoSiteInput.addEventListener('input', () => {
    dattoSiteManuallyEdited = true;
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    search();
  });

  // Fires all three sections' fetches in parallel -- Section 1 (Orders) and
  // Section 2 (Subscriptions) both key off Ingram Client (their own
  // client_name data is Ingram-sourced, same as Ingram Subscriptions' own
  // page); Section 3 (Contract Services) keys off Autotask Client (Autotask
  // companyName). One of these being slow or down must not block the other
  // two -- each load*() function below catches its own errors and renders
  // its own section's status independently, so Promise.allSettled here is
  // only about running them concurrently and knowing when ALL are done (to
  // re-enable the Search button) -- not about propagating failures.
  async function search() {
    const autotaskClient = autotaskClientInput.value.trim();
    const exactClient = exactClientInput.checked;
    const ingramClient = ingramClientInput.value.trim();
    const dattoSite = dattoSiteInput.value.trim();
    const since = sinceInput.value;
    const month = monthInput.value;
    searchButton.disabled = true;
    // Clears the Client Check Summary immediately, by request -- otherwise
    // the PREVIOUS client's own comparison rows keep showing right through
    // the loads below (Subscriptions and M365 Tenancy both take a real
    // moment), which reads as this new search's own data until it isn't.
    // Subscriptions'/M365's own section tables clear themselves the same
    // way already (their own loadXxx()'s first few lines), this is just
    // the one section with no single load() of its own to do it from.
    lastSubscriptionsData = null;
    lastM365Data = null;
    lastM365UsersData = null;
    activeRenderers.renderClientCheckSummary();
    try {
      // Datto RMM has no dependency on the other sections' own results
      // (unlike Microsoft 365 Tenancy below), so it runs alongside the
      // first three rather than waiting on them.
      await Promise.allSettled([
        loadOrders(ingramClient, since),
        loadSubscriptions(ingramClient),
        loadServices(autotaskClient, exactClient, month),
        loadDattoRmm(dattoSite),
      ]);
      // Runs only after all three above have settled -- Microsoft 365
      // Tenancy's own fallback path (see loadM365Tenancy()'s comment) wants
      // the resolved Autotask name too, not just Ingram's, and that only
      // exists once Contract Services' own load has finished.
      await loadM365Tenancy();
    } finally {
      lastAutotaskClient = autotaskClient;
      lastExactClient = exactClient;
      lastIngramClient = ingramClient;
      lastIngramClientManuallyEdited = ingramClientManuallyEdited;
      lastDattoSite = dattoSite;
      lastDattoSiteManuallyEdited = dattoSiteManuallyEdited;
      lastSince = since;
      lastMonth = month;
      searchButton.disabled = false;
    }
  }

  // ---------------------------------------------------------------------
  // Client Check Summary -- a combined view at the top of the page, by
  // request ("a comparison of Ingram Subscriptions and Microsoft 365
  // Tenancy ... Later we will also add Contracts into the line"). Pure
  // client-side join of two sections' own already-fetched data (Section 2
  // -- Subscriptions, Section 4 -- Microsoft 365 Tenancy) -- no new API
  // call of its own, so it's re-rendered (via activeRenderers, same
  // staleness protection every other section here already has) every time
  // either underlying section's data changes, from whichever side arrives
  // last. Grouped by the Microsoft FRIENDLY product name (Section 4's own
  // `productName`, resolved server-side from product_mappings'
  // friendly_ms_product_name) rather than the raw Ingram Micro product
  // name -- by request, "so that matching items appear on one line": the
  // same real Microsoft product can legitimately be listed under more than
  // one Ingram Micro name, and grouping on the Ingram-side name alone
  // (the previous approach)
  // split those into separate rows repeating the identical M365 numbers.
  // A full comparison, not just "Ingram subscriptions that happen to have
  // M365 data" -- an M365 SKU with no matching Ingram subscription, and an
  // Ingram subscription with no matching M365 SKU, both still get their
  // own row (blank on whichever side didn't match) rather than being
  // silently dropped, since a missing match on either side is exactly the
  // kind of discrepancy this section exists to surface.
  // ---------------------------------------------------------------------

  // Every active-contract service/bundle line this client has, flattened
  // across however many company groups Contract Services' own response
  // has (normally just one, for a single-client search) -- the "Contract
  // (AT)" column's own match pool, by request ("Check all active
  // contracts for the product" -- Contract Services' own data is already
  // scoped to active contracts only, see its own summary line/server.js).
  function allServiceRows() {
    return (lastServicesData?.byCompany || []).flatMap((c) => c.rows);
  }

  // Real Autotask service/invoice names almost always carry a
  // billing-term or adjustment qualifier AFTER the base product name,
  // so this is a PREFIX match (same approach, same " and "/"+"
  // bundle-exclusion guard, as matchSkuByFriendlyNamePrefix() above),
  // not an exact one; an exact match against these real names would
  // almost never succeed.
  function serviceRowNameStartsWithAny(rowName, names) {
    const lower = (rowName || '').trim().toLowerCase();
    if (!lower) return false;
    for (const name of names) {
      if (!lower.startsWith(name)) continue;
      const remainder = lower.slice(name.length);
      if (/^\s+and\s/.test(remainder) || /^\s*\+/.test(remainder)) continue;
      return true;
    }
    return false;
  }

  // A real contract line whose own name marks it as a Refund or a
  // Prorate adjustment is excluded from the Contract (AT) count
  // entirely, by request -- a billing adjustment for units already
  // counted elsewhere, not a distinct standing quantity, so summing it
  // in alongside the real standing service lines would inflate the
  // count.
  function isAdjustmentLine(r) {
    return /refund|prorate/i.test(r.serviceItemName || '') || /refund|prorate/i.test(r.serviceName || '');
  }

  // A SKU's Autotask name(s) (server.js's own autotaskNames, from
  // product_mappings' server-name/invoice-name columns) matched against
  // every active contract service row's OWN name -- checked against
  // BOTH serviceItemName (the real Autotask Service name) and serviceName
  // (the invoice description) since either one can legitimately be what
  // product_mappings recorded. Grouped by contractName (summing units
  // within the same contract, in case the same service appears on it more
  // than once) -- "if it exists in more than one place" means more than
  // one real CONTRACT, by request, not just more than one matching row.
  // Falls back to the SKU's own Ingram product name(s) when
  // product_mappings has no Autotask name recorded at all, by request --
  // an Autotask contract service is occasionally named after the Ingram
  // listing rather than a Microsoft friendly name, so this still has a
  // real shot at matching instead of just going blank.
  //
  // Deliberately NOT scoped to any one Term/Billing Period split row --
  // tried that, but since M365 Licenses already always shows the full
  // cross-term total on every split row, a term-scoped Contract (AT)
  // never actually lined up with it either; showing the full breakdown
  // on every split row (same as M365 Licenses) is the more useful,
  // less confusing version. See clientCheckSummaryRowHtml()'s own
  // comment for how its total is now reconciled against IM/M365
  // instead.
  function contractMatchesForSku(sku) {
    if (!sku) return [];
    const rawNames = sku.autotaskNames && sku.autotaskNames.length > 0 ? sku.autotaskNames : (sku.ingramProductName || '').split('\n');
    const names = [...new Set(rawNames.map((n) => n.trim().toLowerCase()).filter(Boolean))];
    if (names.length === 0) return [];
    // A mid-month unit change splits a contract line's own
    // ContractServiceUnit period in two -- e.g. one day at the OLD count
    // immediately followed by the rest of the month at the NEW count --
    // and BOTH rows legitimately overlap "active this month", so both
    // arrive here. Those must collapse to ONE number (the most CURRENT
    // period), never summed together, or a routine mid-month adjustment
    // inflates the count by the old count's own leftover sliver.
    // contractServiceID/contractServiceBundleID (the line's own real FK,
    // not just contractName) is what tells two rows apart as "the same
    // line, different period" vs. "a genuinely different line" -- only
    // genuinely different lines (a separate add-on line, or a different
    // contract entirely) get summed together; same-line period rows just
    // keep whichever one started most recently.
    const byContract = new Map(); // contractName -> Map(lineKey -> latest-period row)
    for (const r of allServiceRows()) {
      if (isAdjustmentLine(r)) continue;
      const matches = serviceRowNameStartsWithAny(r.serviceItemName, names) || serviceRowNameStartsWithAny(r.serviceName, names);
      if (!matches) continue;
      const contractKey = r.contractName || '(no contract name)';
      const lineKey = r.isBundle ? `bundle:${r.contractServiceBundleID}` : `service:${r.contractServiceID}`;
      if (!byContract.has(contractKey)) byContract.set(contractKey, new Map());
      const lines = byContract.get(contractKey);
      const existing = lines.get(lineKey);
      if (!existing || r.startDate > existing.startDate) lines.set(lineKey, r);
    }
    // nextPeriodUnits -- the same per-line "count as at the start of this
    // line's own next billing period" Contract Services' own unitsCell()
    // already shows. Tracked as "known or not" (hasNextPeriod) rather
    // than defaulting to 0, since Contract Services only resolves this
    // when it found a real next-period row to look it up from -- a
    // contract with no known next period shouldn't display as "(0)".
    return [...byContract.entries()]
      .map(([contractName, lines]) => {
        const picked = [...lines.values()];
        const units = picked.reduce((n, r) => n + (r.units || 0), 0);
        const hasNextPeriod = picked.some((r) => r.nextPeriodUnits !== null && r.nextPeriodUnits !== undefined);
        const nextPeriodUnits = hasNextPeriod ? picked.reduce((n, r) => n + (r.nextPeriodUnits ?? r.units ?? 0), 0) : null;
        return { contractName, units, nextPeriodUnits };
      })
      .sort((a, b) => a.contractName.localeCompare(b.contractName));
  }

  function buildClientCheckSummaryRows() {
    const subscriptions = (lastSubscriptionsData?.byClient || []).flatMap((c) => c.subscriptions);
    const skus = lastM365Data?.matched ? lastM365Data.skus.filter((s) => !s.isFree && s.ingramProductName) : [];

    // Every Ingram Micro name a SKU's own product_mappings match(es) claim,
    // pointing back at that SKU -- '\n'-joined when ambiguous (see
    // server.js's own comment on this), same split the hover tooltip
    // already does.
    const ingramNameToSku = new Map();
    for (const sku of skus) {
      for (const name of sku.ingramProductName.split('\n')) {
        const trimmed = name.trim();
        if (trimmed) ingramNameToSku.set(trimmed.toLowerCase(), sku);
      }
    }

    // Ingram's own NCE naming convention appends a billing-term suffix onto
    // the base product name, and a hand-typed ingram_product_name can
    // likewise carry its own trailing qualifier -- neither shape has (or
    // could reasonably have) its own product_mappings row for every
    // possible suffix combination. By request ("match using the
    // friendly_ms_product_name so that matching items appear on one
    // line"): when a subscription's name isn't a KNOWN
    // ingram_product_name, it still matches a SKU when its name simply
    // STARTS WITH that SKU's own Microsoft friendly product name
    // (`productName`). Only applied when exactly one SKU's friendly name
    // prefix-matches -- an ambiguous clash (more than one candidate) is
    // left unmatched rather than guessed, same "don't guess" convention
    // server.js's own SKU matching already follows for a genuinely
    // ambiguous case.
    //
    // Real bug, confirmed: this prefix check alone also caught a
    // genuinely DIFFERENT, compound bundle subscription, wrongly merged
    // into a shorter product's own group just because it happened to
    // start with that same text. A real qualifier suffix never joins on
    // " and " or "+" right after the matched name -- only a genuinely
    // separate bundled product name does, so that specific shape is
    // excluded here.
    // Tries BOTH the SKU's Microsoft friendly name AND each of its own
    // already-known Ingram listing name(s) as the prefix, not just the
    // friendly name alone -- a Microsoft rebrand can leave product_mappings'
    // friendly_ms_product_name on the OLD name while a real subscription's
    // own name (and ingram_product_name) already use the NEW one, so the
    // two share no common prefix at all; trying the SKU's own ingram name(s)
    // too still catches it.
    function matchSkuByFriendlyNamePrefix(subName) {
      const lower = subName.trim().toLowerCase();
      const candidates = skus.filter((s) => {
        const prefixes = [s.productName, ...(s.ingramProductName || '').split('\n')]
          .map((p) => (p || '').trim().toLowerCase())
          .filter(Boolean);
        return prefixes.some((prefix) => {
          if (!lower.startsWith(prefix)) return false;
          const remainder = lower.slice(prefix.length);
          return !/^\s+and\s/.test(remainder) && !/^\s*\+/.test(remainder);
        });
      });
      return candidates.length === 1 ? candidates[0] : null;
    }

    // Strips that same trailing "(NCE ...)" qualifier back off again for
    // display -- by request, it's useful for matching but just clutter in
    // the table itself.
    function stripNceSuffix(name) {
      return (name || '').replace(/\s*\(NCE[^)]*\)\s*$/i, '').trim();
    }

    // groupKey -> { sku, subscriptions: [] } -- one entry per real
    // Microsoft product (AND, by request, per distinct Term/Billing
    // Period combination -- "only where the term / billing period
    // matches as well") this client either has an M365 SKU for, an
    // Ingram subscription for, or both. A plain product-name key alone
    // used to merge a Monthly subscription and a separate Annual one for
    // the SAME product into one row, whose own Term/Billing Period
    // column could then only show ONE of the two (picked arbitrarily)
    // next to the FULL combined license count -- misleading when the
    // two subscriptions don't carry the same number of licenses each.
    const groups = new Map();
    function groupFor(key, sku) {
      if (!groups.has(key)) groups.set(key, { sku: sku || null, subscriptions: [] });
      else if (sku && !groups.get(key).sku) groups.get(key).sku = sku;
      return groups.get(key);
    }
    // Raw term/billingPeriod (not the formatted display strings) --
    // blank when a subscription carries neither (kept in the SAME group
    // as any other blank-term subscription for that product, same as
    // before this change, rather than needlessly splitting on "no data"
    // alone).
    // Real bug, confirmed: sub.term/sub.billingPeriod are OBJECTS
    // ({type, duration} -- see formatPeriod()'s own comment further down
    // this file), not strings -- calling .trim() on them directly threw
    // a real TypeError inside buildClientCheckSummaryRows(), which is
    // exactly why Client Check Summary went completely blank and
    // Subscriptions' own "(failed to load licenses -- click to retry)"
    // kept firing: loadLicensesForClient() calls
    // activeRenderers.renderClientCheckSummary() inside its OWN try
    // block, so THIS crash was being caught by ITS catch handler and
    // misreported as a license-load failure, even though licenses
    // themselves loaded fine. formatPeriod() already turns this shape
    // into a plain display string safely -- reused here instead of
    // touching sub.term/sub.billingPeriod directly a second way.
    function termKeyFor(sub) {
      const term = formatPeriod(sub.term);
      const billing = formatPeriod(sub.billingPeriod);
      return term || billing ? `${term}|${billing}` : '';
    }
    // Every subscription decides its own group first (product + term)
    // -- a SKU is only pre-seeded into its OWN standalone group
    // afterward, and only when NO subscription claimed it at all, so a
    // SKU whose subscriptions split across two terms correctly ends up
    // attached to BOTH of those term-specific groups (each showing the
    // same real M365 Licenses/Consumed/Suspended numbers -- genuinely
    // not split by term on Microsoft's own side) instead of stranded in
    // a third, orphaned, subscription-less group of its own.
    const claimedSkus = new Set();
    for (const sub of subscriptions) {
      const key = (sub.name || '').trim().toLowerCase();
      if (!key) continue;
      const matchedSku = ingramNameToSku.get(key) || matchSkuByFriendlyNamePrefix(sub.name);
      const baseGroupKey = matchedSku ? matchedSku.productName || matchedSku.sku : sub.name;
      const tKey = termKeyFor(sub);
      const groupKey = tKey ? `${baseGroupKey}\u0000${tKey}` : baseGroupKey;
      groupFor(groupKey, matchedSku).subscriptions.push(sub);
      if (matchedSku) claimedSkus.add(matchedSku);
    }
    for (const sku of skus) {
      if (!claimedSkus.has(sku)) groupFor(sku.productName || sku.sku, sku);
    }

    const rows = [...groups.entries()].map(([groupKey, g]) => ({
      // Still the real Ingram subscription name(s) when there's a match
      // (joined, on the rare chance more than one real subscription landed
      // in the same group) -- only falls back to the Microsoft product
      // name itself when there's no Ingram side to show at all. The
      // trailing "(NCE ...)" billing-term qualifier (see
      // matchSkuByFriendlyNamePrefix()'s own comment on it) is stripped
      // here for DISPLAY only, by request -- the real sub.name used for
      // matching above is never touched. Deduped before joining -- two
      // distinct real subscriptions for the same product (e.g. an old
      // one still briefly active alongside its own renewal) can strip
      // down to the IDENTICAL display name, which should still only
      // show once.
      name: g.subscriptions.length > 0 ? [...new Set(g.subscriptions.map((s) => stripNceSuffix(s.name)))].join(' + ') : groupKey,
      subscriptions: g.subscriptions,
      sku: g.sku,
    }));
    rows.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    // Dropped entirely, by request -- a row with real numbers nowhere
    // EXCEPT Suspended isn't worth a line in the comparison (nothing to
    // actually check/reconcile: no IM subscription, no Autotask contract
    // match, nothing currently enabled or consumed in M365 -- just
    // leftover suspended licenses sitting on an otherwise-dead SKU).
    return rows.filter((row) => !isSuspendedOnlyRow(row));
  }

  function isSuspendedOnlyRow(row) {
    const sku = row.sku;
    if (!sku || !sku.suspended) return false;
    const licenseTotal = row.subscriptions.some((s) => s.licenseCount != null) ? row.subscriptions.reduce((n, s) => n + (s.licenseCount || 0), 0) : null;
    if (licenseTotal) return false;
    if (contractMatchesForSku(sku).length > 0) return false;
    if (sku.enabled) return false;
    if (sku.consumed) return false;
    return true;
  }

  function licenseTotalForRow(r) {
    return r.subscriptions.some((s) => s.licenseCount != null) ? r.subscriptions.reduce((n, s) => n + (s.licenseCount || 0), 0) : null;
  }

  // allRows is Array.map's own 3rd callback argument (the array being
  // mapped) -- renderClientCheckSummary() calls this as
  // `rows.map(clientCheckSummaryRowHtml)`, so it arrives for free, no
  // call-site change needed.
  function clientCheckSummaryRowHtml(row, _index, allRows) {
    const subs = row.subscriptions;
    // The one subscription whose own Term/Auto-Renewal/Renews/Expires
    // represents this row -- prefers an active one; arbitrary beyond that
    // (the rare case of more than one REAL subscription sharing one
    // Microsoft product, see buildClientCheckSummaryRows()'s own comment).
    const primarySub = subs.find((s) => s.status === 'active') || subs[0] || null;
    const sku = row.sku;
    const licenseTotal = licenseTotalForRow(row);
    // "Contract (AT)" -- the number of matching licenses/units on this
    // client's active Autotask contract(s) for this product, by request.
    // A single match shows its own plain number; more than one (i.e. the
    // same product billed across more than one real contract) shows each
    // contract's own count joined "NN / NN / NN", with a hover tooltip
    // listing which contract each number belongs to -- contractMatches is
    // already sorted by contractName, so the order here is stable.
    // Deliberately NOT scoped to this row's own Term/Billing Period --
    // tried that, but since M365 Licenses already always shows the FULL
    // cross-term total on every split row, a term-scoped Contract (AT)
    // never actually lines up with it either; showing the SAME full
    // breakdown on every split row (same as M365 Licenses) is the more
    // useful, less confusing version.
    const contractMatches = contractMatchesForSku(sku);
    // IM Licenses vs M365 Licenses vs Contract (AT), by request -- summed
    // ACROSS every term-split row for this same product ("ignoring
    // term"), not just this row's own partial count, since a row's own
    // partial IM total would never equal the full M365/Contract total
    // even when everything genuinely reconciles once all terms are added
    // back together.
    const siblingRows = sku ? (allRows || [row]).filter((r) => r.sku === sku) : [row];
    const imProductTotal = siblingRows.some((r) => licenseTotalForRow(r) !== null) ? siblingRows.reduce((n, r) => n + (licenseTotalForRow(r) || 0), 0) : null;
    const hasContractData = contractMatches.length > 0;
    const contractTotal = contractMatches.reduce((n, m) => n + m.units, 0);
    // Same idea as contractTotal, but using each match's own NEXT-period
    // units where known (falling back to its current units where not,
    // so a contract with no scheduled change just reproduces
    // contractTotal here rather than going null and losing the check).
    const contractNextPeriodTotal = hasContractData ? contractMatches.reduce((n, m) => n + (m.nextPeriodUnits ?? m.units), 0) : null;
    // By request: once a contract line has a known, DIFFERENT next-period
    // count (a scheduled change already entered in Autotask ahead of its
    // effective date), the comparison uses that NEXT-period total
    // instead of the current one -- the current one is expected to look
    // "off" by exactly the pending change in that case, so it's not the
    // number worth checking against IM/M365 any more.
    const usingNextPeriodTotal = hasContractData && contractNextPeriodTotal !== contractTotal;
    const contractComparisonTotal = usingNextPeriodTotal ? contractNextPeriodTotal : contractTotal;
    const knownTotals = [];
    if (imProductTotal !== null) knownTotals.push(imProductTotal);
    if (hasContractData) knownTotals.push(contractComparisonTotal);
    if (sku && sku.enabled !== null) knownTotals.push(sku.enabled);
    const threeWayMismatch = knownTotals.length > 1 && !knownTotals.every((v) => v === knownTotals[0]);
    // Each number's own "(NN)" (shown only when it differs from the
    // current count) is the count as at the start of that contract
    // line's NEXT billing period. When it's shown, IT (not the plain
    // current count beside it) is the one being compared above, so it's
    // the one that gets coloured -- red on a mismatch, green when all
    // three otherwise agree -- while the plain current count stays
    // default/grey either way. When there's no bracket at all, the plain
    // count IS the comparison, so it alone gets the red/not-red colour
    // instead. .cell-flag-red's own !important only applies to the <td>
    // itself, so it's safe to leave the OTHER number in a mismatched cell
    // with no color class at all -- it won't inherit red from the row.
    const contractCell =
      contractMatches.length === 0
        ? ''
        : `<span title="${escapeHtml(contractMatches.map((m) => `${m.contractName}: ${m.units}`).join('\n'))}">${contractMatches
            .map((m) => {
              const showBracket = m.nextPeriodUnits !== null && m.nextPeriodUnits !== m.units;
              const currentHtml = !showBracket && threeWayMismatch ? `<span class="cell-flag-red">${m.units}</span>` : String(m.units);
              const bracketHtml = showBracket
                ? ` <span class="${threeWayMismatch ? 'cell-flag-red' : 'cell-flag-green'}">(${m.nextPeriodUnits})</span>`
                : '';
              return `${currentHtml}${bracketHtml}`;
            })
            .join(' / ')}</span>`;
    // M365 Licenses vs Consumed stays its own separate check, unaffected
    // by the three-way one above -- only drives M365 Licenses' own red
    // state (OR'd with threeWayMismatch), never IM Licenses/Contract (AT).
    const consumedVsM365Mismatch = sku && sku.enabled !== null && sku.consumed !== null && sku.enabled !== sku.consumed;
    const m365Mismatch = threeWayMismatch || consumedVsM365Mismatch;
    // Suspended deliberately NOT part of this -- "If any of the 3 (ignore
    // suspended) don't match... shade the row red", same --row-warn-bg
    // paler-red row shading this page's own M365 table already uses
    // (tr.row-no-mapping, for an unmapped SKU -- "flagged row, not a hard
    // error").
    // "[Suspended]" etc. after the Subscription name, by request, when
    // the M365 Tenancy side's own status is anything other than
    // "Enabled" -- same .cell-flag-blue colour (and same `!== 'Enabled'`
    // check) that table's own Status column already uses for this.
    const statusBadge = sku && sku.status && sku.status !== 'Enabled' ? ` <span class="cell-flag-blue">[${escapeHtml(sku.status)}]</span>` : '';
    // Renews and Expires merged into one column, by request -- whichever
    // one is actually the meaningful date for this subscription (Renews
    // when it auto-renews and a renewal date is known, Expires
    // otherwise), coloured green for a Renews date and red for an
    // Expires date so which one's showing is clear without needing two
    // separate columns.
    const renewsExpiresCell = !primarySub
      ? ''
      : primarySub.autoRenews && primarySub.renewalDate
        ? `<span class="cell-flag-green">${formatDate(primarySub.renewalDate)}</span>`
        : primarySub.expirationDate
          ? `<span class="cell-flag-red">${formatDate(primarySub.expirationDate)}</span>`
          : '';
    return `
      <tr${m365Mismatch ? ' class="chk-summary-row-mismatch"' : ''}>
        <td>${escapeHtml(row.name || '')}${statusBadge}</td>
        <td class="ticket-number${threeWayMismatch ? ' cell-flag-red' : ''}">${licenseTotal ?? ''}</td>
        <td class="ticket-number">${contractCell}</td>
        <td class="ticket-number${m365Mismatch ? ' cell-flag-red' : ''}">${sku ? (sku.enabled ?? '') : ''}</td>
        <td class="ticket-number${consumedVsM365Mismatch ? ' cell-flag-red' : ''}">${sku ? (sku.consumed ?? '') : ''}</td>
        <td class="ticket-number${sku && sku.suspended ? ' cell-flag-red' : ''}">${sku ? (sku.suspended ?? '') : ''}</td>
        <td class="ticket-number">${primarySub ? `${formatPeriod(primarySub.term)} / ${formatPeriod(primarySub.billingPeriod)}` : ''}</td>
        <td class="${primarySub ? (primarySub.autoRenews ? 'cell-flag-green' : 'cell-flag-red') : ''}">${primarySub ? (primarySub.autoRenews ? 'Yes' : 'No') : ''}</td>
        <td class="ticket-number">${renewsExpiresCell}</td>
      </tr>`;
  }

  // Tech Cover Elite, by request -- a separate section, shown only when
  // this client actually has a real Autotask contract whose name STARTS
  // WITH "Tech Cover Elite" (checked against Contract Services' own
  // already-loaded rows, not re-fetched) -- by request, not an exact
  // match, so a real variant name (e.g. "Tech Cover Elite Platinum")
  // still counts.
  function hasTechCoverEliteContract() {
    return (lastServicesData?.byCompany || []).some((c) => c.rows.some((r) => (r.contractName || '').trim().toLowerCase().startsWith('tech cover elite')));
  }

  // One row per real contract LINE, by request -- collapses a line that
  // got mid-month split into two period rows (same real issue/fix as
  // Contract (AT)'s own contractMatchesForSku(): a routine unit-count
  // change shouldn't show as an extra phantom row here either) down to
  // just its own most-recently-started period, keyed on the line's real
  // FK (contractServiceID/contractServiceBundleID) within each contract.
  function techCoverEliteContractLines() {
    const linesByKey = new Map();
    for (const r of allServiceRows()) {
      if (!(r.contractName || '').trim().toLowerCase().startsWith('tech cover elite')) continue;
      const lineKey = `${r.contractId}:${r.isBundle ? `bundle:${r.contractServiceBundleID}` : `service:${r.contractServiceID}`}`;
      const existing = linesByKey.get(lineKey);
      if (!existing || r.startDate > existing.startDate) linesByKey.set(lineKey, r);
    }
    return [...linesByKey.values()].sort((a, b) => (a.serviceItemName || '').localeCompare(b.serviceItemName || ''));
  }

  // The real Autotask data carries this tag in the Internal Description
  // field (confirmed live: "[U1+U2]", "Exch Online Users [U3+U4]",
  // "[DW-U1-U2]") -- extracted verbatim for the Tag column, by request,
  // not parsed there (the TC Calc column below is where it gets
  // interpreted as a formula instead).
  function bracketPart(text) {
    const m = /\[([^\]]*)\]/.exec(text || '');
    return m ? m[1] : '';
  }

  // Shared by the Tag-as-formula column (TC Calc) and the Licensed
  // Users/RMM table below, so both read the exact same underlying
  // counts. Each of u1-u4/w/s/n/o is a number once its own source has
  // loaded, or null while it hasn't -- same "each user counts once,
  // under their SMALLEST user_level" rule as the Licensed Users table
  // (a license with no user_level mapped is ignored when picking that
  // minimum). W is Desktop + Laptop combined, N is "Network Device", O
  // is everything else (deviceType is UNCONFIRMED against this
  // account's real live payload, same caveat renderDattoRmm()'s own
  // per-type grouping already carries).
  function computeTceCounts() {
    function userMinLevel(u) {
      const levels = (u.licenses || []).map((l) => l.userLevel).filter((lvl) => lvl !== null && lvl !== undefined);
      return levels.length > 0 ? Math.min(...levels) : null;
    }
    const userLevelCount = (level) => (lastM365UsersData ? lastM365UsersData.filter((u) => userMinLevel(u) === level).length : null);
    const devices = lastDattoData ? (lastDattoData.bySite || []).flatMap((s) => s.devices) : null;
    const w = devices ? devices.filter((d) => d.deviceType === 'Desktop' || d.deviceType === 'Laptop').length : null;
    const s = devices ? devices.filter((d) => d.deviceType === 'Server').length : null;
    const n = devices ? devices.filter((d) => d.deviceType === 'Network Device').length : null;
    const o = devices ? devices.length - w - s - n : null;
    return { u1: userLevelCount(1), u2: userLevelCount(2), u3: userLevelCount(3), u4: userLevelCount(4), w, s, n, o };
  }

  // TC Calc, by request ("give it a try") -- a real small formula
  // evaluator (recursive descent, standard +/- lowest, then */, then
  // Max()/Min()/parens/identifiers), not just a flat token sum. Real
  // confirmed formulas needed this: Kraftur's own tags are
  // "Max(U*/2,U1)" and "U* - Max(U*/2,U1)" -- a function call AND
  // division, not just +/-. An identifier is "DW"/"DS"/"DN"/"DO" (that
  // DRMM count), "D*" (all 4 DRMM counts summed), "U1".."U4" (that
  // licensed-user-level count), or "U*" (all 4 user levels summed).
  // Returns '' for a blank tag, an unrecognised identifier, or any
  // parse error (never guesses at a formula it can't fully understand),
  // or null if a recognised identifier's own underlying data (Users/
  // Datto) hasn't loaded yet -- null propagates through the whole
  // expression (can't compute ANY of it without that one piece).
  function resolveTceIdentifier(tok, counts) {
    const t = tok.toUpperCase();
    if (t === 'D*') return [counts.w, counts.s, counts.n, counts.o].some((x) => x === null) ? null : counts.w + counts.s + counts.n + counts.o;
    if (t === 'U*') return [counts.u1, counts.u2, counts.u3, counts.u4].some((x) => x === null) ? null : counts.u1 + counts.u2 + counts.u3 + counts.u4;
    if (t === 'DW') return counts.w;
    if (t === 'DS') return counts.s;
    if (t === 'DN') return counts.n;
    if (t === 'DO') return counts.o;
    if (t === 'U1') return counts.u1;
    if (t === 'U2') return counts.u2;
    if (t === 'U3') return counts.u3;
    if (t === 'U4') return counts.u4;
    return undefined; // unrecognised
  }
  // Tokenizes against an explicit allow-list (identifiers/function names/
  // numbers/parens/operators) rather than a generic letter pattern --
  // anything that doesn't cleanly tokenize this way (a typo, a genuinely
  // different convention) throws, which tcCalcForTag() below turns into
  // a blank cell instead of a wrong guess.
  function tokenizeTceFormula(text) {
    const cleaned = text.replace(/\s+/g, '');
    if (!cleaned) return [];
    const re = /DW|DS|DN|DO|D\*|U1|U2|U3|U4|U\*|MAX|MIN|\d+(?:\.\d+)?|[()+\-*/,]/gi;
    const tokens = [];
    let lastEnd = 0;
    let m;
    while ((m = re.exec(cleaned))) {
      if (m.index !== lastEnd) throw new Error('unrecognised text in formula');
      tokens.push(m[0]);
      lastEnd = re.lastIndex;
    }
    if (lastEnd !== cleaned.length) throw new Error('unrecognised trailing text in formula');
    return tokens;
  }
  // Standard recursive-descent precedence: expr (+/-) over term (*//)
  // over factor (a number, an identifier, Max(...)/Min(...), a
  // parenthesized expr, or a unary minus). null short-circuits through
  // every combine() -- a sub-expression that can't be computed yet
  // means the WHOLE formula can't be, not a guessed partial answer.
  function evaluateTceFormula(tokens, counts) {
    let pos = 0;
    const peek = () => tokens[pos];
    const combine = (a, b, fn) => (a === null || b === null ? null : fn(a, b));
    function parseExpr() {
      let value = parseTerm();
      while (peek() === '+' || peek() === '-') {
        const op = tokens[pos++];
        value = combine(value, parseTerm(), op === '+' ? (a, b) => a + b : (a, b) => a - b);
      }
      return value;
    }
    function parseTerm() {
      let value = parseFactor();
      while (peek() === '*' || peek() === '/') {
        const op = tokens[pos++];
        // Division rounds UP to the nearest whole number, by request
        // -- Math.ceil, not a plain a/b (e.g. U*/2 for an odd U* total
        // shouldn't leave a .5 in the result).
        value = combine(value, parseFactor(), op === '*' ? (a, b) => a * b : (a, b) => Math.ceil(a / b));
      }
      return value;
    }
    function parseFactor() {
      const tok = peek();
      if (tok === undefined) throw new Error('unexpected end of formula');
      if (tok === '-') {
        pos++;
        const v = parseFactor();
        return v === null ? null : -v;
      }
      if (tok === '(') {
        pos++;
        const v = parseExpr();
        if (tokens[pos++] !== ')') throw new Error('expected )');
        return v;
      }
      if (/^(MAX|MIN)$/i.test(tok)) {
        const fn = tok.toUpperCase();
        pos++;
        if (tokens[pos++] !== '(') throw new Error('expected ( after ' + fn);
        const args = [parseExpr()];
        while (peek() === ',') {
          pos++;
          args.push(parseExpr());
        }
        if (tokens[pos++] !== ')') throw new Error('expected )');
        if (args.some((a) => a === null)) return null;
        return fn === 'MAX' ? Math.max(...args) : Math.min(...args);
      }
      if (/^\d+(\.\d+)?$/.test(tok)) {
        pos++;
        return Number(tok);
      }
      const v = resolveTceIdentifier(tok, counts);
      if (v === undefined) throw new Error('unrecognised identifier ' + tok);
      pos++;
      return v;
    }
    const result = parseExpr();
    if (pos !== tokens.length) throw new Error('unexpected trailing tokens');
    return result;
  }
  function tcCalcForTag(tag, counts) {
    const bracket = bracketPart(tag).trim();
    if (!bracket) return '';
    try {
      const tokens = tokenizeTceFormula(bracket);
      if (tokens.length === 0) return '';
      return evaluateTceFormula(tokens, counts);
    } catch {
      return ''; // couldn't parse/resolve this formula -- never guess
    }
  }

  function techCoverEliteLinesTableHtml() {
    const lines = techCoverEliteContractLines();
    if (lines.length === 0) return '<p class="status">No active Tech Cover Elite contract lines found.</p>';
    const counts = computeTceCounts();
    const rows = lines
      .map((r) => {
        const calc = tcCalcForTag(r.internalDescription, counts);
        // Contract shows the NEXT period's count when one's known, by
        // request -- only falling back to the current count when
        // there's no next-period value at all. Unit Price/Total are
        // deliberately untouched -- those are the real CURRENT billing
        // amounts, not a hypothetical future one.
        const contractCount = r.nextPeriodUnits ?? r.units;
        // Bold red on BOTH cells when they genuinely disagree, by
        // request -- only when calc resolved to a real number (never
        // for '' -- no formula to compare -- or null -- not loaded yet,
        // nothing to compare against either). Compared against the SAME
        // value Contract actually displays, so the highlight always
        // matches what's on screen.
        const mismatch = typeof calc === 'number' && calc !== contractCount;
        const mismatchClass = mismatch ? ' cell-flag-red' : '';
        const calcCell = calc === null ? '<span class="inline-subtext">Not yet loaded</span>' : calc;
        return `
      <tr>
        <td>${escapeHtml(r.serviceItemName || '')}</td>
        <td>${escapeHtml(bracketPart(r.internalDescription))}</td>
        <td class="ticket-number${mismatchClass}">${calcCell}</td>
        <td class="ticket-number${mismatchClass}">${contractCount ?? ''}</td>
        <td class="ticket-number">${formatPrice(perItem(r.price, r.units))}</td>
        <td class="ticket-number">${formatPrice(r.price)}</td>
      </tr>`;
      })
      .join('');
    return `
      <table class="chk-tce-lines-table">
        <thead><tr class="shaded-row"><th>Service Name</th><th>Tag</th><th>TC Calc</th><th>Contract</th><th>Unit Price</th><th>Total</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  // Licensed Users reads whatever "Show Users" (Microsoft 365 Tenancy's
  // own lazy toggle) has already loaded -- by request, this section
  // never fires that fetch on its own, so it shows a prompt instead of a
  // number until someone's actually clicked that button this search.
  function techCoverEliteUsersRmmTableHtml() {
    const counts = computeTceCounts();
    const usersNotLoaded = 'Click &quot;Show Users&quot;';
    const dattoNotLoaded = 'Not yet loaded';
    // "N1/N2/N3/N4 = total", by request -- the slash-joined breakdown
    // PLUS the sum of all of them (U* -- "any time you see U*, that's
    // all the U's added together"), one combined row/prompt rather than
    // 4 separate ones.
    function breakdownCell(values, notLoadedText, notLoadedClass = 'inline-subtext') {
      if (values.some((v) => v === null)) return `<span class="${notLoadedClass}">${notLoadedText}</span>`;
      return `${values.join(' | ')} = ${values.reduce((a, b) => a + b, 0)}`;
    }
    const licensedUsersCell = breakdownCell([counts.u1, counts.u2, counts.u3, counts.u4], usersNotLoaded, 'text-highlight-orange');
    const rmmCell = breakdownCell([counts.w, counts.s, counts.n, counts.o], dattoNotLoaded);
    return `
      <table class="chk-tce-table">
        <thead><tr class="shaded-row"><th>Source</th><th>Metric</th><th>Count</th></tr></thead>
        <tbody>
          <tr><td>Users-M365</td><td>Licensed Users</td><td class="ticket-number">${licensedUsersCell}</td></tr>
          <tr><td>DRMM</td><td>W/S/N/O</td><td class="ticket-number">${rmmCell}</td></tr>
        </tbody>
      </table>
    `;
  }

  function techCoverEliteSectionHtml() {
    if (!hasTechCoverEliteContract()) return '';
    // Same heading format as Client Check Summary's own (h2.chk-section-
    // heading, not the smaller section-heading--nav style this used
    // before), by request -- including an inline orange status span the
    // same way that heading's own "Loading Microsoft 365 Tenancy..."
    // does, shown here while ANY of TC Calc's own underlying counts
    // (Users/Datto) hasn't loaded yet.
    const counts = computeTceCounts();
    const stillCalculating = Object.values(counts).some((v) => v === null);
    const calculatingBadge = stillCalculating ? ' <span class="status loading chk-tce-calculating">Calculating TC Calc values...</span>' : '';
    // Two columns for the Users/RMM table alongside the shaded grey
    // notes box, same layout as before; the new per-line table sits on
    // its own row above both, since it can run to several real lines.
    return `
      <h2 class="chk-section-heading">Tech Cover Elite Check Summary${calculatingBadge}</h2>
      ${techCoverEliteLinesTableHtml()}
      <div class="chk-tce-columns">
        ${techCoverEliteUsersRmmTableHtml()}
        <div class="chk-tce-notes">
          <p><u>Calculations based on Microsoft allocated licenses and Datto RMM Devices</u></p>
          <p>Contract Counts are for Next Period</p>
          <p><strong>USERS:</strong> <span class="text-highlight-orange">U1:</span>Premium,Standard,Office E3 | <span class="text-highlight-orange">U2:</span>Basic | <span class="text-highlight-orange">U3:</span>Exch Online | <span class="text-highlight-orange">U4:</span>F3 = <span class="text-highlight-orange">U*:</span>All</p>
          <p><strong>DRMM:</strong> <span class="text-highlight-orange">DW:</span>Workstation | <span class="text-highlight-orange">DS:</span>Server | <span class="text-highlight-orange">DN:</span>Network | <span class="text-highlight-orange">DO:</span>Other | <span class="text-highlight-orange">D*:</span>All</p>
        </div>
      </div>
    `;
  }

  // Matched against the row's own RENDERED text (every column, tags
  // stripped) rather than re-deriving a separate searchable string from
  // row's raw fields -- guarantees the filter can never drift out of sync
  // with what's actually shown (a new column added to
  // clientCheckSummaryRowHtml() later is automatically filterable too,
  // with no second place to update).
  function renderClientCheckSummary() {
    const rows = buildClientCheckSummaryRows();
    const tceHtml = techCoverEliteSectionHtml();
    if (rows.length === 0) {
      summaryResultsEl.innerHTML = tceHtml;
      summaryStatusEl.hidden = false;
      summaryStatusEl.className = 'status';
      summaryStatusEl.textContent =
        lastSubscriptionsData || lastM365Data
          ? 'No comparable Ingram Subscriptions / Microsoft 365 Tenancy data found.'
          : 'Search above to see a combined Ingram Subscriptions / Microsoft 365 Tenancy comparison.';
      return;
    }
    summaryStatusEl.hidden = true;
    summaryResultsEl.innerHTML = `
      <table class="chk-summary-table">
        <thead>
          <tr>
            <th>Subscription</th><th>IM Licenses</th><th>Contract (AT)</th><th>M365 Licenses</th><th>Consumed</th><th>Suspended</th>
            <th>Term / Billing Period</th><th>Auto-Renewal</th><th>Renews / Expires</th>
          </tr>
        </thead>
        <tbody>${rows.map(clientCheckSummaryRowHtml).join('')}</tbody>
      </table>
      ${tceHtml ? `<hr class="chk-box-divider" />${tceHtml}` : ''}
    `;
  }

  // ---------------------------------------------------------------------
  // Section 1 -- Orders (Contract Checks, read-only)
  // ---------------------------------------------------------------------

  async function loadOrders(client, since) {
    ordersStatusEl.hidden = false;
    ordersStatusEl.className = 'status loading';
    ordersStatusEl.textContent = `Loading orders for "${client}"...`;
    ordersSummaryEl.hidden = true;
    ordersResultsEl.innerHTML = '';
    try {
      const params = new URLSearchParams({ client, since });
      const data = await fetchJson(`/api/check-client/orders?${params.toString()}`, 'GET');
      lastOrdersData = data;
      activeRenderers.renderOrders(data);
    } catch (err) {
      ordersStatusEl.className = 'status error';
      ordersStatusEl.textContent = `Error: ${err.message}`;
    }
  }

  function renderOrders(data) {
    updateClientLabel();
    ordersStatusEl.hidden = true;
    const statusBreakdown = Object.entries(data.statusCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([status, count]) => `${count} ${capitalize(status)}`)
      .join(', ');
    ordersSummaryEl.hidden = false;
    ordersSummaryEl.innerHTML = `<strong>${data.totalCount}</strong> order${data.totalCount === 1 ? '' : 's'} (${statusBreakdown}) across ${data.byClient.length} client${data.byClient.length === 1 ? '' : 's'} since ${data.sinceDate}`;

    ordersResultsEl.innerHTML = '';
    if (data.byClient.length === 0) {
      ordersResultsEl.innerHTML = '<p class="status">No orders found.</p>';
      return;
    }
    for (const client of data.byClient) {
      const groupEl = document.createElement('div');
      groupEl.className = 'resource-group';

      const header = document.createElement('div');
      header.className = 'resource-group-header';
      header.innerHTML = `<span>${escapeHtml(client.clientName || '(unknown)')}</span>`;
      groupEl.appendChild(header);

      const table = document.createElement('table');
      table.className = 'contract-checks-table';
      table.innerHTML = `
        <thead>
          <tr>
            <th>Order #</th><th>Type</th><th>Status</th><th>Created</th><th>Provisioned</th>
            <th>PO #</th><th>Product</th><th>Licenses</th>
            ${TOGGLE_COLUMNS.filter((c) => c.field !== 'all_done')
              .map((c) => `<th>${escapeHtml(c.label)}</th>`)
              .join('')}
            <th>Info</th><th>DONE</th>
          </tr>
        </thead>
        <tbody>${orderRowsHtml(client.orders)}</tbody>
      `;
      groupEl.appendChild(table);
      ordersResultsEl.appendChild(groupEl);
      wireOrderRowActions(groupEl);
    }
  }

  // Read-only variant of Contract Checks' own orderRowsHtml() -- no leading
  // row-select column (no bulk update, by request), every toggle checkbox
  // disabled with no change listener, PO # edit pencil dropped (nothing
  // here is editable). The PO#/ticket link itself stays -- opening Autotask
  // is navigation, not an edit.
  function orderRowsHtml(orders) {
    return orders
      .map(
        (o) => `
      <tr>
        <td class="ticket-number"><button type="button" class="wsp-icon-btn cc-history-btn" data-id="${o.id}" title="${historyIconTitle(o)}">\u{1F553}</button> ${escapeHtml(o.orderNumber)}</td>
        <td>${escapeHtml(capitalize(o.orderType))}</td>
        <td${o.status !== 'completed' ? ' class="cell-flag-blue"' : ''}>${escapeHtml(capitalize(o.status))}</td>
        <td class="ticket-number">${formatDateTime(o.creationDate)}</td>
        <td class="ticket-number">${provisionedCellHtml(o)}</td>
        <td class="ticket-number">${poNumberCellHtml(o)}</td>
        <td class="cc-product-cell">${escapeHtml((o.products || []).map((p) => p.name).join(', '))}</td>
        <td class="ticket-number">${licensesCellHtml(o)}</td>
        ${TOGGLE_COLUMNS.filter((c) => c.field !== 'all_done')
          .map((c) => `<td>${toggleCellHtml(o, c)}</td>`)
          .join('')}
        <td>${infoIconsHtml(o)}</td>
        <td>${toggleCellHtml(o, TOGGLE_COLUMNS.find((c) => c.field === 'all_done'))}</td>
      </tr>`
      )
      .join('');
  }

  function provisionedCellHtml(o) {
    if (o.status === 'cancelled') return `<span class="text-highlight-blue">Order Cancelled</span>`;
    if (o.provisioningDate) return formatDateTime(o.provisioningDate);
    if (o.status === 'processing' && o.pendingDate) {
      return `<span class="cell-flag-red">${formatDate(o.pendingDate)}</span>`;
    }
    return '';
  }

  function historyIconTitle(o) {
    const count = o.historyCount || 0;
    return `View history (${count} record${count === 1 ? '' : 's'})`;
  }

  function poNumberCellHtml(o) {
    if (!o.poNumber) return '';
    const linkOrText = o.ticketUrl
      ? `<a href="${escapeHtml(o.ticketUrl)}" target="_blank" rel="noopener" class="cc-ticket-link">${escapeHtml(o.poNumber)}</a>`
      : `<span title="Ticket not found in Autotask">${escapeHtml(o.poNumber)}</span>`;
    // Small icon after the link, by request, when this ticket's status
    // history ever passed through "Rewst - Stage Done" -- same
    // attachRewstStageDoneFlags() flag Contract Checks' own page shows
    // (check-client/server.js's /orders route calls it too, since this
    // page's Orders section bypasses that page's own GET / route where it
    // normally runs).
    // Rewst's own real logo (packages/shell/public/rewst-icon.png), by
    // request -- served as a plain static asset, same convention as
    // logo.png/favicon.png already sitting in that same folder.
    const rewstIcon = o.hasRewstStageDone
      ? `<img src="/rewst-icon.png" class="cc-rewst-icon" alt="Rewst" title="This ticket passed through Rewst - Stage Done" />`
      : '';
    // After the link, by request -- same two mutually exclusive icons
    // Contract Checks' own page shows (see that page's own poFlagIconHtml()
    // comment for the full reasoning): green check when o.poNumberManual
    // (a human already confirmed this PO#/ticket), else "?" when
    // o.ticketDateMismatch (the ticket's own creation date is more than a
    // day from the order's -- worth a second look). check-client/server.js's
    // /orders route calls attachTicketDetails() (where the mismatch is
    // computed) since this page bypasses Contract Checks' own GET / route.
    const flagIcon = o.poNumberManual
      ? `<span class="cc-po-manual-icon" title="PO # / Ticket manually entered">✓</span>`
      : o.ticketDateMismatch
        ? `<span class="cc-po-mismatch-icon" title="This ticket was created more than a day away from the order's own creation date -- worth double-checking this is the right ticket">?</span>`
        : '';
    return `${linkOrText}${flagIcon}${rewstIcon}`;
  }

  function licensesCellHtml(o) {
    const products = o.products || [];
    if (o.orderType === 'change' && products.length === 1 && typeof products[0].quantity === 'number') {
      const qty = products[0].quantity;
      const total = o.currentTotal;
      const isPendingAdd = qty > 0 && o.status === 'processing';

      if (isPendingAdd && typeof total === 'number' && qty < total) {
        const effectiveDelta = qty - total;
        return `<span class="cell-flag-red">${effectiveDelta}</span> (${total})`;
      }

      const colorClass = qty > 0 ? (isPendingAdd ? 'cell-flag-blue' : 'cell-flag-green') : qty < 0 ? 'cell-flag-red' : '';
      const sign = qty > 0 && !isPendingAdd ? '+' : '';
      const deltaHtml = colorClass ? `<span class="${colorClass}">${sign}${qty}</span>` : `${sign}${qty}`;
      return total === null || total === undefined ? deltaHtml : `${deltaHtml} (${total})`;
    }
    return escapeHtml(products.map((p) => formatLicenseEntry(p, o.orderType)).join(', '));
  }

  function formatLicenseEntry(p, orderType) {
    if (p.quantity === null || p.quantity === undefined) return '';
    if (orderType === 'change') return `${p.quantity > 0 ? '+' : ''}${p.quantity}`;
    return `${p.quantity}`;
  }

  function toggleHistoryTitle(historyArr) {
    if (!historyArr || historyArr.length === 0) return 'No history yet';
    return historyArr.map((e) => `${e.action === 'on' ? 'ON' : 'OFF'} - ${formatDateTime(e.at)} by ${e.byName}`).join('\n');
  }

  // Always disabled, no change listener -- read-only by request. `checked`
  // and the hover-history tooltip (the native `title` attribute) are pure
  // display and carry over unchanged from Contract Checks' own version.
  function toggleCellHtml(o, col) {
    const checked = !!o[col.atKey];
    const history = o.toggleHistory && o.toggleHistory[col.field];
    return `<input type="checkbox" disabled ${checked ? 'checked' : ''} title="${escapeHtml(toggleHistoryTitle(history))}" />`;
  }

  function infoIconsHtml(o) {
    const hasQuestion = !!o.infoQuestion;
    const hasAnswer = !!o.infoAnswer;
    const hasNote = !!o.ticketNote;
    const dataAttrs = `data-id="${o.id}"`;

    let qaHtml;
    if (!hasQuestion && !hasAnswer) {
      qaHtml = `<span class="wsp-qa-icon wsp-qa-icon--q wsp-qa-icon--empty cc-info-icon" ${dataAttrs} title="No question/answer left">?</span>`;
    } else if (!hasQuestion && hasAnswer) {
      qaHtml = `<span class="wsp-qa-icon wsp-qa-icon--a wsp-qa-icon--set cc-info-icon" ${dataAttrs} title="${escapeHtml(o.infoAnswer)}">A</span>`;
    } else {
      const qIcon = `<span class="wsp-qa-icon wsp-qa-icon--q wsp-qa-icon--set cc-info-icon" ${dataAttrs} title="${escapeHtml(o.infoQuestion)}">?</span>`;
      qaHtml = hasAnswer ? `${qIcon}<span class="wsp-qa-icon wsp-qa-icon--a wsp-qa-icon--set cc-info-icon" ${dataAttrs} title="${escapeHtml(o.infoAnswer)}">A</span>` : qIcon;
    }
    const tIcon = `<span class="wsp-qa-icon wsp-qa-icon--t ${hasNote ? 'wsp-qa-icon--set' : 'wsp-qa-icon--empty'} cc-ticket-note-icon" ${dataAttrs} title="${hasNote ? escapeHtml(o.ticketNote) : 'No ticket note left'}">T</span>`;
    return `${qaHtml}${tIcon}`;
  }

  function findOrder(id) {
    if (!lastOrdersData) return null;
    for (const client of lastOrdersData.byClient) {
      const found = client.orders.find((o) => String(o.id) === String(id));
      if (found) return found;
    }
    return null;
  }

  // Same "open as a real separate window, sized/positioned on the same
  // monitor" behaviour Contract Checks' own client.js uses for its PO#
  // link, reused verbatim.
  function openInNewWindow(url) {
    const width = Math.round(window.outerWidth * 0.9);
    const height = Math.round(window.outerHeight * 0.9);
    const left = window.screenX + Math.round((window.outerWidth - width) / 2);
    const top = window.screenY + Math.round((window.outerHeight - height) / 2);
    window.open(url, '_blank', `noopener,width=${width},height=${height},left=${left},top=${top}`);
  }

  function wireOrderRowActions(groupEl) {
    groupEl.querySelectorAll('.cc-ticket-link').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        openInNewWindow(el.href);
      });
    });
    groupEl.querySelectorAll('.cc-info-icon').forEach((el) => {
      el.addEventListener('click', () => openInfoModalReadOnly(findOrder(el.dataset.id)));
    });
    groupEl.querySelectorAll('.cc-ticket-note-icon').forEach((el) => {
      el.addEventListener('click', () => openTicketNoteModalReadOnly(findOrder(el.dataset.id)));
    });
    groupEl.querySelectorAll('.cc-history-btn').forEach((el) => {
      el.addEventListener('click', () => openHistoryModal(el.dataset.id, findOrder(el.dataset.id)));
    });
  }

  // Read-only variant of Contract Checks' own openInfoModal() -- same shell,
  // fields are readonly and there's no Save button, just Close.
  function openInfoModalReadOnly(item) {
    const overlay = document.createElement('div');
    overlay.className = 'history-modal-overlay';
    const title = item ? `${item.orderNumber} -- Info` : 'Info';
    overlay.innerHTML = `
      <div class="history-modal-panel wsp-qa-modal-panel">
        <div class="history-modal-panel-header">
          <span>${escapeHtml(title)}</span>
          <button type="button" class="history-modal-close" aria-label="Close">✕</button>
        </div>
        <div class="history-modal-body">
          <label class="wsp-qa-modal-label">
            <span class="wsp-qa-icon wsp-qa-icon--q wsp-qa-icon--set">?</span>
            <input type="text" class="wsp-field" value="${escapeHtml((item && item.infoQuestion) || '')}" readonly />
          </label>
          <label class="wsp-qa-modal-label">
            <span class="wsp-qa-icon wsp-qa-icon--a wsp-qa-icon--set">A</span>
            <input type="text" class="wsp-field" value="${escapeHtml((item && item.infoAnswer) || '')}" readonly />
          </label>
          <div class="wsp-form-actions">
            <button type="button" class="cc-info-close-button">Close</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKeydown);
    };
    function onKeydown(e) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('keydown', onKeydown);
    overlay.querySelector('.history-modal-close').addEventListener('click', close);
    overlay.querySelector('.cc-info-close-button').addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
  }

  // Read-only variant of Contract Checks' own openTicketNoteModal() -- same
  // wider panel (.cc-ticket-note-modal-panel), textarea is readonly, no
  // Save/Get Template/Edit Template buttons, just Close.
  function openTicketNoteModalReadOnly(item) {
    const overlay = document.createElement('div');
    overlay.className = 'history-modal-overlay';
    const title = item ? `${item.orderNumber} -- Ticket Note` : 'Ticket Note';
    overlay.innerHTML = `
      <div class="history-modal-panel wsp-qa-modal-panel cc-ticket-note-modal-panel">
        <div class="history-modal-panel-header">
          <span>${escapeHtml(title)}</span>
          <button type="button" class="history-modal-close" aria-label="Close">✕</button>
        </div>
        <div class="history-modal-body">
          <label class="wsp-qa-modal-label wsp-qa-modal-label--top">
            <span class="wsp-qa-icon wsp-qa-icon--t wsp-qa-icon--set">T</span>
            <textarea class="wsp-field" rows="11" readonly>${escapeHtml((item && item.ticketNote) || '')}</textarea>
          </label>
          <div class="wsp-form-actions">
            <button type="button" class="cc-ticket-note-close-button">Close</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKeydown);
    };
    function onKeydown(e) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('keydown', onKeydown);
    overlay.querySelector('.history-modal-close').addEventListener('click', close);
    overlay.querySelector('.cc-ticket-note-close-button').addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
  }

  // History is already pure view-only in Contract Checks itself -- reused
  // as-is, calling that page's own public route directly (the item IDs
  // Check Client's /orders route returns come straight from Contract
  // Checks' own DB rows, so they're the exact same IDs that route expects).
  async function openHistoryModal(itemId, item) {
    const overlay = document.createElement('div');
    overlay.className = 'history-modal-overlay';
    const title = item ? `${item.orderNumber} -- History` : `Item #${itemId} -- History`;
    overlay.innerHTML = `
      <div class="history-modal-panel">
        <div class="history-modal-panel-header">
          <span>${escapeHtml(title)}</span>
          <button type="button" class="history-modal-close" aria-label="Close">✕</button>
        </div>
        <div class="history-modal-body"><p class="status loading">Loading...</p></div>
      </div>
    `;
    document.body.appendChild(overlay);
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

    try {
      const data = await fetchJson(`/api/contract-checks/items/${itemId}/history`, 'GET');
      const body = overlay.querySelector('.history-modal-body');
      if (!data.history || data.history.length === 0) {
        body.innerHTML = '<p class="status">No history found.</p>';
        return;
      }
      body.innerHTML = `<ul class="history-modal-list">${data.history.map(historyEntryHtml).join('')}</ul>`;
    } catch (err) {
      overlay.querySelector('.history-modal-body').innerHTML = `<p class="status error">Error: ${escapeHtml(err.message)}</p>`;
    }
  }

  function historyEntryHtml(entry) {
    const label = FIELD_LABELS[entry.field] || entry.field;
    let changeText;
    if (TOGGLE_FIELD_SET.has(entry.field)) {
      changeText = `${escapeHtml(label)}: ${entry.newValue ? 'ON' : 'OFF'}`;
    } else if (entry.field === 'ticket_note') {
      const block = (value) =>
        value ? `<div class="cc-history-note-block">${escapeHtml(value)}</div>` : `<div class="cc-history-note-block cc-history-note-empty">(none)</div>`;
      changeText = `<div>${escapeHtml(label)}:</div><div class="cc-history-note-label">Before</div>${block(entry.oldValue)}<div class="cc-history-note-label">After</div>${block(entry.newValue)}`;
    } else {
      changeText = `${escapeHtml(label)}: ${escapeHtml(entry.oldValue || '(none)')} → ${escapeHtml(entry.newValue || '(none)')}`;
    }
    const when = `${escapeHtml(entry.changedByName)} -- ${escapeHtml(formatDateTime(entry.changedAt))}`;
    return `<li class="history-modal-entry"><div>${changeText}</div><div class="history-modal-when">${when}</div></li>`;
  }

  // ---------------------------------------------------------------------
  // Section 2 -- Subscriptions (Ingram Subscriptions)
  // ---------------------------------------------------------------------

  async function loadSubscriptions(client) {
    subsStatusEl.hidden = false;
    subsStatusEl.className = 'status loading';
    subsStatusEl.textContent = `Loading subscriptions for "${client}"...`;
    subsSummaryEl.hidden = true;
    subsCurrentDataNoteEl.hidden = true;
    subsResultsEl.innerHTML = '';
    // Stale the moment a new search starts -- Microsoft 365 Tenancy is
    // derived from this section's (and Contract Services') own results (see
    // loadM365Tenancy() below), so the previous search's answer shouldn't
    // linger on screen while a new one is in flight.
    m365StatusEl.hidden = false;
    m365StatusEl.className = 'status loading';
    m365StatusEl.textContent = 'Waiting for Subscriptions and Contracts...';
    m365SummaryEl.hidden = true;
    m365CurrentDataNoteEl.hidden = true;
    m365ResultsEl.innerHTML = '';
    syncSummaryM365Pending();
    try {
      const params = new URLSearchParams({ client });
      const data = await fetchJson(`/api/check-client/subscriptions?${params.toString()}`, 'GET');
      lastSubscriptionsData = data;
      activeRenderers.renderSubscriptions(data);
      activeRenderers.renderClientCheckSummary();
    } catch (err) {
      subsStatusEl.className = 'status error';
      subsStatusEl.textContent = `Error: ${err.message}`;
    }
  }

  // Microsoft 365 Tenancy -- runs after Orders/Subscriptions/Contracts have
  // ALL settled (called from search() itself, not from any one section's
  // own load), since its fallback path wants Contract Services' resolved
  // Autotask name too, not just Ingram's.
  //
  // PRIMARY: joins the client's real Microsoft tenant ID (Ingram's own
  // ms_customer_id, confirmed elsewhere this session to BE the real MS
  // tenant id -- see Match IDs) against Rewst's own tenant_id field for an
  // EXACT match, by request ("use the Tenant ID from Ingram Micro... is
  // that a better choice?") -- an exact GUID join can't misfire the way
  // name matching sometimes does (e.g. "Sleepys" vs "Sleepy's Pty Ltd").
  // Needs a real Microsoft-named Ingram subscription to read the tenant id
  // off of, and exactly one resolved Ingram client (an ambiguous multi-
  // client match isn't safe to guess a subscription from).
  //
  // FALLBACK, by request ("if not found in Ingram Micro, only then try
  // Rewst"): when there's no such subscription, the resolved Autotask/
  // Ingram client NAME (preferring Autotask's, since Autotask is this
  // MSP's own system of record) is sent instead, and server.js's own
  // matchRewstCustomerByName() -- the same normalize+cascade approach
  // Match IDs' bigger cross-reference uses -- tries to find the right
  // Rewst customer that way. Server-side always tries the tenant-id path
  // first when a subscriptionId is sent, falling back to the name only if
  // that doesn't resolve -- so sending both here is safe, never a
  // name-match overriding a good tenant-id match.
  async function loadM365Tenancy() {
    m365StatusEl.hidden = false;
    m365StatusEl.className = 'status';
    m365SummaryEl.hidden = true;
    m365CurrentDataNoteEl.hidden = true;
    m365ResultsEl.innerHTML = '';

    let subscriptionId = null;
    if (lastSubscriptionsData && lastSubscriptionsData.byClient.length === 1) {
      const msSub = lastSubscriptionsData.byClient[0].subscriptions.find((s) => /microsoft/i.test(s.name));
      if (msSub) subscriptionId = msSub.id;
    }

    const autotaskNames = lastServicesData ? [...new Set(lastServicesData.byCompany.map((c) => c.companyName))] : [];
    const ingramNames = lastSubscriptionsData ? [...new Set(lastSubscriptionsData.byClient.map((c) => c.clientName))] : [];
    const clientName = autotaskNames.length === 1 ? autotaskNames[0] : ingramNames.length === 1 ? ingramNames[0] : null;

    if (!subscriptionId && !clientName) {
      m365StatusEl.textContent = 'No single client resolved above -- narrow the search to look up Microsoft 365 Tenancy.';
      syncSummaryM365Pending();
      activeRenderers.renderClientCheckSummary();
      return;
    }

    m365StatusEl.className = 'status loading';
    m365StatusEl.textContent = 'Loading Microsoft 365 Tenancy...';
    syncSummaryM365Pending();
    try {
      const params = new URLSearchParams();
      if (subscriptionId) params.set('subscriptionId', subscriptionId);
      if (clientName) params.set('clientName', clientName);
      const data = await fetchJson(`/api/check-client/m365-tenancy?${params.toString()}`, 'GET');
      lastM365Data = data;
      activeRenderers.renderM365Tenancy(data);
      activeRenderers.renderClientCheckSummary();
    } catch (err) {
      m365StatusEl.className = 'status error';
      m365StatusEl.textContent = `Error: ${err.message}`;
      syncSummaryM365Pending();
      activeRenderers.renderClientCheckSummary();
    }
  }

  function renderM365Tenancy(data) {
    if (!data.matched) {
      m365StatusEl.hidden = false;
      m365StatusEl.className = 'status';
      m365StatusEl.textContent = m365UnmatchedText(data);
      m365SummaryEl.hidden = true;
      m365CurrentDataNoteEl.hidden = true;
      m365ResultsEl.innerHTML = '';
      syncSummaryM365Pending();
      return;
    }
    m365StatusEl.hidden = true;
    syncSummaryM365Pending();
    m365SummaryEl.hidden = false;
    m365CurrentDataNoteEl.hidden = false;
    const sourceText = data.tenantSource === 'rewst-name-match' ? ' (matched by name via Rewst -- no Ingram Microsoft subscription found)' : '';
    // The client name was rendering at the line's own normal (larger)
    // font-size while the Tenant ID right beside it sits in
    // .inline-subtext's smaller 0.85em -- by request, sized to match
    // (font-size only, kept bold and at the normal text colour rather than
    // .inline-subtext's muted grey, so it still reads as the emphasised
    // "who" of the line, just no longer oversized next to the Tenant ID).
    m365SummaryEl.innerHTML = `<strong>${data.skus.length}</strong> SKU${data.skus.length === 1 ? '' : 's'} for <strong style="font-size: 0.85em">${escapeHtml(data.rewstClientName)}</strong><span class="inline-subtext"> -- Tenant ID ${escapeHtml(data.tenantId)}${sourceText}</span>`;

    m365ResultsEl.innerHTML = '';
    if (data.skus.length === 0) {
      m365ResultsEl.innerHTML = '<p class="status">No subscribed SKUs found.</p>';
      return;
    }
    // Split into the "Product Table" (everything worth checking -- real
    // paid products, PLUS anything unmapped, since the whole point of that
    // half is surfacing rows that still need a mapping) and the "Free
    // Product Table" (every mapped row product_mappings' own `free` column
    // marks as free -- Pacgold was the confirmed test case), by request --
    // a client with several free SKUs was burying the products actually
    // worth checking. The free table stays out of sight behind a button,
    // and that button only renders at all when there's at least one free
    // row to show.
    // Alphabetical by Product Name, with unmapped rows (no product_mappings
    // match at all, so no name to sort by) always pushed to the bottom
    // rather than interleaved by raw SKU -- by request. Client-side, not
    // server.js's own sort-by-raw-SKU (still there for its own reasons) --
    // this ordering only makes sense once productName is known and the
    // Free split has already happened.
    function sortM365(skus) {
      return [...skus].sort((a, b) => {
        if (!a.productName && !b.productName) return a.sku.localeCompare(b.sku);
        if (!a.productName) return 1;
        if (!b.productName) return -1;
        return a.productName.localeCompare(b.productName, undefined, { sensitivity: 'base' });
      });
    }
    const mainSkus = sortM365(data.skus.filter((s) => !s.isFree));
    const freeSkus = sortM365(data.skus.filter((s) => s.isFree));
    // Bare table (no .ingram-subscriptions-table -- that class's own
    // nth-child column widths are tuned for THAT section's 8 columns, wrong
    // fit for this one's 5), same plain-table-in-a-.resource-group pattern
    // CSP Customers' own client.js uses for its own differently-shaped table.
    // Product Name is looked up server-side from Contract Checks' own
    // product_mappings table, matched on its Microsoft SKU column. Falls
    // back to the raw SKU itself (muted, via .inline-subtext) when nothing
    // matches -- that reference table doesn't cover every SKU yet, and a
    // blank cell would read as a bug rather than "not mapped yet". The raw
    // SKU and the matched row's Ingram Micro Product Name both come back
    // too but, by request, neither is its own column -- shown only as this
    // cell's hover title, so they're there to check without taking up
    // table width.
    // .chk-m365-table -- by request, this table shouldn't stretch to the
    // page's full width the way a plain table normally does dashboard-wide
    // (table { width: 100% }); it's only 5 narrow columns, so it fits its
    // own content instead, and cells never wrap (see that class's own CSS
    // for both).
    // highlightMismatch -- Enabled vs Consumed flagged red/bold when they
    // differ, by request, but ONLY in the main (non-Free) table; the Free
    // Products table below reuses this exact same row renderer, so the
    // check is gated behind a param rather than baked into the row markup
    // itself.
    function m365RowHtml(s, highlightMismatch) {
      // The "[N]" ambiguous-match count is its own span (reusing
      // .text-highlight-orange -- by request, changed from the original
      // .cell-flag-red since it read too easily as an error rather than
      // just a "heads up" flag; same #f59e0b "yellowy orange" shade already
      // established dashboard-wide, not a new one-off) rather than baked
      // into the name text, so it stands out from the name itself, not
      // just read as part of it. Its own hover tooltip lists the shared MS
      // SKU once up top (every matched row has the identical one -- that's
      // what makes it ambiguous in the first place, so showing it per-row
      // would just repeat itself) then every matched row's own Ingram
      // Micro name below it, one per line -- by request. Separate from the
      // product name span's own SKU/Ingram Micro tooltip below, since this
      // one is specifically about what the [N] count actually consists of.
      const matchListTitle = s.ambiguousMatches
        ? [`[${s.ambiguousMatches[0].msSku}]`, ...s.ambiguousMatches.map((m) => m.ingramProductName)].join('\n')
        : '';
      const matchCountFlag = s.matchCount ? ` <span class="text-highlight-orange" title="${escapeHtml(matchListTitle)}">[${s.matchCount}]</span>` : '';
      // SKU column hidden by request -- the raw SKU still shows up
      // as the fallback text for an unmapped row (it's the only
      // thing to show there), and as part of a mapped row's hover
      // title alongside its Ingram Micro name(s), so it's not gone
      // entirely, just out of the table's own width.
      const titleParts = [`SKU: ${s.sku}`];
      if (s.ingramProductName) titleParts.push(`Ingram Micro: ${s.ingramProductName}`);
      const productCell = s.productName
        ? `<span title="${escapeHtml(titleParts.join('\n'))}">${escapeHtml(s.productName)}</span>${matchCountFlag}`
        : `<span class="inline-subtext">${escapeHtml(s.sku)} (no mapping)</span>`;
      // Only flagged when both counts are actually known (neither null) --
      // an unresolved count isn't a real mismatch, just missing data.
      const countsMismatch = highlightMismatch && s.enabled !== null && s.consumed !== null && s.enabled !== s.consumed;
      return `
            <tr${s.productName ? '' : ' class="row-no-mapping"'}>
              <td>${productCell}</td>
              <td${s.status !== 'Enabled' ? ' class="cell-flag-blue"' : ''}>${escapeHtml(s.status)}</td>
              <td class="ticket-number${countsMismatch ? ' cell-flag-red' : ''}">${s.enabled ?? ''}</td>
              <td class="ticket-number${countsMismatch ? ' cell-flag-red' : ''}">${s.consumed ?? ''}</td>
              <td class="ticket-number${s.suspended ? ' cell-flag-red' : ''}">${s.suspended ?? ''}</td>
            </tr>`;
    }
    function m365TableHtml(skus, highlightMismatch) {
      return `
      <table class="chk-m365-table">
        <thead>
          <tr class="shaded-row"><th>Product Name</th><th>Status</th><th>Licenses</th><th>Consumed</th><th>Suspended</th></tr>
        </thead>
        <tbody>
          ${skus.map((s) => m365RowHtml(s, highlightMismatch)).join('')}
        </tbody>
      </table>
    `;
    }

    // Display Name/Email/User Type/Status/Department/Office/Licenses, by
    // request -- Office is always blank right now (see server.js's own
    // comment on this -- the underlying Rewst workflow doesn't $select
    // officeLocation yet), shown as its own column regardless so it starts
    // working with no client-side change the moment that's added. Licenses
    // already comes back as friendly product names (server.js's own
    // ms_sku_id match), joined onto one line, comma-separated -- a
    // wrapping <td>, not .ticket-number's nowrap, since a well-licensed
    // user can easily have 4-5 products listed. User Type ("Member"/
    // "Guest", Graph's own real distinction) and Status (accountEnabled,
    // as "Enabled"/"Disabled") both added by request, confirmed live
    // against real data.
    const M365_USERS_COLUMNS = [
      { key: 'displayName', label: 'Display Name' },
      { key: 'email', label: 'Email' },
      { key: 'userType', label: 'User Type' },
      { key: 'status', label: 'Status' },
      { key: 'department', label: 'Department' },
      { key: 'office', label: 'Office' },
      { key: 'licenses', label: 'Licenses' },
    ];
    // Plain text -- used for the per-column filter match (substring
    // search still has to see every license name, free or not) and as
    // the fallback inside m365UserCellHtml() below for every column that
    // isn't 'licenses'.
    function m365UserCellText(u, key) {
      if (key === 'licenses') return u.licenses.map((l) => l.name).join(', ');
      if (key === 'status') return u.accountEnabled ? 'Enabled' : 'Disabled';
      return u[key] || '';
    }
    // Free licenses sort after the paid ones and render grey/italic in
    // brackets, by request -- only the 'licenses' column needs real HTML
    // (every other column just escapes m365UserCellText() as before).
    function m365UserCellHtml(u, key) {
      if (key !== 'licenses') return escapeHtml(m365UserCellText(u, key));
      const paid = u.licenses.filter((l) => !l.free).map((l) => escapeHtml(l.name));
      const free = u.licenses.filter((l) => l.free).map((l) => escapeHtml(l.name));
      const freeHtml = free.length ? `<span class="chk-m365-free-license">(${free.join(', ')})</span>` : '';
      return [paid.join(', '), freeHtml].filter(Boolean).join(' ');
    }
    // Red row+text for a Disabled account that STILL holds a license
    // (wasting a paid seat), orange/yellow row+text for an Enabled
    // account with NO license (a possible provisioning gap) -- by
    // request ("the red and yellow thing"). Same --row-warn-bg red tint
    // this dashboard already uses elsewhere (chk-summary-row-mismatch
    // etc.) for the red case; a parallel amber tint, new to this table,
    // for the yellow/orange case -- there's no existing dashboard-wide
    // "whole row amber" convention to reuse, only cell-level .status.warn
    // (#b45309), which this borrows for the text color.
    function m365UserRowClass(u) {
      const hasLicense = u.licenses.length > 0;
      if (!u.accountEnabled && hasLicense) return ' class="chk-m365-user-disabled-licensed"';
      // Any unlicensed row still showing here is already Enabled (the
      // server's own filter drops a Disabled+unlicensed row entirely), so
      // this plain !hasLicense check already covers Guests too -- by
      // request ("have Guest rows with no license yellow"), no separate
      // userType check needed.
      if (!hasLicense) return ' class="chk-m365-user-enabled-unlicensed"';
      return '';
    }
    // Per-column filters, by request ("filters on the column headings"),
    // not one combined box -- a second header row, one plain text input
    // per column, each ANDed together (every active filter has to match
    // for a row to show). Built as a real DOM element (not an HTML
    // string, unlike this page's other small table builders) since the
    // filter inputs need live 'input' listeners wired directly to it, not
    // just a static render.
    function buildM365UsersTable(users) {
      const wrap = document.createElement('div');
      if (users.length === 0) {
        wrap.innerHTML = '<p class="status">No users returned.</p>';
        return wrap;
      }
      const filters = {};
      const table = document.createElement('table');
      table.className = 'chk-m365-users-table';
      // The header row's own far-right edge carries the live filtered
      // match count, by request ("when the user table filters are used,
      // show a row count match in the column header like [N]", "make
      // that row count ... the same size and style as the column headers
      // and put it on the far right") -- same plain <th> text as every
      // other header (no separate color/size override), just floated to
      // the right within the LAST column's own header cell. Empty/hidden
      // until at least one filter is actually narrowing the list, see
      // renderRows() below.
      table.innerHTML = `
        <thead>
          <tr class="shaded-row">${M365_USERS_COLUMNS.map((c, i) => `<th>${escapeHtml(c.label)}${i === M365_USERS_COLUMNS.length - 1 ? ' <span class="chk-m365-users-count"></span>' : ''}</th>`).join('')}</tr>
          <tr class="chk-m365-users-filter-row">${M365_USERS_COLUMNS.map((c) => `<th><input type="text" data-filter-key="${c.key}" placeholder="Filter..." /></th>`).join('')}</tr>
        </thead>
        <tbody></tbody>
      `;
      const tbody = table.querySelector('tbody');
      const countEl = table.querySelector('.chk-m365-users-count');
      function renderRows() {
        const anyFilterActive = Object.values(filters).some(Boolean);
        const filtered = users.filter((u) =>
          M365_USERS_COLUMNS.every((c) => {
            const f = filters[c.key];
            return !f || m365UserCellText(u, c.key).toLowerCase().includes(f);
          })
        );
        countEl.textContent = anyFilterActive ? `[${filtered.length}]` : '';
        tbody.innerHTML =
          filtered.length > 0
            ? filtered.map((u) => `<tr${m365UserRowClass(u)}>${M365_USERS_COLUMNS.map((c) => `<td>${m365UserCellHtml(u, c.key)}</td>`).join('')}</tr>`).join('')
            : `<tr><td colspan="${M365_USERS_COLUMNS.length}" class="status">No users matching these filters.</td></tr>`;
      }
      table.querySelectorAll('[data-filter-key]').forEach((input) => {
        input.addEventListener('input', () => {
          filters[input.dataset.filterKey] = input.value.trim().toLowerCase();
          renderRows();
        });
      });
      renderRows();
      wrap.appendChild(table);
      return wrap;
    }

    const group = document.createElement('div');
    group.className = 'resource-group chk-m365-group';
    group.innerHTML = mainSkus.length ? m365TableHtml(mainSkus, true) : '<p class="status">No non-Free subscribed SKUs found.</p>';
    m365ResultsEl.appendChild(group);

    // Both toggle buttons sit together in one row now, by request ("put
    // the Show Users button next to the Show Free Products button" --
    // previously Show Users sat above its own users table, ahead of Show
    // Free Products, which read oddly). Same .date-form flex-row-with-gap
    // class this dashboard already uses elsewhere to group small buttons.
    const buttonRow = document.createElement('div');
    buttonRow.className = 'date-form';
    m365ResultsEl.appendChild(buttonRow);

    // "Show Users" -- a second, separate Rewst call (REWST_WEBHOOK_M365_
    // Users_URL via /api/check-client/m365-users), by request, only fired
    // the first time this button is actually clicked (not on every
    // search) -- most searches never need the user list. Toggles after
    // that first fetch, same show/hide-without-refetching convention
    // chk-m365-free-toggle below already uses. data.organisationId is the
    // SAME real Rewst Organisation ID this M365 Tenancy search already
    // resolved -- no second customer lookup needed.
    const usersToggle = document.createElement('button');
    usersToggle.type = 'button';
    usersToggle.className = 'button-link button-link--small chk-m365-users-toggle';
    usersToggle.textContent = 'Show Users';
    // Appended to buttonRow further down, AFTER Show Free Products -- by
    // request, Show Users goes second.

    const usersGroup = document.createElement('div');
    usersGroup.className = 'resource-group chk-m365-group';
    usersGroup.hidden = true;
    m365ResultsEl.appendChild(usersGroup);

    let usersLoaded = false;
    usersToggle.addEventListener('click', async () => {
      if (!usersLoaded) {
        usersToggle.disabled = true;
        usersGroup.hidden = false;
        usersGroup.innerHTML = '<p class="status">Loading users...</p>';
        try {
          const params = new URLSearchParams({ organisationId: data.organisationId });
          const usersData = await fetchJson(`/api/check-client/m365-users?${params.toString()}`, 'GET');
          usersLoaded = true;
          usersGroup.innerHTML = '';
          usersGroup.appendChild(buildM365UsersTable(usersData.users));
          // "Users (N), N Unlicensed" -- by request; the Show/Hide verb
          // in front is still swapped by the toggle handler below, same
          // as before, so this keeps working across repeat clicks.
          const unlicensedCount = usersData.users.filter((u) => (u.licenses || []).length === 0).length;
          usersToggle.textContent = `Hide Users (${usersData.users.length}), ${unlicensedCount} Unlicensed`;
          // Tech Cover Elite's own licensed-users count reads this --
          // refreshed now that it's actually available, same "each
          // independent load renders the Summary on ITS OWN completion"
          // convention every other section here already follows.
          lastM365UsersData = usersData.users;
          activeRenderers.renderClientCheckSummary();
        } catch (err) {
          usersGroup.innerHTML = `<p class="status error">Error: ${escapeHtml(err.message)}</p>`;
        } finally {
          usersToggle.disabled = false;
        }
        return;
      }
      usersGroup.hidden = !usersGroup.hidden;
      usersToggle.textContent = usersGroup.hidden ? usersToggle.textContent.replace('Hide', 'Show') : usersToggle.textContent.replace('Show', 'Hide');
    });

    if (freeSkus.length) {
      const freeToggle = document.createElement('button');
      freeToggle.type = 'button';
      freeToggle.className = 'button-link button-link--small chk-m365-free-toggle';
      freeToggle.textContent = `Show Free Products (${freeSkus.length})`;
      buttonRow.appendChild(freeToggle);

      const freeGroup = document.createElement('div');
      freeGroup.className = 'resource-group chk-m365-group';
      freeGroup.hidden = true;
      freeGroup.innerHTML = m365TableHtml(freeSkus, false);
      m365ResultsEl.appendChild(freeGroup);

      freeToggle.addEventListener('click', () => {
        freeGroup.hidden = !freeGroup.hidden;
        freeToggle.textContent = freeGroup.hidden ? `Show Free Products (${freeSkus.length})` : `Hide Free Products (${freeSkus.length})`;
      });
    }

    buttonRow.appendChild(usersToggle);
  }

  function m365UnmatchedText(data) {
    if (data.reason === 'no-rewst-customer') {
      return data.tenantId
        ? `No Rewst customer found with tenant ID ${data.tenantId} -- this client may not be set up in Rewst yet.`
        : 'No Microsoft-named Ingram subscription and no name match in Rewst -- this client may not be set up in Rewst yet.';
    }
    if (data.reason === 'no-organisation-id') return `Rewst customer "${data.rewstClientName}" has no linked Organisation -- can’t look up licenses.`;
    return 'Could not resolve Microsoft 365 Tenancy for this client.';
  }

  function renderSubscriptions(data) {
    updateClientLabel();
    subsStatusEl.hidden = true;
    const statusBreakdown = STATUS_ORDER.filter((s) => data.statusCounts[s] > 0)
      .map((s) => `${data.statusCounts[s]} ${STATUS_LABELS[s]}`)
      .join(', ');
    subsSummaryEl.hidden = false;
    subsSummaryEl.innerHTML = `<strong>${data.totalCount}</strong> subscriptions (${statusBreakdown}) across ${data.byClient.length} client${data.byClient.length === 1 ? '' : 's'}<span class="inline-subtext"> -- as of ${formatDateTime(data.asOf)}</span>`;
    subsCurrentDataNoteEl.hidden = false;

    subsResultsEl.innerHTML = '';
    if (data.byClient.length === 0) {
      subsResultsEl.innerHTML = '<p class="status">No active or pending subscriptions found.</p>';
      return;
    }
    for (const client of data.byClient) {
      const groupEl = document.createElement('div');
      groupEl.className = 'resource-group';

      const header = document.createElement('div');
      header.className = 'resource-group-header';
      header.innerHTML = `
        <span><button type="button" class="link-button client-name-button">${escapeHtml(client.clientName)}</button></span>
        <span class="count">${client.count} subscription${client.count === 1 ? '' : 's'}</span>
      `;
      const nameButton = header.querySelector('.client-name-button');
      // Click still works as a manual retry (loadLicensesForClient()'s own
      // guard skips it once already loaded), but no longer the ONLY way to
      // trigger it -- by request, licenses load automatically here rather
      // than waiting for a click. Unlike Ingram Subscriptions' own page
      // (where a broad, unfiltered search can return dozens of clients,
      // making an eager per-client license fetch expensive), Check Client
      // is already scoped to a specific client search, so this is cheap.
      nameButton.addEventListener('click', () => loadLicensesForClient(client, groupEl, nameButton));
      groupEl.appendChild(header);

      const table = document.createElement('table');
      table.className = 'ingram-subscriptions-table';
      table.innerHTML = `
        <thead>
          <tr><th>Subscription</th><th>Status</th><th>Auto-Renewal</th><th>Licenses</th><th>Term / Billing Period</th><th>Created</th><th>Renews</th><th>Expires</th></tr>
        </thead>
        <tbody>${subscriptionRowsHtml(client.subscriptions)}</tbody>
      `;
      groupEl.appendChild(table);
      subsResultsEl.appendChild(groupEl);
      loadLicensesForClient(client, groupEl, nameButton);
    }
  }

  function subscriptionRowsHtml(subscriptions) {
    return subscriptions
      .map(
        (s) => `
      <tr>
        <td>${escapeHtml(s.name)}</td>
        <td${s.status === 'pending' ? ' class="cell-flag-blue"' : ''}>${escapeHtml(s.status === 'hold' ? 'On Hold' : capitalize(s.status))}</td>
        <td class="${s.autoRenews ? 'cell-flag-green' : 'cell-flag-red'}">${s.autoRenews ? 'Yes' : 'No'}</td>
        <td class="ticket-number">${s.licenseCount ?? ''}</td>
        <td class="ticket-number">${formatPeriod(s.term)} / ${formatPeriod(s.billingPeriod)}</td>
        <td class="ticket-number">${formatDate(s.creationDate)}</td>
        <td class="ticket-number">${formatDate(s.renewalDate)}</td>
        <td class="ticket-number">${formatDate(s.expirationDate)}</td>
      </tr>`
      )
      .join('');
  }

  // Same on-demand per-client license lookup Ingram Subscriptions' own
  // client.js uses -- calls that page's own public /licenses route
  // directly (needs no proxy through check-client's server).
  async function loadLicensesForClient(client, groupEl, nameButton) {
    if (client.licensesLoaded || nameButton.disabled) return;
    nameButton.disabled = true;
    nameButton.textContent = `${client.clientName} (loading licenses...)`;
    try {
      const ids = client.subscriptions.map((s) => s.id).join(',');
      const data = await fetchJson(`/api/ingram-subscriptions/licenses?ids=${encodeURIComponent(ids)}`, 'GET');
      for (const s of client.subscriptions) {
        s.licenseCount = data.licenseCounts[s.id] ?? null;
      }
      client.licensesLoaded = true;
      groupEl.querySelector('tbody').innerHTML = subscriptionRowsHtml(client.subscriptions);
      nameButton.textContent = client.clientName;
      // IM Licenses on the Client Check Summary above comes from this same
      // client.subscriptions data -- refresh it now that licenseCount has
      // actually arrived (it's still null/blank at the time
      // renderClientCheckSummary() first ran, right after Subscriptions
      // itself loaded).
      activeRenderers.renderClientCheckSummary();
    } catch (err) {
      nameButton.textContent = `${client.clientName} (failed to load licenses -- click to retry)`;
    } finally {
      nameButton.disabled = false;
    }
  }

  // Ingram's term/billing-period shape is {type: 'month'|'year'|..., duration: N}.
  function formatPeriod(period) {
    if (!period) return '';
    const { type, duration } = period;
    if (duration === 1) {
      if (type === 'month') return 'Monthly';
      if (type === 'year') return 'Annual';
      if (type === 'day') return 'Daily';
    }
    return `${duration} ${type}${duration === 1 ? '' : 's'}`;
  }

  // ---------------------------------------------------------------------
  // Section 3 -- Contract Services (current month by default)
  // ---------------------------------------------------------------------

  async function loadServices(client, exactClient, month) {
    servicesStatusEl.hidden = false;
    servicesStatusEl.className = 'status loading';
    servicesStatusEl.textContent = `Loading services active in ${formatMonth(month)}...`;
    servicesSummaryEl.hidden = true;
    servicesResultsEl.innerHTML = '';
    try {
      const params = new URLSearchParams({ client, month });
      if (exactClient) params.set('exactClient', 'true');
      const data = await fetchJson(`/api/check-client/services?${params.toString()}`, 'GET');
      lastServicesData = data;
      activeRenderers.renderServices(data);
      // Real bug, confirmed: this was the ONE section whose own load()
      // never re-rendered the Client Check Summary at all. Contract (AT)
      // reads straight off lastServicesData (contractMatchesForSku()),
      // and loadServices() runs CONCURRENTLY with loadSubscriptions() (see
      // search()'s own Promise.allSettled) -- whichever of the two
      // happened to resolve first before THIS fix determined whether the
      // Summary's very next render saw fresh Services data or not, which
      // is exactly why Contract (AT) showed up correctly some loads and
      // went blank on others for the SAME client, purely on network
      // timing. Now every one of Subscriptions/M365/Services calls this
      // on its own completion, so whichever finishes LAST always leaves
      // the Summary showing fully-current data regardless of order.
      activeRenderers.renderClientCheckSummary();
    } catch (err) {
      servicesStatusEl.className = 'status error';
      servicesStatusEl.textContent = `Error: ${err.message}`;
      activeRenderers.renderClientCheckSummary();
    }
  }

  function renderServices(data) {
    updateClientLabel();
    servicesStatusEl.hidden = true;
    servicesSummaryEl.hidden = false;
    servicesSummaryEl.innerHTML = `<strong>${data.totalCount}</strong> service item${data.totalCount === 1 ? '' : 's'} active in ${formatMonth(data.month)} (active contracts only)`;

    if (data.totalCount === 0) {
      servicesResultsEl.innerHTML = '<p class="status">No matching service items.</p>';
      return;
    }
    servicesResultsEl.innerHTML = '';
    for (const group of data.byCompany) {
      const groupEl = document.createElement('div');
      groupEl.className = 'resource-group';

      const header = document.createElement('div');
      header.className = 'resource-group-header';
      header.innerHTML = `<span>${escapeHtml(group.companyName)}</span><span class="count">${group.count} item${group.count === 1 ? '' : 's'}</span>`;
      groupEl.appendChild(header);

      const table = document.createElement('table');
      table.className = 'contract-services-table';
      table.innerHTML = `
        <thead>
          <tr><th>Service</th><th>Contract</th><th title="Bracketed figure is the unit count for the 1st of next month, where already known">Units</th><th>Cost</th><th>Sell</th><th>Total</th><th>Period</th><th>Last Changed</th></tr>
        </thead>
        <tbody>
          ${group.rows
            .map(
              // Rows arrive already sorted by contractName within a company
              // (contract-services/server.js's shared buildReport()), so
              // equal names are always contiguous -- same "differs from the
              // row right above it" boundary check Contract Services' own
              // client.js uses.
              (r, i) => `
            <tr${rowClass(r, i > 0 && r.contractName !== group.rows[i - 1].contractName)}>
              <td><div class="col-service" title="${escapeHtml(r.serviceName)}"><span class="col-service-name">${formatServiceName(r.serviceItemName)}</span>${r.internalDescription ? `<span class="cell-subtext">${escapeHtml(r.internalDescription)}</span>` : ''}</div></td>
              <td class="col-contract">${contractLink(r)}</td>
              <td class="ticket-number">${unitsCell(r)}</td>
              <td class="ticket-number">${formatPrice(perItem(r.cost, r.units))}</td>
              <td class="ticket-number">${formatPrice(perItem(r.price, r.units))}</td>
              <td class="ticket-number">${formatPrice(r.price)}</td>
              <td class="ticket-number">${formatServiceDate(r.startDate)} - ${formatServiceDate(r.endDate)}</td>
              <td class="ticket-number${isRecentChange(r.contractLastModified) ? ' cell-flag-red' : ''}" title="Contract's last-modified date -- the service unit itself has no modification timestamp">${formatServiceDate(r.contractLastModified)}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      `;
      groupEl.appendChild(table);
      servicesResultsEl.appendChild(groupEl);
      wireServiceRowActions(groupEl, group);
    }
  }

  // Finds the real row object a click's data-* attributes point at --
  // `group` is already the exact object rendered (not re-derived from
  // lastServicesData), same reasoning wireOrderRowActions()'s own
  // findOrder() has for going straight to what's on screen.
  function wireServiceRowActions(groupEl, group) {
    groupEl.querySelectorAll('.chk-units-clickable').forEach((el) => {
      el.addEventListener('click', () => {
        const unitId = el.dataset.unitId;
        const isBundle = el.dataset.isBundle === '1';
        const row = group.rows.find((r) => String(r.id) === unitId && !!r.isBundle === isBundle);
        if (row) openAdjustUnitsModal(row);
      });
    });
  }

  function formatServiceName(name) {
    return escapeHtml(name).replace(/\s+(AVC\d+)(?!.*AVC\d+)/i, '<br>$1');
  }

  function rowClass(r, isContractBoundary) {
    const classes = [];
    if (isContractBoundary) classes.push('row-contract-boundary');
    if (r.nextPeriodUnits === null) classes.push('row-no-next-period');
    else if (r.nextPeriodUnits !== r.units) classes.push('row-units-changed');
    return classes.length ? ` class="${classes.join(' ')}"` : '';
  }

  function unitsCell(r) {
    const current = escapeHtml(r.units);
    const bracket =
      r.nextPeriodUnits === null
        ? ''
        : ` <span class="inline-subtext${r.nextPeriodUnits < r.units ? ' cell-flag-red' : r.nextPeriodUnits > r.units ? ' cell-flag-green' : ''}">(${escapeHtml(r.nextPeriodUnits)})</span>`;
    const inner = `${current}${bracket}`;
    // Clickable only for a Contract Manager (server-supplied isManager flag
    // on lastServicesData, checked here rather than trusting a stale copy)
    // -- everyone else sees this exact cell unchanged. By request, the
    // click target is a small pencil icon IN FRONT of the number (not the
    // number itself); the number stays plain text, no dotted-underline.
    // Same real pencil-outline SVG path + .wsp-icon-btn shell that
    // contract-checks/client.js's own ticket-number edit button already
    // uses (a currentColor SVG recolors with CSS, unlike a colored emoji
    // glyph, which is why that one moved off emoji too). Identifying
    // fields for openAdjustUnitsModal() below are on the button itself via
    // data-* rather than a separate id-lookup helper -- this row's own
    // `r.id` is a raw Autotask entity id shared across two different
    // entity types (ContractServiceUnit/ContractServiceBundleUnit in the
    // same flat rows array), so isBundle travels with it too rather than
    // relying on `id` alone to stay unique.
    if (!lastServicesData?.isManager) return inner;
    const icon = `<button type="button" class="wsp-icon-btn chk-units-clickable" data-company-id="${escapeHtml(String(r.companyId))}" data-unit-id="${escapeHtml(String(r.id))}" data-is-bundle="${r.isBundle ? '1' : '0'}" title="Adjust units"><svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a.9959.9959 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg></button>`;
    return `${icon} ${inner}`;
  }

  // The date-only ISO string (YYYY-MM-DD) for the start of this row's own
  // NEXT billing period -- one day after the CURRENT period's own
  // endDate, regardless of whether a real ContractServiceUnits row exists
  // for it yet (most don't, until either Autotask's own billing run
  // creates one or an adjustment like this page's own does) --
  // deterministic from the row's own endDate alone. Shared by the
  // Contract column's own "(next billing date)" annotation below and the
  // adjust-units popup's own date default.
  function nextPeriodStartISO(row) {
    const d = new Date(row.endDate);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  }

  function contractLink(r) {
    const label = escapeHtml(r.contractName);
    // By request -- the contract's own next billing date, so it's visible
    // without having to open the adjust-units popup just to see it.
    const nextBilling = ` <span class="inline-subtext">(${formatServiceDate(nextPeriodStartISO(r))})</span>`;
    if (!r.contractUrl) return `${label}${nextBilling}`;
    return `<a href="${escapeHtml(r.contractUrl)}" target="_blank" rel="noopener noreferrer" onclick="window.open(this.href, '_blank', 'noopener,noreferrer,width=1200,height=900'); return false;">${label}</a>${nextBilling}`;
  }

  function formatMonth(month) {
    if (!month) return '';
    const [y, m] = month.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'Australia/Brisbane' });
  }

  // Contract Services' own rows carry real ISO datetimes (not date-only
  // strings), so this is a plain local-timezone parse -- kept as its own
  // function (not `formatDate` below) since that one is deliberately
  // AEST-anchored for the date-ONLY strings Orders/Subscriptions use.
  function formatServiceDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString();
  }

  function isRecentChange(iso) {
    if (!iso) return false;
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    return new Date(iso) >= thirtyDaysAgo;
  }

  function formatPrice(value) {
    if (value === null || value === undefined) return '';
    return '$' + Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function perItem(total, units) {
    if (total === null || total === undefined || !units) return total;
    return total / units;
  }

  // By request: default Effective Date is THIS row's own next billing
  // period start (nextPeriodStartISO() above) -- UNLESS today (AEST,
  // same Date.now() + 10h approximation defaultSinceISO() above already
  // uses elsewhere on this page, not DST-aware) is still within 5 days
  // after this row's own CURRENT period started (r.startDate -- "the last
  // effective date"), in which case default to THAT date instead. Same
  // "just after a period boundary probably means THIS period, not the
  // next one" intent the original version of this rule had -- that one
  // was anchored to calendar-month day-of-month (1st-4th); this one's
  // anchored to the row's own real period dates instead, since a period
  // only USUALLY starts on the 1st of a month (every monthly service
  // does, confirmed against real data -- but an annual/quarterly line's
  // own period boundary can fall on any date).
  function defaultEffectiveDateForRow(row) {
    const aestNow = new Date(Date.now() + 10 * 60 * 60 * 1000);
    // Whole-CALENDAR-DAY difference, not raw millisecond math -- comparing
    // the AEST-shifted "now" directly against row.startDate's own
    // unshifted UTC-midnight value produced a real boundary bug (5 days
    // in read as 5.4 fractional days, wrongly tipping into "next" a whole
    // day early); both sides are reduced to a plain UTC-midnight
    // calendar-date key first so only whole days are ever compared.
    const todayKey = Date.UTC(aestNow.getUTCFullYear(), aestNow.getUTCMonth(), aestNow.getUTCDate());
    const lastEffective = new Date(row.startDate);
    const lastKey = Date.UTC(lastEffective.getUTCFullYear(), lastEffective.getUTCMonth(), lastEffective.getUTCDate());
    const daysSinceLast = Math.round((todayKey - lastKey) / 86400000);
    if (daysSinceLast >= 0 && daysSinceLast <= 5) return lastEffective.toISOString().slice(0, 10);
    return nextPeriodStartISO(row);
  }

  // First popup -- Effective Date / +- / Units, by request. `prefill` is
  // only passed when returning here via the confirmation popup's own Back
  // button, so a Back-then-forward round trip never loses what was typed.
  // Shared 3-line heading for both adjust-units popups -- Client Name
  // (green, same #16a34a as .chk-section-heading elsewhere on this page),
  // Contract Name (plain text color, not a literal black, so it still
  // reads in dark mode), Service/Item name (orange, same #f59e0b this
  // page's own "Loading..." status text already uses) -- by request.
  // Service/Item line uses row.serviceItemName (the real Autotask Service's
  // own name), NOT row.serviceName (an invoice description, which can be
  // generic/shared across different services billed the same way) -- the
  // whole point of this popup is confirming exactly which item is being
  // changed.
  function adjustModalHeadingHtml(row) {
    return `
      <div class="chk-adjust-modal-heading">
        <div class="chk-adjust-modal-client">${escapeHtml(row.companyName)}</div>
        <div class="chk-adjust-modal-contract">${escapeHtml(row.contractName)}</div>
        <div class="chk-adjust-modal-service">${escapeHtml(row.serviceItemName)}</div>
      </div>`;
  }

  function openAdjustUnitsModal(row, prefill) {
    const overlay = document.createElement('div');
    overlay.className = 'history-modal-overlay';
    const sign = prefill?.sign ?? 1;
    overlay.innerHTML = `
      <div class="history-modal-panel chk-adjust-units-modal-panel">
        <div class="history-modal-panel-header">
          ${adjustModalHeadingHtml(row)}
          <button type="button" class="history-modal-close" aria-label="Close">✕</button>
        </div>
        <div class="history-modal-body">
          <label class="chk-adjust-field-label">
            Effective Date
            <input type="date" class="wsp-field chk-adjust-date-input" value="${escapeHtml(prefill?.effectiveDate || defaultEffectiveDateForRow(row))}" />
          </label>
          <div class="chk-adjust-sign-row">
            <button type="button" class="chk-adjust-sign-button${sign === 1 ? ' chk-adjust-sign-button--active' : ''}" data-sign="1">+ Add</button>
            <button type="button" class="chk-adjust-sign-button${sign === -1 ? ' chk-adjust-sign-button--active' : ''}" data-sign="-1">&minus; Remove</button>
          </div>
          <label class="chk-adjust-field-label">
            Units
            <input type="number" min="1" step="1" class="wsp-field chk-adjust-units-input" placeholder="0" value="${prefill?.unitsAmount || ''}" />
          </label>
          <p class="status error chk-adjust-modal-error" hidden></p>
          <div class="wsp-form-actions">
            <button type="button" class="button-link chk-adjust-save-button" disabled>Save</button>
            <button type="button" class="chk-adjust-exit-button">Exit</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKeydown);
    };
    function onKeydown(e) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('keydown', onKeydown);
    overlay.querySelector('.history-modal-close').addEventListener('click', close);
    overlay.querySelector('.chk-adjust-exit-button').addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    let currentSign = sign;
    const signButtons = [...overlay.querySelectorAll('.chk-adjust-sign-button')];
    const dateInput = overlay.querySelector('.chk-adjust-date-input');
    const unitsInput = overlay.querySelector('.chk-adjust-units-input');
    const saveButton = overlay.querySelector('.chk-adjust-save-button');

    signButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        currentSign = Number(btn.dataset.sign);
        signButtons.forEach((b) => b.classList.toggle('chk-adjust-sign-button--active', b === btn));
      });
    });
    // Save greyed out with no units, exactly as specified -- a non-numeric
    // or zero amount is treated the same as empty, not a parse error.
    function updateSaveEnabled() {
      const amount = Number(unitsInput.value);
      saveButton.disabled = !unitsInput.value || !Number.isFinite(amount) || amount <= 0;
    }
    unitsInput.addEventListener('input', updateSaveEnabled);
    updateSaveEnabled();

    saveButton.addEventListener('click', () => {
      const effectiveDate = dateInput.value;
      const unitsAmount = Math.trunc(Number(unitsInput.value));
      const errorEl = overlay.querySelector('.chk-adjust-modal-error');
      if (!effectiveDate) {
        errorEl.hidden = false;
        errorEl.textContent = 'Effective Date is required.';
        return;
      }
      close();
      openAdjustUnitsConfirmModal(row, effectiveDate, currentSign, unitsAmount);
    });
    unitsInput.focus();
  }

  // Second popup -- by request, shows current (red) vs new (green) units,
  // cost, and sell before anything is actually sent, since a real Autotask
  // ContractServiceAdjustment can never be edited or deleted once created
  // (only reversed by a later opposite adjustment). New Cost/Sell are
  // computed from THIS row's own already-known per-unit rate
  // (perItem(cost/price, units) -- confirmed live against real contract
  // data that these divide evenly), not a separate fetch -- Autotask itself
  // prices the real adjustment the same way server-side, since
  // adjustedUnitPrice/adjustedUnitCost are deliberately never sent (see
  // contract-services/server.js's own adjustUnits()).
  function openAdjustUnitsConfirmModal(row, effectiveDate, sign, unitsAmount) {
    const unitChange = sign * unitsAmount;
    // By request: when a change is already pending for the next period
    // (row.nextPeriodUnits -- the same value the main table's own "1 (2)"
    // bracket already shows), base New on THAT pending count rather than
    // the currently-billing row.units. The Effective Date defaults to the
    // start of next period (see defaultEffectiveDateForRow()), so a new
    // adjustment almost always stacks on top of a change already scheduled
    // to take effect then, not on top of what's billing right now -- won't
    // always net out exactly right (a chain of several pending
    // adjustments, or one effective mid-period), but reads far clearer
    // than silently basing it on the current period alone.
    const baseUnits = row.nextPeriodUnits ?? row.units;
    const newUnits = baseUnits + unitChange;
    const costRate = perItem(row.cost, row.units);
    const priceRate = perItem(row.price, row.units);
    const newCost = costRate === null || costRate === undefined ? null : costRate * newUnits;
    const newPrice = priceRate === null || priceRate === undefined ? null : priceRate * newUnits;
    // Same "current (pending)" bracket format unitsCell() already uses on
    // the main table, so the Current column here reads consistently with
    // what's already on screen behind this popup -- full size, not
    // .inline-subtext's smaller size, since on this popup the bracketed
    // number is the one the New column's own math actually uses, not a
    // secondary detail.
    const currentUnitsDisplay =
      row.nextPeriodUnits === null || row.nextPeriodUnits === row.units
        ? escapeHtml(row.units)
        : `${escapeHtml(row.units)} <span class="chk-adjust-pending-count">(${escapeHtml(row.nextPeriodUnits)})</span>`;

    const overlay = document.createElement('div');
    overlay.className = 'history-modal-overlay';
    overlay.innerHTML = `
      <div class="history-modal-panel chk-adjust-units-modal-panel">
        <div class="history-modal-panel-header">
          <div>
            ${adjustModalHeadingHtml(row)}
            <div class="chk-adjust-modal-date"><span class="chk-adjust-modal-date-label">Effective Date:</span> <span class="chk-adjust-modal-date-value">${formatServiceDate(effectiveDate)}</span></div>
          </div>
          <button type="button" class="history-modal-close" aria-label="Close">✕</button>
        </div>
        <div class="history-modal-body">
          <table class="chk-adjust-confirm-table">
            <thead><tr><th></th><th>Current</th><th>New</th></tr></thead>
            <tbody>
              <tr><td>Units</td><td class="cell-flag-red">${currentUnitsDisplay}</td><td class="cell-flag-green">${escapeHtml(newUnits)}</td></tr>
              <tr><td>Cost</td><td class="cell-flag-red">${formatPrice(row.cost)}</td><td class="cell-flag-green">${formatPrice(newCost)}</td></tr>
              <tr><td>Sell</td><td class="cell-flag-red">${formatPrice(row.price)}</td><td class="cell-flag-green">${formatPrice(newPrice)}</td></tr>
            </tbody>
          </table>
          <p class="status error chk-adjust-modal-error" hidden></p>
          <div class="wsp-form-actions">
            <button type="button" class="button-link chk-adjust-confirm-button">Confirm</button>
            <button type="button" class="chk-adjust-back-button">Back</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
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
    overlay.querySelector('.chk-adjust-back-button').addEventListener('click', () => {
      close();
      openAdjustUnitsModal(row, { effectiveDate, sign, unitsAmount });
    });

    const confirmButton = overlay.querySelector('.chk-adjust-confirm-button');
    confirmButton.addEventListener('click', async () => {
      const errorEl = overlay.querySelector('.chk-adjust-modal-error');
      errorEl.hidden = true;
      confirmButton.disabled = true;
      confirmButton.textContent = 'Saving...';
      try {
        await fetchJson('/api/check-client/services/adjust-units', 'POST', {
          contractId: row.contractId,
          serviceId: row.serviceId,
          contractServiceID: row.contractServiceID,
          contractServiceBundleID: row.contractServiceBundleID,
          isBundle: row.isBundle,
          effectiveDate,
          unitChange,
        });
        close();
        await loadServices(autotaskClientInput.value.trim(), exactClientInput.checked, monthInput.value);
      } catch (err) {
        errorEl.hidden = false;
        errorEl.textContent = `Error: ${err.message}`;
        confirmButton.disabled = false;
        confirmButton.textContent = 'Confirm';
      }
    });
  }

  // ---------------------------------------------------------------------
  // Section 5 -- Datto RMM (devices & open alerts), read-only
  // ---------------------------------------------------------------------

  async function loadDattoRmm(site, force) {
    dattoStatusEl.hidden = false;
    dattoStatusEl.className = 'status';
    dattoSummaryEl.hidden = true;
    dattoCurrentDataNoteEl.hidden = true;
    dattoResultsEl.innerHTML = '';
    if (!site) {
      dattoStatusEl.textContent = 'Type a Datto Site above (defaults to Autotask Client) to look up devices.';
      return;
    }
    dattoStatusEl.className = 'status loading';
    dattoStatusEl.textContent = `Loading Datto RMM devices for "${site}"...`;
    try {
      const params = new URLSearchParams({ site });
      if (force) params.set('force', 'true');
      const data = await fetchJson(`/api/check-client/datto-rmm?${params.toString()}`, 'GET');
      lastDattoData = data;
      activeRenderers.renderDattoRmm(data);
    } catch (err) {
      dattoStatusEl.className = 'status error';
      dattoStatusEl.textContent = `Error: ${err.message}`;
    }
  }

  function renderDattoRmm(data) {
    if (!data.connected) {
      dattoStatusEl.hidden = false;
      dattoStatusEl.className = 'status';
      dattoStatusEl.textContent = 'Datto RMM is not configured in .env.';
      dattoSummaryEl.hidden = true;
      dattoCurrentDataNoteEl.hidden = true;
      dattoResultsEl.innerHTML = '';
      return;
    }
    dattoStatusEl.hidden = true;
    dattoSummaryEl.hidden = false;
    dattoCurrentDataNoteEl.hidden = false;
    const alertsText = data.alertsTotalCount > 0 ? `, ${data.alertsTotalCount} open High/Critical alert${data.alertsTotalCount === 1 ? '' : 's'}` : ', no open High/Critical alerts';
    dattoSummaryEl.innerHTML = `<strong>${data.totalDevices}</strong> device${data.totalDevices === 1 ? '' : 's'} (${data.onlineCount} online, ${data.offlineCount} offline, ${data.rebootRequiredCount} reboot required) across ${data.bySite.length} site${data.bySite.length === 1 ? '' : 's'}${alertsText}<span class="inline-subtext"> -- as of ${formatDateTime(data.asOf)}</span>`;

    dattoResultsEl.innerHTML = '';
    if (data.bySite.length === 0) {
      dattoResultsEl.innerHTML = '<p class="status">No matching Datto RMM sites found.</p>';
      return;
    }

    if (data.alertsTotalCount > 0) {
      const alertsGroup = document.createElement('div');
      alertsGroup.className = 'resource-group';
      alertsGroup.innerHTML = `
        <div class="resource-group-header"><span>Open Alerts (High/Critical)</span><span class="count">${data.alertsTotalCount}</span></div>
        <table>
          <thead>
            <tr class="shaded-row"><th>Time</th><th>Site</th><th>Priority</th><th>Device</th><th>Message</th></tr>
          </thead>
          <tbody>${alertRowsHtml(data.alerts)}</tbody>
        </table>
        ${data.alertsTruncated ? '<p class="inline-subtext" style="padding:0.5rem 1rem;">More alerts exist than shown -- the account-wide alert fetch hit its own cap.</p>' : ''}
      `;
      dattoResultsEl.appendChild(alertsGroup);
    }

    for (const site of data.bySite) {
      const groupEl = document.createElement('div');
      groupEl.className = 'resource-group';
      const header = document.createElement('div');
      header.className = 'resource-group-header';
      header.innerHTML = `<span>${escapeHtml(site.site)}</span><span class="count">${site.devices.length} device${site.devices.length === 1 ? '' : 's'}</span>`;
      groupEl.appendChild(header);

      // By request: instead of one long flat device list per site, show
      // counts by device type (Datto's own deviceType.category/type --
      // "Desktop"/"Laptop"/"Server"/"Network Device"/etc, see
      // mapDeviceSummary() in datto-rmm/lib.js), each expandable to that
      // type's own device list on click. Same real
      // .resource-group-header--toggle/.toggle-arrow collapsible
      // convention Completed Tickets/Ticket Times' own resource groups
      // already use, reused here rather than invented fresh -- collapsed
      // by default, same as those. deviceType is UNCONFIRMED against this
      // account's real live payload (see that field's own comment in
      // datto-rmm/lib.js) -- if it turns out every device falls back to
      // "Unknown", this still works, just as one bucket, until that's
      // confirmed/fixed properly.
      const byType = new Map();
      for (const d of site.devices) {
        const type = d.deviceType || 'Unknown';
        if (!byType.has(type)) byType.set(type, []);
        byType.get(type).push(d);
      }
      const types = [...byType.keys()].sort((a, b) => a.localeCompare(b));

      for (const type of types) {
        const devices = byType.get(type);
        const typeHeader = document.createElement('div');
        typeHeader.className = 'resource-group-header resource-group-header--toggle chk-datto-type-header';
        typeHeader.innerHTML = `<span><span class="toggle-arrow">▸</span>${escapeHtml(type)}</span><span class="count">${devices.length} device${devices.length === 1 ? '' : 's'}</span>`;
        groupEl.appendChild(typeHeader);

        const typeContent = document.createElement('div');
        typeContent.hidden = true;
        typeContent.innerHTML = `
          <table>
            <thead>
              <tr class="shaded-row"><th>Hostname</th><th>Online</th><th>OS</th><th>Patch Status</th><th>Last User</th><th>External IP</th><th>Last Seen</th></tr>
            </thead>
            <tbody>${deviceRowsHtml(devices)}</tbody>
          </table>
        `;
        groupEl.appendChild(typeContent);

        const arrow = typeHeader.querySelector('.toggle-arrow');
        typeHeader.addEventListener('click', () => {
          typeContent.hidden = !typeContent.hidden;
          arrow.textContent = typeContent.hidden ? '▸' : '▾';
        });
      }
      dattoResultsEl.appendChild(groupEl);
    }
  }

  function deviceRowsHtml(devices) {
    return devices
      .map(
        (d) => `
      <tr>
        <td>${escapeHtml(d.hostname)}${d.rebootRequired ? ' <span class="text-highlight-orange">(reboot required)</span>' : ''}</td>
        <td class="${d.online ? 'cell-flag-green' : 'cell-flag-red'}">${d.online ? 'Online' : 'Offline'}</td>
        <td>${escapeHtml(d.os)}</td>
        <td>${escapeHtml(d.patchStatus)}</td>
        <td>${escapeHtml(d.lastUser)}</td>
        <td class="ticket-number">${escapeHtml(d.extIpAddress || '')}</td>
        <td class="ticket-number">${formatDateTime(d.lastSeen)}</td>
      </tr>`
      )
      .join('');
  }

  function alertRowsHtml(alerts) {
    return alerts
      .map(
        (a) => `
      <tr>
        <td class="ticket-number">${formatDateTime(a.timestamp)}</td>
        <td>${escapeHtml(a.siteName)}</td>
        <td class="${a.priority === 'Critical' ? 'cell-flag-red' : 'cell-flag-blue'}">${escapeHtml(a.priority)}</td>
        <td>${escapeHtml(a.deviceName)}</td>
        <td>${escapeHtml(a.message)}</td>
      </tr>`
      )
      .join('');
  }

  // ---------------------------------------------------------------------
  // Shared boilerplate -- no shared module for this in the codebase (every
  // page keeps its own copy), so this is copied from Contract Checks'
  // own client.js.
  // ---------------------------------------------------------------------

  // This mount is now the active one -- see activeRenderers' own comment
  // up top. Registered before the restore calls below (though it wouldn't
  // matter either way -- these are hoisted function declarations, already
  // callable from the top of mount()).
  activeRenderers = { renderOrders, renderSubscriptions, renderM365Tenancy, renderServices, renderDattoRmm, renderClientCheckSummary };

  if (lastOrdersData) renderOrders(lastOrdersData);
  if (lastSubscriptionsData) renderSubscriptions(lastSubscriptionsData);
  if (lastM365Data) renderM365Tenancy(lastM365Data);
  if (lastServicesData) renderServices(lastServicesData);
  if (lastDattoData) renderDattoRmm(lastDattoData);
  renderClientCheckSummary();

  async function fetchJson(url, method, body) {
    const res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    if (res.status !== 204) data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
    return data;
  }

  function capitalize(str) {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  function formatDateTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString();
  }

  // Plain YYYY-MM-DD date (no time component) -- AEST-anchored, same
  // convention Contract Checks/Ingram Subscriptions/Orders already use for
  // their own date-only fields (pendingDate, subscription creation/renewal/
  // expiration dates).
  function formatDate(isoDateOnly) {
    if (!isoDateOnly) return '';
    return new Date(`${isoDateOnly}T00:00:00.000Z`).toLocaleDateString(undefined, { timeZone: 'Australia/Brisbane' });
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
