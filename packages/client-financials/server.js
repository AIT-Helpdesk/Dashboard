const express = require('express');
const {
  getClient,
  listAll,
  fetchByFieldIn,
  getInvoiceUrl,
  getCompanyUrl,
  getBillingCodeIdByName,
  matchesWildcard,
  resolveSingleCompany,
  last12MonthKeys,
  monthKeyOf,
  monthLabel,
  monthKeysWindow,
} = require('@dashboard/autotask-client');

// BillingItems.billingItemType picklist (fixed Autotask-wide values, not org
// config -- see BillingItems field info): 1 Labor, 2 Labor Adjustment,
// 3 Cost (ticket/project/contract), 4 Expense, 5 Subscription,
// 6 Recurring Service/Bundle, 7 Recurring Contract Setup Fee, 8 Milestone.
// Mapped to the three requested buckets; everything not Labour or Recurring
// Service falls into Charges (materials, expenses, one-off costs and fees).
const LABOUR_TYPES = new Set([1, 2]);
const RECURRING_TYPES = new Set([6]);
// Within Charges, by request, items whose BillingCode ("Material Code" in
// Autotask's UI) is named "Labour in Charges" are split out from every other
// charge -- e.g. labour billed via a Charge line rather than a normal Ticket
// Labor time entry. `labourInChargesCodeId` is resolved by name once per
// process (cached in @dashboard/autotask-client), not hardcoded, so it stays
// correct if the billing code is ever recreated with a new ID.
//
// Within Recurring Services, by request, items on a CONTRACT whose name
// starts with "Tech Cover" (e.g. "Tech Cover Essentials", "Tech Cover Elite")
// are split out from every other recurring service. "Tech Cover" is a
// CONTRACT naming convention, not a Service/ServiceBundle name -- confirmed
// against a real example (Redlands Sporting Club Inc's "Tech Cover
// Essentials" contract invoices its recurring line as "Kaseya 365 User &
// Endpoint Bundle", which doesn't mention "Tech Cover" anywhere itself) -- so
// this matches `item.contractID` against `Contracts.contractName`
// (`contractNameById`, built below) rather than the item's own itemName/
// description, using the dashboard's standard wildcard convention
// (`matchesWildcard()`, beginsWith).
function bucketOf(item, labourInChargesCodeId, contractNameById) {
  if (LABOUR_TYPES.has(item.billingItemType)) return 'labour';
  if (RECURRING_TYPES.has(item.billingItemType)) {
    const contractName = contractNameById.get(item.contractID) || '';
    return matchesWildcard(contractName, 'Tech Cover*') ? 'recurringTechCover' : 'recurringOther';
  }
  if (labourInChargesCodeId && item.billingCodeID === labourInChargesCodeId) return 'chargesLabour';
  return 'chargesOther';
}

const router = express.Router();

router.get('/', async (req, res) => {
  const clientSearch = (req.query.client || '').trim();
  if (!clientSearch) {
    return res.status(400).json({ error: 'Query param "client" is required.' });
  }
  // Set when the user picks a specific company from an earlier ambiguous-match
  // list, so a repeat click goes straight to that exact company by ID rather
  // than re-running the (still-ambiguous) name wildcard.
  const companyId = req.query.companyId ? Number(req.query.companyId) : null;

  try {
    const client = await getClient();

    const resolved = await resolveSingleCompany(client, clientSearch, companyId);
    if (resolved.status !== 'ok') {
      return res.json({ client: clientSearch, ...resolved });
    }
    const company = resolved.company;

    const monthKeys = last12MonthKeys();
    const { windowStart, windowEnd } = monthKeysWindow(monthKeys);

    // Non-voided invoices for this client in the window -- both the invoice
    // list itself and the month each BillingItem's amount gets bucketed into
    // (by the INVOICE's date, not the billing item's own itemDate, since this
    // is a summary of invoiced amounts specifically).
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

    // Contract names for the "Tech Cover" split above -- only fetched for
    // contracts actually referenced by a recurring billing item, not every
    // contract this company has ever had.
    const recurringContractIds = [
      ...new Set(billingItems.filter((i) => RECURRING_TYPES.has(i.billingItemType) && i.contractID).map((i) => i.contractID)),
    ];
    const contracts = recurringContractIds.length > 0 ? await fetchByFieldIn(client.contracts, 'id', recurringContractIds) : [];
    const contractNameById = new Map(contracts.map((c) => [c.id, c.contractName]));

    const totals = new Map(
      monthKeys.map((key) => [key, { labour: 0, recurringTechCover: 0, recurringOther: 0, chargesLabour: 0, chargesOther: 0 }])
    );
    for (const item of billingItems) {
      const invoice = invoicesById.get(item.invoiceID);
      if (!invoice) continue; // scoped to invoiceIds above, so this shouldn't happen
      const bucket = totals.get(monthKeyOf(invoice.invoiceDateTime));
      if (!bucket) continue; // shouldn't happen given the invoice date filter, but safe
      bucket[bucketOf(item, labourInChargesCodeId, contractNameById)] += item.totalAmount || 0;
    }

    const months = monthKeys.map((key) => {
      const t = totals.get(key);
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
    const grandTotal = months.reduce(
      (acc, m) => ({
        labour: acc.labour + m.labour,
        recurringTechCover: acc.recurringTechCover + m.recurringTechCover,
        recurringOther: acc.recurringOther + m.recurringOther,
        chargesLabour: acc.chargesLabour + m.chargesLabour,
        chargesOther: acc.chargesOther + m.chargesOther,
        total: acc.total + m.total,
      }),
      { labour: 0, recurringTechCover: 0, recurringOther: 0, chargesLabour: 0, chargesOther: 0, total: 0 }
    );

    const invoiceRows = [];
    for (const inv of invoices) {
      invoiceRows.push({
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        invoiceUrl: await getInvoiceUrl(inv.id),
        invoiceDate: inv.invoiceDateTime,
        total: inv.invoiceTotal,
        // Confirmed against real Invoice field metadata: `paidDate` (not
        // required) is the actual Autotask field for this -- blank means
        // unpaid. Scoped to invoice NUMBERS starting "INV-" only, by
        // request -- other invoiceNumber prefixes (credit memos etc.)
        // aren't real client invoices and can legitimately have no
        // paidDate without meaning anything is actually owing.
        isUnpaid: (inv.invoiceNumber || '').startsWith('INV-') && !inv.paidDate,
      });
    }
    invoiceRows.sort((a, b) => new Date(b.invoiceDate) - new Date(a.invoiceDate));

    res.json({
      client: clientSearch,
      status: 'ok',
      companyId: company.id,
      companyName: company.companyName,
      companyUrl: await getCompanyUrl(company.id),
      months,
      grandTotal,
      invoices: invoiceRows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
