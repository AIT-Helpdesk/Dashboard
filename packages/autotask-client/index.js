const { AutotaskClient } = require('autotask-node');
const axios = require('axios');

// Turns a search term into an Autotask filter op + value. The dashboard-wide
// wildcard convention: '*' anchors the match: 'Email*' -> beginsWith, '*Email'
// -> endsWith, '*Email*' (or no stars at all) -> contains.
function parseWildcard(term) {
  if (!term) return null;
  const startsWithStar = term.startsWith('*');
  const endsWithStar = term.endsWith('*');
  let value = term;
  if (startsWithStar) value = value.slice(1);
  if (endsWithStar) value = value.slice(0, -1);
  value = value.trim();
  if (!value) return null;
  if (startsWithStar && endsWithStar) return { op: 'contains', value };
  if (endsWithStar) return { op: 'beginsWith', value };
  if (startsWithStar) return { op: 'endsWith', value };
  return { op: 'contains', value };
}

// Local (JS-side) counterpart to parseWildcard()'s Autotask filter op, for
// matching a resolved value (e.g. a picklist label) that isn't itself queryable
// via the Autotask API filter -- e.g. Companies.classification is stored as an
// integer code, so "matches this wildcard" has to be evaluated against the
// resolved label in application code, not sent to Autotask as a filter.
function matchesWildcard(value, term) {
  const parsed = parseWildcard(term);
  if (!parsed) return true;
  const v = (value || '').toLowerCase();
  const needle = parsed.value.toLowerCase();
  if (parsed.op === 'beginsWith') return v.startsWith(needle);
  if (parsed.op === 'endsWith') return v.endsWith(needle);
  return v.includes(needle);
}

let clientPromise = null;
function getClient() {
  if (!clientPromise) {
    clientPromise = AutotaskClient.create(
      {
        username: process.env.AUTOTASK_USERNAME,
        secret: process.env.AUTOTASK_SECRET,
        integrationCode: process.env.AUTOTASK_INTEGRATION_CODE,
      },
      // Autotask's API does not handle gzip-encoded POST bodies well; the SDK's
      // compression option gzips request bodies, which breaks POST /query calls.
      { enableCompression: false }
    );
  }
  return clientPromise;
}

// Autotask rate-limits to ~5 req/s by default; firing a large Promise.all burst of
// lookups causes silent failures under load, so resolution is capped at low concurrency.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const resourceNameCache = new Map();
async function resolveResourceName(client, id) {
  if (!id) return null;
  if (resourceNameCache.has(id)) return resourceNameCache.get(id);
  try {
    const res = await client.resources.get(id);
    const r = res.data || {};
    const name = [r.firstName, r.lastName].filter(Boolean).join(' ').trim() || `Resource #${id}`;
    resourceNameCache.set(id, name);
    return name;
  } catch (err) {
    console.error(`Failed to resolve resource ${id}:`, err.message);
    const fallback = `Resource #${id}`;
    resourceNameCache.set(id, fallback);
    return fallback;
  }
}

const companyNameCache = new Map();
async function resolveCompanyName(client, id) {
  if (id === null || id === undefined) return 'Unknown';
  if (companyNameCache.has(id)) return companyNameCache.get(id);
  try {
    const res = await client.companies.get(id);
    const name = res.data?.companyName || `Company #${id}`;
    companyNameCache.set(id, name);
    return name;
  } catch (err) {
    console.error(`Failed to resolve company ${id}:`, err.message);
    const fallback = id === 0 ? 'Ambient IT (internal)' : `Company #${id}`;
    companyNameCache.set(id, fallback);
    return fallback;
  }
}

// Autotask's REST API paginates POST /query results via a `pageDetails.nextPageUrl`
// cursor in the response body -- NOT via a `page` number in the request, despite the
// SDK's `.list()` wrapper accepting a `page` option (it silently ignores it and
// re-returns page 1 every time, and also strips `pageDetails` from its return value).
// This talks to the entity's underlying axios instance directly to do real pagination.
// `entity.axios` / `entity.endpoint` are TypeScript "protected" but plain runtime
// properties, so they're reachable from JS.
async function listAll(entity, filter) {
  const all = [];
  const body = { filter, MaxRecords: 500 };
  let response = await entity.axios.post(`${entity.endpoint}/query`, body);
  all.push(...(response.data?.items || []));
  let nextUrl = response.data?.pageDetails?.nextPageUrl || null;
  // Safety cap in case Autotask ever returns a cursor that doesn't terminate.
  for (let i = 0; i < 100 && nextUrl; i++) {
    response = await entity.axios.post(nextUrl, body);
    all.push(...(response.data?.items || []));
    nextUrl = response.data?.pageDetails?.nextPageUrl || null;
  }
  return all;
}

