const axios = require('axios');

// IT Glue's documentation/asset-management API -- a wholly separate system
// from Autotask, mirroring @dashboard/ingram-client/@dashboard/saasalerts-client's
// shape (thin get() wrapper, auth + base URL baked in once here).
//
// Region matters: IT Glue has separate regional API hosts (api.itglue.com,
// api.eu.itglue.com, api.au.itglue.com) -- confirmed against the real
// account this dashboard is for, which is api.au.itglue.com. Configurable
// via env rather than hardcoded, in case that ever needs to change.
const { ITGLUE_API_KEY: API_KEY, ITGLUE_API_BASE: BASE_URL } = process.env;

// Auth is a plain `x-api-key` header, not Bearer/Basic -- confirmed against
// the real API.
async function get(path, params) {
  const res = await axios.get(`${BASE_URL}${path}`, {
    headers: { 'x-api-key': API_KEY },
    params,
  });
  return res.data;
}

// Write support, by request (packages/live-reports' own Email Domain
// Protection card -- adding/marking a client's primary domain in IT
// Glue's native Domains feature). Standard JSON:API body shape (same
// {data: {type, attributes}} envelope every IT Glue resource uses) --
// content-type has to be the real vnd.api+json media type, not plain
// json, or the real API rejects the write.
async function patch(path, body) {
  const res = await axios.patch(`${BASE_URL}${path}`, body, {
    headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/vnd.api+json' },
  });
  return res.data;
}
async function post(path, body) {
  const res = await axios.post(`${BASE_URL}${path}`, body, {
    headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/vnd.api+json' },
  });
  return res.data;
}

// "Primary Domain" Flexible Asset helpers -- shared here (not left living
// in just one consumer package) because BOTH @dashboard/live-reports (Mail
// Domain Protection DNS Check's own primary-domain resolution + its own
// "Set this Domain as Primary" checkbox) and @dashboard/domain-itglue-gap
// (its own "clients missing a Primary Domain" section) need to agree on
// exactly the same Flexible Asset Type/trait, by request ("no longer using
// the Notes field... Use the Flexible Asset instead"). Confirmed live
// against this account: a Flexible Asset Type named "Primary Domain"
// exists, with one Tag-type trait field, `primary-domain-tag`, pointing at
// a real record in IT Glue's native Domains feature; the write shape here
// (traits keyed by the trait's own name, value = the tagged resource's
// plain id) is confirmed live too (tested against a real client, iCar).
const PRIMARY_DOMAIN_ASSET_TYPE_NAME = 'Primary Domain';
const PRIMARY_DOMAIN_TRAIT_NAME = 'primary-domain-tag';
let primaryDomainTypeIdCache = null;

// Resolved by name once and cached, same "no hardcoded id" convention
// every other picklist/UDF lookup on this dashboard already follows --
// fetches the full type list (24 total on this account) and matches
// client-side rather than trusting an unconfirmed `filter[name]` semantics
// on this endpoint.
async function getPrimaryDomainAssetTypeId() {
  if (primaryDomainTypeIdCache) return primaryDomainTypeIdCache;
  const res = await get('/flexible_asset_types', { 'page[size]': 1000 });
  const match = (res.data || []).find((t) => (t.attributes.name || '').trim().toLowerCase() === PRIMARY_DOMAIN_ASSET_TYPE_NAME.toLowerCase());
  primaryDomainTypeIdCache = match ? match.id : null; // null -- Type genuinely doesn't exist; treated as "nothing tagged yet", not a hard error.
  return primaryDomainTypeIdCache;
}

// Reads whichever domain (if any) this one organisation's own "Primary
// Domain" Flexible Asset record currently tags. A Tag-type trait reads
// back as `{type, values: [{id, name, ...}]}` (confirmed live) even though
// it's a single-value tag on this asset type -- only `values[0]` is used.
async function getPrimaryDomainForOrganization(organizationId) {
  const typeId = await getPrimaryDomainAssetTypeId();
  if (!typeId) return null;
  const res = await get('/flexible_assets', { 'filter[flexible-asset-type-id]': typeId, 'filter[organization-id]': organizationId, 'page[size]': 1 });
  const record = res.data?.[0];
  const tagged = record?.attributes?.traits?.[PRIMARY_DOMAIN_TRAIT_NAME]?.values?.[0];
  if (!tagged?.name) return null;
  return { id: String(tagged.id), name: tagged.name };
}

