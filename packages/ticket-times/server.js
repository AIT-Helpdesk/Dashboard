const express = require('express');
const {
  getClient,
  mapWithConcurrency,
  resolveResourceName,
  resolveCompanyName,
  resolveResourceIdByEmail,
  listAll,
  fetchByFieldIn,
  getTicketUrl,
  getPicklistLabels,
  fetchServiceDeskAndProfessionalServicesMembership,
  fetchRoleHourlyRates,
  fetchWorkTypeModifiers,
  fetchBillingItemsByTimeEntryId,
  resolveChargeableValue,
} = require('@dashboard/autotask-client');

// Same real confirmed prefix @dashboard/times' own Billable $ box uses to
// single out T&M TC Elite* contracts (see that page's own
// TM_TC_ELITE_PREFIX) -- duplicated here rather than imported, same
// "separate page package" convention every other small shared constant on
// this dashboard already follows. Originally split the page-level total
// into "To Invoice"/"TC Elite" (by request: "Separate this total into 2
// amounts. - To Invoice: $value (TC Elite: $value) ... The TC Elite total
// is for where the Contract associated with the ticket is 'T&M TC
// Elite*' and all others sum up in the To Invoice $$"), then "To Invoice"
// was itself split further into Posted/Pending (by request: "break up To
// Invoice into Posted and Pending ... Leave the TC Elite $$ as the one
// figure") -- see the totalPostedDollars/totalPendingDollars/
// totalTcEliteDollars accumulation below for the real per-state logic.
const TM_TC_ELITE_PREFIX = 'T&M TC Elite';

