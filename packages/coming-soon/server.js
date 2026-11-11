const express = require('express');
const { fetchAllDomains } = require('@dashboard/tpp-client');
const {
  getClient,
  listAll,
  fetchByFieldIn,
  resolveSingleCompany,
  mapWithConcurrency,
  matchesWildcard,
  todayAestKey,
  getCompanyUdfValueToNameMap,
} = require('@dashboard/autotask-client');
const { getToken, fetchAllPages } = require('@dashboard/ingram-client');

// Renewals early-warning page -- Phase 1 (by request: "let's start by
// getting the info on a page and then work from there"). Read-only. No
// notifications, ticket creation, invoicing, or auto-renew toggling yet --
// see this package's own README for the full phase breakdown.

// Shared day-window config across both sections, same convention as
// @dashboard/subscriptions-expiring's own WINDOWS -- 30/14/7 days are the
// three notification points actually named for this feature; 60 and
// "Expired Recently" included for the same reasons Subscriptions Expiring
// has them (a wider look-ahead, and catching something that already
// lapsed). Default is 30 -- the longest of the three named points, so
// nothing relevant is hidden on first load.
const WINDOWS = {
  '7': { label: 'Next 7 days', minDays: 0, maxDays: 7 },
  '14': { label: 'Next 14 days', minDays: 0, maxDays: 14 },
  '30': { label: 'Next 30 days', minDays: 0, maxDays: 30 },
  '60': { label: 'Next 60 days', minDays: 0, maxDays: 60 },
  'expired-recently': { label: 'Expired in the last 7 days', minDays: -7, maxDays: -1 },
};
const DEFAULT_WINDOW = '30';

// Plain calendar-day arithmetic on YYYY-MM-DD strings -- identical to
// @dashboard/subscriptions-expiring's own daysBetween(), copied rather than
// imported since that package has no shared export for it (same "small
// enough to just copy" call subscriptions-expiring itself already made for
// EXCLUDED_NAME_PATTERNS vs. Ingram Subscriptions).
function daysBetween(fromDateStr, toDateStr) {
  const [fy, fm, fd] = fromDateStr.split('-').map(Number);
  const [ty, tm, td] = toDateStr.split('-').map(Number);
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / msPerDay);
}

// ---------------------------------------------------------------------------
// TPP account reference -> Autotask company name, via the "Name:TPP" UDF on
// Companies -- populated by hand, via a one-off fuzzy-match-then-review pass
// against TPP's own customer export (see this package's README). Now a
// shared helper (@dashboard/autotask-client's getCompanyUdfValueToNameMap) --
// @dashboard/data-matching needs this exact same map for its own "TPP
// Domains Without an Autotask Match" check, so it was pulled up rather than
// kept as a second local copy.
// ---------------------------------------------------------------------------
// Domains -- every domain in our own TPP Wholesale reseller account
// (@dashboard/tpp-client's fetchAllDomains(), confirmed live against the
// real account: 564 domains across the whole reseller account as of this
// writing), filtered to the selected expiry window.
// ---------------------------------------------------------------------------

async function buildDomainsReport(windowKey) {
  const win = WINDOWS[windowKey];
  const client = await getClient();
  const [domains, tppNameMap] = await Promise.all([fetchAllDomains(), getCompanyUdfValueToNameMap(client, 'Name:TPP')]);
  const today = todayAestKey();

  const rows = [];
  for (const d of domains) {
    if (!d.expiryDate) continue; // not expected in real data, but no date to compare against if it happens
    const daysUntilExpiry = daysBetween(today, d.expiryDate);
    if (daysUntilExpiry < win.minDays || daysUntilExpiry > win.maxDays) continue;
    const accountReference = d.accountReference || null;
    rows.push({
      domainId: d.domainId,
      domainName: d.domainName,
      // TPP's own `accountReference` (e.g. "SHE-696") groups every domain
      // belonging to the same client -- confirmed live it repeats across a
      // client's domains. Resolved to a real Autotask company name where
      // the "Name:TPP" UDF has been matched (see getTppAccountRefToCompanyMap
      // above); null for anything not matched yet.
      accountReference,
      autotaskClientName: accountReference ? tppNameMap.get(accountReference) || null : null,
      // TPP's own `category` field -- present on some domains, absent on
      // others in real data (e.g. "Not Required" on one, no key at all on
      // another), by request.
      category: d.category || null,
      expiryDate: d.expiryDate,
      daysUntilExpiry,
      autoRenew: !!d.autoRenew,
    });
  }
  rows.sort((a, b) => a.expiryDate.localeCompare(b.expiryDate) || (a.accountReference || '').localeCompare(b.accountReference || ''));

  return {
    asOf: new Date().toISOString(),
    section: 'domains',
    window: windowKey,
    windowLabel: win.label,
    today,
    totalCount: rows.length,
    rows,
  };
}

