const axios = require('axios');

// Rewst has no public REST/GraphQL API of its own for third parties to
// query its platform data (confirmed -- no official API reference exists;
// the only way data comes OUT of Rewst on this dashboard is via individual
// workflows Amber has built in Rewst Studio and published as webhooks, one
// REWST_WEBHOOK_<Name>_URL per workflow -- same convention
// @dashboard/check-client/server.js's own fetchRewstCustomers() already
// uses). Reusing THAT exact webhook here (Get CSP Customers) rather than a
// second call to the same one -- its own real response shape (confirmed
// live, 370 real rows): { company_name, csp_tenant_id, has_consent, id,
// linked_organizations: [{ id, name }], tenant_id }.
//
// Only confirmed REWST_WEBHOOK_* workflows on this account today (checked
// live): Get CSP Customers, Customer M365 Licenses, M365 Users -- none of
// them return a per-organization list of CONNECTED INTEGRATIONS (what was
// actually asked for alongside this). `linked_organizations` looked like a
// candidate but confirmed live it's just a single { id, name } pair that
// mirrors the Autotask company name 1:1, not a list of connected systems.
// So "installed" here only ever means "this company has a matching Rewst
// CSP customer record" -- the detail tooltip falls back to the matched
// Rewst company_name, the best available fact, not a real integrations
// list. Getting that would need a NEW Rewst workflow built in Rewst
// Studio itself (outside this codebase, same "can't be fixed in code"
// situation as Datto RMM's own Report Center having no API at all).
const CACHE_TTL_MS = 5 * 60 * 1000; // same TTL check-client's own fetchRewstCustomers() uses
let cache = null; // { customers, expiresAt }
let inFlight = null;

function hasRewstCredentials() {
  return Boolean((process.env.REWST_WEBHOOK_Get_CSP_Customers_URL || '').trim());
}

async function fetchCustomers() {
  const url = process.env.REWST_WEBHOOK_Get_CSP_Customers_URL;
  const res = await axios.post(url, {}, { headers: { 'Content-Type': 'application/json' } });
  return res.data.Customers || res.data.customers || [];
}

async function getCustomers(force) {
  if (!force && cache && Date.now() < cache.expiresAt) return cache.customers;
  if (!inFlight) {
    inFlight = fetchCustomers()
      .then((customers) => {
        cache = { customers, expiresAt: Date.now() + CACHE_TTL_MS };
        return customers;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

// Same &/and-normalize + bidirectional-contains matching every other
// cross-vendor name lookup on this dashboard uses -- confirmed live this
// is needed here too (real sample: Rewst's own company_name is the short
// "Kraftur", Autotask's is "Kraftur Pty Ltd").
function normalize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/\s*&\s*/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Every name worth matching against for one Rewst customer record --
// company_name, plus each linked_organizations[].name, by request
// ("EBP Rehab shows as NOT being in Rewst when it is"). Confirmed live:
// company_name can be a bare domain slug instead of a real business name
// (a real example, "ebprehab.com.au" for the Autotask company "EBP
// Rehab") -- normalizing a domain like that never lines up with a normal
// two-word company name (no word boundary between "ebp" and "rehab" in
// the slug), so a match purely on company_name silently misses it, even
// though that SAME record's own linked_organizations already carries the
// correct human name ("EBP Rehab") right there. check-client/server.js's
// own matchRewstCustomerByName() already does this same broadened check
// (confirmed working there) -- this mirrors that fix here specifically,
// not a shared refactor of the two.
function candidateNames(customer) {
  const names = [customer.company_name];
  if (Array.isArray(customer.linked_organizations)) {
    for (const org of customer.linked_organizations) {
      if (org && org.name) names.push(org.name);
    }
  }
  return names;
}

async function findCustomerMatch(companyName, force) {
  const customers = await getCustomers(force);
  const normCompany = normalize(companyName);
  if (!normCompany) return null;
  const pool = customers.filter((c) =>
    candidateNames(c).some((name) => {
      const n = normalize(name);
      if (!n) return false;
      return n === normCompany || n.includes(normCompany) || normCompany.includes(n);
    })
  );
  return pool.length === 1 ? pool[0] : null;
}

module.exports = { hasRewstCredentials, getCustomers, findCustomerMatch };
