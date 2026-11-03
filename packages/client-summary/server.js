const express = require('express');
const {
  getClient,
  listAll,
  fetchByFieldIn,
  resolveSingleCompany,
  getPicklistLabels,
  getBillingCodeIdByName,
  getContractUrl,
  getCompanyUrl,
  getInvoiceUrl,
  getTicketUrl,
  matchesWildcard,
  last12MonthKeys,
  monthKeyOf,
  monthLabel,
  monthKeysWindow,
  todayAestKey,
  aestToUtcIso,
  excludeMonitoringAlerts,
} = require('@dashboard/autotask-client');
const { get: saasAlertsGet } = require('@dashboard/saasalerts-client');
const { findSaasAlertsCustomerId, buildInstalledServices } = require('./installed-services.js');

// Company-level UDFs to surface next to Primary/Billing Contact, by request.
// Confirmed against real data (Companies/178): these live on
// Companies.userDefinedFields, NOT Contacts.userDefinedFields, despite the
// "Contact - " naming prefix -- each one holds a free-text name (or is
// blank) for who fills that role at the client, not an actual link to a
// Contact record.
const CONTACT_UDF_NAMES = ['Contact - Primary IT', 'Contact - IT Security', 'Contact - Sales Approvals'];
function getCompanyUdf(company, udfName) {
  const udf = (company.userDefinedFields || []).find((f) => f.name === udfName);
  return udf ? udf.value : null;
}

// --- Financial snapshot -----------------------------------------------
// Same billingItemType bucketing Client Financials uses (see that page's
// README for the full rationale on the picklist mapping and the "Tech
// Cover"/"Labour in Charges" splits). Condensed relative to that page's full
// 13-column (12 months + total) grid -- this shows just the last 4 months
// individually, plus the 12-month total as its own last column, by request
// -- a glance at recent trend without repeating the full year Client
// Financials already covers in detail.
const RECENT_MONTHS = 4;
const LABOUR_TYPES = new Set([1, 2]);
const RECURRING_TYPES = new Set([6]);
function bucketOf(item, labourInChargesCodeId, contractNameById) {
  if (LABOUR_TYPES.has(item.billingItemType)) return 'labour';
  if (RECURRING_TYPES.has(item.billingItemType)) {
    const contractName = contractNameById.get(item.contractID) || '';
    return matchesWildcard(contractName, 'Tech Cover*') ? 'recurringTechCover' : 'recurringOther';
  }
  if (labourInChargesCodeId && item.billingCodeID === labourInChargesCodeId) return 'chargesLabour';
  return 'chargesOther';
}