// Autotask's `in` filter caps how many values a single request can carry, so any
// lookup scoped to a large ID/value set (company IDs, contract IDs, etc.) has to
// page across multiple requests. Shared here since Contract Services, Client
// Details, and Client Contacts all do this exact chunked "in" fetch.
const IN_FILTER_CHUNK = 450;
async function fetchByFieldIn(entity, field, values, extraFilter = []) {
  const all = [];
  for (let i = 0; i < values.length; i += IN_FILTER_CHUNK) {
    const chunk = values.slice(i, i + IN_FILTER_CHUNK);
    const part = await listAll(entity, [{ op: 'in', field, value: chunk }, ...extraFilter]);
    all.push(...part);
  }
  return all;
}

// Resolves a client-name wildcard to exactly one Company -- shared by any
// single-client report page (Client Financials, Client Activity). Mixing
// several companies' data into one single-client report would misstate every
// number, so more than one match is reported back rather than silently picked
// or merged. `companyId`, when given, bypasses the wildcard entirely and
// resolves that exact company directly -- used when the caller already picked
// one off an earlier `ambiguous` match list.
async function resolveSingleCompany(client, clientSearch, companyId) {
  if (companyId) {
    const res = await client.companies.get(companyId);
    if (!res.data) return { status: 'not-found' };
    return { status: 'ok', company: res.data };
  }
  const wildcard = parseWildcard(clientSearch);
  const matchFilter = wildcard
    ? [{ op: wildcard.op, field: 'companyName', value: wildcard.value }]
    : [{ op: 'eq', field: 'companyName', value: clientSearch }];
  const matches = await listAll(client.companies, matchFilter);
  if (matches.length === 0) return { status: 'not-found' };
  if (matches.length > 1) {
    return {
      status: 'ambiguous',
      matches: matches.map((c) => ({ id: c.id, companyName: c.companyName })).sort((a, b) => a.companyName.localeCompare(b.companyName)),
    };
  }
  return { status: 'ok', company: matches[0] };
}

// Ambient iT operates out of Queensland, which does NOT observe daylight
// saving time -- AEST (UTC+10) year-round, never AEDT. That makes a fixed
// 10-hour offset correct and safe here, unlike most of the rest of
// Australia (NSW, VIC, etc.), which would need real DST-aware timezone
// handling since their offset changes twice a year. Every "which calendar
// day/week/month does this fall in" computation across the dashboard is
// anchored to AEST via these helpers, not UTC and not the server's own
// local clock -- by request, so a ticket/invoice/contract-period near a day
// or month boundary lands on the day the business actually considers it to
// be, not whatever day UTC happens to be showing at that exact instant.
const AEST_OFFSET_MS = 10 * 60 * 60 * 1000;

// Shifts a real instant (a Date, or anything `new Date()` accepts) forward
// by the AEST offset, so that reading the result's UTC-labeled fields
// (getUTCFullYear(), getUTCMonth(), getUTCDate(), getUTCDay(), ...) gives
// AEST wall-clock values instead of UTC ones -- e.g. an instant that's
// genuinely 2am UTC on the 1st is 12pm AEST on the 1st; toAest(that)
// .getUTCHours() reads 12, not 2. This is the one primitive every other
// AEST helper below builds on.
function toAest(instant) {
  return new Date(new Date(instant).getTime() + AEST_OFFSET_MS);
}

