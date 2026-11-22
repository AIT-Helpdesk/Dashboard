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
// gap scan).
const PAGE_SIZE = 1000;

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

// Every domain on the account, grouped by its own organisation -- one bulk
// `GET /domains` fetch, keeping `organization-id`/`organization-name` (both
// present on every domain's own attributes, confirmed live) rather than
// discarding them. Used by primary-domain-gaps.js (which organisations have
// domains on file at all) and by job.js's own computeGaps() (which
// organisation a given domain actually sits under, for the "wrong client in
// IT Glue" check -- see that file's own comment).
async function fetchAllDomainsGroupedByOrg() {
  const rows = [];
  let page = 1;
  for (;;) {
    const res = await itglue.get('/domains', { 'page[size]': PAGE_SIZE, 'page[number]': page });
    for (const d of res.data || []) {
      if (d.attributes?.name && d.attributes?.['organization-id']) {
        rows.push({
          id: d.id,
          name: d.attributes.name,
          organizationId: String(d.attributes['organization-id']),
          organizationName: d.attributes['organization-name'] || null,
        });
      }
    }
    const nextPage = res.meta?.['next-page'];
    if (!nextPage) break;
    page = nextPage;
  }
  return rows;
}

// Same org-page-URL convention fetchOrganizationUrlsByName() above already
// uses (ITGLUE_WEB_BASE_URL + "/" + the org's own id) but keyed by id, not
// name -- primary-domain-gaps.js already has each organisation's real id on
// hand (from the domains it just grouped), so no name-matching is needed
// here at all.
function organizationUrlById(organizationId) {
  return WEB_BASE_URL ? `${WEB_BASE_URL}/${organizationId}` : null;
}

module.exports = { normalizeDomainName, fetchOrganizationUrlsByName, fetchAllDomainsGroupedByOrg, organizationUrlById };
