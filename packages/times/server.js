const express = require('express');
const {
  getClient,
  listAll,
  fetchByFieldIn,
  getPicklistLabels,
  getTicketUrl,
  resolveResourceName,
  fetchServiceDeskAndProfessionalServicesMembership,
  resolveLeaveBillingCodeIds,
  fetchRoleHourlyRates,
  fetchWorkTypeModifiers,
  fetchBillingItemsByTimeEntryId,
  resolveChargeableValue,
} = require('@dashboard/autotask-client');
// For the Billable $ box's own admin-only visibility, by request ("make
// that Billable $ table only visible to admins") -- same "everyone can
// read the page, only the admin sees/does the extra bit" precedent
// @dashboard/updates and @dashboard/workshop already established (an
// `isAdmin`-style flag in the JSON response, client.js renders around
// it), not a route-level restrictedTo -- the rest of this page stays
// open to everyone, only this one box is admin-only.
const { isDashboardAdmin } = require('@dashboard/shell/registry.js');

// A technician's normal working day, by request -- "7.6 for all (for now)".
// Flat and global for everyone EXCEPT the real per-resource overrides
// below.
const NORMAL_HOURS_PER_DAY = 7.6;

// Per-resource weekly hours, by request -- "I need to vary the hours for
// some staff ... it's Jett Filmer 29 hours per week", broken down by real
// day-of-week rather than a flat weekly-total/5 average once offered
// ("Monday 7.5, Tuesday 5.5, Wednesday 4, Thursday 6.5, Friday 5.5" --
// confirmed sums to the real 29). Kept in .env (TIMES_NORMAL_HOURS_
// OVERRIDES, a JSON object of `{ "<exact resolved resource name>": {
// mon/tue/wed/thu/fri: <hours> } }`), not hardcoded here, by request --
// deliberately a map (not a single-person special case) so more staff can
// get their own real schedule later just by adding another entry, no code
// change needed. Matched by exact resolved "First Last" name, same
// convention EXCLUDED_RESOURCE_NAMES above already uses. Parsed once at
// module load; a missing/malformed env var just means nobody has an
// override (falls back to the flat NORMAL_HOURS_PER_DAY for everyone,
// same as before this existed) rather than crashing the whole page.
let NORMAL_HOURS_OVERRIDES = new Map();
try {
  if (process.env.TIMES_NORMAL_HOURS_OVERRIDES) {
    const parsed = JSON.parse(process.env.TIMES_NORMAL_HOURS_OVERRIDES);
    NORMAL_HOURS_OVERRIDES = new Map(Object.entries(parsed));
  }
} catch (err) {
  console.error('Times: failed to parse TIMES_NORMAL_HOURS_OVERRIDES -- ignoring, everyone falls back to the flat rate:', err.message);
}

// Real Autotask Date.getUTCDay() values (0 Sun .. 6 Sat) for the 5
// weekdays an override can name -- Sat/Sun are never looked up here,
// same "weekends never cost/earn Normal Hours" rule every other
// weekday-only calculation in this file already follows.
const OVERRIDE_DOW_KEYS = { 1: 'mon', 2: 'tue', 3: 'wed', 4: 'thu', 5: 'fri' };

// This resource's own real Normal Hours for one specific real calendar
// date -- the flat NORMAL_HOURS_PER_DAY for everyone without an override,
// or that day-of-week's own figure from NORMAL_HOURS_OVERRIDES for a
// resource who has one (falling back to the flat rate for any weekday NOT
// named in their override, so a partial schedule doesn't silently zero
// out the rest of the week). 0 for a real weekend date -- callers already
// only ever pass a weekday key in practice (countWeekdays()/
// isWeekdayDateKey()'s own convention), but this stays correct even if
// one didn't.
function normalHoursForDateKey(resourceName, dateKey) {
  const dowKey = OVERRIDE_DOW_KEYS[new Date(`${dateKey}T00:00:00Z`).getUTCDay()];
  if (!dowKey) return 0;
  const override = NORMAL_HOURS_OVERRIDES.get(resourceName);
  return override && override[dowKey] !== undefined ? override[dowKey] : NORMAL_HOURS_PER_DAY;
}

