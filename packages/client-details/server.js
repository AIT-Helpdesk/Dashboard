const express = require('express');
const { getClient, listAll, getCompanyUrl, getInvoiceUrl, parseWildcard, getPicklistLabels, fetchByFieldIn, toAest, aestToUtcIso } = require('@dashboard/autotask-client');

const CRITERIA = new Set(['active', 'inactive', 'any', 'no-primary-contact', 'no-billing-contact', 'no-recent-invoice']);

// 1 July, 2 years before the most recent PAST 1 July -- a moving window, by
// request, not a fixed date. "Most recent past 1 July" is this AEST
// calendar year's if today is on or after 1 July, otherwise last year's;
// the cutoff is 2 years earlier than THAT year's 1 July. Recomputed on
// every request so it stays correct as years pass -- e.g. evaluated any
// time from 1 Jul 2026 through 30 Jun 2027, the most recent past 1 July is
// 2026, so this is 2024-07-01; from 1 Jul 2027 it rolls to 2025-07-01.
// Anchored to the AEST calendar (toAest's getUTC* getters read AEST wall-
// clock fields, not the server's own local timezone), consistent with
// every other date boundary on this dashboard now being AEST-anchored.
function noRecentInvoiceCutoffISO() {
  const aestNow = toAest(new Date());
  const mostRecentPastJulyYear = aestNow.getUTCMonth() + 1 >= 7 ? aestNow.getUTCFullYear() : aestNow.getUTCFullYear() - 1;
  return aestToUtcIso(mostRecentPastJulyYear - 2, 7, 1);
}

// companyType picklist codes (Autotask-wide, not org-specific config, so safe to
// hardcode unlike `classification` below): 1 = Customer, 3 = Prospect.
const CUSTOMER_OR_PROSPECT_TYPES = [1, 3];

