const express = require('express');
const { fetchAllDomains } = require('@dashboard/tpp-client');
const { getClient, listAll, getCompanyUdfValueToNameMap, invalidateCompanyUdfMap, todayAestKey } = require('@dashboard/autotask-client');
const { getToken: getIngramToken, fetchAllPages: fetchIngramPages } = require('@dashboard/ingram-client');
const dattoRmm = require('@dashboard/datto-rmm/lib.js');
const saasProtection = require('@dashboard/saas-protection/server.js');

// "Data Matching" -- a page for surfacing cross-system matching GAPS (not
// renewals -- that's @dashboard/coming-soon). Each route here is one
// "concept": a specific pair of systems whose client/account references
// should line up, and a report of where they currently don't.
//
// Concept 1 (TPP Wholesale) compares a short account-reference CODE
// against the "Name:TPP" UDF, since TPP's own reference never looks like
// a real company name. Concepts 2 (Ingram Micro), 3 (Datto RMM), and 4
// (SaaS Protection) instead compare a real name directly against
// Autotask's own company name -- each of those three systems' own
// customer/site name is a real-world name that should just equal the
// matching Autotask company's name outright, no UDF needed for the
// MATCHING itself (the UDF only comes in once writing a confirmed match,
// same convention every one of these concepts shares). More concepts can
// follow the same shape: one route + one report-builder function here, one
// render function in client.js.

// Plain calendar-day arithmetic on YYYY-MM-DD strings -- same convention
// @dashboard/coming-soon and @dashboard/subscriptions-expiring already use,
// copied rather than imported since neither of those packages exports it.
function daysBetween(fromDateStr, toDateStr) {
  const [fy, fm, fd] = fromDateStr.split('-').map(Number);
  const [ty, tm, td] = toDateStr.split('-').map(Number);
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / msPerDay);
}

// ---------------------------------------------------------------------------
// Concept 1: TPP Domains Without an Autotask Match -- every domain in our
// TPP Wholesale reseller account whose `accountReference` (e.g. "SHE-696")
// does NOT appear as a value anywhere in the "Name:TPP" UDF across all
// Autotask companies. "Active" = not yet expired (TPP's own /domains list
// is this reseller account's full inventory with no separate active/
// inactive flag of its own -- see @dashboard/tpp-client); an already-expired
// domain's account reference is far less worth chasing down for a matching
// gap, so those are left out here rather than adding dead-renewal noise to
// a list meant to drive real review/UDF-writing follow-up.
// ---------------------------------------------------------------------------
async function buildTppDomainsUnmatchedReport() {
  const client = await getClient();
  const [domains, tppNameMap] = await Promise.all([fetchAllDomains(), getCompanyUdfValueToNameMap(client, 'Name:TPP')]);
  const today = todayAestKey();

  const unmatched = [];
  for (const d of domains) {
    if (d.expiryDate && daysBetween(today, d.expiryDate) < 0) continue; // already expired -- not "active"
    const accountReference = d.accountReference || null;
    const matched = accountReference ? tppNameMap.has(accountReference) : false;
    if (matched) continue; // only the UNMATCHED ones belong on this page
    unmatched.push({
      domainId: d.domainId,
      domainName: d.domainName,
      accountReference,
      category: d.category || null,
      expiryDate: d.expiryDate || null,
      daysUntilExpiry: d.expiryDate ? daysBetween(today, d.expiryDate) : null,
      autoRenew: !!d.autoRenew,
    });
  }

  // Grouped by TPP Client (the `accountReference` code) so the client shows
  // ONCE with its domains listed underneath, by request -- same
  // "resource-group" per-client convention @dashboard/ingram-subscriptions
  // already uses for its own per-client sections. Every domain here is
  // unmatched by definition of this report, so there's no Autotask Client
  // column to repeat per row/group -- the group itself IS the unmatched TPP
  // Client.
  const domainsByAccountReference = new Map();
  for (const row of unmatched) {
    const key = row.accountReference || 'Unknown';
    if (!domainsByAccountReference.has(key)) domainsByAccountReference.set(key, []);
    domainsByAccountReference.get(key).push(row);
  }
  const byClient = [...domainsByAccountReference.entries()]
    .map(([accountReference, clientDomains]) => ({
      accountReference,
      count: clientDomains.length,
      domains: clientDomains.sort((a, b) => a.domainName.localeCompare(b.domainName)),
    }))
    .sort((a, b) => a.accountReference.localeCompare(b.accountReference));

  return {
    asOf: new Date().toISOString(),
    concept: 'tpp-domains-unmatched',
    udfName: 'Name:TPP',
    today,
    totalCount: unmatched.length,
    byClient,
  };
}