// Every organisation id that ALREADY has a Primary Domain tagged -- one
// bulk paginated fetch (there are only ever a handful of these records on
// the whole account so far) rather than one call per organisation, for
// @dashboard/domain-itglue-gap's own "clients missing a Primary Domain"
// section.
async function getAllPrimaryDomainTaggedOrganizationIds() {
  const typeId = await getPrimaryDomainAssetTypeId();
  const ids = new Set();
  if (!typeId) return ids;
  let page = 1;
  for (;;) {
    const res = await get('/flexible_assets', { 'filter[flexible-asset-type-id]': typeId, 'page[size]': 1000, 'page[number]': page });
    for (const record of res.data || []) {
      const tagged = record.attributes?.traits?.[PRIMARY_DOMAIN_TRAIT_NAME]?.values?.[0];
      if (tagged) ids.add(String(record.attributes['organization-id']));
    }
    const nextPage = res.meta?.['next-page'];
    if (!nextPage) break;
    page = nextPage;
  }
  return ids;
}

// Every organisation's own tagged Primary Domain NAME (not just whether
// one exists) -- same one bulk paginated fetch as
// getAllPrimaryDomainTaggedOrganizationIds() above, just keeping the
// actual tagged domain instead of discarding it. For
// @dashboard/domain-itglue-gap's own "Email Domain Mismatch" check, by
// request ("only do this match for nominated primary domains in IT
// Glue") -- that check only ever runs against the ONE domain an
// organisation has actually nominated as primary, not every domain it
// happens to own.
async function getAllPrimaryDomainsByOrganizationId() {
  const typeId = await getPrimaryDomainAssetTypeId();
  const map = new Map();
  if (!typeId) return map;
  let page = 1;
  for (;;) {
    const res = await get('/flexible_assets', { 'filter[flexible-asset-type-id]': typeId, 'page[size]': 1000, 'page[number]': page });
    for (const record of res.data || []) {
      const tagged = record.attributes?.traits?.[PRIMARY_DOMAIN_TRAIT_NAME]?.values?.[0];
      if (tagged?.name) map.set(String(record.attributes['organization-id']), tagged.name);
    }
    const nextPage = res.meta?.['next-page'];
    if (!nextPage) break;
    page = nextPage;
  }
  return map;
}

// Creates or updates this organisation's own "Primary Domain" Flexible
// Asset record to tag `domainId` -- one record per organisation (upsert,
// never a second one).
async function setPrimaryDomain(organizationId, domainId) {
  const typeId = await getPrimaryDomainAssetTypeId();
  if (!typeId) {
    throw new Error(`No Flexible Asset Type named "${PRIMARY_DOMAIN_ASSET_TYPE_NAME}" exists in IT Glue -- cannot tag a Primary Domain.`);
  }
  const existing = await get('/flexible_assets', { 'filter[flexible-asset-type-id]': typeId, 'filter[organization-id]': organizationId, 'page[size]': 1 });
  const record = existing.data?.[0];
  const traits = { [PRIMARY_DOMAIN_TRAIT_NAME]: domainId };
  if (record) {
    await patch(`/flexible_assets/${record.id}`, { data: { type: 'flexible-assets', attributes: { traits } } });
  } else {
    await post('/flexible_assets', { data: { type: 'flexible-assets', attributes: { 'organization-id': organizationId, 'flexible-asset-type-id': typeId, traits } } });
  }
}

module.exports = {
  get,
  patch,
  post,
  getPrimaryDomainAssetTypeId,
  getPrimaryDomainForOrganization,
  getAllPrimaryDomainTaggedOrganizationIds,
  getAllPrimaryDomainsByOrganizationId,
  setPrimaryDomain,
};
