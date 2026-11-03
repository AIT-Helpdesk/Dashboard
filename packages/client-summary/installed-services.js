const { get: saasAlertsGet } = require('@dashboard/saasalerts-client');
const saasProtectionRouter = require('@dashboard/saas-protection/server.js');
const { hasDattoEdrCredentials, findLocationMatches } = require('./datto-edr.js');
const { hasAutoElevateCredentials, findCompanyMatch: findAutoElevateMatch } = require('./autoelevate.js');
const { hasHuntressCredentials, findOrganizationMatch: findHuntressMatch } = require('./huntress.js');
const { hasRewstCredentials, findCustomerMatch: findRewstMatch } = require('./rewst.js');

// Pulled out of Client Summary's own server.js (where this originally
// lived) so TC Elite Services -- which needs the SAME "which services are
// active" check for every TC Elite client at once, not just one -- doesn't
// have to duplicate six vendor-matching calls per company. See each
// vendor's own file (./datto-edr.js etc.) for the full confirmed-live
// methodology behind its own findX() match.

// SaaS Alerts' own /reports/customers list has no cache of its own
// (@dashboard/saasalerts-client is a thin pass-through) -- fine for
// Client Summary's original one-company-at-a-time usage, but now that
// TC Elite Services calls findSaasAlertsCustomerId() once per TC Elite
// client in a single page load, that would otherwise refetch the same
// whole-account customer list once per row. Short cache (5 min, same
// convention every other vendor-list cache on this dashboard uses) fixes
// that without risking a genuinely stale mapping for long.
const SAAS_ALERTS_CUSTOMERS_CACHE_TTL_MS = 5 * 60 * 1000;
let saasAlertsCustomersCache = null; // { customers, expiresAt }
let saasAlertsCustomersInFlight = null;

async function getSaasAlertsCustomers(force) {
  if (!force && saasAlertsCustomersCache && Date.now() < saasAlertsCustomersCache.expiresAt) return saasAlertsCustomersCache.customers;
  if (!saasAlertsCustomersInFlight) {
    saasAlertsCustomersInFlight = saasAlertsGet('/reports/customers')
      .then((customers) => {
        saasAlertsCustomersCache = { customers, expiresAt: Date.now() + SAAS_ALERTS_CUSTOMERS_CACHE_TTL_MS };
        return customers;
      })
      .finally(() => {
        saasAlertsCustomersInFlight = null;
      });
  }
  return saasAlertsCustomersInFlight;
}

// Matched by the SaaS Alerts customer's OWN id, resolved via its
// `mappedToPSA` entry for this exact Autotask company, rather than
// name-wildcard matching (which is what the standalone Security Alerts
// page has to fall back on, since it has no Autotask company to start
// from) -- an id match is exact where a name match could coincidentally
// collide. Also used by Client Summary's own Security Alerts section.
async function findSaasAlertsCustomerId(companyId, force) {
  const customers = await getSaasAlertsCustomers(force);
  const match = customers.find((c) => (c.mappedToPSA || []).some((m) => m.product === 'autotaskpsa' && m.mappedTo === String(companyId)));
  return match ? match.id : null;
}