// The real UTC instant that a given AEST wall-clock moment represents --
// e.g. aestToUtcIso(2026, 8, 1) (AEST midnight, August 1st) is
// "2026-07-31T14:00:00.000Z". This is what actually gets sent to Autotask's
// API as a gte/lt date-field boundary: Autotask's date fields are real
// instants, so a boundary meant to mean "AEST midnight" has to be the UTC
// instant AEST midnight actually falls at, not written as if AEST midnight
// and UTC midnight were the same moment (they're 10 hours apart). The
// (year, month, day) args accept overflow (day 32, month 13, ...) the same
// way `Date.UTC` does, so callers can just add days/months without their
// own rollover logic.
function aestToUtcIso(year, month, day, hour = 0, minute = 0, second = 0, ms = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms) - AEST_OFFSET_MS).toISOString();
}

// [startISO, endISO) UTC bounds for one AEST calendar day ("YYYY-MM-DD") --
// the shared version of what Completed Tickets, Tickets Created, and Asked
// for Review each used to compute independently (and incorrectly, against
// UTC midnight instead of AEST midnight).
function aestDayBoundsIso(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return { startISO: aestToUtcIso(y, m, d), endISO: aestToUtcIso(y, m, d + 1) };
}

// AEST "YYYY-MM-DD" for right now -- e.g. a date-picker's default value.
function todayAestKey() {
  const d = toAest(new Date());
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// Last 12 calendar months (as "YYYY-MM" keys, oldest first), ending with the
// current (partial) month -- shared moving-window shape for any page reporting
// a rolling year (Client Financials, Client Activity). Recomputed from the
// current date on every call, so it stays correct as time passes. Anchored
// to AEST "now", not UTC "now" -- otherwise the window's own idea of
// "the current month" flips a day early/late for roughly the first/last 10
// hours of any given AEST day, most consequentially right at a month
// boundary (e.g. still showing July as "current" for the first 10 hours of
// August AEST, because UTC hadn't reached August yet).
function last12MonthKeys() {
  const now = toAest(new Date());
  const keys = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    keys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return keys;
}
// Buckets a real timestamp (e.g. an invoice's invoiceDateTime) into the
// AEST month it actually falls in, not the UTC month -- otherwise a real
// AEST-morning event within ~10 hours of midnight gets bucketed into the
// wrong (previous) month whenever UTC hasn't rolled over yet.
function monthKeyOf(dateStr) {
  const d = toAest(dateStr);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function monthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'Australia/Brisbane' });
}
// [windowStart, windowEnd) UTC-instant bounds covering a set of "YYYY-MM"
// AEST month keys (assumed contiguous, oldest first) -- windowEnd is AEST
// midnight on the 1st of the month AFTER the last key, so the range is a
// clean half-open interval for `gte`/`lt` date filters, expressed as the
// real UTC instants those AEST month boundaries fall at.
function monthKeysWindow(monthKeys) {
  const [y0, m0] = monthKeys[0].split('-').map(Number);
  const windowStart = aestToUtcIso(y0, m0, 1);
  const [y, m] = monthKeys[monthKeys.length - 1].split('-').map(Number);
  const windowEnd = aestToUtcIso(y, m + 1, 1);
  return { windowStart, windowEnd };
}

// Picklist fields (e.g. Companies.classification) store an integer code, not the
// label shown in Autotask's UI -- this resolves the code -> label map via the
// entity's own field metadata endpoint. Cached per entity+field since picklist
// definitions are effectively static configuration, not per-record data.
const picklistLabelCache = new Map(); // `${endpoint}:${fieldName}` -> Map(code -> label)
async function getPicklistLabels(entity, fieldName) {
  const cacheKey = `${entity.endpoint}:${fieldName}`;
  if (picklistLabelCache.has(cacheKey)) return picklistLabelCache.get(cacheKey);
  const res = await entity.axios.get(`${entity.endpoint}/entityInformation/fields`);
  const field = (res.data?.fields || []).find((f) => f.name === fieldName);
  const labels = new Map();
  for (const pv of field?.picklistValues || []) {
    labels.set(Number(pv.value), pv.label);
  }
  picklistLabelCache.set(cacheKey, labels);
  return labels;
}

