const { fetchAllDomains } = require('@dashboard/tpp-client');
const { getClient, listAll, fetchByFieldIn, getCompanyUdfValueToNameMap, getCompanyUrl, todayAestKey, getTicketUrl } = require('@dashboard/autotask-client');
const { normalizeDomainName, fetchOrganizationUrlsByName, fetchAllDomainsGroupedByOrg, organizationUrlById } = require('./itglue-domains');
const { getAllPrimaryDomainsByOrganizationId } = require('@dashboard/itglue-client');
const { resolveTicketPicklists } = require('./ticket-picklists');
const { buildGapCsv } = require('./csv');
const { logEvent, logFailure } = require('./log');
const { replaceCurrentGaps, getSummaryCounts } = require('./db');

// The ticket body's link must always point at the real production
// dashboard, by request -- never env-driven (APP_BASE_URL would read as
// "http://localhost:3000" for a manual run from a dev machine, landing a
// real ticket's link on a URL nobody else can open), so this is a plain
// hardcoded constant rather than process.env.APP_BASE_URL. The dashboard is
// a hash-routed SPA (same `/#<pageId>` convention packages/shell/server.js's
// own stretyConnectPage() already uses for its own self-link), so the
// gap-review page is simply `${DASHBOARD_BASE_URL}/#domain-itglue-gap`.
const DASHBOARD_BASE_URL = 'http://dashboard.ambientit.com.au';
const GAP_PAGE_URL = `${DASHBOARD_BASE_URL}/#domain-itglue-gap`;

const TICKET_TITLE = 'FIX Domains in IT Glue (Found in TPP Wholesale)';
// Autotask's own "home company" record for this account -- confirmed live
// this session (listAll with companyName "Ambient iT" resolved to the real
// record "Ambient IT", id 0 -- Autotask's own reserved id for the tenant's
// own company, not a bug).
const COMPANY_ID = 0;
const DUE_DATE_DAYS_AHEAD = 7;
// Same noteType/publish picks @dashboard/workshop/server.js's own
// TICKET_NOTE_TYPE/TICKET_NOTE_PUBLISH already use for a plain internal
// note+attachment on this tenant ("Task Notes" / "Internal & Co-Managed"),
// confirmed live against the real picklists -- reused here rather than a
// third one-off pick.
const NOTE_TYPE = 3;
const NOTE_PUBLISH = 4;
// 5 = Complete, 20 = Billing - Contract -- the repo's own existing open/
// closed convention (client-summary/server.js, strety-autotask-sync/metrics.js).
const CLOSED_STATUSES = [5, 20];

function daysBetween(fromDateStr, toDateStr) {
  const [fy, fm, fd] = fromDateStr.split('-').map(Number);
  const [ty, tm, td] = toDateStr.split('-').map(Number);
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / msPerDay);
}