// ---------------------------------------------------------------------------
// Microsoft Licensing -- two systems joined per client, for now:
//   - renewal DATE + auto-renew flag + term (annual/monthly): Ingram Micro
//     subscriptions (same pattern @dashboard/subscriptions-expiring already
//     proved out)
//   - current CONTRACTED quantity: Autotask Contracts/ContractServices
//
// The actual M365-tenancy "licenses in use" join (via
// @dashboard/m365-environment's IT-Glue-backed snapshot) is deliberately
// NOT wired in yet, by request -- "Don't look up the M365 licenses at the
// moment, we will bring that in when we've worked it all out so we aren't
// making so many calls." A real next step, not forgotten.
//
// Confirmed live against real data (this account's Ingram catalog is almost
// entirely Microsoft CSP licensing -- 1456 of 1659 total subscriptions
// match the name filter below): resolveSingleCompany() does successfully
// resolve real Ingram customer names to the right Autotask company for
// several real clients (e.g. "EBP Rehab", "All Safe Financial", "Atho
// Group" all matched correctly), though not every one (e.g. "Cranny Blue
// Pty Ltd" and "GEEBUNG BOWLS CLUB INCORPORATED" didn't resolve in this
// sample -- likely a name-formatting mismatch against whatever's actually
// on the Autotask Company record, not a bug in the matching itself).
// Rows whose company didn't resolve still show up with the Ingram-side
// data; they just don't get the Autotask contracted-quantity column.
// ---------------------------------------------------------------------------

// Deliberately broad -- by request this covers "Microsoft annual licenses"
// generally, not just the core M365 seat SKUs, so Teams/Exchange/Intune/etc.
// add-on licensing isn't silently excluded. Confirmed against real
// subscription names to catch genuine Microsoft products without obvious
// false positives in a 5-row sample; not exhaustively audited across all
// 1456 matches.
const MS_LICENSE_NAME_PATTERN = /microsoft|m365|office ?365|exchange online|sharepoint|teams|intune|azure ?ad|entra|defender|power ?bi/i;

// Same one-off-SKU exclusion as Ingram Subscriptions / Subscriptions
// Expiring (not shared as a constant between packages, by the same
// convention those two already follow for this exact list).
const EXCLUDED_NAME_PATTERNS = ['Windows 11 Home to Pro Upgrade *'];

// `subscriptionPeriod.type` is Ingram's own term field ('year'/'month'),
// same one @dashboard/subscriptions-expiring already reads for its own
// Annual/Monthly split.
function isAnnualTerm(subscription) {
  return subscription.subscriptionPeriod?.type === 'year';
}

// Which rows show by default, by request: Annual licenses regardless of
// renewing-or-expiring (both are worth seeing for an annual commitment --
// there's a real yearly decision point either way), but Monthly licenses
// ONLY when they're actually EXPIRING (not auto-renewing). A monthly NCE
// subscription that auto-renews has no real decision point attached to it
// every single month, and confirmed live this drowns out the genuinely
// actionable rows otherwise (283 rows in just a 60-day window with no
// term/renewal filtering at all, almost all routine monthly auto-billing).
// Monthly-AND-renewing rows are excluded here by default but still
// available on request -- see `includeRenewingMonthly` on the route below.
function showsByDefault(annual, autoRenews) {
  return annual || !autoRenews;
}

// Strips Ingram's own trailing commercial-term qualifier -- e.g.
// "(NCE COM MTH)", "(NCE COM ANN)", "(NCE NFP MTH)" -- confirmed against
// real subscription names this is ALWAYS the last parenthetical group, so
// stripping only the trailing one leaves an earlier, meaningful
// parenthetical alone (e.g. "Exchange Online (Plan 1) (NCE COM MTH)" ->
// "Exchange Online (Plan 1)", not just "Exchange Online").
function stripIngramTermSuffix(name) {
  return name.replace(/\s*\(NCE[^)]*\)\s*$/i, '').trim();
}

