// "Clients missing a Primary Domain" section, by request -- organisations
// that have at least one domain in IT Glue's own native Domain Tracker but
// no "Primary Domain" Flexible Asset tag set yet (see
// @dashboard/itglue-client's own Primary Domain helpers, shared with
// @dashboard/live-reports' Mail Domain Protection DNS Check for exactly
// this same Flexible Asset Type/trait).
//
// Computed from two bulk fetches, never a per-organisation loop (~1,946
// organisations on this account, but only ever a few hundred with any
// domains on file, and only ever a handful already tagged) --
// fetchAllDomainsGroupedByOrg() groups every domain by its own org,
// getAllPrimaryDomainTaggedOrganizationIds() is the set of orgs to exclude.
const { getAllPrimaryDomainTaggedOrganizationIds } = require('@dashboard/itglue-client');
const { fetchAllDomainsGroupedByOrg, organizationUrlById } = require('./itglue-domains');

async function computeClientsMissingPrimaryDomain() {
  const [domains, taggedOrgIds] = await Promise.all([fetchAllDomainsGroupedByOrg(), getAllPrimaryDomainTaggedOrganizationIds()]);

  const byOrg = new Map();
  for (const d of domains) {
    if (taggedOrgIds.has(d.organizationId)) continue; // already tagged -- not a gap
    if (!byOrg.has(d.organizationId)) {
      byOrg.set(d.organizationId, { organizationId: d.organizationId, organizationName: d.organizationName, organizationUrl: organizationUrlById(d.organizationId), domains: [] });
    }
    byOrg.get(d.organizationId).domains.push({ id: d.id, name: d.name });
  }

  const rows = [...byOrg.values()];
  rows.sort((a, b) => (a.organizationName || '').localeCompare(b.organizationName || ''));
  for (const r of rows) r.domains.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}

module.exports = { computeClientsMissingPrimaryDomain };