// Pulls TPP, resolves each domain's accountReference to a real Autotask
// Client via the Name:TPP UDF (same mechanism @dashboard/coming-soon and
// @dashboard/data-matching already use for this exact UDF), and splits into
// `gaps` (Client resolved, domain not in IT Glue) and `unmatched` (no
// Name:TPP match at all for that accountReference -- a data-hygiene gap,
// not an IT-Glue one).
async function computeGaps() {
  const client = await getClient();

  let domains;
  try {
    domains = await fetchAllDomains();
    logEvent({ stage: 'tpp-pull', message: `Pulled ${domains.length} TPP domains.`, recordCount: domains.length });
  } catch (err) {
    logFailure('tpp-pull', err, { recordCount: 0, stopped: true });
    throw err;
  }

  let tppNameMap;
  try {
    tppNameMap = await getCompanyUdfValueToNameMap(client, 'Name:TPP');
  } catch (err) {
    logFailure('tpp-pull', err, { recordCount: 0, stopped: true, endpoint: 'Companies (Name:TPP UDF)' });
    throw err;
  }

  // An empty TPP/UDF response must never read as "everything is a gap" --
  // per the brief's own "stop and log... rather than treating missing data
  // as gaps" instruction. A genuinely empty account is implausible (this one
  // currently has 500+ domains), so treat it as a failed pull, not a real
  // zero.
  if (domains.length === 0) {
    const err = new Error('TPP returned zero domains -- treating as a failed pull, not a real empty account.');
    logFailure('tpp-pull', err, { recordCount: 0, stopped: true });
    throw err;
  }

  const today = todayAestKey();
  let skippedNotRequired = 0;
  const active = domains.filter((d) => {
    if (!d.expiryDate) return false;
    if (daysBetween(today, d.expiryDate) < 0) return false; // already expired
    if (d.category && d.category.trim().toLowerCase() === 'not required') {
      skippedNotRequired += 1;
      return false;
    }
    return true;
  });
  logEvent({ stage: 'tpp-pull', message: `${active.length} active domains after filtering (${skippedNotRequired} skipped as "Not Required").`, recordCount: active.length, skippedNotRequired });

  const matched = [];
  const unmatched = [];
  for (const d of active) {
    const autotaskClientName = d.accountReference ? tppNameMap.get(d.accountReference) || null : null;
    if (autotaskClientName) matched.push({ ...d, autotaskClientName });
    else unmatched.push(d);
  }

  // Grouped by organisation, not just a flat name set -- needed for the
  // "wrong Client in IT Glue" check below, not just "is this domain in IT
  // Glue at all".
  let itGlueDomains;
  try {
    itGlueDomains = await fetchAllDomainsGroupedByOrg();
    logEvent({ stage: 'itglue-pull', message: `Pulled ${itGlueDomains.length} IT Glue domains.`, recordCount: itGlueDomains.length });
  } catch (err) {
    logFailure('itglue-pull', err, { recordCount: 0, stopped: true });
    throw err;
  }

  if (itGlueDomains.length === 0) {
    const err = new Error('IT Glue returned zero domains -- treating as a failed pull, not a real empty account.');
    logFailure('itglue-pull', err, { recordCount: 0, stopped: true });
    throw err;
  }

  // First match wins for a domain that somehow sits under more than one
  // organisation -- not expected in real data, but this is a best-effort
  // check either way, not a guarantee.
  const itGlueOrgByDomain = new Map();
  for (const d of itGlueDomains) {
    const key = normalizeDomainName(d.name);
    if (!itGlueOrgByDomain.has(key)) itGlueOrgByDomain.set(key, { organizationId: d.organizationId, organizationName: d.organizationName });
  }

  // Three outcomes for a MATCHED domain (a real Name:TPP UDF resolved it to
  // an Autotask Client), by request ("If a domain appears on an IT Glue
  // Client but that Client is not the same client as the Autotask Client on
  // which the TPP Account appears in the UDF"):
  //   - not in IT Glue at all -> gapsBeforeOrgLink (the existing "Missing
  //     from IT Glue" check, unchanged)
  //   - in IT Glue, under an org whose name doesn't match (exact,
  //     case-insensitive, trimmed -- same "never guess past an exact match"
  //     convention fetchOrganizationUrlsByName() already uses) the resolved
  //     Client name -> wrongClientBeforeOrgLink, a NEW check
  //   - in IT Glue, under the right org -> not a gap at all, dropped here
  // A domain whose IT Glue organisation name is missing/blank is left out
  // of the wrong-client check entirely (nothing to compare against), not
  // flagged as wrong.
  const gapsBeforeOrgLink = [];
  const wrongClientBeforeOrgLink = [];
  for (const d of matched) {
    const orgInfo = itGlueOrgByDomain.get(normalizeDomainName(d.domainName));
    if (!orgInfo) {
      gapsBeforeOrgLink.push(d);
      continue;
    }
    const normalizedOrgName = (orgInfo.organizationName || '').trim().toLowerCase();
    const normalizedClientName = d.autotaskClientName.trim().toLowerCase();
    if (normalizedOrgName && normalizedOrgName !== normalizedClientName) {
      wrongClientBeforeOrgLink.push({ ...d, wrongOrgId: orgInfo.organizationId, wrongOrgName: orgInfo.organizationName });
    }
  }
  gapsBeforeOrgLink.sort((a, b) => a.expiryDate.localeCompare(b.expiryDate));
  wrongClientBeforeOrgLink.sort((a, b) => a.expiryDate.localeCompare(b.expiryDate));
  unmatched.sort((a, b) => a.expiryDate.localeCompare(b.expiryDate));

  // Email Domain Mismatch, by request ("List where Domain is different
  // from the domain of the Primary Contact's email address in
  // Autotask"), narrowed to ONLY a domain's own nominated IT Glue Primary
  // Domain (by request, "only do this match for nominated primary
  // domains in IT Glue") -- NOT every domain a Client happens to own.
  // Confirmed live this was the right call: checking every matched
  // domain produced 319 rows (mostly a Client's own legitimate extra
  // domains), almost all noise; this version only ever checks the ONE
  // domain IT Glue itself says is primary for that organisation.
  let primaryDomainNameByOrgId;
  try {
    primaryDomainNameByOrgId = await getAllPrimaryDomainsByOrganizationId();
    logEvent({ stage: 'itglue-pull', message: `${primaryDomainNameByOrgId.size} organisation(s) with a Primary Domain tagged.`, recordCount: primaryDomainNameByOrgId.size });
  } catch (err) {
    logFailure('itglue-pull', err, { endpoint: 'Flexible Assets (Primary Domain)' });
    primaryDomainNameByOrgId = new Map(); // non-fatal -- this check just finds nothing
  }
  const primaryDomains = matched.filter((d) => {
    const orgInfo = itGlueOrgByDomain.get(normalizeDomainName(d.domainName));
    if (!orgInfo) return false; // not in IT Glue at all -- can't be ITS nominated primary domain
    const primaryName = primaryDomainNameByOrgId.get(orgInfo.organizationId);
    return !!primaryName && normalizeDomainName(primaryName) === normalizeDomainName(d.domainName);
  });

  // Needs the Client's real companyID (tppNameMap only ever resolved to a
  // NAME, see getCompanyUdfValueToNameMap's own comment), so this is the
  // same real "scan every Company's Name:TPP UDF" query a second time,
  // just keeping `id` instead of `companyName`.
  let companyIdByAccountRef;
  try {
    companyIdByAccountRef = await buildTppAccountRefToCompanyIdMap(client);
  } catch (err) {
    logFailure('tpp-pull', err, { endpoint: 'Companies (Name:TPP UDF, for Primary Contact check)' });
    companyIdByAccountRef = new Map(); // non-fatal -- this check just finds nothing
  }
  const primaryDomainCompanyIds = [...new Set(primaryDomains.map((d) => companyIdByAccountRef.get(d.accountReference)).filter(Boolean))];
  let primaryContactEmailDomainByCompanyId = new Map();
  if (primaryDomainCompanyIds.length > 0) {
    try {
      // Same real Contacts.primaryContact flag/batched-fetch convention
      // @dashboard/client-details and @dashboard/client-summary already
      // use for this exact concept -- "the first one found wins" if more
      // than one contact somehow has the flag set (Autotask doesn't
      // enforce uniqueness), same as those pages.
      const primaryContacts = await fetchByFieldIn(client.contacts, 'companyID', primaryDomainCompanyIds, [{ op: 'eq', field: 'primaryContact', value: true }]);
      for (const c of primaryContacts) {
        if (primaryContactEmailDomainByCompanyId.has(c.companyID)) continue;
        const email = (c.emailAddress || '').trim();
        const emailDomain = email.includes('@') ? email.split('@').pop().trim().toLowerCase() : null;
        if (emailDomain) primaryContactEmailDomainByCompanyId.set(c.companyID, emailDomain);
      }
    } catch (err) {
      logFailure('autotask-search', err, { endpoint: 'Contacts (Primary Contact email check)' });
      primaryContactEmailDomainByCompanyId = new Map(); // non-fatal -- this check just finds nothing
    }
  }
  // Exact (normalized) comparison only -- same "never guess" convention
  // this job already follows elsewhere.
  const emailDomainMismatchBeforeOrgLink = [];
  for (const d of primaryDomains) {
    const companyId = companyIdByAccountRef.get(d.accountReference);
    const contactEmailDomain = companyId ? primaryContactEmailDomainByCompanyId.get(companyId) : null;
    if (!contactEmailDomain) continue; // no Primary Contact / no email -- nothing to compare
    if (normalizeDomainName(d.domainName) !== contactEmailDomain) {
      emailDomainMismatchBeforeOrgLink.push({ ...d, contactEmailDomain });
    }
  }
  emailDomainMismatchBeforeOrgLink.sort((a, b) => a.expiryDate.localeCompare(b.expiryDate));

  // Attaches a link to the resolved Client's own IT Glue organisation page,
  // by request -- a gap row's domain itself is never IN IT Glue (that's why
  // it's a gap), but its Client's organisation record usually is, so clicking
  // the Client name opens that instead of nothing. Reused for the
  // wrong-client rows' own "should be" link (the CORRECT client's org page,
  // for comparison against wrongOrgUrl, the domain's ACTUAL current org).
  let orgUrlByName;
  try {
    orgUrlByName = await fetchOrganizationUrlsByName();
  } catch (err) {
    logFailure('itglue-pull', err, { endpoint: 'Organizations (for Client links)' });
    orgUrlByName = new Map(); // non-fatal -- rows just render without a link
  }
  const gaps = gapsBeforeOrgLink.map((d) => ({ ...d, itGlueOrgUrl: orgUrlByName.get(d.autotaskClientName.trim().toLowerCase()) || null }));
  // wrongClient's own "Autotask Client UDF" column links to the real
  // Autotask Company record, by request ("The links in the 'Autotask
  // Client UDF' column should go to Autotask, not IT Glue") -- itGlueOrgUrl
  // is kept too (the Client's own IT Glue org, same as every other
  // section's "should be" link), just no longer what that one column uses.
  const wrongClient = await Promise.all(
    wrongClientBeforeOrgLink.map(async (d) => {
      const companyId = companyIdByAccountRef.get(d.accountReference);
      return {
        ...d,
        itGlueOrgUrl: orgUrlByName.get(d.autotaskClientName.trim().toLowerCase()) || null,
        wrongOrgUrl: organizationUrlById(d.wrongOrgId),
        autotaskClientUrl: companyId ? await getCompanyUrl(companyId) : null,
      };
    })
  );
  const emailDomainMismatch = emailDomainMismatchBeforeOrgLink.map((d) => ({
    ...d,
    itGlueOrgUrl: orgUrlByName.get(d.autotaskClientName.trim().toLowerCase()) || null,
  }));

  logEvent({
    stage: 'comparison',
    message: `${gaps.length} domains missing from IT Glue, ${unmatched.length} domains with no matching Autotask Client, ${wrongClient.length} domains filed under the wrong Client in IT Glue, ${emailDomainMismatch.length} domains different from their Primary Contact's email domain.`,
    gapCount: gaps.length,
    unmatchedCount: unmatched.length,
    wrongClientCount: wrongClient.length,
    emailDomainMismatchCount: emailDomainMismatch.length,
  });

  return { gaps, unmatched, wrongClient, emailDomainMismatch };
}