// ---------------------------------------------------------------------------
// Concept 2: Ingram Client Names Not Matching Autotask -- every distinct
// client name on an ACTIVE Ingram Micro subscription whose name doesn't
// case/whitespace-exactly equal a real Autotask company name. Unlike
// Concept 1 (TPP's own short account-reference CODE, matched via a UDF),
// Ingram's own customer name is a real company name that SHOULD just equal
// the matching Autotask company's name outright when things line up
// correctly -- so this compares the two systems' own names directly, no
// UDF involved at all.
//
// "Active" = Ingram's own `status: 'active'` filter value (one list call,
// not the active+pending pair @dashboard/ingram-subscriptions' default
// view fetches) -- by request, specifically active subscriptions, not
// pending ones.
// ---------------------------------------------------------------------------
async function buildIngramClientsUnmatchedReport() {
  const client = await getClient();
  const [token, autotaskCompanies, ingramUdfMap] = await Promise.all([
    getIngramToken(),
    getAllCompanyNames(client),
    getCompanyUdfValueToNameMap(client, 'Name:Ingram Micro'),
  ]);
  const [subscriptions, customers] = await Promise.all([
    fetchIngramPages('/subscriptions', token, { status: 'active' }),
    fetchIngramPages('/customers', token),
  ]);
  const customerNameById = new Map(customers.map((c) => [c.id, c.name]));
  const autotaskNameSet = new Set(autotaskCompanies.map((c) => normalizeForExactCompare(c.companyName)));
  // Already matched via the UDF write path -- confirmed live, by request
  // ("AMD Constructions" still showed up as unmatched even though
  // company "AMD Quality Constructions" already has Name:Ingram Micro =
  // "AMD Constructions", because the two companyNames themselves don't
  // match -- that's exactly WHY a human wrote the UDF in the first place).
  // Checked case/whitespace-insensitively, same as the companyName check
  // above, since a human may have typed the UDF value slightly differently.
  const ingramUdfValueSet = new Set([...ingramUdfMap.keys()].map(normalizeForExactCompare));

  const activeCountByClientName = new Map();
  for (const s of subscriptions) {
    const clientName = customerNameById.get(s.customerId) || `Customer #${s.customerId}`;
    activeCountByClientName.set(clientName, (activeCountByClientName.get(clientName) || 0) + 1);
  }

  const rows = [];
  for (const [clientName, activeSubscriptionCount] of activeCountByClientName.entries()) {
    const normalized = normalizeForExactCompare(clientName);
    if (autotaskNameSet.has(normalized)) continue; // exact match -- not a gap at all, not even an ignorable one
    if (ingramUdfValueSet.has(normalized)) continue; // already matched via the UDF write path
    // Ambient IT's own internal naming convention for a Microsoft 365
    // subscription tied to a specific underlying client -- confirmed live
    // against 3 real rows ("Ambient iT - W365 (Blackk Group)", "Ambient iT
    // - W365 (Ascot Mortgage Group)", "Ambient iT - W365 (MD)", one with a
    // double space before the hyphen) -- never a real company name of its
    // own to match against Autotask, so flagged "ignored" rather than
    // treated as a genuine unmatched gap. Still shown (not dropped
    // outright), by request -- hidden by default behind "Show Ignored
    // Lines", same convention as Concept 3's own " - On Demand" rows below.
    const ignored = /^ambient\s+it\s*-\s*w365\s*\(.+\)$/i.test(clientName.trim());
    rows.push({
      clientName,
      activeSubscriptionCount,
      suggestions: ignored ? [] : findFuzzySuggestionsFromList(autotaskCompanies, clientName),
      ignored,
    });
  }
  rows.sort((a, b) => a.clientName.localeCompare(b.clientName));

  return {
    asOf: new Date().toISOString(),
    concept: 'ingram-clients-unmatched',
    udfName: 'Name:Ingram Micro',
    totalCount: rows.filter((r) => !r.ignored).length,
    ignoredCount: rows.filter((r) => r.ignored).length,
    rows,
  };
}