// Strips Autotask's own trailing billing-frequency qualifier on a
// Microsoft-licensing service/invoice-description name -- e.g.
// "Microsoft 365 Business Premium (Monthly)" -> "Microsoft 365 Business
// Premium" -- confirmed against real contract service names.
function stripAutotaskTermSuffix(name) {
  return name.replace(/\s*\((Monthly|Annual)\)\s*$/i, '').trim();
}

// Matches one Ingram subscription to the SPECIFIC Autotask-contracted line
// it corresponds to (out of a company's several Microsoft-ish lines), for
// the page's own "#" column -- both sides' term-qualifier suffix stripped
// first since Ingram and Autotask spell theirs completely differently
// ("(NCE COM MTH)" vs "(Monthly)"), then compared for equality or
// containment either direction. The longest/closest match wins when more
// than one line could plausibly match.
function findMatchingContractedLine(contractedLines, subscriptionName) {
  const base = stripIngramTermSuffix(subscriptionName).toLowerCase();
  let best = null;
  for (const line of contractedLines) {
    const lineBase = stripAutotaskTermSuffix(line.serviceName).toLowerCase();
    if (lineBase === base || base.includes(lineBase) || lineBase.includes(base)) {
      if (!best || lineBase.length > stripAutotaskTermSuffix(best.serviceName).length) best = line;
    }
  }
  return best;
}

// A company's CURRENTLY active contracted quantity for whatever Autotask
// Services look like Microsoft licensing, by MS_LICENSE_NAME_PATTERN above.
// Deliberately simpler than @dashboard/contract-services' own buildReport()
// -- this just wants "what's contracted right now", not a specific billing
// month's full next-period/bundle machinery, so it queries ContractServiceUnits
// directly for the period covering today rather than reusing that heavier report.
async function fetchCompanyContractedQty(client, companyId) {
  const contracts = await listAll(client.contracts, [
    { op: 'eq', field: 'companyID', value: companyId },
    { op: 'eq', field: 'status', value: 1 }, // 1 = "In Effect" (confirmed via field info, same convention contract-services/server.js documents)
  ]);
  if (contracts.length === 0) return [];
  const contractIds = contracts.map((c) => c.id);

  const nowIso = new Date().toISOString();
  const units = await fetchByFieldIn(client.contractServiceUnits, 'contractID', contractIds, [
    { op: 'lte', field: 'startDate', value: nowIso },
    { op: 'gte', field: 'endDate', value: nowIso },
  ]);
  const activeUnits = units.filter((u) => u.units > 0);
  if (activeUnits.length === 0) return [];

  const serviceIds = [...new Set(activeUnits.map((u) => u.serviceID))];
  const services = await fetchByFieldIn(client.services, 'id', serviceIds);
  const serviceById = new Map(services.map((s) => [s.id, s]));

  const matched = [];
  for (const u of activeUnits) {
    const service = serviceById.get(u.serviceID);
    if (service && MS_LICENSE_NAME_PATTERN.test(service.name)) {
      matched.push({ serviceName: service.name, units: u.units });
    }
  }
  return matched;
}

// All of a company's invoices (confirmed live against real data: accessed
// via `client.financial.invoices`, NOT a top-level `client.invoices` --
// fields include invoiceNumber, invoiceDateTime, paidDate, isVoided; no
// direct link to a specific contract/service, so there's no way to tie one
// invoice to one specific subscription's renewal). Annual licenses only, by
// request -- monthly licenses auto-bill every month with no single
// "has THIS renewal been invoiced" question to ask.
async function fetchCompanyInvoices(client, companyId) {
  return listAll(client.financial.invoices, [{ op: 'eq', field: 'companyID', value: companyId }]);
}

// "Has an invoice been sent for this renewal" has no direct field to check
// (see fetchCompanyInvoices' own comment) -- by request, invoice EXISTENCE
// near the renewal date is used as the proxy instead: the most recent
// non-voided invoice dated within a window around this subscription's own
// expirationDate. The window is deliberately asymmetric -- an annual
// renewal invoice is far more likely to have already gone out BEFORE the
// expiry date than after it, so this looks back further than it looks
// forward.
const INVOICE_LOOKBACK_DAYS = 45;
const INVOICE_LOOKAHEAD_DAYS = 7;

