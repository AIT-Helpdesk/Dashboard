// Email Domain Protection -- live DNS checks (DMARC/SPF/DKIM) for the
// client's own primary domain, by request. A brand new, separate widget
// from the existing (manual-entry) Mail Domain Protection Monitoring card
// -- this one needs no admin input at all once a primary domain is known,
// just a real domain name to check.
//
// The primary domain itself comes from IT Glue's native Domains feature
// (an organization's own built-in domain tracker, NOT a flexible asset --
// confirmed live this session that no flexible asset type named
// "Domain..." exists on this account; GET
// /organizations/{id}/relationships/domains is the real one, with `name`/
// `notes` fields). Resolution order, by request:
//   1 domain on file  -> that one, no ambiguity.
//   >1, exactly one Notes field starting with "Primary" -> that one.
//   0 domains, or >1 with none marked Primary -> unresolved; client.js's
//     own picker UI (shown on the card itself) lets the admin pick or type
//     one for the CURRENT report only, with an on-screen prompt to go fix
//     it for real in IT Glue -- see the big comment below for why.
//
// IT Glue's Domains resource is READ-ONLY via their public API -- confirmed
// live this session: GET /domains/{id} works, but PATCH to that same path,
// to /organizations/{id}/relationships/domains, and to the nested single-
// resource relationship path all 404 (empty body, not a validation error --
// the route itself doesn't exist for writes). There is no write-back
// function in this file any more as a result; marking/adding a domain as
// Primary has to happen by hand in IT Glue's own UI, which is exactly what
// client.js's own on-screen prompt (after a manual pick) tells the admin
// to go do.
const dns = require('dns').promises;
const { get } = require('@dashboard/itglue-client');

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

function findPrimaryDomain(domains) {
  if (domains.length === 1) return domains[0];
  if (domains.length === 0) return null;
  return domains.find((d) => d.notes.trim().toLowerCase().startsWith('primary')) || null;
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
  const domains = await getDomains(orgResult.organization.id);
  const primary = findPrimaryDomain(domains);
  if (!primary) return { status: 'needs-domain', organizationId: orgResult.organization.id, domains };
  const checks = await runDnsChecks(primary.name);
  return { status: 'ok', organizationId: orgResult.organization.id, domainId: primary.id, domains, ...checks };
}

module.exports = { getStatus, runDnsChecks };