// Same real "scan every Company's own Name:TPP UDF" query
// getCompanyUdfValueToNameMap() already does (autotask-client/index.js),
// just keeping `c.id` instead of `c.companyName` -- that shared helper's
// own cached Map only ever resolves to a NAME, and the Primary Contact
// check above needs the real companyID to query Contacts with. Not
// cached (unlike the shared helper) -- this job only ever runs once per
// invocation (a weekly scheduled run, a manual run, or one live
// Refresh), never repeatedly within a single process the way that
// helper's own callers (coming-soon, data-matching, several per-page
// views) do.
async function buildTppAccountRefToCompanyIdMap(client) {
  const companies = await listAll(client.companies, [{ op: 'gte', field: 'id', value: 0 }]);
  const map = new Map();
  for (const c of companies) {
    const udf = (c.userDefinedFields || []).find((u) => u.name === 'Name:TPP');
    const value = udf?.value?.trim();
    if (!value) continue;
    for (const piece of value.split(';').map((v) => v.trim()).filter(Boolean)) {
      map.set(piece, c.id);
    }
  }
  return map;
}

// Short, by request -- the full 155-item list was about to exceed
// Autotask's own 8000-character ticket description limit (confirmed live),
// which would have silently hidden most of the "no matching client" list
// from anyone just reading the ticket. The full, currently-open, tickable
// list now lives on its own dashboard page (persisted in db.js) instead --
// this body is just the summary + counts + a link there, plus the
// attached CSV as an offline copy.
function buildTicketBody({ gaps, unmatched, wrongClient, emailDomainMismatch }, asOfIso) {
  const lines = [];
  lines.push(`Run date: ${asOfIso}`);
  lines.push(`Domains missing from IT Glue: ${gaps.length}`);
  lines.push(`Domains with no matching Autotask Client (Name:TPP UDF): ${unmatched.length}`);
  lines.push(`Domains filed under the wrong Client in IT Glue: ${wrongClient.length}`);
  lines.push(`Domains different from their Client's Primary Contact email domain: ${emailDomainMismatch.length}`);
  lines.push('');
  lines.push(`View, tick off, and work through the full list here: ${GAP_PAGE_URL}`);
  lines.push('');
  lines.push(
    'Add each domain to the correct organisation in IT Glue, then tag it on the client\'s Primary Domain asset where relevant. Move a wrongly-filed domain to its correct organisation. The Primary Contact email mismatch list only checks each Client\'s own nominated Primary Domain in IT Glue -- still worth a look, not necessarily wrong. A full CSV of all four lists is also attached to this ticket.'
  );
  return lines.join('\n');
}