async function buildFinancialSnapshot(client, company) {
  const monthKeys = last12MonthKeys();
  const { windowStart, windowEnd } = monthKeysWindow(monthKeys);

  const invoices = await listAll(client.invoices, [
    { op: 'eq', field: 'companyID', value: company.id },
    { op: 'gte', field: 'invoiceDateTime', value: windowStart },
    { op: 'lt', field: 'invoiceDateTime', value: windowEnd },
    { op: 'eq', field: 'isVoided', value: false },
  ]);
  const invoicesById = new Map(invoices.map((inv) => [inv.id, inv]));
  const invoiceIds = [...invoicesById.keys()];

  const [billingItems, labourInChargesCodeId] = await Promise.all([
    invoiceIds.length > 0 ? fetchByFieldIn(client.billingItems, 'invoiceID', invoiceIds) : [],
    getBillingCodeIdByName(client, 'Labour in Charges'),
  ]);

  const recurringContractIds = [
    ...new Set(billingItems.filter((i) => RECURRING_TYPES.has(i.billingItemType) && i.contractID).map((i) => i.contractID)),
  ];
  const contracts = recurringContractIds.length > 0 ? await fetchByFieldIn(client.contracts, 'id', recurringContractIds) : [];
  const contractNameById = new Map(contracts.map((c) => [c.id, c.contractName]));

  // Bucketed per MONTH (same shape Client Financials uses), not just a flat
  // 12-month total -- the recent-months table below is a slice of this, and
  // the 12-Month Total column is this same map's grand sum, so the two
  // always agree with each other by construction rather than being computed
  // two different ways.
  const monthTotals = new Map(
    monthKeys.map((key) => [key, { labour: 0, recurringTechCover: 0, recurringOther: 0, chargesLabour: 0, chargesOther: 0 }])
  );
  for (const item of billingItems) {
    const invoice = invoicesById.get(item.invoiceID);
    if (!invoice) continue; // scoped to invoiceIds above, so this shouldn't happen
    const bucket = monthTotals.get(monthKeyOf(invoice.invoiceDateTime));
    if (!bucket) continue; // shouldn't happen given the invoice date filter, but safe
    bucket[bucketOf(item, labourInChargesCodeId, contractNameById)] += item.totalAmount || 0;
  }

  const months = monthKeys.map((key) => {
    const t = monthTotals.get(key);
    return {
      key,
      label: monthLabel(key),
      labour: t.labour,
      recurringTechCover: t.recurringTechCover,
      recurringOther: t.recurringOther,
      chargesLabour: t.chargesLabour,
      chargesOther: t.chargesOther,
      total: t.labour + t.recurringTechCover + t.recurringOther + t.chargesLabour + t.chargesOther,
    };
  });
  const recentMonths = months.slice(-RECENT_MONTHS);

  const totals = months.reduce(
    (acc, m) => ({
      labour: acc.labour + m.labour,
      recurringTechCover: acc.recurringTechCover + m.recurringTechCover,
      recurringOther: acc.recurringOther + m.recurringOther,
      chargesLabour: acc.chargesLabour + m.chargesLabour,
      chargesOther: acc.chargesOther + m.chargesOther,
    }),
    { labour: 0, recurringTechCover: 0, recurringOther: 0, chargesLabour: 0, chargesOther: 0 }
  );
  const total = totals.labour + totals.recurringTechCover + totals.recurringOther + totals.chargesLabour + totals.chargesOther;

  let mostRecentInvoice = null;
  if (invoices.length > 0) {
    const latest = [...invoices].sort((a, b) => new Date(b.invoiceDateTime) - new Date(a.invoiceDateTime))[0];
    mostRecentInvoice = {
      id: latest.id,
      invoiceNumber: latest.invoiceNumber,
      invoiceUrl: await getInvoiceUrl(latest.id),
      invoiceDate: latest.invoiceDateTime,
      total: latest.invoiceTotal,
    };
  }

  return {
    recentMonths,
    twelveMonthTotals: { ...totals, total },
    invoiceCount: invoices.length,
    mostRecentInvoice,
  };
}

// --- Active contracts ----------------------------------------------------
// Contracts.status is a 2-value picklist -- 1 "In Effect", 3 "Terminated"
// (confirmed via field info) -- "active" here means status 1, a live
// current-state snapshot, not date-range-overlap logic like Contract
// Services' month-scoped report.
//
// Warnings (orange, by request) -- checked against this SAME active-
// contracts list, not a second unfiltered query:
//   - No active contract whose name starts with "T&M" has
//     Contracts.isDefaultContract set (confirmed live, a real boolean
//     field -- Autotask's own "which contract is this company's billing
//     default" flag). Always checked, every client.
//   - Classification-specific, only when it applies: a "Tech Cover Elite"
//     client with no active contract starting "Tech Cover Elite", or a
//     "Tech Cover Essentials" client with none starting "Tech Cover
//     Essentials" (confirmed real classification label strings via
//     Companies.classification's own picklist). Both are plain
//     case-insensitive PREFIX checks on contractName, same "starting
//     with" wording the request used.
function normalizeContractName(s) {
  return (s || '').trim().toUpperCase();
}

