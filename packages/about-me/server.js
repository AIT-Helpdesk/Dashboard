const express = require('express');
const {
  getClient,
  listAll,
  fetchByFieldIn,
  getPicklistLabels,
  getTicketUrl,
  getTicketUdf,
  resolveResourceName,
  resolveCompanyName,
  resolveResourceIdByEmail,
  fetchServiceDeskAndProfessionalServicesMembership,
  excludeMonitoringAlerts,
  mapWithConcurrency,
  aestToUtcIso,
  aestDayBoundsIso,
  todayAestKey,
} = require('@dashboard/autotask-client');
const { getPersonalClient, getTodoUrl } = require('@dashboard/strety-client');
const { getTeams, getShiftsByDay } = require('@dashboard/teams-shifts/lib.js');

// One page pulling together everything real about ONE resource, by request
// ("finds all the various parts for a Resource"). Everything below is
// either a lighter-weight re-derivation of an already-proven query
// elsewhere on this dashboard (same real fields/filters, just re-scoped to
// one resource and/or a shorter window), or a genuinely new one confirmed
// against real data the same way -- see this package's own README for the
// per-section sourcing and the two sections deliberately NOT resource-
// filtered (Subscriptions Expiring, Tickets Dashboard widgets), by request.

// ---- Shared date-range helper -- Completed Tickets/Ticket Times/Asked for
// Review/Accrued Time all take an explicit [fromKey, toKey] AEST date range
// now (both inclusive), by request ("Add date selectors and buttons to the
// 'About Me' page matching what we have on the Time Summaries page") --
// Service Calls/Deadlines/Strety Tasks/Shifts are explicitly NOT part of
// this ("won't be affected by this"), so they keep their own fixed windows
// regardless of what's picked here. `isoForKey()` turns a plain YYYY-MM-DD
// key into the real UTC instant aestToUtcIso() needs, the same tiny
// adapter @dashboard/whats-on's own server.js already uses for its
// "next 7 working days" window. ----
function isoForKey(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return aestToUtcIso(y, m, d);
}
// Plain calendar-key arithmetic, same "Date.UTC as a neutral calculator"
// convention @dashboard/whats-on's own server.js already uses for its
// identically-named helper (not shared as a dependency -- separate page
// package).
function addDaysToKey(dateKey, delta) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

// ---- Resource picker -- Service Desk + Professional Services only, by
// request ("allow selection of Resources in the two teams mentioned on the
// Time Summaries page/tab"). Same real department ids/membership
// @dashboard/times' own Team selector already uses (shared helper, see
// @dashboard/autotask-client). ----
const API_USER_LICENSE_TYPE = 7; // same real fact @dashboard/times' own README confirms