// Short note naming just what's changed, not the full current state (that's
// buildTicketBody()'s job, used only by the scheduled/manual run() below) --
// by request: the dashboard's own live Refresh never creates a ticket and
// never overwrites it with a fresh full summary/CSV, it only ever adds a
// small note saying what's been fixed since the last stored state. Never
// speculates on WHY a domain dropped out (now in IT Glue? now matched?
// expired? reclassified "Not Required"?) -- just that it's no longer in
// this run's gap list, same "don't guess, let a person check" convention
// this job already follows elsewhere.
function buildFixedNoteBody(resolvedRows, asOfIso) {
  const lines = [`Live refresh ${asOfIso} -- ${resolvedRows.length} domain(s) no longer appear in the gap list:`, ''];
  for (const r of resolvedRows) {
    const label =
      r.category === 'missing_from_itglue'
        ? r.autotask_client_name || 'unknown client'
        : r.category === 'wrong_client'
          ? `was under "${r.wrong_itglue_org_name || 'unknown'}", should be ${r.autotask_client_name || 'unknown client'}`
          : r.category === 'email_domain_mismatch'
            ? `didn't match Primary Contact email domain "${r.contact_email_domain || 'unknown'}"`
            : 'no matching Autotask Client';
    lines.push(`- ${r.domain_name} (was: ${label})`);
  }
  lines.push('', `Full current list: ${GAP_PAGE_URL}`);
  return lines.join('\n');
}