// Next Billing Date, by request -- derived the same way Check Client's own
// Contract column annotation does (contract-services/server.js's own
// nextPeriodStartISO()): the day after the CURRENT ContractServiceUnits
// period's own endDate, for whichever service on that contract is
// currently mid-period (startDate <= today <= endDate). One BATCHED
// fetchByFieldIn() across every active contract id, not one query per
// contract. A contract can have several services on different cycles --
// the LATEST current-period endDate among them wins (same "soonest wrong,
// latest right" reasoning as picking the longest-running current period).
// Not every contract has one at all -- confirmed live, a T&M (time &
// materials) contract has no recurring per-period units to begin with, so
// it simply shows no Next Billing Date, same as any other contract with no
// current-period unit found (nothing to guess at).
async function buildNextBillingDates(client, contractIds) {
  if (contractIds.length === 0) return new Map();
  const todayKey = todayAestKey();
  const [ty, tm, td] = todayKey.split('-').map(Number);
  const todayIso = aestToUtcIso(ty, tm, td);
  const units = await fetchByFieldIn(client.contractServiceUnits, 'contractID', contractIds, [
    { op: 'lte', field: 'startDate', value: todayIso },
    { op: 'gte', field: 'endDate', value: todayIso },
  ]);
  const latestEndByContract = new Map();
  for (const u of units) {
    const existing = latestEndByContract.get(u.contractID);
    if (!existing || u.endDate > existing) latestEndByContract.set(u.contractID, u.endDate);
  }
  const nextBillingByContract = new Map();
  for (const [contractId, endDate] of latestEndByContract.entries()) {
    const next = new Date(endDate);
    next.setUTCDate(next.getUTCDate() + 1);
    nextBillingByContract.set(contractId, next.toISOString());
  }
  return nextBillingByContract;
}

async function buildActiveContracts(client, company, classification) {
  const [contracts, contractTypeLabels] = await Promise.all([
    listAll(client.contracts, [
      { op: 'eq', field: 'companyID', value: company.id },
      { op: 'eq', field: 'status', value: 1 },
    ]),
    getPicklistLabels(client.contracts, 'contractType'),
  ]);
  const nextBillingByContract = await buildNextBillingDates(client, contracts.map((c) => c.id));

  const rows = [];
  for (const c of contracts) {
    rows.push({
      id: c.id,
      contractName: c.contractName,
      contractUrl: await getContractUrl(c.id),
      contractType: contractTypeLabels.get(c.contractType) || `#${c.contractType}`,
      startDate: c.startDate,
      endDate: c.endDate,
      nextBillingDate: nextBillingByContract.get(c.id) || null,
    });
  }
  rows.sort((a, b) => a.contractName.localeCompare(b.contractName));

  const warnings = [];
  const hasTmDefault = contracts.some((c) => c.isDefaultContract && normalizeContractName(c.contractName).startsWith('T&M'));
  if (!hasTmDefault) {
    warnings.push('No active contract starting with "T&M" is set as the default contract.');
  }
  if (classification === 'Tech Cover Elite' && !contracts.some((c) => normalizeContractName(c.contractName).startsWith('TECH COVER ELITE'))) {
    warnings.push('No active "Tech Cover Elite" contract was found.');
  }
  if (classification === 'Tech Cover Essentials' && !contracts.some((c) => normalizeContractName(c.contractName).startsWith('TECH COVER ESSENTIALS'))) {
    warnings.push('No active "Tech Cover Essentials" contract was found.');
  }

  // 2 blue "contract pills", by request -- which active contract (if any)
  // is this client's billing default, and which (if any) is its "Tech
  // Cover Elite*" contract (the SAME wildcard-prefix match the warning
  // above already uses). Shown here and on TC Elite Services (every TC
  // Elite client at once) -- TC Elite Services builds the identical pair
  // itself from its own batched contract fetch, not via this function
  // (that page never resolves one company's Active Contracts section at
  // all), but the two are deliberately the exact same rule.
  const defaultContract = contracts.find((c) => c.isDefaultContract) || null;
  const eliteContract = contracts.find((c) => normalizeContractName(c.contractName).startsWith('TECH COVER ELITE')) || null;

  return {
    rows,
    warnings,
    defaultContractName: defaultContract ? defaultContract.contractName : null,
    // Both pills click through to the matched contract in Autotask, by
    // request -- same getContractUrl()/popup-window convention every
    // other contract link on this page already uses.
    defaultContractUrl: defaultContract ? await getContractUrl(defaultContract.id) : null,
    eliteContractName: eliteContract ? eliteContract.contractName : null,
    eliteContractUrl: eliteContract ? await getContractUrl(eliteContract.id) : null,
  };
}