// Resolves a BillingCode's internal ID from its exact `name` (what Autotask's UI
// labels "Material Code" on a Charge / BillingItem line) -- cached per name since
// billing codes are effectively static configuration, not per-record data. Returns
// null if no billing code with that exact name exists, so callers can fail open
// (treat nothing as matching) rather than throw.
const billingCodeIdCache = new Map(); // name -> id | null
async function getBillingCodeIdByName(client, name) {
  if (billingCodeIdCache.has(name)) return billingCodeIdCache.get(name);
  const matches = await listAll(client.billingCodes, [{ op: 'eq', field: 'name', value: name }]);
  const id = matches.length > 0 ? matches[0].id : null;
  billingCodeIdCache.set(name, id);
  return id;
}

// Reads one User Defined Field's value off a Ticket (or any entity) by its
// Autotask UDF label -- the API includes `userDefinedFields` as an array of
// `{name, value}` pairs on every ticket by default, no extra request needed.
// Returns null when the UDF has never been set (present with value: null) or
// is absent entirely (older records created before the UDF existed). Shared
// by any page that reads a specific UDF (Completed Tickets' "Review?" column,
// Asked for Review) so the lookup logic doesn't drift between them.
function getTicketUdf(ticket, udfName) {
  const udf = (ticket.userDefinedFields || []).find((f) => f.name === udfName);
  return udf ? udf.value : null;
}

// The zoneInformation endpoint (unauthenticated besides the username query param)
// returns the web portal's base URL alongside the API URL -- fetched once and
// cached rather than hardcoded, so ticket links stay correct if the account's zone
// ever changes.
let webUrlPromise = null;
async function getWebUrl() {
  if (!webUrlPromise) {
    webUrlPromise = axios
      .get('https://webservices.autotask.net/ATServicesRest/V1.0/zoneInformation', {
        params: { user: process.env.AUTOTASK_USERNAME },
      })
      .then((res) => res.data.webUrl.replace(/\/$/, ''));
  }
  return webUrlPromise;
}

// Deep link to a ticket in the Autotask web UI. Takes the internal numeric ticket
// `id` (not the human-readable `ticketNumber` like "T20260730.0020").
async function getTicketUrl(ticketId) {
  if (!ticketId) return null;
  const webUrl = await getWebUrl();
  return `${webUrl}/Mvc/ServiceDesk/TicketDetail.mvc?workspace=False&ids%5B0%5D=${ticketId}&ticketId=${ticketId}`;
}

// Deep link to a contract's Summary page via Autotask's documented ExecuteCommand
// API (not the regular web UI routes, which are versioned/unstable) -- takes the
// internal numeric contract `id`.
async function getContractUrl(contractId) {
  if (!contractId) return null;
  const webUrl = await getWebUrl();
  return `${webUrl}/Autotask/AutotaskExtend/ExecuteCommand.aspx?Code=OpenContract&ContractID=${contractId}`;
}

// Deep link to a company's Detail page via Autotask's documented ExecuteCommand
// API. The command is named "OpenAccount" in Autotask's own docs -- "Account" is
// the database/API term for what the UI calls "Company" -- with parameter
// AccountID, not CompanyID.
async function getCompanyUrl(companyId) {
  if (!companyId) return null;
  const webUrl = await getWebUrl();
  return `${webUrl}/Autotask/AutotaskExtend/ExecuteCommand.aspx?Code=OpenAccount&AccountID=${companyId}`;
}

// Deep link to an invoice's viewer page. Unlike tickets/contracts/companies,
// there's no documented ExecuteCommand for invoices -- this route was confirmed
// directly against a real Autotask invoice URL rather than guessed.
async function getInvoiceUrl(invoiceId) {
  if (!invoiceId) return null;
  const webUrl = await getWebUrl();
  return `${webUrl}/Mvc/Contracts/InvoiceViewer.mvc?invoiceId=${invoiceId}`;
}

module.exports = {
  getClient,
  mapWithConcurrency,
  resolveResourceName,
  resolveCompanyName,
  listAll,
  getTicketUrl,
  getContractUrl,
  getCompanyUrl,
  getInvoiceUrl,
  getBillingCodeIdByName,
  getTicketUdf,
  parseWildcard,
  matchesWildcard,
  getPicklistLabels,
  fetchByFieldIn,
  resolveSingleCompany,
  last12MonthKeys,
  monthKeyOf,
  monthLabel,
  monthKeysWindow,
  toAest,
  aestToUtcIso,
  aestDayBoundsIso,
  todayAestKey,
};