// ---------------------------------------------------------------------------
// Concept 3: Datto RMM Sites Not Matching Autotask -- every distinct Datto
// RMM site whose own site name doesn't case/whitespace-exactly equal a
// real Autotask company name. Same direct name-to-name comparison as
// Concept 2 above. Datto's own siteName is a THIRD, independent naming
// system alongside Autotask's and Ingram's own (see @dashboard/
// check-client's own Section 5 comment on this) with no existing
// fuzzy-matching precedent of its own to lean on, so this page's shared
// fuzzy-suggestion scoring is reused here too.
//
// There's no dedicated "list sites" endpoint on the Datto RMM API this
// dashboard talks to (confirmed via @dashboard/datto-rmm's own lib.js) --
// every existing Datto RMM page derives sites from the bulk device list's
// own siteUid/siteName fields instead (same approach Check Client's own
// Datto RMM section already uses), so that's what this does too, deduped
// by siteUid rather than siteName (two genuinely different real sites
// could in principle share a display name; siteUid can't collide).
// ---------------------------------------------------------------------------
async function buildDattoSitesUnmatchedReport() {
  if (!dattoRmm.hasDattoCredentials()) {
    // Quietly "not configured", same convention Check Client's own Datto
    // RMM section uses -- not an error, just nothing to report yet.
    return {
      asOf: new Date().toISOString(),
      concept: 'datto-sites-unmatched',
      udfName: 'Name:Datto RMM',
      configured: false,
      totalCount: 0,
      ignoredCount: 0,
      rows: [],
    };
  }

  const client = await getClient();
  const [devices, autotaskCompanies, dattoUdfMap] = await Promise.all([
    dattoRmm.getAllDevices(),
    getAllCompanyNames(client),
    getCompanyUdfValueToNameMap(client, 'Name:Datto RMM'),
  ]);
  const autotaskNameSet = new Set(autotaskCompanies.map((c) => normalizeForExactCompare(c.companyName)));
  // Already matched via the UDF write path -- same reasoning as Concept 2's
  // own ingramUdfValueSet above (confirmed live: a site whose own real
  // Autotask company name differs from its Datto site name is exactly the
  // case a human writes this UDF for).
  const dattoUdfValueSet = new Set([...dattoUdfMap.keys()].map(normalizeForExactCompare));

  const siteByUid = new Map(); // siteUid -> { siteName, deviceCount }
  for (const d of devices) {
    if (!d.siteUid) continue;
    if (!siteByUid.has(d.siteUid)) siteByUid.set(d.siteUid, { siteName: d.site, deviceCount: 0 });
    siteByUid.get(d.siteUid).deviceCount += 1;
  }

  const rows = [];
  for (const { siteName, deviceCount } of siteByUid.values()) {
    // mapDeviceSummary() falls back to the em-dash placeholder "—" when a
    // device genuinely has no site set in Datto itself -- not a real site
    // name to match (or fail to match) against anything.
    if (!siteName || siteName === '—') continue;
    const normalized = normalizeForExactCompare(siteName);
    if (autotaskNameSet.has(normalized)) continue; // exact match -- not a gap at all, not even an ignorable one
    if (dattoUdfValueSet.has(normalized)) continue; // already matched via the UDF write path
    // Datto's own " - On Demand" site-name suffix (e.g. "Griffith
    // Corporation - On Demand" for the real client "Griffith Corporation"),
    // by request -- confirmed live this is a large, consistent chunk of this
    // report (18 of 34 rows) and never actually worth chasing down as a real
    // naming gap, unlike every other mismatch here. Still shown (not
    // dropped outright), hidden by default behind "Show Ignored Lines",
    // same convention as Concept 2's own Ambient IT/W365 rows above.
    const ignored = / - On Demand$/i.test(siteName);
    rows.push({ siteName, deviceCount, suggestions: ignored ? [] : findFuzzySuggestionsFromList(autotaskCompanies, siteName), ignored });
  }
  rows.sort((a, b) => a.siteName.localeCompare(b.siteName));

  return {
    asOf: new Date().toISOString(),
    concept: 'datto-sites-unmatched',
    udfName: 'Name:Datto RMM',
    configured: true,
    totalCount: rows.filter((r) => !r.ignored).length,
    ignoredCount: rows.filter((r) => r.ignored).length,
    rows,
  };
}