// TimeEntries.dateWorked is a date-only field -- Autotask always stores it as
// midnight UTC of the calendar date the technician logged against (confirmed
// against real data), not a real instant. Unlike completedDate/createDate
// elsewhere on this dashboard, it needs no AEST offset conversion: a plain
// bare-string gte/lt range against midnight UTC of the from/to dates IS the
// selected range, because that's the same calendar dates the technician's
// own (AEST) clock showed when they entered it.
//
// From/To + quick-date buttons, by request ("use the From and To date
// style selectors and the 6 buttons like on the Time Summaries Page on
// the Completed Tickets and Ticket Times Pages. Both should default to
// Today") -- replaces the original single-date picker. `toKey` is
// inclusive (the UI's own "To" field), so the query's own upper bound is
// the day AFTER it.
function addDaysToKey(dateKey, delta) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}
async function fetchTimeEntriesInRange(client, fromKey, toKey) {
  return listAll(client.timeEntries, [
    { op: 'gte', field: 'dateWorked', value: `${fromKey}T00:00:00.000Z` },
    { op: 'lt', field: 'dateWorked', value: `${addDaysToKey(toKey, 1)}T00:00:00.000Z` },
    // Time can also be logged against Tasks (project work) with no ticketID
    // at all -- this page is ticket time only, so those are excluded.
    { op: 'exist', field: 'ticketID' },
  ]);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const router = express.Router();

router.get('/', async (req, res) => {
  const from = req.query.from;
  const to = req.query.to;
  if (!from || !DATE_RE.test(from)) return res.status(400).json({ error: 'Query param "from" is required in YYYY-MM-DD format.' });
  if (!to || !DATE_RE.test(to)) return res.status(400).json({ error: 'Query param "to" is required in YYYY-MM-DD format.' });
  if (to < from) return res.status(400).json({ error: '"to" must not be before "from".' });

  try {
    const client = await getClient();
    const [rawEntries, { leadership }] = await Promise.all([fetchTimeEntriesInRange(client, from, to), fetchServiceDeskAndProfessionalServicesMembership(client)]);

    // Leadership Team members omitted entirely, by request -- their own
    // time entries are dropped before anything else builds off them, not
    // just hidden after the fact, so they never contribute to another
    // technician's totals, this page's own grand total, or show up as
    // their own group. A ticket that also has a real entry from a
    // non-Leadership technician still shows that technician's own entry
    // normally -- this excludes the PERSON, not the ticket.
    const entries = rawEntries.filter((e) => !leadership.has(e.resourceID));

    if (entries.length === 0) {
      return res.json({ from, to, totalCount: 0, totalHoursWorked: 0, totalDollars: 0, totalInvoicedDollars: 0, totalPostedDollars: 0, totalPendingDollars: 0, totalTcEliteDollars: 0, byResource: [] });
    }

    const ticketIds = [...new Set(entries.map((e) => e.ticketID))];
    // Chargeable $ value of each entry, by request ("use these data
    // sources and formulas for 'awaiting approve and post', posted and
    // invoiced to show the dollar value of the times shown"). See
    // @dashboard/autotask-client's own resolveChargeableValue() for the
    // real, 100%-verified formula and its full real-data confirmation.
    const [tickets, statusLabels, categoryLabels, roleRatesById, billingItemByTeId] = await Promise.all([
      fetchByFieldIn(client.tickets, 'id', ticketIds),
      getPicklistLabels(client.tickets, 'status'),
      getPicklistLabels(client.tickets, 'ticketCategory'),
      fetchRoleHourlyRates(client),
      fetchBillingItemsByTimeEntryId(
        client,
        entries.map((e) => e.id)
      ),
    ]);
    const workTypeModifiersById = await fetchWorkTypeModifiers(
      client,
      entries.map((e) => e.billingCodeID)
    );
    const ticketsById = new Map(tickets.map((t) => [t.id, t]));

    // Contract name per ticket, just to split the page-level $ total into
    // "To Invoice"/"TC Elite" below -- not shown per-row/table, only used
    // for that one top-of-page split.
    const contractIds = [...new Set(tickets.map((t) => t.contractID).filter(Boolean))];
    const contracts = contractIds.length > 0 ? await fetchByFieldIn(client.contracts, 'id', contractIds) : [];
    const contractNameById = new Map(contracts.map((c) => [c.id, c.contractName]));
    function isTcEliteTicket(ticket) {
      const contractName = ticket.contractID ? contractNameById.get(ticket.contractID) : null;
      return Boolean(contractName && contractName.startsWith(TM_TC_ELITE_PREFIX));
    }

    const uniqueResourceIDs = [...new Set(entries.map((e) => e.resourceID).filter(Boolean))];
    const uniqueCompanyIDs = [...new Set(tickets.map((t) => t.companyID).filter((id) => id !== null && id !== undefined))];
    await mapWithConcurrency(uniqueResourceIDs, 3, (id) => resolveResourceName(client, id));
    await mapWithConcurrency(uniqueCompanyIDs, 3, (id) => resolveCompanyName(client, id));

    // The same ticket can carry entries from more than one technician (or
    // more than one entry from the same technician) on the same day -- sum
    // hours (and $, same reasoning) per technician+ticket pair, not per
    // entry, so each technician's row shows only THEIR OWN hours/$ on that
    // ticket for THIS day, never someone else's or the ticket's all-time
    // total ("only for the specific person, not the whole ticket").
    //
    // Page-level Invoiced/Posted/Pending/TC Elite totals accumulated in
    // this same pass (one resolveChargeableValue() call per entry, not a
    // second one later), by request -- went through a couple of
    // revisions: first "To Invoice"/"TC Elite" (2 figures), then "break
    // up To Invoice into Posted and Pending" (Posted meaning NOT yet
    // invoiced), then clarified the other way ("Posted to include
    // Invoiced and Posted"), then finally settled as all 4 kept separate:
    // "Let's have Invoiced, Posted, Pending and TC Elite." Invoiced =
    // state 'invoiced'. Posted = has a real BillingItems row but hasn't
    // reached an invoice yet (state 'posted' or 'posted-non-billable' --
    // the latter always $0 anyway). Pending = has NOT gone through
    // Approve and Post at all yet (state 'awaiting'), a computed estimate
    // rather than a real posted dollar figure.
    let totalInvoicedDollars = 0;
    let totalPostedDollars = 0;
    let totalPendingDollars = 0;
    let totalTcEliteDollars = 0;
    const rowsByKey = new Map();
    for (const e of entries) {
      const ticket = ticketsById.get(e.ticketID);
      if (!ticket) continue; // ticket deleted/inaccessible since the entry was logged -- skip rather than crash
      const key = `${e.resourceID || 'unassigned'}:${e.ticketID}`;
      if (!rowsByKey.has(key)) {
        rowsByKey.set(key, { ticketId: e.ticketID, resourceId: e.resourceID || null, hoursWorked: 0, dollars: 0 });
      }
      const row = rowsByKey.get(key);
      row.hoursWorked += e.hoursWorked || 0;
      const { state, value } = resolveChargeableValue(e, billingItemByTeId, roleRatesById, workTypeModifiersById);
      const v = value || 0;
      row.dollars += v;

      if (isTcEliteTicket(ticket)) {
        totalTcEliteDollars += v;
      } else if (state === 'invoiced') {
        totalInvoicedDollars += v;
      } else if (state === 'awaiting') {
        totalPendingDollars += v;
      } else {
        // 'posted' or 'posted-non-billable'.
        totalPostedDollars += v;
      }
    }

    const rows = [];
    for (const r of rowsByKey.values()) {
      const ticket = ticketsById.get(r.ticketId);
      rows.push({
        id: ticket.id,
        ticketNumber: ticket.ticketNumber,
        ticketUrl: await getTicketUrl(ticket.id),
        title: ticket.title,
        status: statusLabels.get(ticket.status) || `#${ticket.status}`,
        category: categoryLabels.get(ticket.ticketCategory) || `#${ticket.ticketCategory}`,
        companyID: ticket.companyID,
        company: await resolveCompanyName(client, ticket.companyID),
        resourceId: r.resourceId,
        resourceName: r.resourceId ? await resolveResourceName(client, r.resourceId) : 'Unassigned',
        hoursWorked: r.hoursWorked,
        dollars: r.dollars,
        isTcElite: isTcEliteTicket(ticket),
      });
    }

    const byResourceMap = new Map();
    for (const r of rows) {
      const key = r.resourceId || 'unassigned';
      if (!byResourceMap.has(key)) {
        byResourceMap.set(key, { resourceId: r.resourceId, resourceName: r.resourceName, tickets: [] });
      }
      byResourceMap.get(key).tickets.push(r);
    }
    // Within each technician's group, tickets are further broken out by
    // Ticket Category (Autotask's own picklist -- "Standard", "TECH COVER",
    // "Billing", etc.), category sub-groups ordered Z->A by request. Tickets
    // within a category keep the same company-name ordering the page always
    // used before categories existed. Each category also carries its own
    // hours/$ totals now, by request ("totals on each table").
    function groupByCategory(tickets) {
      const byCategory = new Map();
      for (const t of tickets) {
        if (!byCategory.has(t.category)) byCategory.set(t.category, []);
        byCategory.get(t.category).push(t);
      }
      return [...byCategory.entries()]
        .map(([category, categoryTickets]) => ({
          category,
          tickets: categoryTickets.sort((a, b) => a.company.localeCompare(b.company)),
          hoursWorked: categoryTickets.reduce((sum, t) => sum + t.hoursWorked, 0),
          dollars: categoryTickets.reduce((sum, t) => sum + t.dollars, 0),
        }))
        .sort((a, b) => b.category.localeCompare(a.category));
    }

    let byResource = [...byResourceMap.values()]
      .map((g) => ({
        ...g,
        count: g.tickets.length,
        hoursWorked: g.tickets.reduce((sum, t) => sum + t.hoursWorked, 0),
        dollars: g.tickets.reduce((sum, t) => sum + t.dollars, 0),
        categories: groupByCategory(g.tickets),
        tickets: undefined,
      }))
      .sort((a, b) => b.count - a.count);

    // The signed-in user's own group, if they logged any time that day, goes
    // first -- everyone else stays in the existing count-descending order
    // behind it. Resolved from the dashboard's own auth session (Entra
    // email), not a query param, so there's no way to spoof viewing "as"
    // someone else via the URL.
    const currentUserResourceId = await resolveResourceIdByEmail(client, req.session?.user?.email);
    if (currentUserResourceId) {
      const mineIndex = byResource.findIndex((g) => g.resourceId === currentUserResourceId);
      if (mineIndex > 0) {
        const [mine] = byResource.splice(mineIndex, 1);
        byResource = [{ ...mine, isCurrentUser: true }, ...byResource];
      } else if (mineIndex === 0) {
        byResource[0] = { ...byResource[0], isCurrentUser: true };
      }
    }

    // Posted/Pending/TC Elite already accumulated above, per entry, in the
    // same pass that built rowsByKey -- see that loop's own comment.
    res.json({
      from,
      to,
      totalCount: new Set(rows.map((r) => r.id)).size,
      totalHoursWorked: rows.reduce((sum, r) => sum + r.hoursWorked, 0),
      totalDollars: rows.reduce((sum, r) => sum + r.dollars, 0),
      totalInvoicedDollars,
      totalPostedDollars,
      totalPendingDollars,
      totalTcEliteDollars,
      byResource,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