// --- Installed Services --------------------------------------------------
// "Do we have X installed for this client" across a handful of other
// systems, by request -- shown right after Active Contracts on Client
// Summary, and across every row of TC Elite Services. Two sources today:
//   - SaaS Alerts: findSaasAlertsCustomerId() above -- an EXACT id match
//     via SaaS Alerts' own mappedToPSA entry, not a name guess.
//   - Datto SaaS Protection: @dashboard/saas-protection's own
//     findDomainMatch(), a NAME match (no PSA-style id mapping exists on
//     that side) -- "installed: false" below can mean either genuinely not
//     a SaaS Protection client, or a name that didn't line up well enough to
//     match confidently; this can't currently tell those two apart.
// Dark Web ID and INKY (Email Security) are left out for now -- by
// request -- neither has a live subscription API, only sparse manually-
// parsed report files for a handful of clients (see @dashboard/meeting-prep),
// which isn't a reliable "installed or not" signal for the whole client base.
//   - Datto EDR: ./datto-edr.js's own findLocationMatches() -- a NAME match
//     against Datto EDR's own Locations (its per-site/branch unit, synced
//     from Datto RMM), same reasoning as SaaS Protection's match. Shows
//     "not-configured" (not a false "No") until DATTO_EDR_API_KEY/
//     DATTO_EDR_URL are both set, same "quietly not there" convention
//     hasDattoCredentials() already uses for live Datto RMM elsewhere.
// AutoElevate / Huntress: ./autoelevate.js's own findCompanyMatch() and
// ./huntress.js's own findOrganizationMatch() -- real live APIs (CyberFOX's
// Partner API and Huntress's own REST API, both confirmed live against the
// real account), NOT sourced from @dashboard/tc-elite-rollout's own
// staff-maintained rollout data (that tracker is itself what's being
// verified against a real source, by explicit request -- reusing it here
// would be circular).
async function buildInstalledServices(company) {
  const [saasAlertsCustomerId, saasProtectionMatch, dattoEdrMatches, autoElevateMatch, huntressMatch, rewstMatch] = await Promise.all([
    findSaasAlertsCustomerId(company.id),
    saasProtectionRouter.findDomainMatch(company.companyName),
    hasDattoEdrCredentials() ? findLocationMatches(company.companyName) : Promise.resolve(null),
    hasAutoElevateCredentials() ? findAutoElevateMatch(company.companyName) : Promise.resolve(undefined),
    hasHuntressCredentials() ? findHuntressMatch(company.companyName) : Promise.resolve(undefined),
    hasRewstCredentials() ? findRewstMatch(company.companyName) : Promise.resolve(undefined),
  ]);
  // SaaS Protection's own billable-seat count needs a SECOND live call
  // (per-customer /seats, not the bulk /domains list findDomainMatch()
  // already used) -- only made when there's actually a match, by request
  // ("show the user count or billable seats rather than total seats" --
  // /domains' own seatsUsed lumps in SharePoint sites/Teams/shared
  // mailboxes alongside real licensed users; confirmed live on a real
  // account, 173 total seat rows there, only 52 actually billable).
  const billableSeatCount = saasProtectionMatch ? await saasProtectionRouter.getBillableSeatCount(saasProtectionMatch.customerId) : null;
  return {
    saasAlerts: { installed: saasAlertsCustomerId !== null },
    saasProtection: saasProtectionMatch
      ? { installed: true, billableSeatCount, backupPercentage: saasProtectionMatch.backupPercentage }
      : { installed: false },
    dattoEdr:
      dattoEdrMatches === null
        ? { status: 'not-configured' }
        : { status: 'ok', installed: dattoEdrMatches.length > 0, locationCount: dattoEdrMatches.length },
    autoElevate: autoElevateMatch === undefined ? { status: 'not-configured' } : { status: 'ok', installed: autoElevateMatch !== null },
    huntress:
      huntressMatch === undefined
        ? { status: 'not-configured' }
        : { status: 'ok', installed: huntressMatch !== null, agentsCount: huntressMatch ? huntressMatch.agents_count : null },
    // "installed" here only means "has a matching Rewst CSP customer
    // record" -- there's no per-organization connected-integrations list
    // available from the one Rewst workflow this reuses, see
    // ./rewst.js's own comment for why. rewstCompanyName (the matched
    // record's own company_name) is the best available detail for now.
    rewst:
      rewstMatch === undefined
        ? { status: 'not-configured' }
        : { status: 'ok', installed: rewstMatch !== null, rewstCompanyName: rewstMatch ? rewstMatch.company_name : null },
  };
}

// getSaasAlertsCustomers() is also exported (not just the two functions
// above) -- Live Reports reuses it directly for a NAME match against this
// same 5-min-cached list (it has no Autotask company/id to resolve from,
// only a Datto RMM site name -- see live-reports/server.js's own
// buildSaasAlertsSummary() comment), rather than re-fetching the same
// whole-account customer list a third way.
module.exports = { findSaasAlertsCustomerId, buildInstalledServices, getSaasAlertsCustomers };