// ---------------------------------------------------------------------------
// Concept 4: SaaS Protection Clients Not Matching Autotask -- every distinct
// Datto SaaS Protection customer whose own name doesn't case/whitespace-
// exactly equal a real Autotask company name. Same direct name-to-name
// comparison as Concepts 2/3 above, writing "Name:SaaS Backups" (confirmed
// live against this account's real Companies UDF list) once a match is
// confirmed.
//
// @dashboard/saas-protection's own GET /domains is one row per PROTECTED
// DOMAIN, not explicitly deduped by customer -- confirmed live, though,
// this account's real data is already 1:1 (238 domain rows, 238 distinct
// saasCustomerId, no customer with more than one domain, no two different
// customers sharing a display name), so no dedup/grouping is needed here
// the way Datto RMM's own device-level data (above) needs.
// ---------------------------------------------------------------------------
async function buildSaasProtectionClientsUnmatchedReport() {
  const client = await getClient();
  const [domains, autotaskCompanies, saasUdfMap] = await Promise.all([
    saasProtection.getDomains(false),
    getAllCompanyNames(client),
    getCompanyUdfValueToNameMap(client, 'Name:SaaS Backups'),
  ]);
  const autotaskNameSet = new Set(autotaskCompanies.map((c) => normalizeForExactCompare(c.companyName)));
  const saasUdfValueSet = new Set([...saasUdfMap.keys()].map(normalizeForExactCompare));

  const rows = [];
  for (const d of domains) {
    const clientName = d.saasCustomerName;
    if (!clientName) continue;
    const normalized = normalizeForExactCompare(clientName);
    if (autotaskNameSet.has(normalized)) continue; // exact match -- not a gap
    if (saasUdfValueSet.has(normalized)) continue; // already matched via the UDF write path
    rows.push({
      clientName,
      seatsUsed: d.seatsUsed ?? null,
      suggestions: findFuzzySuggestionsFromList(autotaskCompanies, clientName),
      ignored: false,
    });
  }
  rows.sort((a, b) => a.clientName.localeCompare(b.clientName));

  return {
    asOf: new Date().toISOString(),
    concept: 'saas-protection-clients-unmatched',
    udfName: 'Name:SaaS Backups',
    totalCount: rows.length,
    ignoredCount: 0,
    rows,
  };
}

// ---------------------------------------------------------------------------
// Caching -- same 20-min TTL + in-flight-sharing convention as
// @dashboard/coming-soon, since this concept hits the exact same real
// external APIs (TPP + a full Autotask company scan) that are no cheaper to
// re-run on every Load click. One cache slot per concept, keyed by name, so
// adding a second concept later doesn't require restructuring this.
// ---------------------------------------------------------------------------
const REPORT_CACHE_TTL_MS = 20 * 60 * 1000;
const reportCache = new Map(); // conceptKey -> { data, expiresAt }
const reportInFlight = new Map();

async function getCachedReport(conceptKey, force, build) {
  const cached = reportCache.get(conceptKey);
  if (!force && cached && Date.now() < cached.expiresAt) return cached.data;
  if (!reportInFlight.has(conceptKey)) {
    const promise = build()
      .then((data) => {
        reportCache.set(conceptKey, { data, expiresAt: Date.now() + REPORT_CACHE_TTL_MS });
        return data;
      })
      .finally(() => reportInFlight.delete(conceptKey));
    reportInFlight.set(conceptKey, promise);
  }
  return reportInFlight.get(conceptKey);
}

// ---------------------------------------------------------------------------
// Writing the match -- the "Update" button on each TPP Client group header.
// Resolves the typed Autotask company name, then writes the TPP account
// reference into that company's "Name:TPP" UDF, the SAME real Autotask
// write every earlier batch-write script this session used (see
// @dashboard/coming-soon's README/history for the full backstory on how
// this UDF came to exist and the 405-vs-real-API-shape bug that had to be
// worked around to write it at all).
//
// By request: only ever permitted when the UDF is CURRENTLY BLANK.
// Enforced here, server-side, right before the write -- not just left to
// the client only ever showing this control for already-unmatched rows --
// because the cached report feeding this page's own UI can be up to 20 min
// stale, and someone else could have matched this exact client in the
// meantime (via this same button, or a future batch script). A fresh,
// uncached read of the company's own current UDF value is the only way to
// be sure this never clobbers a real value that was just set.
// ---------------------------------------------------------------------------
// Exact match only, by request -- deliberately NOT @dashboard/autotask-
// client's own resolveSingleCompany(). Confirmed live that function is the
// wrong tool for this: its parseWildcard() treats ANY plain, un-starred
// term as an implicit CONTAINS search by design (the same "no stars at
// all -> contains" convention every other client-name search box on this
// dashboard relies on for forgiving search) -- so typing "Shepherd
// Contracting" there silently matched "Shepherd Contracting Pty Ltd" even
// with no `*` typed and no fallback code of this page's own involved.
// That's exactly the loose/substring behaviour this write action must
// NOT have: a typed name that happens to be a substring of some other
// unrelated real client could silently write a production UDF onto the
// wrong company. This queries Autotask directly with a real `eq` filter
// instead -- confirmed live against real data that Autotask's own `eq` on
// companyName genuinely is exact (0 matches for "Shepherd Contracting", 1
// for the real full name "Shepherd Contracting Pty Ltd").
async function resolveCompanyForMatch(client, companyName) {
  const matches = await listAll(client.companies, [{ op: 'eq', field: 'companyName', value: companyName }]);
  if (matches.length === 0) return { status: 'not-found' };
  if (matches.length > 1) {
    // Real duplicate company NAMES are rare but not impossible in
    // Autotask -- surfaced as the same "ambiguous" shape matchTppClient
    // already handles, rather than silently picking one.
    return { status: 'ambiguous', matches: matches.map((c) => ({ id: c.id, companyName: c.companyName })) };
  }
  return { status: 'ok', company: matches[0] };
}