// Sums a resource's own real Normal Hours across every real weekday in
// [fromKey, toKey] -- day-of-week aware, not a flat rate times
// countWeekdays(), so a resource with a real per-day schedule (see above)
// gets their own real total for whatever date range is selected, not an
// average. For a resource with no override this reduces to exactly
// NORMAL_HOURS_PER_DAY * countWeekdays(fromKey, toKey), same figure the
// flat calculation always produced.
function sumNormalHoursForRange(resourceName, fromKey, toKey) {
  let total = 0;
  const d = new Date(`${fromKey}T00:00:00Z`);
  const end = new Date(`${toKey}T00:00:00Z`);
  while (d <= end) {
    total += normalHoursForDateKey(resourceName, d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return total;
}

// Real Leave/Time Off billing codes -- what makes an entry Leave here,
// by request ("There is a list of Billing Codes identified as Internal.
// You've recognised the Vacation one ... There's more that need to be
// treated as Time Off") after a real bug report: Peter Kiem's 2 real
// "Unpaid" leave days weren't showing in Leave Hours at all. Root cause:
// this page used to infer Leave from plain TimeEntries rows tagged with
// one of 4 specific timeEntryType values (15 PersonalTime, 16
// VacationTime, 17 SickTime, 18 PaidTimeOff) with no ticketID/taskID --
// true for real Vacation/Sick Time/Floating Holiday/Personal Time
// entries, but NOT for "Unpaid" (confirmed real: every real Unpaid leave
// entry instead carries timeEntryType 10 CompanyTask AND a real taskID)
// -- so the old query's own type-list/`notExist taskID` filter could
// never catch it no matter how it was tuned.
//
// `resolveLeaveBillingCodeIds()` (shared, `@dashboard/autotask-client` --
// see its own comment for the full LEAVE_TYPES/.env story and why
// Autotask's own "Display In Time Off" checkbox has no REST API
// equivalent) resolves the real .env-configured list to real billing
// code ids -- matched by billingCodeID directly, with no timeEntryType or
// ticketID/taskID constraint at all, since the billing code itself is
// what makes an entry Leave regardless of which internal timeEntryType
// or task-linkage Autotask happens to record it under. Shared with
// @dashboard/teams-shifts, @dashboard/whats-on, and @dashboard/about-me
// -- all four need the exact same real definition of Leave and must
// never quietly disagree.

// Resources.licenseType 7 is "API User" -- confirmed against real data: 25
// of this tenant's 38 "active" resources are integration service accounts
// (Gluh API, Xero API, Cloud Olive API, etc.), not real people, and have no
// hours of their own to report on. Excluded from the selectable list, by
// request ("active, non-API Autotask resources").
const API_USER_LICENSE_TYPE = 7;

// Always excluded, by request -- "show any time against any resource that's
// not an API user, not Amber Worth, Damon Kirkpatrick, Melissa Tannock, Matt
// Jeavons or Autotask [Administrator]". A fixed rule now, not a picker
// default -- matched by exact resolved name (same "First Last" shape used
// throughout this file), same as the resource-picker's own former default.
const EXCLUDED_RESOURCE_NAMES = new Set(['Amber Worth', 'Damon Kirkpatrick', 'Melissa Tannock', 'Matt Jeavons', 'Autotask Administrator']);

// Team selector -- "add a selector at the top for Team: with Support Desk,
// Proffessional Services, Both". No Autotask entity is literally called
// "Workgroups" (confirmed against both the SDK's own entity files and
// Autotask's official REST API docs); Amber created real Departments in
// Autotask instead ("ok I've entered them in Departments"), confirmed live
// against the real API: "Service Desk" (id 29683489), "Professional
// Services" (id 29683490), plus the pre-existing "Leadership Team" (id
// 29683488, already used for the AMBER/DAMON/MELISSA exclusion above --
// confirmed those same three names ARE this department's real membership).
// Membership comes from ResourceRoleDepartments (a resource can hold more
// than one row -- a role per department -- so membership here means ANY
// active row for that department, not just their isDefault/primary one).
// Department ids themselves now live in @dashboard/autotask-client (shared
// with @dashboard/about-me) -- see fetchTeamMembership() below.

const TEAM_SERVICE_DESK = 'service-desk';
const TEAM_PROFESSIONAL_SERVICES = 'professional-services';
const TEAM_BOTH = 'both';
const VALID_TEAMS = new Set([TEAM_SERVICE_DESK, TEAM_PROFESSIONAL_SERVICES, TEAM_BOTH]);
const DEFAULT_TEAM = TEAM_SERVICE_DESK; // "Default to Support Desk please."

function resolveTeam(rawTeam) {
  return VALID_TEAMS.has(rawTeam) ? rawTeam : DEFAULT_TEAM;
}

// Real active ResourceRoleDepartments rows for just these 3 departments --
// confirmed against real data: Leadership Team 3 (Damon Kirkpatrick, Melissa
// Tannock, Amber Worth -- all 3 already excluded above regardless), Service
// Desk 5, Professional Services 3. Shared with @dashboard/about-me now
// (@dashboard/autotask-client's own fetchServiceDeskAndProfessionalServicesMembership()),
// not duplicated here anymore -- this local wrapper just keeps this file's
// own `fetchTeamMembership()` call sites and return shape unchanged.
async function fetchTeamMembership(client) {
  return fetchServiceDeskAndProfessionalServicesMembership(client);
}

// The three real rules, by request:
// - Service Desk (default): everyone EXCEPT Professional Services or
//   Leadership Team.
// - Professional Services: ONLY resources in the Professional Services team.
// - Both: everyone EXCEPT Leadership Team.
// Service Desk membership itself is never checked here -- "Service Desk"
// reads as "not one of the other two", not "must appear in the Service Desk
// department's own rows", so a resource who has real data but was never
// explicitly added to the Service Desk department in Autotask still shows
// up under the default, same as before this selector existed.
function filterResourcesByTeam(resources, team, membership) {
  if (team === TEAM_PROFESSIONAL_SERVICES) {
    return resources.filter((r) => membership.professionalServices.has(r.id));
  }
  if (team === TEAM_BOTH) {
    return resources.filter((r) => !membership.leadership.has(r.id));
  }
  return resources.filter((r) => !membership.professionalServices.has(r.id) && !membership.leadership.has(r.id));
}

// Shared by every path that turns a raw Resources record into this page's
// own resource shape -- applies both standing exclusions (API User license
// type, EXCLUDED_RESOURCE_NAMES) the same way regardless of how the
// underlying Resources rows were found.
function mapAndFilterResources(resources) {
  return resources
    // licenseType is excluded client-side, not via a `noteq` query filter --
    // this codebase already hit a real bug from exactly that shape (see
    // excludeMonitoringAlerts()'s own comment, above the import list, for
    // the full story): Autotask's REST API applies SQL three-valued logic
    // to `noteq`, so any resource whose licenseType somehow came back null
    // would be silently dropped by the query rather than kept. Filtering
    // in plain JS avoids that failure mode entirely, even though
    // licenseType is not expected to be null here.
    .filter((r) => r.licenseType !== API_USER_LICENSE_TYPE)
    .map((r) => ({
      id: r.id,
      name: [r.firstName, r.lastName].filter(Boolean).join(' ').trim() || `Resource #${r.id}`,
      // Carried through for Public Holidays below (Resources.locationID ->
      // InternalLocations.holidaySetId).
      locationID: r.locationID,
    }))
    .filter((r) => !EXCLUDED_RESOURCE_NAMES.has(r.name));
}

// The resource set for a report is driven by who actually HAS real
// TimeEntries in the selected period -- NOT by today's Resources.isActive
// flag. Confirmed a real bug the other way round, by request: "Resources
// who are not present in the data still appeared and resources who are in
// the data but are now disabled did not appear." A resource deactivated in
// Autotask sometime AFTER the reported period still has real history in
// that period and belongs on a report about it; a resource who logged
// nothing at all in the period (on leave the whole tenure, joined
// afterwards, whatever the reason) has nothing to show and shouldn't
// appear as a row of zeros. isActive is not checked anywhere in this
// function -- presence of a real TimeEntries row in the period is the only
// test, same standing exclusions (API User, EXCLUDED_RESOURCE_NAMES)
// still apply on top of that.
//
// Also returns the leave/ticket entries this already had to fetch to
// determine who has data, narrowed down to the final resource set -- so
// the main report route doesn't need a second TimeEntries fetch for the
// exact same period.
async function resolveResourcesWithData(client, fromIso, toIso, team) {
  const timeOffBillingCodeIds = await resolveLeaveBillingCodeIds(client);
  const [leaveEntries, ticketEntries, membership] = await Promise.all([
    timeOffBillingCodeIds.length > 0
      ? listAll(client.timeEntries, [
          { op: 'gte', field: 'dateWorked', value: fromIso },
          { op: 'lte', field: 'dateWorked', value: toIso },
          { op: 'in', field: 'billingCodeID', value: timeOffBillingCodeIds },
        ])
      : Promise.resolve([]),
    listAll(client.timeEntries, [
      { op: 'gte', field: 'dateWorked', value: fromIso },
      { op: 'lte', field: 'dateWorked', value: toIso },
      { op: 'exist', field: 'ticketID' },
    ]),
    fetchTeamMembership(client),
  ]);

  const idsWithData = [...new Set([...leaveEntries.map((e) => e.resourceID), ...ticketEntries.map((e) => e.resourceID)])];
  if (idsWithData.length === 0) return { selected: [], leaveEntries: [], ticketEntries: [] };

  const resources = await fetchByFieldIn(client.resources, 'id', idsWithData);
  const withData = mapAndFilterResources(resources).sort((a, b) => a.name.localeCompare(b.name));
  const selected = filterResourcesByTeam(withData, team, membership);
  const selectedIds = new Set(selected.map((r) => r.id));

  return {
    selected,
    leaveEntries: leaveEntries.filter((e) => selectedIds.has(e.resourceID)),
    ticketEntries: ticketEntries.filter((e) => selectedIds.has(e.resourceID)),
  };
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

// Same Mon-Fri definition countWeekdays() uses, applied to a single real
// calendar-date key -- a real Holidays row that happens to fall on a
// weekend doesn't cost anyone an extra day, since that date was never in
// weekdayCount/Normal Hours to begin with.
function isWeekdayDateKey(dateKey) {
  const day = new Date(`${dateKey}T00:00:00Z`).getUTCDay();
  return day >= 1 && day <= 5;
}

// Public Holidays -- "They are called holiday sets in Autotask". Confirmed
// against real data: Resources carry no holiday info directly, only their
// own `locationID` (InternalLocations); InternalLocations carries the real
// link, `holidaySetId`; Holidays rows carry `holidaySetID` (different
// capitalization -- confirmed as two genuinely distinct real field names,
// not a typo here) plus a real `holidayDate`/`holidayName`. This tenant's
// real InternalLocations: Geebung (holidaySetId 1, "QLD" set, the default
// location, 36 of 38 real active resources), Grafton (holidaySetId 1, 1
// resource), Perth (holidaySetId 2, "WA" set, 1 resource), Sri Lanka
// (holidaySetId 0 -- no set assigned, 0 real active resources there
// currently). Only the QLD set (id 1) has any real Holidays rows for 2026
// in this tenant (7 real dates, confirmed) -- WA and Sri Lanka are real,
// currently-empty calendars, not a bug here; a resource whose set has no
// rows correctly gets 0 Public Holiday hours rather than an error.
async function fetchPublicHolidayHoursByResource(client, selected, fromIso, toIso) {
  const locations = await listAll(client.internalLocations, [{ op: 'gte', field: 'id', value: 0 }]);
  const holidaySetByLocation = new Map(locations.map((l) => [l.id, l.holidaySetId]));

  // 0/undefined means "no holiday set assigned" (confirmed real: Sri Lanka
  // location) -- excluded from the fetch below rather than sent as a real
  // Autotask filter value, same reasoning as every other "skip if empty"
  // guard in this file.
  const holidaySetIds = [...new Set(selected.map((r) => holidaySetByLocation.get(r.locationID)).filter((id) => id))];

  // Real date KEYS per set, not just a count -- a resource with their own
  // per-day-of-week schedule (NORMAL_HOURS_OVERRIDES above) loses THAT
  // day's own real hours to a public holiday landing on it, not a flat
  // NORMAL_HOURS_PER_DAY, so this needs to know WHICH real weekday each
  // holiday fell on, not just how many there were.
  const holidayDateKeysBySet = new Map();
  if (holidaySetIds.length > 0) {
    const holidays = await fetchByFieldIn(client.holidays, 'holidaySetID', holidaySetIds, [
      { op: 'gte', field: 'holidayDate', value: fromIso },
      { op: 'lte', field: 'holidayDate', value: toIso },
    ]);
    for (const h of holidays) {
      const dateKey = (h.holidayDate || '').slice(0, 10);
      if (!isWeekdayDateKey(dateKey)) continue;
      if (!holidayDateKeysBySet.has(h.holidaySetID)) holidayDateKeysBySet.set(h.holidaySetID, []);
      holidayDateKeysBySet.get(h.holidaySetID).push(dateKey);
    }
  }

  const hoursByResource = new Map();
  for (const r of selected) {
    const setId = holidaySetByLocation.get(r.locationID);
    const dateKeys = (setId && holidayDateKeysBySet.get(setId)) || [];
    const hours = dateKeys.reduce((sum, dateKey) => sum + normalHoursForDateKey(r.name, dateKey), 0);
    hoursByResource.set(r.id, hours);
  }
  return hoursByResource;
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

// Billable-hours-to-dollars box, by request -- originally "the dollar
// value of the hours from the tickets for Total Tech Hours Billable ...
// Lets use the the Labour Rate associated with the Helpdesk role in the
// price list in Autotask" (a single flat rate applied to every hour
// regardless of who worked it or what it was billed under). Superseded by
// request ("use these data sources and formulas for 'awaiting approve and
// post', posted and invoiced to show the dollar value of the times shown
// (only for the specific person, not the whole ticket)") -- each entry
// now resolves its OWN real rate/value via
// @dashboard/autotask-client's resolveChargeableValue() (real
// posted/invoiced $ when available, else a computed per-role/per-
// work-type T&M estimate), summed per row in buildClientContractSplitHours()
// below, instead of one flat Helpdesk Service rate applied uniformly.

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
// `roleRatesById`/`workTypeModifiersById`/`billingItemByTeId` are optional
// (empty maps for a non-admin viewer, see this function's own callers) --
// each cell's `dollars` is the SAME real resolveChargeableValue() figure
// Ticket Times/Completed Tickets use, per-entry, per-resource ("only for
// the specific person") -- never a flat rate multiplied onto a summed
// hours total.
function buildClientContractSplitHours(ctx, ticketEntries, wantBillable, roleRatesById = new Map(), workTypeModifiersById = new Map(), billingItemByTeId = new Map()) {
  const filtered = ticketEntries.filter((e) => (e.isNonBillable !== true) === wantBillable);
  const byRow = new Map(); // row label -> Map(resourceID -> {worked, toBill, dollars})
  for (const e of filtered) {
    const ticket = ctx.ticketById.get(e.ticketID);
    if (!ticket || isAmbientItCompany(ctx.companyNameById, ticket.companyID)) continue;
    const rowLabel = clientContractRowLabel(ticket.contractID ? ctx.contractNameById.get(ticket.contractID) : null);
    if (!byRow.has(rowLabel)) byRow.set(rowLabel, new Map());
    const byResource = byRow.get(rowLabel);
    if (!byResource.has(e.resourceID)) byResource.set(e.resourceID, { worked: 0, toBill: 0, dollars: 0 });
    const cell = byResource.get(e.resourceID);
    cell.worked += e.hoursWorked || 0;
    cell.toBill += e.hoursToBill || 0;
    cell.dollars += resolveChargeableValue(e, billingItemByTeId, roleRatesById, workTypeModifiersById).value || 0;
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

// Shared by the main report and the on-demand Work-Type Reconciliation
// route below -- validates from/to, and returns null (after writing the
// 400) when validation fails, so callers can just `if (!resolved) return;`.
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
router.get('/', async (req, res) => {
  const range = validateDateRange(req, res);
  if (!range) return;
  const { from, to } = range;
  const team = resolveTeam((req.query.team || '').toString());
  const weekdayCount = countWeekdays(from, to);
  const fromIso = `${from}T00:00:00.000Z`;
  const toIso = `${to}T00:00:00.000Z`;
  // Billable $ box is admin-only, by request -- everyone else's response
  // just carries isAdmin: false and empty maps below (client.js never
  // renders the box at all when isAdmin is false, so nothing is actually
  // shown to anyone -- this only skips the extra Roles/BillingItems/
  // WorkTypeModifiers fetches for a non-admin viewer who couldn't see the
  // result anyway).
  const isAdmin = isDashboardAdmin(req);

  try {
    const client = await getClient();
    const [{ selected, leaveEntries, ticketEntries }, aittimeTickets] = await Promise.all([
      resolveResourcesWithData(client, fromIso, toIso, team),
      fetchAittimeTickets(client),
    ]);

    if (selected.length === 0) {
      return res.json({ from, to, team, weekdayCount, normalHoursPerDay: NORMAL_HOURS_PER_DAY, isAdmin, resources: [], aittime: [], clientContracts: [], clientContractsBillable: [], clientContractsNonBillable: [] });
    }

    // Depends on `selected` (each resource's own locationID), so this
    // can't join the Promise.all above -- it has to wait for
    // resolveResourcesWithData() to resolve first.
    const publicHolidayHoursByResource = await fetchPublicHolidayHoursByResource(client, selected, fromIso, toIso);

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
    //
    // Real chargeable $ per entry (Billable table only consumes this, but
    // computed for both calls below since they share one function), by
    // request ("use these data sources and formulas for 'awaiting approve
    // and post', posted and invoiced to show the dollar value of the times
    // shown"). Admin-only, same gating as the Billable $ box itself always
    // had -- a non-admin's response carries empty maps, so
    // buildClientContractSplitHours() below just produces real $0 rows
    // rather than skipping the shape entirely.
    const [clientCtx, roleRatesById, billingItemByTeId] = await Promise.all([
      fetchClientTicketContext(client, [...new Set(ticketEntries.map((e) => e.ticketID))]),
      isAdmin ? fetchRoleHourlyRates(client) : Promise.resolve(new Map()),
      isAdmin ? fetchBillingItemsByTimeEntryId(client, ticketEntries.map((e) => e.id)) : Promise.resolve(new Map()),
    ]);
    const workTypeModifiersById = isAdmin ? await fetchWorkTypeModifiers(client, ticketEntries.map((e) => e.billingCodeID)) : new Map();
    const clientContracts = clientCtx ? buildClientContractHours(clientCtx, ticketEntries) : [];
    const clientContractsBillable = clientCtx ? buildClientContractSplitHours(clientCtx, ticketEntries, true, roleRatesById, workTypeModifiersById, billingItemByTeId) : [];
    const clientContractsNonBillable = clientCtx ? buildClientContractSplitHours(clientCtx, ticketEntries, false, roleRatesById, workTypeModifiersById, billingItemByTeId) : [];

    const resources = selected.map((r) => {
      const leaveHours = leaveByResource.get(r.id) || 0;
      const publicHolidayHours = publicHolidayHoursByResource.get(r.id) || 0;
      // Day-of-week aware, by request (NORMAL_HOURS_OVERRIDES, see its own
      // comment) -- reduces to exactly NORMAL_HOURS_PER_DAY * weekdayCount
      // for anyone without an override, same figure as before this
      // existed. normalHoursPerDay is this resource's own AVERAGE across
      // the real weekdays in this range (their own total / weekdayCount),
      // shown in the "Normal Hours (per day)" row -- by construction that
      // average times weekdayCount reproduces the same total, so that row
      // and the Total Hours row can never visibly disagree even though a
      // resource with a real per-day schedule doesn't actually work a flat
      // number of hours every day.
      const totalNormalHours = sumNormalHoursForRange(r.name, from, to);
      const normalHoursPerDay = weekdayCount > 0 ? totalNormalHours / weekdayCount : NORMAL_HOURS_PER_DAY;
      const totalHours = totalNormalHours - leaveHours - publicHolidayHours;
      return {
        resourceId: r.id,
        resourceName: r.name,
        normalHoursPerDay,
        leaveHours,
        publicHolidayHours,
        totalHours,
        ticketHours: ticketByResource.get(r.id) || 0,
      };
    });

    res.json({ from, to, team, weekdayCount, normalHoursPerDay: NORMAL_HOURS_PER_DAY, isAdmin, resources, aittime, clientContracts, clientContractsBillable, clientContractsNonBillable });
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
  const team = resolveTeam((req.query.team || '').toString());
  const fromIso = `${from}T00:00:00.000Z`;
  const toIso = `${to}T00:00:00.000Z`;

  try {
    const client = await getClient();
    // Same resource-set derivation the main report uses (whoever has real
    // TimeEntries in the period, filtered by the same Team selection), and
    // its own already-fetched ticketEntries are reused directly here rather
    // than fetched a second time.
    const { selected, ticketEntries } = await resolveResourcesWithData(client, fromIso, toIso, team);
    if (selected.length === 0) return res.json({ workTypeFixedBillable: [], workTypeFixedUnticked: [], workTypeOther: [], workTypeAccrueIng: [], ambientItTickets: [] });

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

// Time entry drill-down -- click any non-zero hours value on the page to
// see the REAL individual TimeEntries that add up to it. Started scoped to
// just the Total Client Hours Recorded table ("let's start with something
// simple"), then extended to every other real-entry-sum cell on the page,
// by request. Opens as a real new browser window (client.js), not a
// JS-rendered popup -- this route returns a genuine standalone HTML page
// (its own <style>, no dependency on the dashboard shell's own CSS/JS), so
// the window works like any other page: real URL, real back/forward, real
// print.
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const ENTRIES_VIEW_COLUMNS = [
  { key: 'client', label: 'Client' },
  { key: 'ticket', label: 'Ticket' },
  { key: 'workedDate', label: 'Worked Date' },
  { key: 'activityTitle', label: 'Activity Title' },
  { key: 'summaryNote', label: 'Summary Note' },
  { key: 'estimate', label: 'Estimate' },
  { key: 'status', label: 'Task/Ticket Status' },
  { key: 'workType', label: 'Work Type' },
  { key: 'contract', label: 'Contract' },
  { key: 'resource', label: 'Resource' },
  { key: 'workedHours', label: 'Worked Hours' },
  { key: 'billableHours', label: 'Billable Hours' },
  { key: 'nonBillableHours', label: 'Non-Billable Hours' },
  { key: 'offsetHours', label: 'Offset Hours' },
  { key: 'startTime', label: 'Start Time' },
  { key: 'endTime', label: 'End Time' },
];

// A small, dependency-free standalone page -- header cell filter inputs,
// pure client-side substring matching (case-insensitive, every active
// filter ANDed together) against each row's own already-rendered cell
// text. No embedded JSON/framework needed for something this size.
function renderEntriesPage(title, rows) {
  const headHtml = ENTRIES_VIEW_COLUMNS.map((c) => `<th>${escapeHtml(c.label)}</th>`).join('');
  const filterHtml = ENTRIES_VIEW_COLUMNS.map((c, i) => `<th><input type="text" class="filter-input" data-col="${i}" placeholder="Filter..." /></th>`).join('');
  const bodyHtml = rows
    .map((r) => {
      const cells = ENTRIES_VIEW_COLUMNS.map((c) => {
        if (c.key === 'ticket') {
          // A plain <a target="_blank"> reportedly wasn't actually opening
          // a new window here -- switched to the same explicit
          // window.open() pattern the rest of this dashboard's own ticket
          // links already use (e.g. ticket-times' openTicketInNewWindow())
          // rather than relying on native target="_blank" behaviour.
          return `<td>${r.ticketUrl ? `<a href="${escapeHtml(r.ticketUrl)}" class="ticket-link" data-url="${escapeHtml(r.ticketUrl)}">${escapeHtml(r.ticketNumber)}</a>` : escapeHtml(r.ticketNumber)}</td>`;
        }
        return `<td>${escapeHtml(r[c.key])}</td>`;
      }).join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; margin: 1.5rem; color: #1a1a1a; background: #fff; }
  h1 { font-size: 1.1rem; margin: 0 0 1rem; }
  table { border-collapse: collapse; width: 100%; font-size: 0.85rem; }
  th, td { padding: 0.35rem 0.6rem; border: 1px solid #e5e7eb; text-align: left; white-space: nowrap; }
  /* Summary Note (5th column) -- real notes are often multi-line; keep the
     real line breaks instead of collapsing them. Widened, by request --
     28rem was wrapping too eagerly for a normal-length note. */
  th:nth-child(5), td:nth-child(5) { white-space: pre-line; max-width: 60rem; min-width: 24rem; }
  thead tr:first-child th { background: #f3f4f6; position: sticky; top: 0; }
  thead tr:last-child th { background: #fff; position: sticky; top: 1.85rem; padding: 0.2rem 0.4rem; }
  .filter-input { width: 100%; box-sizing: border-box; padding: 0.2rem 0.3rem; border: 1px solid #d1d5db; border-radius: 4px; font-size: 0.8rem; }
  tbody tr:nth-child(even) { background: #fafafa; }
  .row-count { color: #6b7280; font-size: 0.85rem; margin-bottom: 0.75rem; }
  /* No underline/blue colour on the ticket link, by request -- reads as
     plain text, cursor: pointer the only remaining hint it's clickable. */
  .ticket-link { color: inherit; text-decoration: none; cursor: pointer; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p class="row-count" id="row-count"></p>
<table id="entries-table">
  <thead>
    <tr>${headHtml}</tr>
    <tr>${filterHtml}</tr>
  </thead>
  <tbody>${bodyHtml}</tbody>
</table>
<script>
(function () {
  var table = document.getElementById('entries-table');
  var rows = Array.prototype.slice.call(table.tBodies[0].rows);
  var inputs = Array.prototype.slice.call(table.querySelectorAll('.filter-input'));
  var rowCountEl = document.getElementById('row-count');

  function applyFilters() {
    var filters = inputs.map(function (inp) { return inp.value.trim().toLowerCase(); });
    var visible = 0;
    rows.forEach(function (row) {
      var show = true;
      for (var i = 0; i < filters.length; i++) {
        if (!filters[i]) continue;
        var cellText = (row.cells[i].textContent || '').toLowerCase();
        if (cellText.indexOf(filters[i]) === -1) { show = false; break; }
      }
      row.style.display = show ? '' : 'none';
      if (show) visible++;
    });
    rowCountEl.textContent = visible + ' of ' + rows.length + ' entries shown';
  }

  inputs.forEach(function (inp) { inp.addEventListener('input', applyFilters); });
  applyFilters();

  // Explicit window.open() for ticket links, by request -- plain
  // target="_blank" reportedly wasn't reliably opening a new window here.
  document.addEventListener('click', function (e) {
    var link = e.target.closest('.ticket-link');
    if (!link) return;
    e.preventDefault();
    // Same features string every other ticket link on this dashboard uses
    // (Service Calls, What's On, Today Things, Ticket Times) -- for
    // consistent sizing. This page is a standalone document, not part of
    // the dashboard shell, so the shell's own window.open patch (same-
    // monitor positioning for THAT app's own popups) doesn't apply here
    // regardless -- this is a plain, unpatched browser window.open() call.
    window.open(link.dataset.url, '_blank', 'noopener,noreferrer,width=1200,height=900');
  });
})();
</script>
</body>
</html>`;
}

// One row per real TimeEntries record, same column shape regardless of
// which "kind" of drill-down produced it -- `ticket` is null for leave
// entries (no ticket at all), every field null-safe for that case. Work
// Type resolves from whichever of billingCodeID (ticket entries) /
// internalBillingCodeID (leave entries) is actually set -- the same two
// distinct fields this whole page already treats separately elsewhere.
async function buildEntryRow(e, ctx, workTypeNameById, resourceName) {
  const ticket = ctx && e.ticketID ? ctx.ticketById.get(e.ticketID) : null;
  const workTypeCodeId = e.billingCodeID !== null && e.billingCodeID !== undefined ? e.billingCodeID : e.internalBillingCodeID;
  return {
    client: ticket ? ctx.companyNameById.get(ticket.companyID) || '' : '',
    ticketNumber: ticket ? ticket.ticketNumber : '',
    ticketUrl: ticket ? await getTicketUrl(ticket.id) : null,
    workedDate: e.dateWorked ? e.dateWorked.slice(0, 10) : '',
    activityTitle: ticket ? ticket.title || '' : '',
    summaryNote: e.summaryNotes || '',
    estimate: ticket && ticket.estimatedHours !== null && ticket.estimatedHours !== undefined ? ticket.estimatedHours : '',
    status: ticket ? ctx.statusLabels.get(ticket.status) || '' : '',
    workType: workTypeCodeId !== null && workTypeCodeId !== undefined ? workTypeNameById.get(workTypeCodeId) || '' : '',
    contract: ticket && ticket.contractID ? ctx.contractNameById.get(ticket.contractID) || '' : '',
    resource: resourceName,
    workedHours: (e.hoursWorked || 0).toFixed(2),
    billableHours: e.isNonBillable === true ? '' : (e.hoursToBill || 0).toFixed(2),
    nonBillableHours: e.isNonBillable === true ? (e.hoursToBill || 0).toFixed(2) : '',
    offsetHours: e.offsetHours || 0,
    startTime: e.startDateTime ? new Date(e.startDateTime).toLocaleString() : '',
    endTime: e.endDateTime ? new Date(e.endDateTime).toLocaleString() : '',
  };
}

// Time entry drill-down, generalized -- by request, extended from just the
// Total Client Hours Recorded table to every non-zero real-entry-sum cell
// on the page. `kind` selects which of this page's own already-existing
// categorization rules (the exact same functions/constants the aggregate
// tables above are built from -- clientContractRowLabel(),
// isAmbientItCompany(), WORK_TYPE_FIXED_LIST, ACCRUE_ING_*,
// fetchAittimeTickets(), AMBIENT_TICKETS_ROW_*) to re-apply when filtering
// the raw entries down to just the one cell that was clicked, so "what you
// see is what you get" -- there's no separate filtering logic that could
// quietly disagree with the table the click came from.
//
// Rows that are a COMPUTED figure rather than a direct sum of real entries
// (Normal Hours' own flat constant, Total Hours' own subtraction, Hours
// less AITTIME, Recorded less Billable, the "Client Ticket Times"/"Total
// (matches Total Recorded Hours)" reconciliation rows) are deliberately
// NOT wired up to this at all, client-side -- there's no single coherent
// entry list a subtraction/multi-table-sum could point at.
router.get('/entries-view', async (req, res) => {
  const range = validateDateRange(req, res);
  if (!range) return;
  const { from, to } = range;

  const resourceId = parseInt(req.query.resourceId, 10);
  const kind = (req.query.kind || '').toString();
  const label = (req.query.label || '').toString();
  const billable = (req.query.billable || 'all').toString(); // 'all' | 'true' | 'false'
  if (!Number.isInteger(resourceId)) return res.status(400).send('Query param "resourceId" is required.');
  if (!kind) return res.status(400).send('Query param "kind" is required.');

  try {
    const client = await getClient();
    const fromIso = `${from}T00:00:00.000Z`;
    const toIso = `${to}T00:00:00.000Z`;
    const resourceName = await resolveResourceName(client, resourceId);

    let matching;
    let ctx = null;

    if (kind === 'leave') {
      // Same real Time Off billing-code match as Table 1's own Leave
      // Hours row -- see resolveLeaveBillingCodeIds()'s own comment.
      const timeOffBillingCodeIds = await resolveLeaveBillingCodeIds(client);
      matching =
        timeOffBillingCodeIds.length > 0
          ? await listAll(client.timeEntries, [
              { op: 'eq', field: 'resourceID', value: resourceId },
              { op: 'gte', field: 'dateWorked', value: fromIso },
              { op: 'lte', field: 'dateWorked', value: toIso },
              { op: 'in', field: 'billingCodeID', value: timeOffBillingCodeIds },
            ])
          : [];
    } else {
      const entries = await listAll(client.timeEntries, [
        { op: 'eq', field: 'resourceID', value: resourceId },
        { op: 'gte', field: 'dateWorked', value: fromIso },
        { op: 'lte', field: 'dateWorked', value: toIso },
        { op: 'exist', field: 'ticketID' },
      ]);
      const ticketIds = [...new Set(entries.map((e) => e.ticketID))];
      ctx = await fetchClientTicketContext(client, ticketIds);

      if (kind === 'ticket-hours') {
        // ALL ticket time, any company -- Table 1's own Ticket Hours row.
        matching = entries;
      } else if (!ctx) {
        matching = [];
      } else if (kind === 'contract') {
        matching = entries.filter((e) => {
          const ticket = ctx.ticketById.get(e.ticketID);
          if (!ticket || isAmbientItCompany(ctx.companyNameById, ticket.companyID)) return false;
          if (clientContractRowLabel(ticket.contractID ? ctx.contractNameById.get(ticket.contractID) : null) !== label) return false;
          if (billable === 'true' && e.isNonBillable === true) return false;
          if (billable === 'false' && e.isNonBillable !== true) return false;
          return true;
        });
      } else if (kind === 'work-type' || kind === 'work-type-other') {
        const billingCodeIds = [...new Set(entries.map((e) => e.billingCodeID).filter((id) => id !== null && id !== undefined))];
        const codes = billingCodeIds.length > 0 ? await fetchByFieldIn(client.billingCodes, 'id', billingCodeIds) : [];
        const nameById = new Map(codes.map((c) => [c.id, c.name]));
        matching = entries.filter((e) => {
          const ticket = ctx.ticketById.get(e.ticketID);
          if (!ticket || isAmbientItCompany(ctx.companyNameById, ticket.companyID)) return false;
          const workType = e.billingCodeID !== null && e.billingCodeID !== undefined ? nameById.get(e.billingCodeID) || `Work Type #${e.billingCodeID}` : 'No Work Type';
          if (workType !== label) return false;
          if (kind === 'work-type') {
            if (billable === 'true' && e.isNonBillable === true) return false;
            if (billable === 'false' && e.isNonBillable !== true) return false;
          }
          return true;
        });
      } else if (kind === 'aittime-title') {
        const aittimeTickets = await fetchAittimeTickets(client);
        const titleByTicketId = new Map(aittimeTickets.map((t) => [t.id, t.title]));
        matching = entries.filter((e) => titleByTicketId.get(e.ticketID) === label);
      } else if (kind === 'accrue-status') {
        const billingCodeIds = [...new Set(entries.map((e) => e.billingCodeID).filter((id) => id !== null && id !== undefined))];
        const codes = billingCodeIds.length > 0 ? await fetchByFieldIn(client.billingCodes, 'id', billingCodeIds) : [];
        const nameById = new Map(codes.map((c) => [c.id, c.name]));
        matching = entries.filter((e) => {
          const ticket = ctx.ticketById.get(e.ticketID);
          if (!ticket || isAmbientItCompany(ctx.companyNameById, ticket.companyID)) return false;
          const workType = e.billingCodeID !== null && e.billingCodeID !== undefined ? nameById.get(e.billingCodeID) || '' : '';
          if (workType !== ACCRUE_ING_WORK_TYPE) return false;
          const statusLabel = ctx.statusLabels.get(ticket.status);
          const bucket = statusLabel && ACCRUE_ING_COMPLETE_STATUS_LABELS.has(statusLabel) ? ACCRUE_ING_ROW_COMPLETE : ACCRUE_ING_ROW_OTHER;
          return bucket === label;
        });
      } else if (kind === 'ambient-bucket') {
        const aittimeTickets = await fetchAittimeTickets(client);
        const aittimeTicketIds = new Set(aittimeTickets.map((t) => t.id));
        matching = entries.filter((e) => {
          const ticket = ctx.ticketById.get(e.ticketID);
          if (!ticket || !isAmbientItCompany(ctx.companyNameById, ticket.companyID)) return false;
          const bucket = aittimeTicketIds.has(e.ticketID) ? AMBIENT_TICKETS_ROW_AITTIME : AMBIENT_TICKETS_ROW_OTHER;
          return bucket === label;
        });
      } else {
        return res.status(400).send(`Unknown "kind": ${escapeHtml(kind)}`);
      }
    }

    const billingCodeIds = [...new Set(matching.flatMap((e) => [e.billingCodeID, e.internalBillingCodeID]).filter((id) => id !== null && id !== undefined))];
    const workTypeCodes = billingCodeIds.length > 0 ? await fetchByFieldIn(client.billingCodes, 'id', billingCodeIds) : [];
    const workTypeNameById = new Map(workTypeCodes.map((c) => [c.id, c.name]));

    const rows = [];
    for (const e of matching) {
      rows.push(await buildEntryRow(e, ctx, workTypeNameById, resourceName));
    }

    // Newest first -- reading a list of "what made up this total" starts
    // more usefully from the most recent entry, same reasoning every
    // other list-of-real-records page on this dashboard defaults to.
    rows.sort((a, b) => (a.workedDate < b.workedDate ? 1 : a.workedDate > b.workedDate ? -1 : 0));

    const titleLabel = label || (kind === 'ticket-hours' ? 'Ticket Hours' : kind === 'leave' ? 'Leave Hours' : kind);
    const title = `${titleLabel} – ${resourceName} (${from} to ${to})`;
    res.type('html').send(renderEntriesPage(title, rows));
  } catch (err) {
    console.error(err);
    res.status(500).send(`<pre>${escapeHtml(err.message)}</pre>`);
  }
});

module.exports = router;