function contactName(contact) {
  if (!contact) return null;
  return [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim() || null;
}

const router = express.Router();

router.get('/', async (req, res) => {
  const criteria = req.query.criteria;
  if (!CRITERIA.has(criteria)) {
    return res.status(400).json({ error: `Query param "criteria" must be one of: ${[...CRITERIA].join(', ')}.` });
  }
  const clientSearch = (req.query.client || '').trim();

  try {
    const client = await getClient();

    // Client-name wildcard folded into the query itself rather than fetched and
    // filtered in JS -- with ~1,960 active companies, that matters the same way
    // it does on the Contract Services page. Restricted to Customer/Prospect
    // company types by request -- Leads, Dead, Cancellation, Vendor, and Partner
    // records aren't clients in the sense this page cares about -- EXCEPT for
    // "any", which deliberately ignores both isActive and companyType and returns
    // every company regardless.
    //
    // "Inactive" is its own standalone criteria (isActive = false); every other
    // criteria except "any" means "active clients missing X", so isActive stays
    // true for those.
    const companyFilter = [];
    if (criteria === 'any') {
      // No isActive / companyType filter at all.
    } else if (criteria === 'inactive') {
      companyFilter.push({ op: 'eq', field: 'isActive', value: false }, { op: 'in', field: 'companyType', value: CUSTOMER_OR_PROSPECT_TYPES });
    } else {
      companyFilter.push({ op: 'eq', field: 'isActive', value: true }, { op: 'in', field: 'companyType', value: CUSTOMER_OR_PROSPECT_TYPES });
    }
    const clientWildcard = parseWildcard(clientSearch);
    if (clientWildcard) companyFilter.push({ op: clientWildcard.op, field: 'companyName', value: clientWildcard.value });
    // Autotask's query API requires at least one filter condition -- "any" with no
    // client filter would otherwise send an empty array. `id exist` is a true
    // no-op (every company has an id) used purely to satisfy that requirement.
    if (companyFilter.length === 0) companyFilter.push({ op: 'exist', field: 'id' });
    const baseCompanies = await listAll(client.companies, companyFilter);

    let companies;
    if (criteria === 'active' || criteria === 'inactive' || criteria === 'any') {
      companies = baseCompanies;
    } else if (criteria === 'no-primary-contact' || criteria === 'no-billing-contact') {
      // "No primary/billing contact" means: none of this company's Contacts has
      // that flag set. Contacts.primaryContact / Contacts.billingContact are
      // per-contact booleans, not a direct field on Companies, so the check is:
      // fetch every contact with the flag set (across all companies, in one
      // query), then any active company whose ID isn't in that set qualifies.
      const flagField = criteria === 'no-primary-contact' ? 'primaryContact' : 'billingContact';
      const flaggedContacts = await listAll(client.contacts, [{ op: 'eq', field: flagField, value: true }]);
      const companyIdsWithFlag = new Set(flaggedContacts.map((c) => c.companyID));
      companies = baseCompanies.filter((c) => !companyIdsWithFlag.has(c.id));
    } else {
      // "No invoice since the beginning of the year before last": fetch every
      // non-voided invoice from that cutoff date onward (across all companies, in
      // one query -- same pattern as the contact-flag criteria above), then any
      // active company whose ID isn't in that set qualifies. A voided invoice
      // doesn't count -- it was reversed/cancelled, not real billing activity.
      //
      // Also restricted to companies CREATED before the cutoff -- a company that
      // only became a client after that date was never going to have an invoice
      // from before it existed, so including it would just be noise, not a real
      // gap in billing.
      const cutoff = noRecentInvoiceCutoffISO();
      const recentInvoices = await listAll(client.invoices, [
        { op: 'gte', field: 'invoiceDateTime', value: cutoff },
        { op: 'eq', field: 'isVoided', value: false },
      ]);
      const companyIdsWithRecentInvoice = new Set(recentInvoices.map((inv) => inv.companyID));
      companies = baseCompanies.filter((c) => !companyIdsWithRecentInvoice.has(c.id) && c.createDate < cutoff);
    }

    const companyIds = companies.map((c) => c.id);

    // Primary/billing contact NAMES for display -- independent of which criteria
    // was picked (a company excluded by "no primary contact" can still have a
    // billing contact worth showing, and vice versa). Scoped to just the matched
    // companies (`in` filter, chunked) rather than fetched globally, since this
    // set can be much smaller than the full active-company list.
    const [primaryContacts, billingContacts, allInvoices, classificationLabels] = await Promise.all([
      fetchByFieldIn(client.contacts, 'companyID', companyIds, [{ op: 'eq', field: 'primaryContact', value: true }]),
      fetchByFieldIn(client.contacts, 'companyID', companyIds, [{ op: 'eq', field: 'billingContact', value: true }]),
      // Last Invoice column: every non-voided invoice for the matched companies,
      // reduced to the single most-recent one per company in JS below -- Autotask's
      // query filter has no server-side "latest per group" aggregation.
      fetchByFieldIn(client.invoices, 'companyID', companyIds, [{ op: 'eq', field: 'isVoided', value: false }]),
      getPicklistLabels(client.companies, 'classification'),
    ]);
    // A company could in theory have more than one contact flagged the same way
    // (Autotask doesn't enforce uniqueness at the API level) -- first one wins,
    // consistent with treating this as "the" primary/billing contact.
    const primaryContactByCompanyId = new Map();
    for (const c of primaryContacts) {
      if (!primaryContactByCompanyId.has(c.companyID)) primaryContactByCompanyId.set(c.companyID, c);
    }
    const billingContactByCompanyId = new Map();
    for (const c of billingContacts) {
      if (!billingContactByCompanyId.has(c.companyID)) billingContactByCompanyId.set(c.companyID, c);
    }
    const lastInvoiceByCompanyId = new Map();
    for (const inv of allInvoices) {
      const current = lastInvoiceByCompanyId.get(inv.companyID);
      if (!current || inv.invoiceDateTime > current.invoiceDateTime) {
        lastInvoiceByCompanyId.set(inv.companyID, inv);
      }
    }

    const rows = [];
    for (const c of companies) {
      const lastInvoice = lastInvoiceByCompanyId.get(c.id);
      rows.push({
        id: c.id,
        companyName: c.companyName,
        companyUrl: await getCompanyUrl(c.id),
        isActive: c.isActive,
        classification: c.classification != null ? classificationLabels.get(c.classification) || `#${c.classification}` : null,
        lastInvoiceDate: lastInvoice?.invoiceDateTime || null,
        lastInvoiceUrl: lastInvoice ? await getInvoiceUrl(lastInvoice.id) : null,
        state: c.state || null,
        phone: c.phone || null,
        primaryContactName: contactName(primaryContactByCompanyId.get(c.id)),
        billingContactName: contactName(billingContactByCompanyId.get(c.id)),
      });
    }
    rows.sort((a, b) => a.companyName.localeCompare(b.companyName));

    res.json({
      criteria,
      client: clientSearch,
      totalCount: rows.length,
      companies: rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
