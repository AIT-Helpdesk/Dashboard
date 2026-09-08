const express = require('express');
const { getClient, listAll, fetchByFieldIn, getPicklistLabels } = require('@dashboard/autotask-client');

// A technician's normal working day, by request -- "7.6 for all (for now)".
// Flat and global rather than per-resource: no per-person contracted-hours
// field has been wired up yet, this is a deliberate first pass.
const NORMAL_HOURS_PER_DAY = 7.6;

// TimeEntries.timeEntryType picklist values that mean "this hour was leave,
// not work" -- confirmed against real data (see the package README's own
// "Confirmed against real data" section): 15 PersonalTime, 16 VacationTime,
// 17 SickTime, 18 PaidTimeOff. Every real leave entry found in this
// tenant also carried no ticketID/taskID (internal time only) -- the
// notExist filters below confirm that rather than assume it, so a
// mis-tagged entry that somehow also references a ticket doesn't silently
// double-count as both leave and ticket time.
const LEAVE_TIME_ENTRY_TYPES = [15, 16, 17, 18];

// Resources.licenseType 7 is "API User" -- confirmed against real data: 25
// of this tenant's 38 "active" resources are integration service accounts
// (Gluh API, Xero API, Cloud Olive API, etc.), not real people, and have no
// hours of their own to report on. Excluded from the selectable list, by
// request ("active, non-API Autotask resources").
const API_USER_LICENSE_TYPE = 7;

