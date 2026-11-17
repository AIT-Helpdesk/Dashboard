// Email Domain Protection -- live DNS checks (DMARC/SPF/DKIM) for the
// client's own primary domain, by request. A brand new, separate widget
// from the existing (manual-entry) Mail Domain Protection Monitoring card
// -- this one needs no admin input at all once a primary domain is known,
// just a real domain name to check.
//
// The primary domain is now resolved in this order, by request ("no longer
// using the Notes field to identify the Primary Domain... Use the Flexible
// Asset instead"):
//   1. The "Primary Domain" Flexible Asset type's own `primary-domain-tag`
//      trait (a Tag field pointing at one real record in IT Glue's native
//      Domains feature) -- confirmed live this type exists
//      (flexible_asset_types, name "Primary Domain"), though as of writing
//      only one organisation on the account actually has a record of it.
//   2. Falls back to "exactly 1 domain on file" (no ambiguity) if there's
//      no Flexible Asset record yet.
//   3. Otherwise unresolved; client.js's own picker UI (shown on the card
//      itself) lets the admin pick or type one for the CURRENT report, with
//      a "Set this Domain as Primary" checkbox that calls
//      `setPrimaryDomainForSite()` below to tag it properly in IT Glue
//      instead of just using it for this one report.
// The old Notes-field tier ("exactly one Notes field starting with
// 'Primary'") is gone -- Notes is no longer the source of truth for this.
//
// IT Glue's native Domains resource is READ-ONLY via their public API --
// confirmed live: GET /domains/{id} works, but PATCH to that same path, to
// /organizations/{id}/relationships/domains, and to the nested single-
// resource relationship path all 404 (empty body, not a validation error --
// the route itself doesn't exist for writes). Flexible Assets are a
// SEPARATE, writable IT Glue resource, though -- setPrimaryDomain() writes
// there, never to the native Domains resource itself. A brand-new,
// just-typed-in domain that doesn't exist as a Domains record yet still
// can't be tagged as Primary as a result (there's nothing with an id to
// tag) -- setPrimaryDomainForSite() below surfaces that plainly rather
// than silently doing nothing.
//
// The "Primary Domain" Flexible Asset helpers themselves (type lookup,
// per-org read, write) now live in @dashboard/itglue-client, shared with
// @dashboard/domain-itglue-gap's own "clients missing a Primary Domain"
// section -- both need to agree on exactly the same Flexible Asset
// Type/trait, so neither keeps its own copy any more.
const dns = require('dns').promises;
const { get, getPrimaryDomainForOrganization, setPrimaryDomain } = require('@dashboard/itglue-client');

// Resolves the organisation + the real Domains-record id for `domainName`
// (by name, case-insensitive), then tags it as Primary. `domainName` must
// already exist in IT Glue's own native Domain Tracker for this client --
// see this file's own header comment for why a brand-new typed-in domain
// can't be tagged yet.
async function setPrimaryDomainForSite(siteName, domainName) {
  const orgResult = await resolveOrganization(siteName);
  if (orgResult.status !== 'ok') {
    throw new Error(
      orgResult.status === 'ambiguous'
        ? "More than one IT Glue organization matches this client's name -- can't set a Primary Domain."
        : "Could not find this client's organization in IT Glue -- can't set a Primary Domain."
    );
  }
  const domains = await getDomains(orgResult.organization.id);
  const match = domains.find((d) => d.name.trim().toLowerCase() === domainName.trim().toLowerCase());
  if (!match) {
    throw new Error(`"${domainName}" isn't in IT Glue's own Domain Tracker for this client yet -- add it there first, then it can be tagged as Primary.`);
  }
  await setPrimaryDomain(orgResult.organization.id, match.id);
}

// Organizations are matched by NAME only (same "no stored id mapping,
// resolved fresh every time" convention this whole package already
// follows for Autotask company matches) -- IT Glue's own filter[name]
// does a partial/contains match, so more than one hit is treated the same
// "don't guess past an ambiguous match" way resolveSingleCompany()
// (Autotask) does elsewhere in this package, falling back to an exact
// (case-insensitive) name match among them before giving up.
async function resolveOrganization(siteName) {
  const res = await get('/organizations', { 'filter[name]': siteName, 'page[size]': 10 });
  const matches = res.data || [];
  if (matches.length === 0) return { status: 'not-found' };
  if (matches.length === 1) return { status: 'ok', organization: matches[0] };
  const exact = matches.find((o) => (o.attributes.name || '').toLowerCase() === siteName.toLowerCase());
  if (exact) return { status: 'ok', organization: exact };
  return { status: 'ambiguous', matches };
}

async function getDomains(orgId) {
  const res = await get(`/organizations/${orgId}/relationships/domains`, { 'page[size]': 200 });
  return (res.data || []).map((d) => ({ id: d.id, name: d.attributes.name, notes: d.attributes.notes || '' }));
}

// The only remaining IMPLICIT tier -- an org with exactly one domain on
// file needs no explicit Primary tag to be unambiguous. Anything else
// (0, or >1 with no Flexible Asset tag) is genuinely unresolved now that
// the Notes-field tier is gone.
function findPrimaryDomainFallback(domains) {
  return domains.length === 1 ? domains[0] : null;
}