// ---------------------------------------------------------------------------
// Fuzzy SUGGESTIONS for a failed exact match -- by request ("show the
// possible fuzzy match results" when a typed name doesn't exactly match
// anything, e.g. "Cloudking" for the real company "Cloud King Hosting").
// Suggestions only -- never auto-selected or auto-written; clicking one on
// the client just fills the exact real name into the input so the strict
// exact-match write path above still runs unchanged.
//
// Plain Levenshtein-ratio scoring against every real Autotask company name
// (same ballpark approach as the rapidfuzz token-sort-ratio matching this
// session already proved out against the real TPP customer spreadsheet),
// with a flat bonus for an outright substring relationship either
// direction -- that alone would already catch "Cloudking" -> "Cloud King
// Hosting" if it weren't for the missing space, which is exactly what the
// Levenshtein distance underneath is for.
// ---------------------------------------------------------------------------
const ALL_COMPANY_NAMES_TTL_MS = 20 * 60 * 1000;
let allCompanyNamesCache = null; // { data: [{id, companyName}], expiresAt }
let allCompanyNamesInFlight = null;

async function getAllCompanyNames(client) {
  if (allCompanyNamesCache && Date.now() < allCompanyNamesCache.expiresAt) return allCompanyNamesCache.data;
  if (!allCompanyNamesInFlight) {
    allCompanyNamesInFlight = listAll(client.companies, [{ op: 'gte', field: 'id', value: 0 }])
      .then((companies) => {
        const data = companies.map((c) => ({ id: c.id, companyName: c.companyName }));
        allCompanyNamesCache = { data, expiresAt: Date.now() + ALL_COMPANY_NAMES_TTL_MS };
        return data;
      })
      .finally(() => {
        allCompanyNamesInFlight = null;
      });
  }
  return allCompanyNamesInFlight;
}

function levenshteinDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[n];
}

function normalizeForFuzzyMatch(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// 1.0 identical. Below that, two substring checks before falling back to
// a plain Levenshtein ratio -- confirmed necessary against a real miss
// ("Cloudking" vs the real company "Cloud King Hosting"): a bare
// Levenshtein ratio on the full strings scores several unrelated
// same-length "Cloud*" names (CloudAlly, Cloud Olive, Cloudouble) HIGHER
// than the real match, purely because "Cloud King Hosting" is a much
// longer string overall (every extra real word costs edit-distance
// points against a short typed guess, even though the words that ARE
// there match perfectly). Checked in order, most specific first:
//   1. A plain substring relationship with spaces intact (handles a
//      typed name missing a "Pty Ltd"/"Inc" suffix, or trailing words).
//   2. The SAME check with spaces stripped from both sides -- catches a
//      typed name that's just missing the SPACES between real words
//      (exactly the "Cloudking" case: space-stripped "cloud king
//      hosting" is "cloudkinghosting", which "cloudking" is a genuine
//      prefix of).
//   3. Otherwise, whichever of the spaced/space-stripped Levenshtein
//      ratios is higher.
function fuzzySimilarity(typed, candidate) {
  const a = normalizeForFuzzyMatch(typed);
  const b = normalizeForFuzzyMatch(candidate);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (b.includes(a) || a.includes(b)) return 0.95;

  const aCollapsed = a.replace(/ /g, '');
  const bCollapsed = b.replace(/ /g, '');
  if (bCollapsed.includes(aCollapsed) || aCollapsed.includes(bCollapsed)) return 0.85;

  const spacedRatio = 1 - levenshteinDistance(a, b) / Math.max(a.length, b.length);
  const collapsedRatio = 1 - levenshteinDistance(aCollapsed, bCollapsed) / Math.max(aCollapsed.length, bCollapsed.length);
  return Math.max(spacedRatio, collapsedRatio);
}

const FUZZY_SUGGESTION_LIMIT = 6;
// Tuned against real data (see the comment above): scoring the real
// "Cloudking" miss against every real company in this account showed a
// clean gap -- the two genuine "Cloud King *" candidates at 0.85, the rest
// of the "Cloud*" word-family down at 0.5-0.6, then a cluster of
// completely unrelated short names (MAD Accounting, Coalpro Mining, ...)
// bunched at ~0.46 purely by short-string coincidence. 0.5 sits in that
// gap -- keeps the real match and its plausible same-family neighbours,
// drops the coincidental noise.
const FUZZY_SUGGESTION_MIN_SIMILARITY = 0.5;

// Pure/synchronous half, split out so Concepts 2 and 3 below (which both
// already have the full company list in hand, fetched once for their own
// exact-match check) can score suggestions without a second redundant
// fetch -- findFuzzySuggestions() itself (used by the write path, which
// has no reason to have fetched the list already) just fetches then
// delegates here.
function findFuzzySuggestionsFromList(companies, companyName) {
  return companies
    .map((c) => ({ ...c, similarity: fuzzySimilarity(companyName, c.companyName) }))
    .filter((c) => c.similarity >= FUZZY_SUGGESTION_MIN_SIMILARITY)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, FUZZY_SUGGESTION_LIMIT)
    .map((c) => ({ id: c.id, companyName: c.companyName }));
}