// The dashboard page's own live Refresh action -- by request, this is
// DELIBERATELY narrower than run() below: it always does a real live pull
// (TPP, IT Glue, Autotask) and updates the dashboard's own db.js state, but
// it NEVER creates a new ticket and NEVER replaces the ticket's body with a
// fresh full summary/CSV -- that "whole new list" behaviour is reserved for
// the scheduled/manual job (run(), via run.js) alone. If an open ticket
// exists AND at least one domain dropped out of the list since the last
// stored state, it adds one small note naming just those fixed domains. If
// nothing changed, or there's no open ticket to update, no Autotask write
// happens at all -- only the dashboard's own db.js state changes.
async function refreshLive() {
  const client = await getClient();
  const { gaps, unmatched, wrongClient, emailDomainMismatch } = await computeGaps();
  const dbResult = replaceCurrentGaps(gaps, unmatched, wrongClient, emailDomainMismatch);
  logEvent({ stage: 'comparison', message: `Live refresh: ${dbResult.upserted} currently open, ${dbResult.resolved} resolved since last stored state.`, ...dbResult });

  if (dbResult.resolvedRows.length === 0) {
    return { gaps, unmatched, wrongClient, emailDomainMismatch, fixed: [], ticketNoteAdded: false };
  }

  let openTicket = null;
  try {
    const existing = await listAll(client.tickets, [
      { op: 'eq', field: 'title', value: TICKET_TITLE },
      { op: 'notIn', field: 'status', value: CLOSED_STATUSES },
    ]);
    openTicket = existing[0] || null;
  } catch (err) {
    logFailure('autotask-search', err, { endpoint: 'Tickets (live refresh fixed-note check)' });
    return { gaps, unmatched, wrongClient, emailDomainMismatch, fixed: dbResult.resolvedRows, ticketNoteAdded: false };
  }

  // No open ticket -- nothing to note. Deliberately never creates one here;
  // that's run()'s job alone, per request.
  if (!openTicket) {
    return { gaps, unmatched, wrongClient, emailDomainMismatch, fixed: dbResult.resolvedRows, ticketNoteAdded: false };
  }

  const asOfIso = new Date().toISOString();
  await client.ticketNotes.create(openTicket.id, { title: TICKET_TITLE, description: buildFixedNoteBody(dbResult.resolvedRows, asOfIso), noteType: NOTE_TYPE, publish: NOTE_PUBLISH });
  logEvent({ stage: 'ticket-update', message: `Live refresh: added a fixed-items note to ticket ${openTicket.ticketNumber} (${dbResult.resolvedRows.length} domain(s)).`, ticketNumber: openTicket.ticketNumber, fixedCount: dbResult.resolvedRows.length });

  return { gaps, unmatched, wrongClient, emailDomainMismatch, fixed: dbResult.resolvedRows, ticketNoteAdded: true, ticket: openTicket };
}

