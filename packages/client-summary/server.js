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
  monthKeysWindow,
  todayAestKey,
  aestToUtcIso,
} = require('@dashboard/autotask-client');
const { get: saasAlertsGet } = require('@dashboard/saasalerts-client');

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
// Cover"/"Labour in Charges" splits), condensed here to a single 12-month
// total per category rather than a month-by-month grid -- this is meant to
// be a glance, not a repeat of that page.
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

  const totals = { labour: 0, recurringTechCover: 0, recurringOther: 0, chargesLabour: 0, chargesOther: 0 };
  for (const item of billingItems) {
    const invoice = invoicesById.get(item.invoiceID);
    if (!invoice) continue; // scoped to invoiceIds above, so this shouldn't happen
    totals[bucketOf(item, labourInChargesCodeId, contractNameById)] += item.totalAmount || 0;
  }
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
async function buildActiveContracts(client, company) {
  const [contracts, contractTypeLabels] = await Promise.all([
    listAll(client.contracts, [
      { op: 'eq', field: 'companyID', value: company.id },
      { op: 'eq', field: 'status', value: 1 },
    ]),
    getPicklistLabels(client.contracts, 'contractType'),
  ]);

  const rows = [];
  for (const c of contracts) {
    rows.push({
      id: c.id,
      contractName: c.contractName,
      contractUrl: await getContractUrl(c.id),
      contractType: contractTypeLabels.get(c.contractType) || `#${c.contractType}`,
      startDate: c.startDate,
      endDate: c.endDate,
    });
  }
  rows.sort((a, b) => a.contractName.localeCompare(b.contractName));
  return rows;
}

// --- Recent ticket activity ------------------------------------------
// "Open" here is the same definition Completed Tickets uses for "done" --
// status 5 (Complete) and 20 (Billing - Contract) -- inverted: anything
// NOT one of those two counts as open, rather than inventing a separate
// list for this page. issueType 14 (Monitoring Alert) is excluded
// dashboard-wide, same as every other ticket-listing page.
const CLOSED_STATUSES = [5, 20];
const RECENT_TICKET_LIMIT = 8;

async function buildRecentTickets(client, company) {
  const [openTickets, statusLabels] = await Promise.all([
    listAll(client.tickets, [
      { op: 'eq', field: 'companyID', value: company.id },
      { op: 'notIn', field: 'status', value: CLOSED_STATUSES },
      { op: 'noteq', field: 'issueType', value: 14 },
    ]),
    getPicklistLabels(client.tickets, 'status'),
  ]);

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

async function findSaasAlertsCustomerId(companyId) {
  const customers = await saasAlertsGet('/reports/customers');
  const match = customers.find((c) => (c.mappedToPSA || []).some((m) => m.product === 'autotaskpsa' && m.mappedTo === String(companyId)));
  return match ? match.id : null;
}

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

    const [financialSnapshot, activeContracts, recentTickets, securityAlerts] = await Promise.all([
      buildFinancialSnapshot(client, company),
      buildActiveContracts(client, company),
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
      classification: classificationLabels.get(company.classification) || null,
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
      recentTickets,
      securityAlerts,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
