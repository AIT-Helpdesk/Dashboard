const express = require('express');
const {
  getClient,
  listAll,
  fetchByFieldIn,
  resolveSingleCompany,
  getPicklistLabels,
  getContractUrl,
  getCompanyUrl,
  getTicketUrl,
  resolveResourceName,
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

// --- Client Name Matching -------------------------------------------------
// Any Companies UDF whose name starts with "Name:" (e.g. "Name:TPP",
// "Name:Ingram Client") AND actually has a value -- these are the by-hand
// cross-system client-name matches written via @dashboard/data-matching's
// own "Update" button (see that package's README for the full backstory
// on why these UDFs exist). Not a fixed allowlist like CONTACT_UDF_NAMES
// above -- the whole point, by request, is to catch whatever "Name:*" UDFs
// exist now or get added later with no code change here. Case-insensitive
// prefix match ("NAME:" as the request spelled it) since Autotask UDF
// names are free-text and there's no guarantee every one was typed with
// the exact same casing.
function buildNameMatchingUdfs(company) {
  return (company.userDefinedFields || [])
    .filter((f) => f.name && f.name.toLowerCase().startsWith('name:') && f.value && f.value.trim())
    .map((f) => ({ name: f.name, value: f.value.trim() }));
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

// --- Recent Tickets ------------------------------------------
// "Open" here is the same definition Completed Tickets uses for "done" --
// status 5 (Complete) and 20 (Billing - Contract) -- inverted: anything
// NOT one of those two counts as open, rather than inventing a separate
// list for this page. issueType 14 (Monitoring Alert) is excluded
// dashboard-wide, same as every other ticket-listing page -- client-side via
// excludeMonitoringAlerts(), not an Autotask query filter (see that
// function's own comment for why: a `noteq` filter silently drops every
// not-yet-triaged ticket too, confirmed a real production bug).
const CLOSED_STATUS_COMPLETE = 5;
const CLOSED_STATUS_BILLING_CONTRACT = 20;
const CLOSED_STATUSES = [CLOSED_STATUS_COMPLETE, CLOSED_STATUS_BILLING_CONTRACT];
// By request: no longer capped to the 8 most recent -- shows every open
// ticket, plus anything closed in this trailing window.
const CLOSED_LOOKBACK_DAYS = 7;

async function buildRecentTickets(client, company) {
  const todayKey = todayAestKey();
  const [ty, tm, td] = todayKey.split('-').map(Number);
  const windowStartISO = aestToUtcIso(ty, tm, td - CLOSED_LOOKBACK_DAYS);
  const windowEndISO = aestToUtcIso(ty, tm, td + 1); // exclusive, through the end of today

  const [rawOpenTickets, rawCompletedTickets, rawBillingTickets, statusLabels] = await Promise.all([
    listAll(client.tickets, [
      { op: 'eq', field: 'companyID', value: company.id },
      { op: 'notIn', field: 'status', value: CLOSED_STATUSES },
    ]),
    // Status 5 ("Complete") is filtered on completedDate -- same convention
    // Completed Tickets' own server.js uses.
    listAll(client.tickets, [
      { op: 'eq', field: 'companyID', value: company.id },
      { op: 'eq', field: 'status', value: CLOSED_STATUS_COMPLETE },
      { op: 'gte', field: 'completedDate', value: windowStartISO },
      { op: 'lt', field: 'completedDate', value: windowEndISO },
    ]),
    // Status 20 ("Billing - Contract") never gets completedDate set (Autotask
    // only populates that on the transition to status 5) -- resolvedDateTime
    // is the closest equivalent, same real-data quirk Completed Tickets'
    // own server.js already documents.
    listAll(client.tickets, [
      { op: 'eq', field: 'companyID', value: company.id },
      { op: 'eq', field: 'status', value: CLOSED_STATUS_BILLING_CONTRACT },
      { op: 'gte', field: 'resolvedDateTime', value: windowStartISO },
      { op: 'lt', field: 'resolvedDateTime', value: windowEndISO },
    ]),
    getPicklistLabels(client.tickets, 'status'),
  ]);
  const openTickets = excludeMonitoringAlerts(rawOpenTickets);
  const closedTickets = excludeMonitoringAlerts([...rawCompletedTickets, ...rawBillingTickets]);

  const recent = [...openTickets, ...closedTickets].sort(
    (a, b) => new Date(b.lastActivityDate || 0) - new Date(a.lastActivityDate || 0)
  );

  // Secondary resources live on their own child entity (TicketSecondaryResources
  // -- {ticketID, resourceID, roleID}), not a field on Tickets itself. Fetched
  // just for this page's own rows, not every open ticket, since it's only
  // ever displayed for these rows.
  const recentIds = recent.map((t) => t.id);
  const secondaryRows = recentIds.length > 0 ? await fetchByFieldIn(client.ticketSecondaryResources, 'ticketID', recentIds) : [];
  const secondaryByTicket = new Map();
  for (const row of secondaryRows) {
    if (!secondaryByTicket.has(row.ticketID)) secondaryByTicket.set(row.ticketID, []);
    secondaryByTicket.get(row.ticketID).push(row.resourceID);
  }

  const rows = [];
  for (const t of recent) {
    const secondaryResourceIds = secondaryByTicket.get(t.id) || [];
    rows.push({
      id: t.id,
      ticketNumber: t.ticketNumber,
      ticketUrl: await getTicketUrl(t.id),
      title: t.title,
      status: statusLabels.get(t.status) || `#${t.status}`,
      statusId: t.status,
      lastActivityDate: t.lastActivityDate,
      primaryResource: t.assignedResourceID ? await resolveResourceName(client, t.assignedResourceID) : null,
      secondaryResources: await Promise.all(secondaryResourceIds.map((id) => resolveResourceName(client, id))),
    });
  }

  return { openCount: openTickets.length, closedCount: closedTickets.length, recent: rows };
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

    const [activeContracts, installedServices, recentTickets, securityAlerts] = await Promise.all([
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
      nameMatchingUdfs: buildNameMatchingUdfs(company),
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