async function fetchSelectableResources(client) {
  // licenseType is excluded client-side, not via a `noteq` query filter --
  // this codebase already hit a real bug from exactly that shape (see
  // excludeMonitoringAlerts()'s own comment, above the import list, for
  // the full story): Autotask's REST API applies SQL three-valued logic to
  // `noteq`, so any resource whose licenseType somehow came back null
  // would be silently dropped by the query rather than kept. Fetching
  // everyone active and filtering in plain JS avoids that failure mode
  // entirely, even though licenseType is not expected to be null here.
  const resources = await listAll(client.resources, [{ op: 'eq', field: 'isActive', value: true }]);
  return resources
    .filter((r) => r.licenseType !== API_USER_LICENSE_TYPE)
    .map((r) => ({ id: r.id, name: [r.firstName, r.lastName].filter(Boolean).join(' ').trim() || `Resource #${r.id}` }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Mon-Fri calendar dates in [fromKey, toKey], inclusive of both ends -- the
// "number of Mon-Fri in the Period" the Total Hours formula asks for. Plain
// UTC date-string walking, same reasoning ticket-times/dateWorked's own
// comment gives for why no AEST offset conversion is needed here: these are
// calendar dates being compared to calendar dates, not instants.
function countWeekdays(fromKey, toKey) {
  let count = 0;
  const d = new Date(`${fromKey}T00:00:00Z`);
  const end = new Date(`${toKey}T00:00:00Z`);
  while (d <= end) {
    const day = d.getUTCDay(); // 0 Sun .. 6 Sat
    if (day >= 1 && day <= 5) count++;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return count;
}

// Internal, recurring "bucket" tickets used to log non-client time (Service
// Team, Meetings, Training, Major Rollouts, etc.) -- confirmed against real
// data: 75 real tickets, every one companyID 0 (Autotask's own "internal"
// convention, same as resolveCompanyName()'s id-0 case), titled
// "AITTIME: <category>". The SAME title recurs across many separate ticket
// records (e.g. 4 real, distinct ticket ids all titled "AITTIME: Service
// Team") -- a fresh ticket per some recurring period, not one ongoing
// ticket -- so this section groups by TITLE, not by ticket id, exactly as
// requested ("Show each ticket title with a time summed for each
// resource"), merging every ticket that shares a title into one row.
const AITTIME_TITLE_PREFIX = 'AITTIME';

// Confirmed against the real API: `beginsWith` is a real, working Autotask
// query filter operator (unlike the `ne` mistake documented above for
// licenseType) -- a live query for Tickets.title beginsWith "AITTIME"
// returned exactly the expected 75 real tickets, all titled
// "AITTIME: ...", nothing extra and nothing missing.
async function fetchAittimeTickets(client) {
  return listAll(client.tickets, [{ op: 'beginsWith', field: 'title', value: AITTIME_TITLE_PREFIX }]);
}

// "Client" ticket time -- every ticket-time entry whose ticket's company is
// NOT Ambient IT, matched by NAME prefix rather than a single id, by
// request ("All clients whose name starts with Ambient iT should be
// treated as Ambient iT"). Confirmed against real data: this tenant has
// THREE real companies whose name starts with "Ambient iT" under
// inconsistent real casing -- "Ambient IT" (id 0, the same id
// resolveCompanyName() already special-cases as "internal"), "Ambient iT -
// Imported" (id 228), "Ambient iT Loan Equipment" (id 1608) -- matched
// case-insensitively so the real "Ambient IT"/"Ambient iT" casing
// difference doesn't itself cause a miss.
const AMBIENT_IT_NAME_PREFIX = 'ambient it';

// Rows: one per distinct Contract name that starts with "T&M", by request.
// Confirmed against real data (one real week of client ticket time): 8 of
// 13 distinct real contract names started with "T&M" (e.g.
// "T&M TC Elite Platinum", "T&M Adhoc Client"); the other 5
// ("Tech Cover Elite - Managed Service Agreement", "Hosted PBX", etc.) plus
// 12 real tickets with no contractID set at all fall into the catch-all
// row below.
const TM_CONTRACT_PREFIX = 'T&M';
const OTHER_CONTRACT_ROW_LABEL = 'Other or Blank (?)';

// Every real "T&M TC Elite*" variant folds into ONE row, by request --
// confirmed against real data this tenant has SEVEN distinct real contract
// names under this one prefix ("T&M TC Elite", "T&M TC Elite Gold",
// "T&M TC Elite Gold [NO TAM  <6 Seats]", "T&M TC Elite Platinum",
// "T&M TC Elite Platinum [+TAM >5 Seats]", "T&M TC Elite Platinum with
// TAM", "T&M TC Elite (Sponsorship)") -- these are all the same underlying
// TC Elite product at different tiers/add-ons, not seven separate things
// worth their own row here. Every OTHER "T&M ..." contract (e.g.
// "T&M Adhoc Client", "T&M TC Essentials") still gets its own row, exactly
// as before.
const TM_TC_ELITE_PREFIX = 'T&M TC Elite';
const TM_TC_ELITE_ROW_LABEL = 'T&M TC Elite*';

// Ticket/Contract/Company lookups needed to place a client ticket-time
// entry into a contract-breakdown row -- shared by the Recorded and
// Billable tables below (same ticket set, same Ambient IT/contract-name
// rules) so this is one Tickets/Contracts/Companies fetch, not two.
async function fetchClientTicketContext(client, ticketIds) {
  if (ticketIds.length === 0) return null;

  const tickets = await fetchByFieldIn(client.tickets, 'id', ticketIds);
  const ticketById = new Map(tickets.map((t) => [t.id, t]));

  const contractIds = [...new Set(tickets.map((t) => t.contractID).filter(Boolean))];
  const contracts = contractIds.length > 0 ? await fetchByFieldIn(client.contracts, 'id', contractIds) : [];
  const contractNameById = new Map(contracts.map((c) => [c.id, c.contractName]));

  // companyID 0 is a real, fetchable Company record (confirmed against
  // real data, same as resolveCompanyName()'s own id-0 handling) -- no
  // special-casing needed here, a plain id lookup covers it like any
  // other company.
  const companyIds = [...new Set(tickets.map((t) => t.companyID).filter((id) => id !== null && id !== undefined))];
  const companies = companyIds.length > 0 ? await fetchByFieldIn(client.companies, 'id', companyIds) : [];
  const companyNameById = new Map(companies.map((c) => [c.id, c.companyName]));

  // Ticket status labels -- needed by the Accrue--ING-by-status table
  // below, harmless/unused extra data for every other caller of this
  // shared context. getPicklistLabels() caches forever per server
  // process, so this is a real cost only on the very first call.
  const statusLabels = await getPicklistLabels(client.tickets, 'status');

  return { ticketById, contractNameById, companyNameById, statusLabels };
}

function isAmbientItCompany(companyNameById, companyId) {
  return (companyNameById.get(companyId) || '').toLowerCase().startsWith(AMBIENT_IT_NAME_PREFIX);
}

function clientContractRowLabel(contractName) {
  if (contractName && contractName.startsWith(TM_TC_ELITE_PREFIX)) return TM_TC_ELITE_ROW_LABEL;
  if (contractName && contractName.startsWith(TM_CONTRACT_PREFIX)) return contractName;
  return OTHER_CONTRACT_ROW_LABEL;
}

// Same row shape every "one row per named bucket, Total row underneath"
// table on this page uses -- T&M contract rows alphabetical, then the
// Other/Blank catch-all row always LAST (a thing to notice, "(?)", not
// just another row), only rows with at least one real value shown.
function sortClientContractRows(byRow, toValue) {
  const rows = [...byRow.entries()]
    .filter(([label]) => label !== OTHER_CONTRACT_ROW_LABEL)
    .map(([contractName, byResource]) => ({ contractName, hours: toValue(byResource) }))
    .sort((a, b) => a.contractName.localeCompare(b.contractName));

  if (byRow.has(OTHER_CONTRACT_ROW_LABEL)) {
    rows.push({ contractName: OTHER_CONTRACT_ROW_LABEL, hours: toValue(byRow.get(OTHER_CONTRACT_ROW_LABEL)) });
  }
  return rows;
}

// "Total Client Hours Recorded" -- every real hour actually logged
// (hoursWorked), same rule as everywhere else on this page.
function buildClientContractHours(ctx, ticketEntries) {
  const byRow = new Map(); // row label -> Map(resourceID -> hours)
  for (const e of ticketEntries) {
    const ticket = ctx.ticketById.get(e.ticketID);
    if (!ticket || isAmbientItCompany(ctx.companyNameById, ticket.companyID)) continue; // Ambient IT's own tickets aren't "client" time at all
    const rowLabel = clientContractRowLabel(ticket.contractID ? ctx.contractNameById.get(ticket.contractID) : null);
    if (!byRow.has(rowLabel)) byRow.set(rowLabel, new Map());
    const byResource = byRow.get(rowLabel);
    byResource.set(e.resourceID, (byResource.get(e.resourceID) || 0) + (e.hoursWorked || 0));
  }
  return sortClientContractRows(byRow, (byResource) => Object.fromEntries([...byResource.entries()].map(([id, h]) => [String(id), h])));
}

// "Total Client Hours Billable"/"...Non-Billable" -- confirmed against
// real data before picking a definition (a real week showed hoursToBill
// and hoursWorked diverge substantially, and hoursToBill is NOT zeroed on
// entries flagged non-billable, so it can't be read as "billable" on its
// own). By request: split strictly on the isNonBillable flag
// (isNonBillable/showOnInvoice agreed on every real entry checked bar 3 --
// isNonBillable is the field actually used here), and each cell shows real
// hoursWorked as the primary figure, with Autotask's own (contract-
// rounded) hoursToBill alongside in brackets. Shared by both tables --
// Billable passes `true` (keep only entries where isNonBillable !== true),
// Non-Billable passes `false` (keep only entries where isNonBillable ===
// true) -- same grouping/shape either way, just a different half of the
// same split.
function buildClientContractSplitHours(ctx, ticketEntries, wantBillable) {
  const filtered = ticketEntries.filter((e) => (e.isNonBillable !== true) === wantBillable);
  const byRow = new Map(); // row label -> Map(resourceID -> {worked, toBill})
  for (const e of filtered) {
    const ticket = ctx.ticketById.get(e.ticketID);
    if (!ticket || isAmbientItCompany(ctx.companyNameById, ticket.companyID)) continue;
    const rowLabel = clientContractRowLabel(ticket.contractID ? ctx.contractNameById.get(ticket.contractID) : null);
    if (!byRow.has(rowLabel)) byRow.set(rowLabel, new Map());
    const byResource = byRow.get(rowLabel);
    if (!byResource.has(e.resourceID)) byResource.set(e.resourceID, { worked: 0, toBill: 0 });
    const cell = byResource.get(e.resourceID);
    cell.worked += e.hoursWorked || 0;
    cell.toBill += e.hoursToBill || 0;
  }
  return sortClientContractRows(byRow, (byResource) => Object.fromEntries([...byResource.entries()].map(([id, v]) => [String(id), v])));
}

// Work-Type Reconciliation, tables 1-3 of 7, redesigned by request away
// from the earlier billable/non-billable split (kept nothing from that
// version except the Ambient IT exclusion and the underlying "Work Type
// is TimeEntries.billingCodeID" fact -- both still confirmed true, see
// below). "Work Type" is TimeEntries.billingCodeID -- confirmed against
// real data (one real week of ticket time, 583 entries): every real entry
// had one set (no nulls), 13 distinct real work types. A DIFFERENT field
// from internalBillingCodeID (non-ticket internal time -- AITTIME, leave).
//
// Ambient IT's own tickets are excluded throughout, by request -- same
// name-prefix rule as the Client Contract tables (isAmbientItCompany()).
//
// Table 1: a FIXED list of named work types, by request, shown in this
// exact order even when a period has zero hours for one of them ("show
// all nominated work types even if there's no data found") -- these are
// real confirmed names (the request's own spelling normalized to match:
// ".STandard Support" -> ".Standard Support", "Onsite Support" ->
// "Onsite  Support", a real double space in this tenant's own data).
const WORK_TYPE_FIXED_LIST = ['.Standard Support', 'Accrue--END', 'Onsite  Support', 'Quoted Labour Hours', 'Emergency'];

// Table 3's own work type, broken out separately (never appears in Table 2).
const ACCRUE_ING_WORK_TYPE = 'Accrue--ING';

// Table 3: Accrue--ING split by ticket status into two rows, by request --
// confirmed against real data both real status labels exist verbatim in
// this tenant's Tickets.status picklist ("Complete" id 5, "Billing -
// Contract" id 20), and real Accrue--ING entries exist under both (10.17h
// / 1.98h in one real week) alongside many other real statuses that all
// fold into the second row.
// Row labels, by request -- "Complete"/"Incomplete", even though the
// underlying grouping is still status IN ("Complete", "Billing -
// Contract") vs everything else (unchanged).
const ACCRUE_ING_ROW_COMPLETE = 'Complete';
const ACCRUE_ING_ROW_OTHER = 'Incomplete';
const ACCRUE_ING_COMPLETE_STATUS_LABELS = new Set(['Complete', 'Billing - Contract']);

async function fetchWorkTypeBreakdown(client, ctx, ticketEntries) {
  const filtered = ticketEntries.filter((e) => {
    const ticket = ctx && ctx.ticketById.get(e.ticketID);
    return !ticket || !isAmbientItCompany(ctx.companyNameById, ticket.companyID);
  });

  const billingCodeIds = [...new Set(filtered.map((e) => e.billingCodeID).filter((id) => id !== null && id !== undefined))];
  const codes = billingCodeIds.length > 0 ? await fetchByFieldIn(client.billingCodes, 'id', billingCodeIds) : [];
  const nameById = new Map(codes.map((c) => [c.id, c.name]));

  // Table 1 ("Work Type - Billable") -- pre-seeded so an all-zero work
  // type still shows, per request. Table 1-B ("Billable was Unticked",
  // new) -- the SAME five work types' own non-billable entries, but NOT
  // pre-seeded: only work types that actually had non-billable time show
  // a row, by request ("Show only the rows found... but only for the
  // Work Types in table 1").
  const fixedBillableRows = new Map(WORK_TYPE_FIXED_LIST.map((wt) => [wt, new Map()]));
  const fixedUntickedRows = new Map(); // work type name -> Map(resourceID -> hours), only the fixed 5, only if found
  const otherRows = new Map(); // work type name -> Map(resourceID -> hours), dynamic, unchanged (still every billable status)
  const accrueIngRows = new Map([
    [ACCRUE_ING_ROW_COMPLETE, new Map()],
    [ACCRUE_ING_ROW_OTHER, new Map()],
  ]);

  for (const e of filtered) {
    const workType = e.billingCodeID !== null && e.billingCodeID !== undefined ? nameById.get(e.billingCodeID) || `Work Type #${e.billingCodeID}` : 'No Work Type';

    if (workType === ACCRUE_ING_WORK_TYPE) {
      const ticket = ctx && ctx.ticketById.get(e.ticketID);
      const statusLabel = ticket && ctx.statusLabels.get(ticket.status);
      const rowLabel = statusLabel && ACCRUE_ING_COMPLETE_STATUS_LABELS.has(statusLabel) ? ACCRUE_ING_ROW_COMPLETE : ACCRUE_ING_ROW_OTHER;
      const byResource = accrueIngRows.get(rowLabel);
      byResource.set(e.resourceID, (byResource.get(e.resourceID) || 0) + (e.hoursWorked || 0));
      continue;
    }

    if (fixedBillableRows.has(workType)) {
      if (e.isNonBillable === true) {
        if (!fixedUntickedRows.has(workType)) fixedUntickedRows.set(workType, new Map());
        const byResource = fixedUntickedRows.get(workType);
        byResource.set(e.resourceID, (byResource.get(e.resourceID) || 0) + (e.hoursWorked || 0));
      } else {
        const byResource = fixedBillableRows.get(workType);
        byResource.set(e.resourceID, (byResource.get(e.resourceID) || 0) + (e.hoursWorked || 0));
      }
    } else {
      if (!otherRows.has(workType)) otherRows.set(workType, new Map());
      const byResource = otherRows.get(workType);
      byResource.set(e.resourceID, (byResource.get(e.resourceID) || 0) + (e.hoursWorked || 0));
    }
  }

  const toHoursObject = (byResource) => Object.fromEntries([...byResource.entries()].map(([id, h]) => [String(id), h]));

  // Table 1: the FIXED list's own order, not alphabetical -- these are
  // named/ordered explicitly by request, unlike every dynamic list
  // elsewhere on this page. Billable only now (isNonBillable !== true).
  const workTypeFixedBillable = WORK_TYPE_FIXED_LIST.map((wt) => ({ workType: wt, hours: toHoursObject(fixedBillableRows.get(wt)) }));

  // Table 1-B ("Billable was Unticked"): same fixed order as Table 1, but
  // only the work types that actually had non-billable hours -- not
  // pre-seeded, unlike Table 1 itself.
  const workTypeFixedUnticked = WORK_TYPE_FIXED_LIST.filter((wt) => fixedUntickedRows.has(wt)).map((wt) => ({ workType: wt, hours: toHoursObject(fixedUntickedRows.get(wt)) }));

  // Table 2 ("Work Type - Unbillable", renamed by request -- content
  // unchanged, still every OTHER work type regardless of its own billable
  // flag): alphabetical, only real rows shown (same "no all-zero noise"
  // convention as every other dynamic table).
  const workTypeOther = [...otherRows.entries()]
    .map(([wt, byResource]) => ({ workType: wt, hours: toHoursObject(byResource) }))
    .sort((a, b) => a.workType.localeCompare(b.workType));

  // Table 3: always both rows, even at zero -- a fixed 2-way partition of
  // one specific work type, not a "found in data" dynamic list.
  const workTypeAccrueIng = [ACCRUE_ING_ROW_COMPLETE, ACCRUE_ING_ROW_OTHER].map((label) => ({ workType: label, hours: toHoursObject(accrueIngRows.get(label)) }));

  return { workTypeFixedBillable, workTypeFixedUnticked, workTypeOther, workTypeAccrueIng };
}

// "Ambient iT Tickets" -- the LAST table in this section, by request:
// every real ticket-time entry whose own ticket is an Ambient iT ticket
// (isAmbientItCompany(), the same "Ambient iT*" name-prefix rule used
// throughout this section -- "Use 'Ambient iT*' to identify Ambient iT
// tickets"), split into two ALWAYS-shown rows -- "AITTime Tickets" (the
// ticket's own title starts with "AITTIME", same fetchAittimeTickets()
// already used for the page's own AITTIME breakdown table -- just a
// TOTAL here, no per-title breakdown, by request) and "All other Ambient
// iT tickets" (every other real Ambient iT ticket, e.g. a client-work-
// style ticket that happens to be logged against Ambient iT's own
// company record rather than a client's).
const AMBIENT_TICKETS_ROW_AITTIME = 'AITTime Tickets';
const AMBIENT_TICKETS_ROW_OTHER = 'All other Ambient iT tickets';

async function fetchAmbientItTicketBreakdown(client, ctx, ticketEntries) {
  const aittimeTickets = await fetchAittimeTickets(client);
  const aittimeTicketIds = new Set(aittimeTickets.map((t) => t.id));

  const rows = new Map([
    [AMBIENT_TICKETS_ROW_AITTIME, new Map()],
    [AMBIENT_TICKETS_ROW_OTHER, new Map()],
  ]);

  for (const e of ticketEntries) {
    const ticket = ctx && ctx.ticketById.get(e.ticketID);
    if (!ticket || !isAmbientItCompany(ctx.companyNameById, ticket.companyID)) continue; // only Ambient iT's own tickets
    const rowLabel = aittimeTicketIds.has(e.ticketID) ? AMBIENT_TICKETS_ROW_AITTIME : AMBIENT_TICKETS_ROW_OTHER;
    const byResource = rows.get(rowLabel);
    byResource.set(e.resourceID, (byResource.get(e.resourceID) || 0) + (e.hoursWorked || 0));
  }

  const toHoursObject = (byResource) => Object.fromEntries([...byResource.entries()].map(([id, h]) => [String(id), h]));
  // Always both rows, even at zero -- a fixed 2-way partition, same
  // reasoning as the Accrue--ING-by-status table above.
  return [AMBIENT_TICKETS_ROW_AITTIME, AMBIENT_TICKETS_ROW_OTHER].map((label) => ({ workType: label, hours: toHoursObject(rows.get(label)) }));
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const router = express.Router();

// Populates the resource multiselect -- kept as its own endpoint (rather
// than embedded in the main report response) so the picker can render
// before a date range has even been chosen.
router.get('/resources', async (req, res) => {
  try {
    const client = await getClient();
    res.json({ resources: await fetchSelectableResources(client) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Shared by the main report and the on-demand Work-Type Reconciliation
// route below -- validates from/to, resolves the selected resource list
// (no resourceIds param = every selectable resource), and returns null
// (after writing the 400) when validation fails, so callers can just
// `if (!resolved) return;`.
function validateDateRange(req, res) {
  const { from, to } = req.query;
  if (!from || !DATE_RE.test(from)) {
    res.status(400).json({ error: 'Query param "from" is required in YYYY-MM-DD format.' });
    return null;
  }
  if (!to || !DATE_RE.test(to)) {
    res.status(400).json({ error: 'Query param "to" is required in YYYY-MM-DD format.' });
    return null;
  }
  if (to < from) {
    res.status(400).json({ error: '"to" must not be before "from".' });
    return null;
  }
  return { from, to };
}
async function resolveSelectedResources(client, req) {
  const allResources = await fetchSelectableResources(client);
  const resourceIdsParam = (req.query.resourceIds || '').toString();
  const requestedIds = resourceIdsParam
    ? resourceIdsParam.split(',').map((s) => parseInt(s, 10)).filter((n) => Number.isInteger(n))
    : null;
  return requestedIds ? allResources.filter((r) => requestedIds.includes(r.id)) : allResources;
}

router.get('/', async (req, res) => {
  const range = validateDateRange(req, res);
  if (!range) return;
  const { from, to } = range;
  const weekdayCount = countWeekdays(from, to);

  try {
    const client = await getClient();
    const selected = await resolveSelectedResources(client, req);

    if (selected.length === 0) {
      return res.json({ from, to, weekdayCount, normalHoursPerDay: NORMAL_HOURS_PER_DAY, resources: [], aittime: [], clientContracts: [], clientContractsBillable: [], clientContractsNonBillable: [] });
    }
    const selectedIds = selected.map((r) => r.id);

    const fromIso = `${from}T00:00:00.000Z`;
    const toIso = `${to}T00:00:00.000Z`;

    const [leaveEntries, ticketEntries, aittimeTickets] = await Promise.all([
      fetchByFieldIn(client.timeEntries, 'resourceID', selectedIds, [
        { op: 'gte', field: 'dateWorked', value: fromIso },
        { op: 'lte', field: 'dateWorked', value: toIso },
        { op: 'in', field: 'timeEntryType', value: LEAVE_TIME_ENTRY_TYPES },
        { op: 'notExist', field: 'ticketID' },
        { op: 'notExist', field: 'taskID' },
      ]),
      // Total hours recorded on TICKETS for the period -- same convention
      // as ticket-times/server.js's own fetchTimeEntriesOn (time logged
      // against Tasks/project work, not tickets, is excluded), just scoped
      // to the chosen date range and resource set instead of a single day.
      // Reused below for the AITTIME breakdown too, rather than a second
      // TimeEntries query -- it's already every ticket-time entry in this
      // date range/resource set, AITTIME tickets included.
      fetchByFieldIn(client.timeEntries, 'resourceID', selectedIds, [
        { op: 'gte', field: 'dateWorked', value: fromIso },
        { op: 'lte', field: 'dateWorked', value: toIso },
        { op: 'exist', field: 'ticketID' },
      ]),
      fetchAittimeTickets(client),
    ]);

    const leaveByResource = new Map();
    for (const e of leaveEntries) leaveByResource.set(e.resourceID, (leaveByResource.get(e.resourceID) || 0) + (e.hoursWorked || 0));
    const ticketByResource = new Map();
    for (const e of ticketEntries) ticketByResource.set(e.resourceID, (ticketByResource.get(e.resourceID) || 0) + (e.hoursWorked || 0));

    // AITTIME breakdown: title <- ticketID (many real ticket ids can share
    // one title, see fetchAittimeTickets()'s own comment), then every
    // already-fetched ticket-time entry whose ticketID lands in that map
    // gets folded into its title's row, summed per resource.
    const aittimeTitleByTicketId = new Map(aittimeTickets.map((t) => [t.id, t.title]));
    const aittimeByTitle = new Map(); // title -> Map(resourceID -> hours)
    for (const e of ticketEntries) {
      const title = aittimeTitleByTicketId.get(e.ticketID);
      if (!title) continue;
      if (!aittimeByTitle.has(title)) aittimeByTitle.set(title, new Map());
      const byResource = aittimeByTitle.get(title);
      byResource.set(e.resourceID, (byResource.get(e.resourceID) || 0) + (e.hoursWorked || 0));
    }
    // Only titles with at least one real hour in this period/resource set
    // are shown -- an all-zero row for a title nobody touched this period
    // is just noise. Alphabetical, same reasoning as the resource list's
    // own name sort: a stable, predictable order rather than "whichever
    // title happened to total the most this time".
    const aittime = [...aittimeByTitle.entries()]
      .map(([title, byResource]) => ({ title, hours: Object.fromEntries([...byResource.entries()].map(([id, h]) => [String(id), h])) }))
      .sort((a, b) => a.title.localeCompare(b.title));

    // Client contract breakdown (Recorded + Billable) -- both need each
    // ticket's own companyID/contractID, which the entries fetched above
    // don't carry, so this is the one extra real fetch this endpoint makes
    // (Tickets by id, then Contracts/Companies by id) -- shared by both
    // tables via fetchClientTicketContext() rather than fetched twice.
    const clientTicketIds = [...new Set(ticketEntries.map((e) => e.ticketID))];
    const clientCtx = await fetchClientTicketContext(client, clientTicketIds);
    const clientContracts = clientCtx ? buildClientContractHours(clientCtx, ticketEntries) : [];
    const clientContractsBillable = clientCtx ? buildClientContractSplitHours(clientCtx, ticketEntries, true) : [];
    const clientContractsNonBillable = clientCtx ? buildClientContractSplitHours(clientCtx, ticketEntries, false) : [];

    // Public Holidays: not yet wired to a real source -- by request,
    // zeroed for every resource for now ("We will add them later, just pot
    // zeros for now"). Still a real per-resource field, not an omitted
    // one, so plugging in a real source later is a one-line change here
    // rather than a shape change on every consumer.
    const publicHolidayHours = 0;

    const resources = selected.map((r) => {
      const leaveHours = leaveByResource.get(r.id) || 0;
      const totalHours = NORMAL_HOURS_PER_DAY * weekdayCount - leaveHours - publicHolidayHours;
      return {
        resourceId: r.id,
        resourceName: r.name,
        leaveHours,
        publicHolidayHours,
        totalHours,
        ticketHours: ticketByResource.get(r.id) || 0,
      };
    });

    res.json({ from, to, weekdayCount, normalHoursPerDay: NORMAL_HOURS_PER_DAY, resources, aittime, clientContracts, clientContractsBillable, clientContractsNonBillable });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Work-Type Reconciliation -- deliberately NOT fetched as part of the main
// report above, by request ("we can not retrieve it by default so the
// page is faster"): it needs its own real TimeEntries fetch (the main
// route's own ticketEntries isn't available here -- this is a separate
// HTTP request) plus a BillingCodes lookup, so folding it into the default
// load would slow down every visit for a section most loads won't even
// look at. The client's own "SHOW" button calls this on demand instead.
router.get('/work-type', async (req, res) => {
  const range = validateDateRange(req, res);
  if (!range) return;
  const { from, to } = range;

  try {
    const client = await getClient();
    const selected = await resolveSelectedResources(client, req);
    if (selected.length === 0) return res.json({ workTypeFixedBillable: [], workTypeFixedUnticked: [], workTypeOther: [], workTypeAccrueIng: [], ambientItTickets: [] });
    const selectedIds = selected.map((r) => r.id);

    const ticketEntries = await fetchByFieldIn(client.timeEntries, 'resourceID', selectedIds, [
      { op: 'gte', field: 'dateWorked', value: `${from}T00:00:00.000Z` },
      { op: 'lte', field: 'dateWorked', value: `${to}T00:00:00.000Z` },
      { op: 'exist', field: 'ticketID' },
    ]);

    // Needed to exclude Ambient IT's own tickets and (for Table 3) to
    // resolve each Accrue--ING ticket's own status label.
    const workTypeTicketIds = [...new Set(ticketEntries.map((e) => e.ticketID))];
    const workTypeCtx = await fetchClientTicketContext(client, workTypeTicketIds);

    const { workTypeFixedBillable, workTypeFixedUnticked, workTypeOther, workTypeAccrueIng } = await fetchWorkTypeBreakdown(client, workTypeCtx, ticketEntries);
    const ambientItTickets = await fetchAmbientItTicketBreakdown(client, workTypeCtx, ticketEntries);

    res.json({ workTypeFixedBillable, workTypeFixedUnticked, workTypeOther, workTypeAccrueIng, ambientItTickets });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