async function fetchPickerResources(client) {
  const membership = await fetchServiceDeskAndProfessionalServicesMembership(client);
  const ids = [...new Set([...membership.serviceDesk, ...membership.professionalServices])];
  if (ids.length === 0) return [];
  const resources = await fetchByFieldIn(client.resources, 'id', ids);
  return resources
    .filter((r) => r.licenseType !== API_USER_LICENSE_TYPE)
    .map((r) => ({ id: r.id, name: [r.firstName, r.lastName].filter(Boolean).join(' ').trim() || `Resource #${r.id}`, email: r.email || null }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---- Viewer authorization -- the Resource dropdown itself (picking
// someone OTHER than yourself) is Leadership Team only, by request
// ("Allow the Resource dropdown at the top only for people logged in who
// are members of the leadership team"). Everyone else always sees just
// their own page, resourceId locked server-side (not just a hidden/
// disabled dropdown client-side -- a manually-crafted resourceId query
// param is rejected the same way, see the "/" route below). Same real
// Leadership Team department id/membership @dashboard/times' own Team
// selector already resolves (shared helper, see @dashboard/autotask-
// client) -- reuses the SAME fetchServiceDeskAndProfessionalServices-
// Membership() call fetchPickerResources() above already makes, just
// reading its otherwise-unused `leadership` set too. ----
async function resolveViewerAuthorization(client, email) {
  const [membership, ownResourceId] = await Promise.all([
    fetchServiceDeskAndProfessionalServicesMembership(client),
    email ? resolveResourceIdByEmail(client, email) : Promise.resolve(null),
  ]);
  return { ownResourceId, isLeadership: ownResourceId != null && membership.leadership.has(ownResourceId) };
}

// ---- Service Calls -- today & tomorrow, same window What's On's own Today
// & Tomorrow column uses. Allocated-to-this-resource rows first, then
// Unallocated (company-wide -- a staffing gap matters regardless of whose
// About Me page it's shown on, by request), calls allocated to someone
// ELSE are left out entirely -- not relevant to this specific resource's
// own page. Same real ServiceCallTicketResources join @dashboard/service-
// calls and What's On both already use (ServiceCalls itself carries no
// resource field of its own -- confirmed via field info, see that page's
// own README). ----
async function fetchServiceCallsSection(client, resourceId) {
  const todayKey = todayAestKey();
  const [ty, tm, td] = todayKey.split('-').map(Number);
  const startISO = aestToUtcIso(ty, tm, td);
  const endISO = aestToUtcIso(ty, tm, td + 2); // today + tomorrow, end exclusive

  const serviceCalls = await listAll(client.serviceCalls, [
    { op: 'gte', field: 'startDateTime', value: startISO },
    { op: 'lt', field: 'startDateTime', value: endISO },
  ]);
  if (serviceCalls.length === 0) return { allocated: [], unallocated: [] };

  const serviceCallIds = serviceCalls.map((sc) => sc.id);
  const scTickets = await fetchByFieldIn(client.serviceCallTickets, 'serviceCallID', serviceCallIds);
  const scTicketIdsByServiceCallId = new Map();
  for (const t of scTickets) {
    if (!scTicketIdsByServiceCallId.has(t.serviceCallID)) scTicketIdsByServiceCallId.set(t.serviceCallID, []);
    scTicketIdsByServiceCallId.get(t.serviceCallID).push(t.id);
  }
  const allScTicketIds = scTickets.map((t) => t.id);
  const resourceRows = allScTicketIds.length > 0 ? await fetchByFieldIn(client.serviceCallTicketResources, 'serviceCallTicketID', allScTicketIds) : [];
  const resourceIdsByScTicketId = new Map();
  for (const r of resourceRows) {
    if (!resourceIdsByScTicketId.has(r.serviceCallTicketID)) resourceIdsByScTicketId.set(r.serviceCallTicketID, new Set());
    resourceIdsByScTicketId.get(r.serviceCallTicketID).add(r.resourceID);
  }
  function resourceIdsFor(serviceCallId) {
    const ids = new Set();
    for (const scTicketId of scTicketIdsByServiceCallId.get(serviceCallId) || []) {
      for (const rid of resourceIdsByScTicketId.get(scTicketId) || []) ids.add(rid);
    }
    return [...ids];
  }

  const uniqueCompanyIds = [...new Set(serviceCalls.map((sc) => sc.companyID).filter((id) => id !== null && id !== undefined))];
  await mapWithConcurrency(uniqueCompanyIds, 3, (id) => resolveCompanyName(client, id));

  const allocated = [];
  const unallocated = [];
  for (const sc of serviceCalls) {
    const resourceIds = resourceIdsFor(sc.id);
    if (resourceIds.length > 0 && !resourceIds.includes(resourceId)) continue; // allocated to someone else -- not this resource's concern here
    const row = {
      id: sc.id,
      companyName: await resolveCompanyName(client, sc.companyID),
      description: sc.description || null,
      startDateTime: sc.startDateTime,
      endDateTime: sc.endDateTime,
      isComplete: !!sc.isComplete,
    };
    if (resourceIds.includes(resourceId)) allocated.push(row);
    else unallocated.push(row);
  }
  allocated.sort((a, b) => new Date(a.startDateTime) - new Date(b.startDateTime));
  unallocated.sort((a, b) => new Date(a.startDateTime) - new Date(b.startDateTime));
  return { allocated, unallocated };
}

// ---- Completed Tickets -- this resource's own, within the picked date
// range (see the shared date-range helper above; defaults to today when
// no range is picked yet, same as before). Same real "Complete"
// definition (status 5 by completedDate, status 20 Billing - Contract by
// resolvedDateTime -- that status never gets a completedDate set)
// @dashboard/completed-tickets and @dashboard/asked-for-review both
// already use, filtered to completedByResourceID. ----
async function fetchCompletedTicketsSection(client, resourceId, fromKey, toKey) {
  const startISO = isoForKey(fromKey);
  const endISO = isoForKey(addDaysToKey(toKey, 1)); // exclusive -- covers the whole "to" day
  const [completed, billing] = await Promise.all([
    listAll(client.tickets, [
      { op: 'eq', field: 'status', value: 5 },
      { op: 'eq', field: 'completedByResourceID', value: resourceId },
      { op: 'gte', field: 'completedDate', value: startISO },
      { op: 'lt', field: 'completedDate', value: endISO },
    ]),
    listAll(client.tickets, [
      { op: 'eq', field: 'status', value: 20 },
      { op: 'eq', field: 'completedByResourceID', value: resourceId },
      { op: 'gte', field: 'resolvedDateTime', value: startISO },
      { op: 'lt', field: 'resolvedDateTime', value: endISO },
    ]),
  ]);
  const tickets = excludeMonitoringAlerts([...completed, ...billing]);
  const rows = [];
  for (const t of tickets) {
    rows.push({
      id: t.id,
      ticketNumber: t.ticketNumber,
      ticketUrl: await getTicketUrl(t.id),
      title: t.title,
      company: await resolveCompanyName(client, t.companyID),
      billingContract: t.status === 20,
    });
  }
  rows.sort((a, b) => a.company.localeCompare(b.company));
  return rows;
}

// ---- Ticket Times -- this resource's own hours logged within the picked
// date range (see the shared date-range helper above). Same real
// TimeEntries.dateWorked field @dashboard/ticket-times already uses (a
// date-only field, a plain gte/lt on its own UTC-midnight value covers
// the selected AEST range directly -- no AEST offset conversion needed,
// see that page's own README), re-scoped to one resourceID. ----
async function fetchTicketTimesSection(client, resourceId, fromKey, toKey) {
  const entries = await listAll(client.timeEntries, [
    { op: 'gte', field: 'dateWorked', value: `${fromKey}T00:00:00.000Z` },
    { op: 'lt', field: 'dateWorked', value: `${addDaysToKey(toKey, 1)}T00:00:00.000Z` },
    { op: 'eq', field: 'resourceID', value: resourceId },
    { op: 'exist', field: 'ticketID' },
  ]);
  if (entries.length === 0) return [];
  const ticketIds = [...new Set(entries.map((e) => e.ticketID))];
  const [tickets, statusLabels] = await Promise.all([fetchByFieldIn(client.tickets, 'id', ticketIds), getPicklistLabels(client.tickets, 'status')]);
  const ticketById = new Map(tickets.map((t) => [t.id, t]));
  const hoursByTicket = new Map();
  for (const e of entries) hoursByTicket.set(e.ticketID, (hoursByTicket.get(e.ticketID) || 0) + (e.hoursWorked || 0));

  const rows = [];
  for (const [ticketId, hours] of hoursByTicket) {
    const t = ticketById.get(ticketId);
    if (!t) continue;
    rows.push({
      id: ticketId,
      ticketNumber: t.ticketNumber,
      ticketUrl: await getTicketUrl(ticketId),
      title: t.title,
      company: await resolveCompanyName(client, t.companyID),
      status: statusLabels.get(t.status) || `#${t.status}`,
      hours,
    });
  }
  rows.sort((a, b) => b.hours - a.hours);
  return rows;
}

// ---- Asked for Review -- this resource's own, within the picked date
// range (see the shared date-range helper above). Same real definition
// @dashboard/asked-for-review already uses ("Ask For Review" UDF is ASK,
// on a ticket completed within the range), re-scoped to
// completedByResourceID. ----
async function fetchAskedForReviewSection(client, resourceId, fromKey, toKey) {
  const startISO = isoForKey(fromKey);
  const endISO = isoForKey(addDaysToKey(toKey, 1)); // exclusive -- covers the whole "to" day
  const [completed, billing] = await Promise.all([
    listAll(client.tickets, [
      { op: 'eq', field: 'status', value: 5 },
      { op: 'eq', field: 'completedByResourceID', value: resourceId },
      { op: 'gte', field: 'completedDate', value: startISO },
      { op: 'lt', field: 'completedDate', value: endISO },
    ]),
    listAll(client.tickets, [
      { op: 'eq', field: 'status', value: 20 },
      { op: 'eq', field: 'completedByResourceID', value: resourceId },
      { op: 'gte', field: 'resolvedDateTime', value: startISO },
      { op: 'lt', field: 'resolvedDateTime', value: endISO },
    ]),
  ]);
  const tickets = excludeMonitoringAlerts([...completed, ...billing]).filter((t) => getTicketUdf(t, 'Ask For Review') === 'ASK');
  const rows = [];
  for (const t of tickets) {
    rows.push({
      id: t.id,
      ticketNumber: t.ticketNumber,
      ticketUrl: await getTicketUrl(t.id),
      title: t.title,
      company: await resolveCompanyName(client, t.companyID),
      billingContract: t.status === 20,
    });
  }
  rows.sort((a, b) => a.company.localeCompare(b.company));
  return rows;
}

// ---- Accrued Time -- this resource's own qualifying tickets, "qualifying"
// meaning real Accrue-* activity within the picked date range (see the
// shared date-range helper above). Same real "Accrue-" qualification +
// all-time-totals-per-qualifying-ticket logic @dashboard/accrued-time
// already uses (see that page's own README for the full real-data story
// behind both), re-scoped to one resourceID and Complete tickets only
// (the list that page's own main route shows by default). Every column's
// own SUM still reflects each qualifying ticket's ENTIRE real history,
// same as @dashboard/accrued-time's own table -- the date range only
// decides which tickets qualify to show up at all, not what their own
// totals add up to. ----
const WORK_TYPE_ACCRUE_ING = 'Accrue--ING';
const WORK_TYPE_ACCRUE_END = 'Accrue--END';
const WORK_TYPE_ACCRUE_END_NO_BILL = 'Accrue--END-No Bill';
const WORK_TYPE_STANDARD_SUPPORT = '.Standard Support'; // same real Work Type @dashboard/accrued-time's own table already breaks out into its own .STD column
const ACCRUED_TIME_COMPLETE_STATUS_LABELS = new Set(['Complete', 'Billing - Contract']);

async function fetchAccruedTimeSection(client, resourceId, fromKey, toKey) {
  const weekStartISO = isoForKey(fromKey);
  const weekEndISO = isoForKey(addDaysToKey(toKey, 1)); // exclusive -- covers the whole "to" day

  const periodEntries = await listAll(client.timeEntries, [
    { op: 'gte', field: 'dateWorked', value: weekStartISO },
    { op: 'lt', field: 'dateWorked', value: weekEndISO },
    { op: 'eq', field: 'resourceID', value: resourceId },
    { op: 'exist', field: 'ticketID' },
  ]);
  if (periodEntries.length === 0) return [];

  const periodBillingCodeIds = [...new Set(periodEntries.map((e) => e.billingCodeID).filter((id) => id !== null && id !== undefined))];
  const periodCodes = periodBillingCodeIds.length > 0 ? await fetchByFieldIn(client.billingCodes, 'id', periodBillingCodeIds) : [];
  const periodNameById = new Map(periodCodes.map((c) => [c.id, c.name]));
  const qualifyingTicketIds = new Set();
  for (const e of periodEntries) {
    const name = e.billingCodeID != null ? periodNameById.get(e.billingCodeID) || '' : '';
    if (name.startsWith('Accrue-')) qualifyingTicketIds.add(e.ticketID);
  }
  if (qualifyingTicketIds.size === 0) return [];

  const ticketIds = [...qualifyingTicketIds];
  const tickets = await fetchByFieldIn(client.tickets, 'id', ticketIds);
  const ticketById = new Map(tickets.map((t) => [t.id, t]));
  const statusLabelById = await getPicklistLabels(client.tickets, 'status');
  const completeTicketIds = ticketIds.filter((id) => {
    const t = ticketById.get(id);
    const status = t && t.status != null ? statusLabelById.get(t.status) || '' : '';
    return ACCRUED_TIME_COMPLETE_STATUS_LABELS.has(status);
  });
  if (completeTicketIds.length === 0) return [];

  const allTimeEntries = await fetchByFieldIn(client.timeEntries, 'ticketID', completeTicketIds);
  const allBillingCodeIds = [...new Set(allTimeEntries.map((e) => e.billingCodeID).filter((id) => id !== null && id !== undefined))];
  const allCodes = allBillingCodeIds.length > 0 ? await fetchByFieldIn(client.billingCodes, 'id', allBillingCodeIds) : [];
  const nameById = new Map(allCodes.map((c) => [c.id, c.name]));

  const byTicket = new Map();
  for (const e of allTimeEntries) {
    if (!byTicket.has(e.ticketID)) byTicket.set(e.ticketID, { accrueIng: 0, accrueEnd: 0, accrueEndNoBill: 0, standardSupport: 0, other: 0 });
    const bucket = byTicket.get(e.ticketID);
    const name = e.billingCodeID != null ? nameById.get(e.billingCodeID) || '' : '';
    const hours = e.hoursWorked || 0;
    const adjustedHours = hours + (e.offsetHours || 0); // same offsetHours fold-in as @dashboard/accrued-time's own END/NO Bill/.STD/Other columns
    if (name === WORK_TYPE_ACCRUE_ING) bucket.accrueIng += hours;
    else if (name === WORK_TYPE_ACCRUE_END) bucket.accrueEnd += adjustedHours;
    else if (name === WORK_TYPE_ACCRUE_END_NO_BILL) bucket.accrueEndNoBill += adjustedHours;
    else if (name === WORK_TYPE_STANDARD_SUPPORT) bucket.standardSupport += adjustedHours;
    else bucket.other += adjustedHours;
  }

  const rows = [];
  for (const ticketId of completeTicketIds) {
    const t = ticketById.get(ticketId);
    const bucket = byTicket.get(ticketId) || { accrueIng: 0, accrueEnd: 0, accrueEndNoBill: 0, standardSupport: 0, other: 0 };
    rows.push({
      id: ticketId,
      ticketNumber: t?.ticketNumber || `#${ticketId}`,
      ticketUrl: await getTicketUrl(ticketId),
      title: t?.title || '',
      // Between Ticket # and Ticket Title on @dashboard/accrued-time's own
      // table -- resolveCompanyName() caches internally, so a client with
      // several qualifying tickets is still only ever resolved once.
      clientName: t ? await resolveCompanyName(client, t.companyID) : '',
      status: t && t.status != null ? statusLabelById.get(t.status) || `Status #${t.status}` : 'Unknown',
      accrueIng: bucket.accrueIng,
      accrueEnd: bucket.accrueEnd,
      accrueEndNoBill: bucket.accrueEndNoBill,
      standardSupport: bucket.standardSupport,
      other: bucket.other,
    });
  }
  rows.sort((a, b) => (a.ticketNumber || '').localeCompare(b.ticketNumber || ''));
  return rows;
}

// ---- Tickets Dashboard widgets -- Critical (P1), company-wide, NOT
// resource-filtered. Same real priority value @dashboard/tickets-
// dashboard already confirmed (4 = "P1 - CRITICAL"). Only used by
// Deadlines below now -- the Tickets Dashboard and Subscriptions
// Expiring cards themselves were removed from this page, by request
// ("Leave off 'Tickets Dashboard' section and 'Subscriptions
// Expiring'"). ----
const CRITICAL_PRIORITY_VALUE = 4;
async function fetchOpenTicketsByPriority(client, priorityValue, statusLabels) {
  const tickets = await listAll(client.tickets, [
    { op: 'notExist', field: 'completedDate' },
    { op: 'eq', field: 'priority', value: priorityValue },
  ]);
  const rows = [];
  for (const t of excludeMonitoringAlerts(tickets)) {
    rows.push({
      id: t.id,
      ticketNumber: t.ticketNumber,
      ticketUrl: await getTicketUrl(t.id),
      title: t.title,
      company: await resolveCompanyName(client, t.companyID),
      status: statusLabels.get(t.status) || `#${t.status}`,
      resourceName: t.assignedResourceID ? await resolveResourceName(client, t.assignedResourceID) : 'Unassigned',
      createDate: t.createDate || null,
      dueDateTime: t.dueDateTime || null, // same real field @dashboard/workshop's own "Ticket Due Date" column already uses; only used by Deadlines below
    });
  }
  rows.sort((a, b) => (a.ticketNumber || '').localeCompare(b.ticketNumber || ''));
  return rows;
}
// ---- Deadlines -- company-wide, NOT resource-filtered. Same real
// selection criteria as the Tickets Dashboard's own Critical (P1) widget
// (open tickets, no completedDate, priority = P1-CRITICAL, excluding
// monitoring alerts), by request ("Use the selection criteria for the
// first Critical (P1) widget on the Tickets Dashboard page"), further
// narrowed to just the ones that have already hit or passed their own
// real Tickets.dueDateTime (by request, "Due Today or earlier") -- same
// real field @dashboard/workshop's own "Ticket Due Date" column already
// uses. This is the only remaining consumer of fetchOpenTicketsByPriority()
// now that the Tickets Dashboard and Subscriptions Expiring cards
// themselves have been removed from this page, by request. ----
async function fetchDeadlinesSection(client) {
  const statusLabels = await getPicklistLabels(client.tickets, 'status');
  const critical = await fetchOpenTicketsByPriority(client, CRITICAL_PRIORITY_VALUE, statusLabels);
  const todayEndISO = aestDayBoundsIso(todayAestKey()).endISO; // exclusive end of today, AEST
  return critical.filter((t) => t.dueDateTime && t.dueDateTime < todayEndISO).sort((a, b) => a.dueDateTime.localeCompare(b.dueDateTime));
}

// ---- Strety Tasks -- this resource's own open todos. Uses the VIEWER's
// own personal Strety connection (getPersonalClient(viewerEmail)) but
// queries filter[assignee_id] for the SELECTED resource's own Strety
// person id -- confirmed real behavior (@dashboard/my-strety-tasks' own
// server.js comment): the assignee_id filter is honored correctly for
// ANY person regardless of which account is connected, as long as the
// connected account itself has adequate team/space visibility (a
// real person's own personal login does). Resolved by the selected
// resource's real Autotask email -- confirmed real fact (@dashboard/my-
// strety-tasks' README): every real Ambient iT person's Strety email
// matches their Microsoft 365/Autotask one exactly. ----
async function findStretyPersonByEmail(email, client) {
  const res = await client.get('/people', { 'filter[email]': email });
  return res.data[0] || null;
}
// A stored refresh token going stale/revoked (`err.strety_reauth_required`)
// is a real, periodically-occurring, PRE-EXISTING state -- confirmed live
// against Amber's own personal connection while building this (a real
// `400 invalid_grant`), same documented failure mode
// @dashboard/strety-client's own README describes and every other Strety-
// backed page already handles explicitly, not something new this section
// introduced. `strety_not_connected` is thrown, not just an isConnected()
// false, on the FIRST-EVER real API call for a token file that doesn't
// exist yet -- caught here too rather than relying solely on the
// isConnected() precheck above.
async function fetchStretyTasksSection(viewerEmail, resourceEmail) {
  if (!resourceEmail) return { status: 'no-resource-email' };
  const client = getPersonalClient(viewerEmail);
  if (!client.isConnected()) return { status: 'not-connected' };
  let person;
  let todos;
  try {
    person = await findStretyPersonByEmail(resourceEmail, client);
    if (!person) return { status: 'person-not-found' };
    todos = await client.fetchAllPages('/todos', {
      'filter[completed]': 'false',
      'filter[assignee_id]': person.id,
    });
  } catch (err) {
    if (err.strety_reauth_required) return { status: 'reauth-required' };
    if (err.strety_not_connected) return { status: 'not-connected' };
    throw err;
  }
  const rows = todos.map((t) => ({
    id: t.id,
    title: t.attributes.title,
    dueDate: t.attributes.due_date || null,
    priority: t.attributes.priority || null,
    description: t.attributes.description || null,
    // Deep link to open this to-do directly in Strety's own web app, same
    // real helper @dashboard/my-strety-tasks' own server.js already uses.
    todoUrl: getTodoUrl(t.id),
  }));
  rows.sort((a, b) => {
    if (a.dueDate === null && b.dueDate === null) return 0;
    if (a.dueDate === null) return 1;
    if (b.dueDate === null) return -1;
    return a.dueDate.localeCompare(b.dueDate);
  });
  // asOf -- same "as of TIME" timestamp @dashboard/my-strety-tasks' own
  // summary line already shows.
  return { status: 'ok', personName: person.attributes.name, asOf: new Date().toISOString(), tasks: rows };
}

// TimeEntries.timeEntryType picklist values that mean "this hour was
// leave, not work" -- same 4 real confirmed values @dashboard/times' own
// README documents (15 PersonalTime, 16 VacationTime, 17 SickTime, 18
// PaidTimeOff), duplicated here rather than imported, same "separate page
// package" convention every other small shared piece on this dashboard
// already follows. By request ("can you get Leave from Autotask and add
// it to the Shifts data and calendars where it appears").
const LEAVE_TIME_ENTRY_TYPES = [15, 16, 17, 18];
// Fallback label when a leave entry's own billingCodeID somehow fails to
// resolve to a real BillingCodes name (never seen against real data --
// every real leave entry confirmed carries one -- but a null/deleted
// billing code shouldn't render a blank pill).
const LEAVE_TYPE_FALLBACK_LABEL = { 15: 'Personal Time', 16: 'Vacation', 17: 'Sick Time', 18: 'Paid Time Off' };

// This resource's own real Leave time entries (no ticket/task, dateWorked
// in range) -- merged into the same Shifts list below so it renders as
// one combined timeline, same request. billingCodeID is resolved via the
// real BillingCodes entity, NOT getPicklistLabels(), same reason Accrued
// Time's own resolveBillingCodeNames() gives (billingCodeID is a record
// reference, not a small-int picklist). Confirmed against real data:
// this tenant's real leave billing codes are "Vacation", "Sick Time",
// and "Floating Holiday" -- the first two match the shared
// SHIFT_CATEGORIES legend's own vacation/sickOther regexes directly (no
// extra mapping needed); "Floating Holiday" doesn't literally say
// "public holiday" so it needed the rdoTil regex widened (see
// client.js's own SHIFT_CATEGORIES comment) rather than guessing it into
// the wrong bucket.
async function fetchLeaveEntries(client, resourceId, startISO, endISO) {
  const entries = await listAll(client.timeEntries, [
    { op: 'gte', field: 'dateWorked', value: startISO },
    { op: 'lt', field: 'dateWorked', value: endISO },
    { op: 'eq', field: 'resourceID', value: resourceId },
    { op: 'in', field: 'timeEntryType', value: LEAVE_TIME_ENTRY_TYPES },
    { op: 'notExist', field: 'ticketID' },
    { op: 'notExist', field: 'taskID' },
  ]);
  if (entries.length === 0) return [];
  const billingCodeIds = [...new Set(entries.map((e) => e.billingCodeID).filter((id) => id !== null && id !== undefined))];
  const billingCodes = billingCodeIds.length > 0 ? await fetchByFieldIn(client.billingCodes, 'id', billingCodeIds) : [];
  const nameById = new Map(billingCodes.map((c) => [c.id, c.name]));
  return entries.map((e) => ({
    dayKey: (e.dateWorked || '').slice(0, 10),
    kind: 'leave',
    displayName: nameById.get(e.billingCodeID) || LEAVE_TYPE_FALLBACK_LABEL[e.timeEntryType] || 'Leave',
    hoursWorked: e.hoursWorked,
    startDateTime: null,
    endDateTime: null,
  }));
}

// ---- Shifts Entries -- this resource's own, next 30 real AEST days (by
// request -- originally 7, widened to 30). Same real "General" team +
// combined shifts/timesOff data @dashboard/teams-shifts' own lib.js
// already resolves (see that package's README, "Shifts vs. time off").
// Matched by real display NAME (Graph's own resolved userName), not id --
// there's no shared identifier between an Autotask Resource and a
// Microsoft 365/Teams user, but real people's own display names line up
// between the two systems the same way Strety's own email-match
// convention already relies on for a different pair of systems.
//
// Real Autotask Leave (see fetchLeaveEntries() above) is merged into this
// same list -- by request, the whole point is one combined timeline
// rather than Leave living somewhere separate. Scoped by real resourceID,
// not name-matching, since Leave has no Teams-side name-matching problem
// to begin with (it's already an Autotask resourceID same as the rest of
// this page). ----
const SHIFTS_TEAM_NAME = 'General'; // same real team @dashboard/teams-shifts is locked to, by request
const SHIFTS_WINDOW_DAYS = 30;
async function fetchShiftsSection(client, resourceId, resourceName) {
  const teams = await getTeams();
  const team = teams.find((t) => t.name === SHIFTS_TEAM_NAME);
  const today = todayAestKey();
  const [ty, tm, td] = today.split('-').map(Number);
  const endKey = new Date(Date.UTC(ty, tm - 1, td + SHIFTS_WINDOW_DAYS)).toISOString().slice(0, 10);
  // Bare dateWorked-shaped ISO strings, NOT isoForKey()/aestToUtcIso() --
  // TimeEntries.dateWorked is a date-only field that needs no real AEST
  // offset conversion, same established convention this page's own
  // date-range sections above already follow (see the file's own README
  // note on this).
  const startISO = `${today}T00:00:00.000Z`;
  const endISO = `${endKey}T00:00:00.000Z`;

  const [shiftsResult, leaveRows] = await Promise.all([
    team ? getShiftsByDay(team.id, today, endKey) : Promise.resolve({ byDay: {} }),
    fetchLeaveEntries(client, resourceId, startISO, endISO),
  ]);

  const rows = [...leaveRows];
  for (const [dayKey, entries] of Object.entries(shiftsResult.byDay)) {
    for (const e of entries) {
      if ((e.userName || '').toLowerCase() !== resourceName.toLowerCase()) continue;
      rows.push({ dayKey, kind: e.kind, displayName: e.displayName, startDateTime: e.startDateTime, endDateTime: e.endDateTime });
    }
  }
  rows.sort((a, b) => {
    if (a.dayKey !== b.dayKey) return a.dayKey < b.dayKey ? -1 : 1;
    return new Date(a.startDateTime || 0) - new Date(b.startDateTime || 0);
  });
  return { status: team ? 'ok' : 'team-not-found-leave-only', entries: rows };
}

const router = express.Router();

router.get('/resources', async (req, res) => {
  try {
    const client = await getClient();
    const email = req.session?.user?.email;
    const [resources, { ownResourceId, isLeadership }] = await Promise.all([fetchPickerResources(client), resolveViewerAuthorization(client, email)]);
    const ownResourceInPool = resources.some((r) => r.id === ownResourceId);
    // Non-Leadership: locked to their own resource if it's in the SD/PS
    // pool, otherwise there's genuinely nothing of theirs to show (About
    // Me only covers those two teams) -- defaultResourceId comes back
    // null rather than silently falling back to showing someone ELSE's
    // page, which canSelectOthers: false is specifically there to prevent.
    const defaultResourceId = isLeadership ? (ownResourceInPool ? ownResourceId : resources[0]?.id || null) : ownResourceInPool ? ownResourceId : null;
    res.json({
      resources: resources.map((r) => ({ id: r.id, name: r.name })),
      defaultResourceId,
      canSelectOthers: isLeadership,
      ownResourceInPool,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

router.get('/', async (req, res) => {
  const resourceId = parseInt(req.query.resourceId, 10);
  if (!Number.isInteger(resourceId)) return res.status(400).json({ error: 'Query param "resourceId" is required.' });

  // Completed Tickets/Ticket Times/Asked for Review/Accrued Time's own
  // shared date range, by request ("Add date selectors and buttons to the
  // 'About Me' page matching what we have on the Time Summaries page").
  // Defaults to today (both ends), same default Times' own page uses, so
  // the page still auto-loads sensible data on first visit without
  // requiring the user to pick a range first -- same "auto-loads on
  // mount" convention every other part of this page already follows.
  // Service Calls/Deadlines/Strety Tasks/Shifts never read these two
  // params at all -- their own fetchers keep the fixed windows they
  // always had, by request ("The Service Calls, Deadlines, Strety Tasks
  // abd Shifts won't be affected by this").
  const today = todayAestKey();
  const fromKey = req.query.from || today;
  const toKey = req.query.to || today;
  if (!DATE_RE.test(fromKey)) return res.status(400).json({ error: 'Query param "from" must be in YYYY-MM-DD format.' });
  if (!DATE_RE.test(toKey)) return res.status(400).json({ error: 'Query param "to" must be in YYYY-MM-DD format.' });
  if (toKey < fromKey) return res.status(400).json({ error: '"to" must not be before "from".' });

  try {
    const client = await getClient();
    const viewerEmail = req.session?.user?.email;
    const resources = await fetchPickerResources(client);
    const resource = resources.find((r) => r.id === resourceId);
    if (!resource) return res.status(400).json({ error: 'That resource is not in Service Desk or Professional Services.' });

    // Server-side enforcement, not just a hidden/disabled dropdown client-
    // side -- picking someone OTHER than yourself requires Leadership Team
    // membership, by request. A manually-crafted resourceId in the query
    // string for anyone else gets rejected here regardless of what the
    // client sent.
    const { ownResourceId, isLeadership } = await resolveViewerAuthorization(client, viewerEmail);
    if (resourceId !== ownResourceId && !isLeadership) {
      return res.status(403).json({ error: 'Only Leadership Team members can view another resource’s page.' });
    }

    // Each section wrapped in its own try/catch -- one broken/slow section
    // (Strety not connected, a Graph hiccup, ...) never blanks out the
    // others, same "ok: true/false per column" resilience What's On's own
    // Today & Tomorrow already established.
    const settle = async (fn) => {
      try {
        return { ok: true, data: await fn() };
      } catch (err) {
        console.error(err);
        return { ok: false, error: err.message };
      }
    };

    const [serviceCalls, deadlines, completedTickets, ticketTimesToday, askedForReview, accruedTime, stretyTasks, shifts] = await Promise.all([
      settle(() => fetchServiceCallsSection(client, resourceId)),
      settle(() => fetchDeadlinesSection(client)),
      settle(() => fetchCompletedTicketsSection(client, resourceId, fromKey, toKey)),
      settle(() => fetchTicketTimesSection(client, resourceId, fromKey, toKey)),
      settle(() => fetchAskedForReviewSection(client, resourceId, fromKey, toKey)),
      settle(() => fetchAccruedTimeSection(client, resourceId, fromKey, toKey)),
      settle(() => fetchStretyTasksSection(viewerEmail, resource.email)),
      settle(() => fetchShiftsSection(client, resourceId, resource.name)),
    ]);

    res.json({
      resourceId,
      resourceName: resource.name,
      from: fromKey,
      to: toKey,
      serviceCalls,
      deadlines,
      completedTickets,
      ticketTimesToday,
      askedForReview,
      accruedTime,
      stretyTasks,
      shifts,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
