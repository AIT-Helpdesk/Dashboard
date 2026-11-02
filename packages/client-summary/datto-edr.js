const axios = require('axios');

// Datto EDR (built on the Infocyte platform) -- a wholly separate system
// from RocketCyber. The Datto EDR admin guide's own "RocketCyber - EDR
// integration" is a SEPARATE, optional connector FROM Datto EDR TO
// RocketCyber, not this account's own way in -- confirmed live: Ambient
// IT's real RocketCyber account has none of its real clients in it at all,
// only its own internal device, since Ambient IT doesn't actually use
// RocketCyber. This account authenticates straight against its own tenant
// host (DATTO_EDR_URL, e.g. https://ambien3377.ap.infocyte.com -- found in
// the Datto EDR portal's own address bar once signed in; there's no single
// fixed host the way RocketCyber has one) -- confirmed live: a RAW
// `Authorization: <token>` header, NOT `Bearer <token>` (that 500s). The
// token itself comes from Datto EDR's own Admin > Users & Tokens > API
// Tokens -- a different token than RocketCyber's own Provider Settings key.
const { DATTO_EDR_API_KEY: KEY, DATTO_EDR_URL: RAW_URL } = process.env;

function hasDattoEdrCredentials() {
  return Boolean((KEY || '').trim() && (RAW_URL || '').trim());
}

function baseUrl() {
  return (RAW_URL || '').replace(/\/+$/, '');
}

async function edrGet(path, params) {
  const res = await axios.get(`${baseUrl()}${path}`, {
    headers: { Authorization: KEY, Accept: 'application/json' },
    params,
  });
  return res.data;
}

// Every Location (Datto EDR's own per-site/branch unit, synced 1:1 from
// Datto RMM sites -- confirmed live, each one's `data.rmmUid` is a real
// Datto RMM site id) across the WHOLE tenant, regardless of which
// Organization it sits under (most real clients land in one shared
// "Default RMM Org" bucket rather than getting their own Organization --
// confirmed live, so Organizations aren't a usable per-client signal here,
// Locations are). Confirmed live this comes back as one flat, unpaginated
// array (418 real rows at last check, no `filter[limit]` needed to get all
// of them), same "small enough to just fetch whole" shape as Datto SaaS
// Protection's own /domains. Cached (20-min TTL, same convention as every
// other integration here).
const CACHE_TTL_MS = 20 * 60 * 1000;
let cache = null; // { locations, expiresAt }
let inFlight = null;

async function getLocations(force) {
  if (!force && cache && Date.now() < cache.expiresAt) return cache.locations;
  if (!inFlight) {
    inFlight = edrGet('/api/Locations')
      .then((locations) => {
        cache = { locations, expiresAt: Date.now() + CACHE_TTL_MS };
        return locations;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

// Same loose normalize-then-either-contains-the-other matching
// @dashboard/saas-protection's own findDomainMatch() uses (cross-vendor
// name mismatches are the norm, not the exception, on this dashboard) --
// but, unlike that one, NOT narrowed to "exactly one match required":
// confirmed live a single Autotask company can legitimately own many Datto
// EDR Locations (one row per branch/site -- e.g. Sleepy's has 34 real
// rows, one per store). Requiring uniqueness here would wrongly report
// every multi-site client as unmatched. "Installed" just means at least
// one real Location name lines up with this company's name, with the
// match count along for context.
function normalize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function findLocationMatches(companyName, force) {
  const locations = await getLocations(force);
  const normCompany = normalize(companyName);
  if (!normCompany) return [];
  return locations.filter((l) => {
    const normLocation = normalize(l.name);
    if (!normLocation) return false;
    return normLocation === normCompany || normLocation.includes(normCompany) || normCompany.includes(normLocation);
  });
}

module.exports = { hasDattoEdrCredentials, getLocations, findLocationMatches };