// --- Installed Services --------------------------------------------------
// buildInstalledServices() itself now lives in ./installed-services.js --
// shared with TC Elite Services, which needs the exact same per-company
// check across every TC Elite client at once, by request. See that file's
// own comment for the full methodology.

// --- Recent ticket activity ------------------------------------------
// "Open" here is the same definition Completed Tickets uses for "done" --
// status 5 (Complete) and 20 (Billing - Contract) -- inverted: anything
// NOT one of those two counts as open, rather than inventing a separate
// list for this page. issueType 14 (Monitoring Alert) is excluded
// dashboard-wide, same as every other ticket-listing page -- client-side via
// excludeMonitoringAlerts(), not an Autotask query filter (see that
// function's own comment for why: a `noteq` filter silently drops every
// not-yet-triaged ticket too, confirmed a real production bug).
const CLOSED_STATUSES = [5, 20];
const RECENT_TICKET_LIMIT = 8;

async function buildRecentTickets(client, company) {
  const [rawOpenTickets, statusLabels] = await Promise.all([
    listAll(client.tickets, [
      { op: 'eq', field: 'companyID', value: company.id },
      { op: 'notIn', field: 'status', value: CLOSED_STATUSES },
    ]),
    getPicklistLabels(client.tickets, 'status'),
  ]);
  const openTickets = excludeMonitoringAlerts(rawOpenTickets);

  const recent = [...openTickets]
    .sort((a, b) => new Date(b.lastActivityDate || 0) - new Date(a.lastActivityDate || 0))
    .slice(0, RECENT_TICKET_LIMIT);

  const rows = [];
  for (const t of recent) {
    rows.push({
      id: t.id,
      ticketNumber: t.ticketNumber,
      ticketUrl: await getTicketUrl(t.id),
      title: t.title,
      status: statusLabels.get(t.status) || `#${t.status}`,
      lastActivityDate: t.lastActivityDate,
    });
  }

  return { openCount: openTickets.length, recent: rows };
}

// --- Security Alerts (1-month) summary --------------------------------
// Mirrors Security Alerts' own scoping (medium+critical only -- alertStatus
// is `low` for ~99.8% of all events, confirmed against real data there, so
// this page inherits the same "genuine alerts, not a raw activity log"
// scope, no toggle). Matched by the SaaS Alerts customer's OWN id, resolved
// via its `mappedToPSA` entry for this exact Autotask company, rather than
// name-wildcard matching (which is what the standalone Security Alerts page
// has to fall back on, since it has no Autotask company to start from) --
// an id match is exact where a name match could coincidentally collide.
const SEVERITIES = ['critical', 'medium'];
const SIZE_CAP = 10000; // see Security Alerts' server.js for the undocumented ceiling this guards against

// findSaasAlertsCustomerId() itself now lives in ./installed-services.js,
// shared with Installed Services (and now TC Elite Services) -- same
// mappedToPSA id match as before, just no longer duplicated here.

function oneMonthAgoDateKey(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 2, d)).toISOString().slice(0, 10);
}

