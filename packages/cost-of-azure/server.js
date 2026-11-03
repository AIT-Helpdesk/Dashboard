const express = require('express');
const { getClient, listAll, fetchByFieldIn, getCompanyUrl, getContractUrl, parseWildcard, aestToUtcIso, todayAestKey } = require('@dashboard/autotask-client');

// By request: contract name "Sync - Cost of Azure*" -- a trailing `*`
// (the dashboard's standard wildcard convention, see parseWildcard()),
// so this catches per-client variants of the name (e.g. "Sync - Cost of
// Azure Services", "Sync - Cost of Azure Remote Desktop"), not just an
// exact "Sync - Cost of Azure". There are 16 real Contracts matching
// this (one per company), not a single shared contract; every one of
// them is fetched below.
const CONTRACT_NAME_SEARCH = 'Sync - Cost of Azure*';

// BillingItems.billingItemType picklist (fixed Autotask-wide values, not
// org config -- see @dashboard/client-financials' own comment, which this
// mirrors): 1 Labor, 2 Labor Adjustment, 3 Cost, 4 Expense, 5 Subscription,
// 6 Recurring Service/Bundle, 7 Recurring Contract Setup Fee, 8 Milestone.
const RECURRING_SERVICE_TYPE = 6;

// By request: only items from 1 July 2026 (AEST) onward.
const SINCE_ISO = aestToUtcIso(2026, 7, 1);

// By request: up to the end of the current month -- recomputed on every
// call (not a module-load-time constant like SINCE_ISO above), since
// "the current month" changes as real time passes. The exclusive upper
// bound is the 1st of NEXT month AEST (Date.UTC's month arg rolls over
// correctly past 12, same overflow trick aestDayBoundsIso's own `day + 1`
// already relies on, so this works fine in December without special-
// casing the year rollover).
function untilEndOfCurrentMonthIso() {
  const [year, month] = todayAestKey().split('-').map(Number);
  return aestToUtcIso(year, month + 1, 1);
}

const DEFAULT_POSTED_STATE = 'unposted';
const VALID_POSTED_STATES = new Set(['unposted', 'posted-not-invoiced', 'invoiced']);

const router = express.Router();

// Resolves the contract name wildcard + the companies behind them --
// shared setup for every posted-state branch below.
async function resolveContractsAndCompanies(client) {
  const wildcard = parseWildcard(CONTRACT_NAME_SEARCH);
  const contracts = await listAll(client.contracts, [{ op: wildcard.op, field: 'contractName', value: wildcard.value }]);
  const contractById = new Map(contracts.map((c) => [c.id, c]));

  // `.filter(Boolean)` would wrongly drop companyID 0 -- confirmed live
  // that's a REAL company in this tenant ("Ambient IT" itself, AmbientIT's
  // own internal company record), not "no company". Only null/undefined
  // mean that here.
  const companyIds = [...new Set(contracts.map((c) => c.companyID).filter((v) => v !== null && v !== undefined))];
  const companies = companyIds.length > 0 ? await fetchByFieldIn(client.companies, 'id', companyIds) : [];
  const companyById = new Map(companies.map((co) => [co.id, co]));

  return { contracts, contractById, companyById };
}

// ContractServices.invoiceDescription (the real "Invoice Description"
// shown on Autotask's own screens -- confirmed live, NOT a field on
// either BillingItems or ContractServiceUnits directly) and
// ContractServices.unitPrice (the contract's own standard rate, used as
// the "original" -- pre-edit -- amount to compare against), both joined
// via contractServiceID. Shared by both posted-state branches below,
// since both source rows carry a contractServiceID.
async function fetchContractServicesByIds(client, contractServiceIds) {
  const ids = [...new Set(contractServiceIds.filter((v) => v !== null && v !== undefined))];
  const rows = ids.length > 0 ? await fetchByFieldIn(client.contractServices, 'id', ids) : [];
  return new Map(rows.map((cs) => [cs.id, cs]));
}

function buildOriginalAndEdited(contractService, quantity, currentAmount) {
  const originalBillableAmount =
    contractService && typeof contractService.unitPrice === 'number' && typeof quantity === 'number' ? contractService.unitPrice * quantity : null;
  const isEdited = originalBillableAmount !== null && Math.abs(originalBillableAmount - currentAmount) > 0.001;
  return { originalBillableAmount, isEdited };
}

// Posted - Not Invoiced / Invoiced -- unchanged from before, by request
// ("keep the posted and invoiced results 'as is' for now"). Sources from
// BillingItems, which (confirmed live) only ever contains rows that have
// already been through Approve and Post -- see README.
const BILLING_ITEMS_POSTED_STATE_FILTERS = {
  'posted-not-invoiced': [
    { op: 'exist', field: 'postedDate' },
    { op: 'notExist', field: 'invoiceID' },
  ],
  invoiced: [{ op: 'exist', field: 'invoiceID' }],
};