// Dry run computes everything for real (TPP, IT Glue, Autotask search) and
// returns what WOULD happen, without ever writing to Autotask.
async function run({ dryRun }) {
  const client = await getClient();
  const { gaps, unmatched, wrongClient, emailDomainMismatch } = await computeGaps();
  const asOfIso = new Date().toISOString();
  const body = buildTicketBody({ gaps, unmatched, wrongClient, emailDomainMismatch }, asOfIso);
  const csv = buildGapCsv(gaps, unmatched, wrongClient, emailDomainMismatch);

  // Persisted regardless of dry-run -- the dashboard page's own db.js is
  // this job's own local state, not an Autotask write, so it always
  // reflects the latest real computation (ticked state preserved for any
  // domain still present; rows for anything now resolved are dropped).
  const dbResult = replaceCurrentGaps(gaps, unmatched, wrongClient, emailDomainMismatch);
  logEvent({ stage: 'comparison', message: `Dashboard list updated: ${dbResult.upserted} currently open, ${dbResult.resolved} resolved since last run.`, ...dbResult });

  let existing;
  try {
    existing = await listAll(client.tickets, [
      { op: 'eq', field: 'title', value: TICKET_TITLE },
      { op: 'notIn', field: 'status', value: CLOSED_STATUSES },
    ]);
    logEvent({ stage: 'autotask-search', message: `${existing.length} open ticket(s) found with the exact title.`, recordCount: existing.length });
  } catch (err) {
    logFailure('autotask-search', err, { stopped: true });
    throw err;
  }

  const openTicket = existing[0] || null;

  if (gaps.length === 0 && unmatched.length === 0 && wrongClient.length === 0 && emailDomainMismatch.length === 0) {
    if (!openTicket) {
      logEvent({ stage: 'comparison', message: 'No gaps, no open ticket -- nothing to do.' });
      return { action: 'none', gaps, unmatched, wrongClient, emailDomainMismatch };
    }
    const resolveNote = 'All domains previously listed on this ticket are now resolved. Left open for a person to close.';
    if (dryRun) {
      logEvent({ stage: 'comparison', message: `DRY RUN: would add a resolved-note to ticket ${openTicket.ticketNumber} and leave it open.` });
      return { action: 'note-resolved', ticket: openTicket, note: resolveNote, gaps, unmatched, wrongClient, emailDomainMismatch };
    }
    await client.ticketNotes.create(openTicket.id, { title: TICKET_TITLE, description: resolveNote, noteType: NOTE_TYPE, publish: NOTE_PUBLISH });
    logEvent({ stage: 'ticket-update', message: `Added resolved-note to ticket ${openTicket.ticketNumber}.`, ticketNumber: openTicket.ticketNumber });
    return { action: 'note-resolved', ticket: openTicket, gaps, unmatched, wrongClient, emailDomainMismatch };
  }

  if (openTicket) {
    if (dryRun) {
      logEvent({ stage: 'comparison', message: `DRY RUN: would update ticket ${openTicket.ticketNumber} with a refreshed note + CSV.` });
      return { action: 'update', ticket: openTicket, body, csv, gaps, unmatched, wrongClient, emailDomainMismatch };
    }
    await client.ticketNotes.create(openTicket.id, { title: TICKET_TITLE, description: body, noteType: NOTE_TYPE, publish: NOTE_PUBLISH });
    logEvent({ stage: 'ticket-update', message: `Added refreshed note to ticket ${openTicket.ticketNumber}.`, ticketNumber: openTicket.ticketNumber });
    await attachCsv(client, openTicket.id, csv, asOfIso);
    return { action: 'update', ticket: openTicket, gaps, unmatched, wrongClient, emailDomainMismatch };
  }

  // No open ticket -- was there a RECENTLY CLOSED one with this exact title?
  // Quoted in the new ticket's own summary, by request, so a wrongly-closed
  // ticket is visible rather than silently starting a fresh history.
  let recentlyClosed = null;
  try {
    const closed = await listAll(client.tickets, [
      { op: 'eq', field: 'title', value: TICKET_TITLE },
      { op: 'in', field: 'status', value: CLOSED_STATUSES },
    ]);
    recentlyClosed = closed.sort((a, b) => (b.completedDate || '').localeCompare(a.completedDate || ''))[0] || null;
  } catch (err) {
    logFailure('autotask-search', err, { endpoint: 'Tickets (closed check)' });
    // Non-fatal -- proceed without the "earlier ticket" callout.
  }

  const picklists = await resolveTicketPicklists(client);
  const dueDateTime = new Date(Date.now() + DUE_DATE_DAYS_AHEAD * 24 * 60 * 60 * 1000).toISOString();
  const finalBody = recentlyClosed
    ? `NOTE: an earlier ticket with this exact title, ${recentlyClosed.ticketNumber}, was closed recently but gaps still remain -- check it wasn't closed in error.\n\n${body}`
    : body;

  if (dryRun) {
    logEvent({ stage: 'comparison', message: 'DRY RUN: would create a new ticket.' });
    return { action: 'create', body: finalBody, csv, picklists, dueDateTime, recentlyClosed, gaps, unmatched, wrongClient, emailDomainMismatch };
  }

  const createRes = await client.tickets.create({
    companyID: COMPANY_ID,
    title: TICKET_TITLE,
    description: finalBody.length > 8000 ? `${finalBody.slice(0, 7900)}\n\n[Truncated -- see attached CSV for the full list.]` : finalBody,
    queueID: picklists.queueID,
    priority: picklists.priority,
    ticketType: picklists.ticketType,
    status: picklists.status,
    dueDateTime,
  });
  const ticketId = createRes.data.itemId;
  const ticketUrl = await getTicketUrl(ticketId);
  logEvent({ stage: 'ticket-create', message: `Created ticket #${ticketId}.`, ticketId, ticketUrl });
  await attachCsv(client, ticketId, csv, asOfIso);
  return { action: 'create', ticketId, ticketUrl, gaps, unmatched, wrongClient, emailDomainMismatch };
}

