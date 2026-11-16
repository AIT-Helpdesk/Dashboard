const itglue = require('@dashboard/itglue-client');

// The web UI base URL -- a separate host from ITGLUE_API_BASE (the API
// host). Confirmed live: an organization's own page is simply this base +
// "/" + its numeric id, no "/organizations/" segment and no separate
// account-id segment (checked against a real org's own address-bar URL).
const WEB_BASE_URL = process.env.ITGLUE_WEB_BASE_URL;

// IT Glue's own flat Domains resource DOES return across every organisation
// on the account -- confirmed live this session (556 domains, 186 pages at
// page[size]=3; the whole account actually fits in ONE request at
// page[size]=1000, IT Glue's own documented max page size). No per-
// organisation looping needed, unlike @dashboard/live-reports/email-domain-
// protection.js's getDomains(orgId), which is scoped to one org at a time for
// a different purpose (resolving ONE client's own domain, not a full-account
// gap scan). Only `attributes.name` is needed here -- this job labels a gap
// with the Autotask Client name already resolved via the Name:TPP UDF, not
// whichever IT Glue org a domain happens to sit under, so organisation
// attribution from IT Glue's own side is never read.
const PAGE_SIZE = 1000;

async function fetchAllItGlueDomainNames() {
  const names = [];
  let page = 1;
  for (;;) {
    const res = await itglue.get('/domains', { 'page[size]': PAGE_SIZE, 'page[number]': page });
    for (const d of res.data || []) {
      if (d.attributes?.name) names.push(d.attributes.name);
    }
    const nextPage = res.meta?.['next-page'];
    if (!nextPage) break;
    page = nextPage;
  }
  return names;
}

// Same "lower-case, trim, strip a trailing dot" normalisation the brief
// specified for the domain-name comparison -- IT Glue's own names are
// already plain lower-case in real data (confirmed live, e.g.
// "ambientit.au"), but TPP's are not guaranteed to be, so both sides go
// through this before comparing.
function normalizeDomainName(name) {
  return (name || '').trim().toLowerCase().replace(/\.$/, '');
}

// Builds a Map<normalised organisation name, IT Glue org page URL>, one bulk
// fetch (paginated, max page size) rather than one `filter[name]` call per
// resolved gap -- there are ~1,946 organisations on this account but only
// ever a few dozen distinct Autotask Client names among a run's gaps, so
// fetching everything once is cheaper than looking each one up individually.
// IT Glue's API has no "resource-url" on organisations (confirmed live --
// unlike passwords, see @dashboard/find-passwords), so the URL is built from
// ITGLUE_WEB_BASE_URL + "/" + the org's own id.
//
// Exact (case-insensitive, trimmed) name match only -- same "never guess
// past an ambiguous/absent match" convention this job already follows
// elsewhere (Phase 0's own account/picklist resolution); a name that isn't
// an exact match just gets no link rather than a possibly-wrong one.
async function fetchOrganizationUrlsByName() {
  const map = new Map();
  if (!WEB_BASE_URL) return map;
  let page = 1;
  for (;;) {
    const res = await itglue.get('/organizations', { 'page[size]': PAGE_SIZE, 'page[number]': page });
    for (const o of res.data || []) {
      const name = o.attributes?.name;
      if (name) map.set(name.trim().toLowerCase(), `${WEB_BASE_URL}/${o.id}`);
    }
    const nextPage = res.meta?.['next-page'];
    if (!nextPage) break;
    page = nextPage;
  }
  return map;
}

module.exports = { fetchAllItGlueDomainNames, normalizeDomainName, fetchOrganizationUrlsByName };