async function findFuzzySuggestions(client, companyName) {
  const all = await getAllCompanyNames(client);
  return findFuzzySuggestionsFromList(all, companyName);
}

// Trim + lowercase only -- deliberately NOT the punctuation-stripping
// normalizeForFuzzyMatch() above. "Exact" here means a genuine
// case/whitespace-insensitive equality check between two real names
// (what Concepts 2 and 3 below use to decide "this one's fine, skip it"),
// not a fuzzy similarity score -- stripping punctuation would risk
// treating two genuinely different real names as the same one just
// because they only differ by a comma or an ampersand.
function normalizeForExactCompare(s) {
  return (s || '').trim().toLowerCase();
}

// Generalized write path shared by every concept that has a real UDF to
// write to -- Concept 1 (TPP, writing its own short account-reference code
// into "Name:TPP") and Concept 2 (Ingram Micro, writing the real Ingram
// client name itself into "Name:Ingram Micro", confirmed live against this
// account's real Companies UDF list -- see the comment on CONCEPT_UDFS
// below). Concept 3 (Datto RMM) has no UDF of its own yet -- there's no
// "Name:Datto RMM" (or similar) field in this account's real UDF list, so
// it stays read-only on the client until one is created, same convention
// as "Name:TPP"/"Name:Ingram Micro" were (manually, in Autotask's own UI).
async function writeNameMatchUdf({ udfName, matchValue, companyName, reportCacheKeyToInvalidate }) {
  const trimmedValue = (matchValue || '').trim();
  const trimmedName = (companyName || '').trim();
  if (!trimmedValue) {
    const err = new Error(`Missing value to write to ${udfName}.`);
    err.status = 400;
    throw err;
  }
  if (!trimmedName) {
    const err = new Error('Enter an Autotask client name first.');
    err.status = 400;
    throw err;
  }

  const client = await getClient();
  const result = await resolveCompanyForMatch(client, trimmedName);
  if (result.status === 'not-found') {
    const err = new Error(`No Autotask company matches "${trimmedName}".`);
    err.status = 404;
    err.suggestions = await findFuzzySuggestions(client, trimmedName);
    throw err;
  }
  if (result.status === 'ambiguous') {
    const names = result.matches.map((m) => m.companyName).join(', ');
    const err = new Error(`${result.matches.length} Autotask companies match "${trimmedName}" -- be more specific: ${names}`);
    err.status = 409;
    throw err;
  }

  // Fresh, not the cached map -- see the comment above resolveCompanyForMatch.
  const fresh = await client.companies.get(result.company.id);
  const currentUdf = (fresh.data?.userDefinedFields || []).find((u) => u.name === udfName);
  const currentValue = currentUdf?.value?.trim();
  if (currentValue) {
    const err = new Error(`${fresh.data.companyName}'s ${udfName} is already set to "${currentValue}" -- refusing to overwrite.`);
    err.status = 409;
    throw err;
  }

  // Same direct-axios PATCH workaround as the original batch-write scripts
  // -- autotask-node's own update()/patch() sends to the wrong URL
  // (/Companies/{id} instead of the bare /Companies collection with id in
  // the body) and gets a real 405 back from Autotask's actual API.
  await client.companies.axios.patch(client.companies.endpoint, {
    id: result.company.id,
    userDefinedFields: [{ name: udfName, value: trimmedValue }],
  });

  invalidateCompanyUdfMap(udfName);
  if (reportCacheKeyToInvalidate) reportCache.delete(reportCacheKeyToInvalidate);

  return { companyId: result.company.id, companyName: fresh.data.companyName, value: trimmedValue };
}

async function matchTppClient({ accountReference, companyName }) {
  const trimmedRef = (accountReference || '').trim();
  if (!trimmedRef) {
    const err = new Error('Missing TPP account reference.');
    err.status = 400;
    throw err;
  }
  const result = await writeNameMatchUdf({
    udfName: 'Name:TPP',
    matchValue: trimmedRef,
    companyName,
    reportCacheKeyToInvalidate: 'tpp-domains-unmatched',
  });
  return { companyId: result.companyId, companyName: result.companyName, accountReference: trimmedRef };
}

