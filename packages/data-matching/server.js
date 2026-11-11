const express = require('express');
const { fetchAllDomains } = require('@dashboard/tpp-client');
const { getClient, listAll, getCompanyUdfValueToNameMap, invalidateCompanyUdfMap, todayAestKey } = require('@dashboard/autotask-client');

// "Data Matching" -- a page for surfacing cross-system matching GAPS (not
// renewals -- that's @dashboard/coming-soon). Each route here is one
// "concept": a specific pair of systems whose client/account references
// should line up, and a report of where they currently don't. First job,
// by request: TPP Wholesale domains whose TPP account-reference code has
// never been matched to a real Autotask company via the "Name:TPP" UDF
// (see @dashboard/coming-soon's README for how that UDF came to exist and
// how it's populated by hand). More concepts (e.g. the same check against
// Ingram's "Name:Ingram Client" UDF) are expected to join this page later,
// one route + one client.js section each, rather than growing Coming Soon
// into something it isn't.

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
    today,
    totalCount: unmatched.length,
    byClient,
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

async function matchTppClient({ accountReference, companyName }) {
  const trimmedRef = (accountReference || '').trim();
  const trimmedName = (companyName || '').trim();
  if (!trimmedRef) {
    const err = new Error('Missing TPP account reference.');
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
    throw err;
  }
  if (result.status === 'ambiguous') {
    const names = result.matches.map((m) => m.companyName).join(', ');
    const err = new Error(`${result.matches.length} Autotask companies match "${trimmedName}" -- be more specific: ${names}`);
    err.status = 409;
    throw err;
  }

  // Fresh, not the cached map -- see the comment above this function.
  const fresh = await client.companies.get(result.company.id);
  const currentUdf = (fresh.data?.userDefinedFields || []).find((u) => u.name === 'Name:TPP');
  const currentValue = currentUdf?.value?.trim();
  if (currentValue) {
    const err = new Error(`${fresh.data.companyName}'s Name:TPP is already set to "${currentValue}" -- refusing to overwrite.`);
    err.status = 409;
    throw err;
  }

  // Same direct-axios PATCH workaround as the original batch-write scripts
  // -- autotask-node's own update()/patch() sends to the wrong URL
  // (/Companies/{id} instead of the bare /Companies collection with id in
  // the body) and gets a real 405 back from Autotask's actual API.
  await client.companies.axios.patch(client.companies.endpoint, {
    id: result.company.id,
    userDefinedFields: [{ name: 'Name:TPP', value: trimmedRef }],
  });

  // Both caches need to forget this -- the shared UDF map (so Coming
  // Soon's Domains table picks up the new match too) and this page's own
  // report cache (so a reload stops showing this client as unmatched).
  invalidateCompanyUdfMap('Name:TPP');
  reportCache.delete('tpp-domains-unmatched');

  return { companyId: result.company.id, companyName: fresh.data.companyName, accountReference: trimmedRef };
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

router.post('/match-tpp-client', async (req, res) => {
  try {
    const result = await matchTppClient(req.body || {});
    const actor = req.session?.user?.email;
    console.log(`Data Matching: wrote Name:TPP="${result.accountReference}" on "${result.companyName}" (company #${result.companyId})${actor ? ` -- by ${actor}` : ''}.`);
    res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Data Matching: match-tpp-client failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