async function fetchBillingItemsState(client, postedState, contractIds, contractById, companyById) {
  const billingItems = await fetchByFieldIn(client.billingItems, 'contractID', contractIds, [
    { op: 'eq', field: 'billingItemType', value: RECURRING_SERVICE_TYPE },
    { op: 'gte', field: 'itemDate', value: SINCE_ISO },
    { op: 'lt', field: 'itemDate', value: untilEndOfCurrentMonthIso() },
    ...BILLING_ITEMS_POSTED_STATE_FILTERS[postedState],
  ]);

  const contractServiceById = await fetchContractServicesByIds(client, billingItems.map((bi) => bi.contractServiceID));

  const items = [];
  for (const bi of billingItems) {
    const contract = contractById.get(bi.contractID);
    const company = contract ? companyById.get(contract.companyID) : null;
    const contractService = bi.contractServiceID ? contractServiceById.get(bi.contractServiceID) : null;
    const billableAmount = bi.extendedPrice ?? 0;
    const { originalBillableAmount, isEdited } = buildOriginalAndEdited(contractService, bi.quantity, billableAmount);

    items.push({
      id: bi.id,
      companyId: company ? company.id : null,
      companyName: company ? company.companyName : '(unknown client)',
      companyUrl: company ? await getCompanyUrl(company.id) : null,
      contractId: bi.contractID,
      contractUrl: await getContractUrl(bi.contractID),
      description: (contractService && contractService.invoiceDescription) || bi.description || bi.itemName || '',
      quantity: bi.quantity ?? null,
      unitPrice: bi.unitPrice ?? null,
      billableAmount,
      originalBillableAmount,
      isEdited,
      itemDate: bi.itemDate || null,
    });
  }
  return items;
}

// Unposted -- NOT BillingItems at all. Confirmed live (and confirmed
// against Autotask's own REST API docs, which define BillingItems as
// "an approved and posted billable item" -- i.e. a genuinely unposted
// row can never exist in that entity): the real source is
// ContractServiceUnits, one row per service per billing period, with
// `approveAndPostDate` null until Approve and Post happens. Confirmed by
// an exact match against real data -- a row with `price: 315.68` and
// another `price: 371.42` on Cloud King Hosting's own "Sync - Cost of
// Azure Remote Desktop" contract, matching a real screenshot of
// Autotask's own Unposted Items screen exactly.
//
// Read-only, by request ("I don't need to update ContractServiceUnits") --
// Autotask's own docs list this entity as query-only (no Create/Update
// support) anyway, so no write route exists for this branch.
async function fetchUnpostedState(client, contractIds, contractById, companyById) {
  const units = await fetchByFieldIn(client.contractServiceUnits, 'contractID', contractIds, [
    { op: 'notExist', field: 'approveAndPostDate' },
    { op: 'gte', field: 'startDate', value: SINCE_ISO },
    { op: 'lt', field: 'startDate', value: untilEndOfCurrentMonthIso() },
  ]);

  const contractServiceById = await fetchContractServicesByIds(client, units.map((u) => u.contractServiceID));

  const items = [];
  for (const u of units) {
    const contract = contractById.get(u.contractID);
    const company = contract ? companyById.get(contract.companyID) : null;
    const contractService = u.contractServiceID ? contractServiceById.get(u.contractServiceID) : null;
    const billableAmount = u.price ?? 0;
    const { originalBillableAmount, isEdited } = buildOriginalAndEdited(contractService, u.units, billableAmount);

    items.push({
      id: u.id,
      companyId: company ? company.id : null,
      companyName: company ? company.companyName : '(unknown client)',
      companyUrl: company ? await getCompanyUrl(company.id) : null,
      contractId: u.contractID,
      contractUrl: await getContractUrl(u.contractID),
      description: (contractService && contractService.invoiceDescription) || '',
      quantity: u.units ?? null,
      unitPrice: contractService ? contractService.unitPrice ?? null : null,
      billableAmount,
      originalBillableAmount,
      isEdited,
      itemDate: u.startDate || null,
    });
  }
  return items;
}

router.get('/', async (req, res) => {
  const postedState = VALID_POSTED_STATES.has(req.query.postedState) ? req.query.postedState : DEFAULT_POSTED_STATE;

  try {
    const client = await getClient();

    const { contracts, contractById, companyById } = await resolveContractsAndCompanies(client);
    if (contracts.length === 0) {
      return res.json({ contractCount: 0, items: [], postedState });
    }
    const contractIds = contracts.map((c) => c.id);

    const items =
      postedState === 'unposted'
        ? await fetchUnpostedState(client, contractIds, contractById, companyById)
        : await fetchBillingItemsState(client, postedState, contractIds, contractById, companyById);
    items.sort((a, b) => a.companyName.localeCompare(b.companyName));

    res.json({ contractCount: contracts.length, items, postedState });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