async function matchIngramClient({ clientName, companyName }) {
  const trimmedClientName = (clientName || '').trim();
  if (!trimmedClientName) {
    const err = new Error('Missing Ingram client name.');
    err.status = 400;
    throw err;
  }
  const result = await writeNameMatchUdf({
    udfName: 'Name:Ingram Micro',
    matchValue: trimmedClientName,
    companyName,
    reportCacheKeyToInvalidate: 'ingram-clients-unmatched',
  });
  return { companyId: result.companyId, companyName: result.companyName, clientName: trimmedClientName };
}

async function matchDattoSite({ siteName, companyName }) {
  const trimmedSiteName = (siteName || '').trim();
  if (!trimmedSiteName) {
    const err = new Error('Missing Datto RMM site name.');
    err.status = 400;
    throw err;
  }
  const result = await writeNameMatchUdf({
    udfName: 'Name:Datto RMM',
    matchValue: trimmedSiteName,
    companyName,
    reportCacheKeyToInvalidate: 'datto-sites-unmatched',
  });
  return { companyId: result.companyId, companyName: result.companyName, siteName: trimmedSiteName };
}

async function matchSaasProtectionClient({ clientName, companyName }) {
  const trimmedClientName = (clientName || '').trim();
  if (!trimmedClientName) {
    const err = new Error('Missing SaaS Protection client name.');
    err.status = 400;
    throw err;
  }
  const result = await writeNameMatchUdf({
    udfName: 'Name:SaaS Backups',
    matchValue: trimmedClientName,
    companyName,
    reportCacheKeyToInvalidate: 'saas-protection-clients-unmatched',
  });
  return { companyId: result.companyId, companyName: result.companyName, clientName: trimmedClientName };
}

// ---------------------------------------------------------------------------
// "Show UDF Matches" -- by request, the reverse of every concept's own
// unmatched report above: every Autotask company that ALREADY has a value
// in the given "Name:*" UDF, so an existing match can be reviewed (and
// cleared, if wrong) rather than only ever seeing the gaps still needing
// one. Own 20-min cache, same convention as every other report on this
// page -- a full company scan is the same real cost getAllCompanyNames()
// already pays, just keyed per UDF name here since the VALUE (not just the
// id/companyName) is what this needs.
// ---------------------------------------------------------------------------
const UDF_MATCHES_TTL_MS = 20 * 60 * 1000;
const udfMatchesCache = new Map(); // udfName -> { data, expiresAt }
const udfMatchesInFlight = new Map();

async function getUdfMatches(udfName, force) {
  if (!force && udfMatchesCache.has(udfName)) {
    const cached = udfMatchesCache.get(udfName);
    if (Date.now() < cached.expiresAt) return cached.data;
  }
  if (!udfMatchesInFlight.has(udfName)) {
    const promise = (async () => {
      const client = await getClient();
      const companies = await listAll(client.companies, [{ op: 'gte', field: 'id', value: 0 }]);
      const matches = [];
      for (const c of companies) {
        const udf = (c.userDefinedFields || []).find((u) => u.name === udfName);
        const value = udf?.value?.trim();
        if (value) matches.push({ id: c.id, companyName: c.companyName, value });
      }
      matches.sort((a, b) => a.companyName.localeCompare(b.companyName));
      udfMatchesCache.set(udfName, { data: matches, expiresAt: Date.now() + UDF_MATCHES_TTL_MS });
      return matches;
    })().finally(() => udfMatchesInFlight.delete(udfName));
    udfMatchesInFlight.set(udfName, promise);
  }
  return udfMatchesInFlight.get(udfName);
}

// Maps a UDF name back to the report cache key its own unmatched report
// uses, so clearing a match correctly makes that company show back up as a
// real gap on the next load, same as a fresh write invalidates the SAME key
// in the other direction (see writeNameMatchUdf above).
const REPORT_CACHE_KEY_BY_UDF = {
  'Name:TPP': 'tpp-domains-unmatched',
  'Name:Ingram Micro': 'ingram-clients-unmatched',
  'Name:Datto RMM': 'datto-sites-unmatched',
  'Name:SaaS Backups': 'saas-protection-clients-unmatched',
};