async function buildSecurityAlertsSummary(company) {
  const saasCustomerId = await findSaasAlertsCustomerId(company.id);
  if (!saasCustomerId) return { monitored: false };

  const todayKey = todayAestKey();
  const startKey = oneMonthAgoDateKey(todayKey);
  const [sy, sm, sd] = startKey.split('-').map(Number);
  const [ey, em, ed] = todayKey.split('-').map(Number);
  const startISO = aestToUtcIso(sy, sm, sd);
  const endISO = aestToUtcIso(ey, em, ed + 1); // exclusive, includes all of "today"

  const bySeverity = await Promise.all(
    SEVERITIES.map(async (alertStatus) => {
      const { total } = await saasAlertsGet('/reports/events/count', { start: startISO, end: endISO, alertStatus });
      if (total === 0) return [];
      const size = Math.min(total, SIZE_CAP);
      return saasAlertsGet('/reports/events', { start: startISO, end: endISO, alertStatus, size, timeSort: 'desc' });
    })
  );
  const events = bySeverity.flat().filter((e) => e.customer?.id === saasCustomerId);

  const byEventName = new Map();
  let criticalCount = 0;
  let mediumCount = 0;
  for (const e of events) {
    if (e.alertStatus === 'critical') criticalCount++;
    else if (e.alertStatus === 'medium') mediumCount++;
    const name = e.jointDesc || e.jointType || 'Event';
    byEventName.set(name, (byEventName.get(name) || 0) + 1);
  }
  const topEvents = [...byEventName.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return {
    monitored: true,
    periodStart: startKey,
    periodEnd: todayKey,
    totalCount: events.length,
    criticalCount,
    mediumCount,
    topEvents,
  };
}

const router = express.Router();

router.get('/', async (req, res) => {
  const clientSearch = (req.query.client || '').trim();
  if (!clientSearch) {
    return res.status(400).json({ error: 'Query param "client" is required.' });
  }
  const companyId = req.query.companyId ? Number(req.query.companyId) : null;

  try {
    const client = await getClient();

    const resolved = await resolveSingleCompany(client, clientSearch, companyId);
    if (resolved.status !== 'ok') {
      return res.json({ client: clientSearch, ...resolved });
    }
    const company = resolved.company;

    const [contacts, classificationLabels] = await Promise.all([
      listAll(client.contacts, [{ op: 'eq', field: 'companyID', value: company.id }]),
      getPicklistLabels(client.companies, 'classification'),
    ]);
    const primaryContact = contacts.find((c) => c.primaryContact === true) || null;
    const billingContact = contacts.find((c) => c.billingContact === true) || null;
    const classification = classificationLabels.get(company.classification) || null;

    const [financialSnapshot, activeContracts, installedServices, recentTickets, securityAlerts] = await Promise.all([
      buildFinancialSnapshot(client, company),
      buildActiveContracts(client, company, classification),
      buildInstalledServices(company),
      buildRecentTickets(client, company),
      buildSecurityAlertsSummary(company),
    ]);

    res.json({
      client: clientSearch,
      status: 'ok',
      companyId: company.id,
      companyName: company.companyName,
      companyUrl: await getCompanyUrl(company.id),
      isActive: company.isActive,
      classification,
      address: {
        line1: company.address1 || null,
        line2: company.address2 || null,
        city: company.city || null,
        state: company.state || null,
        postalCode: company.postalCode || null,
      },
      phone: company.phone || null,
      primaryContact: primaryContact
        ? { id: primaryContact.id, name: [primaryContact.firstName, primaryContact.lastName].filter(Boolean).join(' '), email: primaryContact.emailAddress || null, phone: primaryContact.phone || primaryContact.mobilePhone || null }
        : null,
      billingContact: billingContact
        ? { id: billingContact.id, name: [billingContact.firstName, billingContact.lastName].filter(Boolean).join(' '), email: billingContact.emailAddress || null, phone: billingContact.phone || billingContact.mobilePhone || null }
        : null,
      contactUdfs: CONTACT_UDF_NAMES.map((name) => ({ name, value: getCompanyUdf(company, name) })),
      financialSnapshot,
      activeContracts,
      installedServices,
      recentTickets,
      securityAlerts,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