// Same POST /Tickets/{id}/Attachments shape @dashboard/workshop/server.js
// already proved out live for this tenant (base64 `data`, FILE_ATTACHMENT).
async function attachCsv(client, ticketId, csv, asOfIso) {
  const dateStamp = asOfIso.slice(0, 10);
  try {
    await client.ticketAttachments.axios.post(`/Tickets/${ticketId}/Attachments`, {
      title: `Domain gaps ${dateStamp}`,
      fullPath: `domain-gaps-${dateStamp}.csv`,
      contentType: 'text/csv',
      data: Buffer.from(csv, 'utf8').toString('base64'),
      publish: NOTE_PUBLISH,
      attachmentType: 'FILE_ATTACHMENT',
    });
    logEvent({ stage: 'csv-attach', message: `Attached CSV to ticket #${ticketId}.`, ticketId });
  } catch (err) {
    logFailure('csv-attach', err, { ticketId });
    // Non-fatal -- the note/ticket body already has the full list; the CSV
    // is a convenience, not the only record.
  }
}

// The CURRENT open ticket's number + URL, for the dashboard page's own
// header (by request -- "put the Ticket Number (with link)" next to
// "Missing from IT Glue"). A live search, not read off last-run.json --
// that file's own `ticketNumber` is unreliable right after a fresh
// "create" (Autotask's create response only gives back the numeric
// ticketId, not the generated ticket NUMBER, so it's never actually
// captured there -- a real gap in run()'s own "create" branch, left as
// found rather than fixed here, since this function sidesteps it
// entirely by searching for the ticket itself instead of trusting what
// an earlier run recorded). Cached briefly (same reasoning
// server.js's own membership cache elsewhere on this dashboard gives) so
// a page load/refresh doesn't re-run this search needlessly.
const TICKET_INFO_CACHE_TTL_MS = 5 * 60 * 1000;
let ticketInfoCache = null; // { data, expiresAt }
async function findOpenTicketInfo() {
  if (ticketInfoCache && Date.now() < ticketInfoCache.expiresAt) return ticketInfoCache.data;
  const client = await getClient();
  const existing = await listAll(client.tickets, [
    { op: 'eq', field: 'title', value: TICKET_TITLE },
    { op: 'notIn', field: 'status', value: CLOSED_STATUSES },
  ]);
  const openTicket = existing[0] || null;
  const data = openTicket ? { ticketId: openTicket.id, ticketNumber: openTicket.ticketNumber, ticketUrl: await getTicketUrl(openTicket.id) } : null;
  ticketInfoCache = { data, expiresAt: Date.now() + TICKET_INFO_CACHE_TTL_MS };
  return data;
}

module.exports = { run, computeGaps, buildTicketBody, refreshLive, findOpenTicketInfo, TICKET_TITLE };