// Clear only -- by request, never an edit. A wrong UDF value is corrected
// by clearing it here and writing the right one through the normal
// Update/Possible-Match flow above (which re-checks the UDF is blank first
// anyway), not by typing over it directly -- keeps exactly one path that
// can ever SET this UDF's value, with its own exact-match/confirm
// safeguards, rather than a second, looser one living here too.
async function clearUdfMatch({ udfName, companyId }) {
  const trimmedUdfName = (udfName || '').trim();
  const id = Number(companyId);
  if (!trimmedUdfName) {
    const err = new Error('Missing udfName.');
    err.status = 400;
    throw err;
  }
  if (!id) {
    const err = new Error('Missing companyId.');
    err.status = 400;
    throw err;
  }

  const client = await getClient();
  const fresh = await client.companies.get(id);
  if (!fresh.data) {
    const err = new Error(`Company #${id} not found.`);
    err.status = 404;
    throw err;
  }

  await client.companies.axios.patch(client.companies.endpoint, {
    id,
    userDefinedFields: [{ name: trimmedUdfName, value: '' }],
  });

  invalidateCompanyUdfMap(trimmedUdfName);
  udfMatchesCache.delete(trimmedUdfName);
  const reportCacheKey = REPORT_CACHE_KEY_BY_UDF[trimmedUdfName];
  if (reportCacheKey) reportCache.delete(reportCacheKey);

  return { companyId: id, companyName: fresh.data.companyName, udfName: trimmedUdfName };
}

const router = express.Router();
router.use(express.json());

router.get('/tpp-domains-unmatched', async (req, res) => {
  try {
    res.json(await getCachedReport('tpp-domains-unmatched', req.query.force === 'true', buildTppDomainsUnmatchedReport));
  } catch (err) {
    console.error('Data Matching: TPP Domains Without an Autotask Match report failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/ingram-clients-unmatched', async (req, res) => {
  try {
    res.json(await getCachedReport('ingram-clients-unmatched', req.query.force === 'true', buildIngramClientsUnmatchedReport));
  } catch (err) {
    console.error('Data Matching: Ingram Client Names Not Matching Autotask report failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/datto-sites-unmatched', async (req, res) => {
  try {
    res.json(await getCachedReport('datto-sites-unmatched', req.query.force === 'true', buildDattoSitesUnmatchedReport));
  } catch (err) {
    console.error('Data Matching: Datto RMM Sites Not Matching Autotask report failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/saas-protection-clients-unmatched', async (req, res) => {
  try {
    res.json(
      await getCachedReport('saas-protection-clients-unmatched', req.query.force === 'true', buildSaasProtectionClientsUnmatchedReport),
    );
  } catch (err) {
    console.error('Data Matching: SaaS Protection Clients Not Matching Autotask report failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/match-tpp-client', async (req, res) => {
  try {
    const result = await matchTppClient(req.body || {});
    const actor = req.session?.user?.email;
    console.log(`Data Matching: wrote Name:TPP="${result.accountReference}" on "${result.companyName}" (company #${result.companyId})${actor ? ` -- by ${actor}` : ''}.`);
    res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, suggestions: err.suggestions });
    console.error('Data Matching: match-tpp-client failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/match-ingram-client', async (req, res) => {
  try {
    const result = await matchIngramClient(req.body || {});
    const actor = req.session?.user?.email;
    console.log(
      `Data Matching: wrote Name:Ingram Micro="${result.clientName}" on "${result.companyName}" (company #${result.companyId})${actor ? ` -- by ${actor}` : ''}.`,
    );
    res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, suggestions: err.suggestions });
    console.error('Data Matching: match-ingram-client failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/match-datto-site', async (req, res) => {
  try {
    const result = await matchDattoSite(req.body || {});
    const actor = req.session?.user?.email;
    console.log(
      `Data Matching: wrote Name:Datto RMM="${result.siteName}" on "${result.companyName}" (company #${result.companyId})${actor ? ` -- by ${actor}` : ''}.`,
    );
    res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, suggestions: err.suggestions });
    console.error('Data Matching: match-datto-site failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/match-saas-protection-client', async (req, res) => {
  try {
    const result = await matchSaasProtectionClient(req.body || {});
    const actor = req.session?.user?.email;
    console.log(
      `Data Matching: wrote Name:SaaS Backups="${result.clientName}" on "${result.companyName}" (company #${result.companyId})${actor ? ` -- by ${actor}` : ''}.`,
    );
    res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, suggestions: err.suggestions });
    console.error('Data Matching: match-saas-protection-client failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/udf-matches', async (req, res) => {
  const udfName = (req.query.udfName || '').trim();
  if (!udfName) return res.status(400).json({ error: 'A udfName is required.' });
  try {
    const matches = await getUdfMatches(udfName, req.query.force === 'true');
    res.json({ udfName, matches });
  } catch (err) {
    console.error('Data Matching: udf-matches failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/clear-udf-match', async (req, res) => {
  try {
    const result = await clearUdfMatch(req.body || {});
    const actor = req.session?.user?.email;
    console.log(`Data Matching: cleared ${result.udfName} on "${result.companyName}" (company #${result.companyId})${actor ? ` -- by ${actor}` : ''}.`);
    res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Data Matching: clear-udf-match failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