// --- DNS checks -------------------------------------------------------------
// ENOTFOUND/ENODATA both mean "no such record" (confirmed Node's own dns
// module throws rather than returning an empty array for either) -- a
// real "not present" result, not an error state; any other DNS error
// (timeout, SERVFAIL, ...) is left to propagate so a genuine lookup
// failure doesn't silently read as "not protected".
function isNoRecordError(err) {
  return err.code === 'ENOTFOUND' || err.code === 'ENODATA';
}

async function checkDmarc(domain) {
  try {
    const records = await dns.resolveTxt(`_dmarc.${domain}`);
    const full = records.map((r) => r.join('')).find((r) => /v=dmarc1/i.test(r));
    if (!full) return { exists: false, policy: null };
    const match = full.match(/p=(\w+)/i);
    return { exists: true, policy: match ? match[1].toLowerCase() : null };
  } catch (err) {
    if (isNoRecordError(err)) return { exists: false, policy: null };
    throw err;
  }
}

// SPF lives at the domain apex itself (not a subdomain). "Valid" means a
// real mail-provider include, by request ("check for Microsoft or Google
// entries and tag appropriately") -- Microsoft 365's own
// (protection.outlook.com, e.g. "include:spf.protection.outlook.com"),
// Google Workspace's own (_spf.google.com, e.g.
// "include:_spf.google.com"), or EasyDMARC's own SPF-flattening include
// for a client managed through them (*.easydmarc.pro, e.g.
// "include:_spf.pacgold_com_au._d.easydmarc.pro") -- not just "an SPF
// record exists at all" on its own. `provider` ('microsoft'/'google'/
// 'easydmarc'/null) is what client.js/pdf-template.js tag the SPF row
// with; Microsoft takes priority over Google when (unusually) a domain's
// SPF includes both, since this dashboard's own M365 integrations are the
// more likely real source of truth for a client running both.
async function checkSpf(domain) {
  try {
    const records = await dns.resolveTxt(domain);
    const text = records
      .map((r) => r.join(''))
      .join(' ')
      .toLowerCase();
    // `easydmarc` broken out as its own flag -- server.js's own Mail
    // Domain Protection Monitoring "implemented" check (the Cybersecurity
    // Services panel's tick, by request) cares specifically about the
    // EasyDMARC-managed case, not SPF passing in general.
    const easydmarc = text.includes('easydmarc.pro');
    const microsoft = text.includes('protection.outlook.com');
    const google = text.includes('_spf.google.com');
    const provider = microsoft ? 'microsoft' : google ? 'google' : easydmarc ? 'easydmarc' : null;
    return { exists: !!provider, easydmarc, provider };
  } catch (err) {
    if (isNoRecordError(err)) return { exists: false, easydmarc: false, provider: null };
    throw err;
  }
}

async function cnameExists(fqdn) {
  try {
    await dns.resolveCname(fqdn);
    return true;
  } catch (err) {
    if (isNoRecordError(err)) return false;
    throw err;
  }
}

async function txtRecordExists(fqdn) {
  try {
    const records = await dns.resolveTxt(fqdn);
    return records.length > 0;
  } catch (err) {
    if (isNoRecordError(err)) return false;
    throw err;
  }
}

// Microsoft 365's own DKIM CNAMEs (both selectors required) OR Google
// Workspace's own single DKIM TXT record (google._domainkey, Google's
// default selector), by request ("check for Microsoft or Google entries
// and tag appropriately") -- `provider` drives the row label the same way
// checkSpf()'s own does.
async function checkDkim(domain) {
  const [selector1, selector2, google] = await Promise.all([
    cnameExists(`selector1._domainkey.${domain}`),
    cnameExists(`selector2._domainkey.${domain}`),
    txtRecordExists(`google._domainkey.${domain}`),
  ]);
  const microsoft = selector1 && selector2;
  const provider = microsoft ? 'microsoft' : google ? 'google' : null;
  return { exists: !!provider, selector1, selector2, google, provider };
}

async function runDnsChecks(domain) {
  const [dmarc, spf, dkim] = await Promise.all([checkDmarc(domain), checkSpf(domain), checkDkim(domain)]);
  return { domain, dmarc, spf, dkim };
}

// --- Public status -----------------------------------------------------

async function getStatus(siteName) {
  const orgResult = await resolveOrganization(siteName);
  if (orgResult.status !== 'ok') return { status: orgResult.status === 'ambiguous' ? 'org-ambiguous' : 'org-not-found' };
  const organizationId = orgResult.organization.id;
  const domains = await getDomains(organizationId);
  const flexAssetPrimary = await getPrimaryDomainForOrganization(organizationId);
  const primary = flexAssetPrimary || findPrimaryDomainFallback(domains);
  if (!primary) return { status: 'needs-domain', organizationId, domains };
  const checks = await runDnsChecks(primary.name);
  // `primarySource` tells client.js whether this is an EXPLICIT, already-
  // authoritative Flexible Asset tag (no need to offer an override picker
  // at all, by request -- "if a primary domain is found we don't need this
  // part") or just the IMPLICIT single-domain fallback (no Flexible Asset
  // set yet, so the override picker + "Set this Domain as Primary"
  // checkbox still make sense, to let an admin promote it properly).
  return { status: 'ok', organizationId, domainId: primary.id, domains, primarySource: flexAssetPrimary ? 'flexible-asset' : 'single-domain', ...checks };
}

module.exports = { getStatus, runDnsChecks, setPrimaryDomainForSite };