// On top of the expiry-relative window above -- by request, never show an
// invoice older than 2 calendar months from TODAY, regardless of how the
// expiry-relative window math works out. Matters most for the "Expired
// Recently" window (whose expirationDate is itself in the past, which
// would otherwise let the lookback above reach further back than this) and
// guards against ever surfacing a genuinely stale invoice as if it were
// current.
function twoMonthsAgoMs() {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - 2);
  return d.getTime();
}

function findMatchingInvoice(invoices, expirationDate) {
  const expiryMs = new Date(`${expirationDate}T00:00:00.000Z`).getTime();
  const minMs = Math.max(expiryMs - INVOICE_LOOKBACK_DAYS * 86400000, twoMonthsAgoMs());
  const maxMs = expiryMs + INVOICE_LOOKAHEAD_DAYS * 86400000;
  let best = null;
  for (const inv of invoices) {
    if (inv.isVoided) continue;
    const invMs = new Date(inv.invoiceDateTime).getTime();
    if (Number.isNaN(invMs) || invMs < minMs || invMs > maxMs) continue;
    if (!best || invMs > new Date(best.invoiceDateTime).getTime()) best = inv;
  }
  return best;
}

async function buildLicensingReport(windowKey, includeRenewingMonthly) {
  const win = WINDOWS[windowKey];
  const token = await getToken();
  const [subscriptions, customers] = await Promise.all([fetchAllPages('/subscriptions', token, {}), fetchAllPages('/customers', token)]);
  const customerNameById = new Map(customers.map((c) => [c.id, c.name]));
  const today = todayAestKey();

  const rows = [];
  for (const s of subscriptions) {
    if (!s.expirationDate) continue;
    if (EXCLUDED_NAME_PATTERNS.some((pattern) => matchesWildcard(s.name, pattern))) continue;
    if (!MS_LICENSE_NAME_PATTERN.test(s.name)) continue;
    const daysUntilExpiry = daysBetween(today, s.expirationDate);
    if (daysUntilExpiry < win.minDays || daysUntilExpiry > win.maxDays) continue;
    const annual = isAnnualTerm(s);
    const autoRenews = !!s.renewalStatus;
    if (!includeRenewingMonthly && !showsByDefault(annual, autoRenews)) continue;
    rows.push({
      customerId: s.customerId,
      clientName: customerNameById.get(s.customerId) || `Customer #${s.customerId}`,
      id: s.id,
      name: s.name,
      term: annual ? 'annual' : 'monthly',
      autoRenews,
      expirationDate: s.expirationDate,
      daysUntilExpiry,
    });
  }

  // Resolve each distinct Ingram client name to a real Autotask company --
  // reuses resolveSingleCompany(), the exact same name-match
  // @dashboard/m365-environment's own route already relies on, rather than
  // inventing a second matching strategy. mapWithConcurrency caps this at 3
  // at a time, same convention @dashboard/contract-services uses for its
  // own per-company resolves.
  const client = await getClient();
  const uniqueClientNames = [...new Set(rows.map((r) => r.clientName))];
  const companyByClientName = new Map();
  await mapWithConcurrency(uniqueClientNames, 3, async (name) => {
    const resolved = await resolveSingleCompany(client, name).catch(() => null);
    companyByClientName.set(name, resolved && resolved.status === 'ok' ? resolved.company : null);
  });

  // Then, per distinct RESOLVED company (not per row -- several matching
  // subscriptions can belong to the same client), fetch its Autotask
  // contracted Microsoft-licensing lines.
  const uniqueCompanyIds = [...new Set([...companyByClientName.values()].filter(Boolean).map((c) => c.id))];
  const contractedByCompanyId = new Map();
  await mapWithConcurrency(uniqueCompanyIds, 3, async (companyId) => {
    contractedByCompanyId.set(companyId, await fetchCompanyContractedQty(client, companyId).catch(() => []));
  });

  // Invoices too, but only for companies that actually have an ANNUAL row
  // in this result set -- no reason to fetch a company's invoice history
  // just because it happens to have a monthly subscription in view.
  const uniqueAnnualCompanyIds = [
    ...new Set(
      rows
        .filter((r) => r.term === 'annual')
        .map((r) => companyByClientName.get(r.clientName))
        .filter(Boolean)
        .map((c) => c.id)
    ),
  ];
  const invoicesByCompanyId = new Map();
  await mapWithConcurrency(uniqueAnnualCompanyIds, 3, async (companyId) => {
    invoicesByCompanyId.set(companyId, await fetchCompanyInvoices(client, companyId).catch(() => []));
  });

  for (const row of rows) {
    const company = companyByClientName.get(row.clientName);
    row.companyId = company ? company.id : null;
    row.companyName = company ? company.companyName : null;
    const contractedLines = company ? contractedByCompanyId.get(company.id) || [] : [];
    const matchedLine = findMatchingContractedLine(contractedLines, row.name);
    row.contractedUnits = matchedLine ? matchedLine.units : null;
    row.contractedServiceName = matchedLine ? matchedLine.serviceName : null;

    if (row.term === 'annual' && company) {
      const invoice = findMatchingInvoice(invoicesByCompanyId.get(company.id) || [], row.expirationDate);
      row.invoiceNumber = invoice ? invoice.invoiceNumber : null;
      row.invoicePaid = invoice ? !!invoice.paidDate : false;
    } else {
      row.invoiceNumber = null;
      row.invoicePaid = false;
    }
  }

  rows.sort((a, b) => a.expirationDate.localeCompare(b.expirationDate) || a.clientName.localeCompare(b.clientName));

  return {
    asOf: new Date().toISOString(),
    section: 'licensing',
    window: windowKey,
    windowLabel: win.label,
    today,
    includeRenewingMonthly,
    totalCount: rows.length,
    rows,
  };
}

// ---------------------------------------------------------------------------
// Caching -- one cache per section, same 20-min TTL + per-key in-flight
// sharing convention as @dashboard/subscriptions-expiring, since both
// sections hit real external APIs (TPP / Ingram+Autotask+IT Glue) that are
// no cheaper to re-run on every Load click.
// ---------------------------------------------------------------------------
const REPORT_CACHE_TTL_MS = 20 * 60 * 1000;
const domainsCache = new Map(); // windowKey -> { data, expiresAt }
const domainsInFlight = new Map();
const licensingCache = new Map();
const licensingInFlight = new Map();

async function getCached(cache, inFlight, key, force, build) {
  const cached = cache.get(key);
  if (!force && cached && Date.now() < cached.expiresAt) return cached.data;
  if (!inFlight.has(key)) {
    const promise = build()
      .then((data) => {
        cache.set(key, { data, expiresAt: Date.now() + REPORT_CACHE_TTL_MS });
        return data;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, promise);
  }
  return inFlight.get(key);
}

const router = express.Router();

function requireValidWindow(req, res) {
  const windowKey = req.query.window || DEFAULT_WINDOW;
  if (!WINDOWS[windowKey]) {
    res.status(400).json({ error: `Query param "window" must be one of: ${Object.keys(WINDOWS).join(', ')}.` });
    return null;
  }
  return windowKey;
}

router.get('/domains', async (req, res) => {
  const windowKey = requireValidWindow(req, res);
  if (!windowKey) return;
  try {
    res.json(await getCached(domainsCache, domainsInFlight, windowKey, req.query.force === 'true', () => buildDomainsReport(windowKey)));
  } catch (err) {
    console.error('Coming Soon: Domains report failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/licensing', async (req, res) => {
  const windowKey = requireValidWindow(req, res);
  if (!windowKey) return;
  // Off by default -- see showsByDefault()'s own comment. The client's own
  // "Show Monthly Renewing" button sends this as 'true' to pull them in.
  const includeRenewingMonthly = req.query.includeRenewingMonthly === 'true';
  const cacheKey = `${windowKey}|${includeRenewingMonthly}`;
  try {
    res.json(
      await getCached(licensingCache, licensingInFlight, cacheKey, req.query.force === 'true', () =>
        buildLicensingReport(windowKey, includeRenewingMonthly)
      )
    );
  } catch (err) {
    console.error('Coming Soon: Microsoft Licensing report failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
