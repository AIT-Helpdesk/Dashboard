// TPP Wholesale's REST/JSON API (v1.0.8), split out of DNS Check's own
// server.js once a second page (Coming Soon, alongside DNS Check) needed
// this same auth + request plumbing, rather than duplicating it -- mirrors
// @dashboard/ingram-client's own "one shared low-level client per external
// system" convention. One reseller account only (TPP_API_KEY/TPP_SECRET in
// .env, no per-account label the way CLOUDFLARE_<LABEL>_* supports) --
// nothing in this dashboard's own TPP account suggests more than one is
// coming, so this stays simple rather than pre-building multi-account
// discovery the way DNS Check's own Cloudflare block needed.
const TPP_API_BASE = 'https://api.tppwholesale.com.au';
const TPP_FETCH_TIMEOUT_MS = 10000;

async function tppApiRequest(path, { method = 'GET', body, token } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TPP_FETCH_TIMEOUT_MS);
  try {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${TPP_API_BASE}${path}`, {
      method,
      signal: controller.signal,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// The auth token is a JWT valid for 1 hour (confirmed against a real token's
// own iat/exp claims) and IP-bound -- cached module-scope (this dashboard's
// own outbound IP never changes mid-process) and refreshed a minute before
// it actually expires, rather than fetched fresh on every call. Module-level
// (shared across every page that imports this package, not per-caller),
// same convention as @dashboard/ingram-client's own tokenCache.
let cachedTppToken = null; // { token, expiresAtMs }

function decodeJwtExpiryMs(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch (err) {
    return null; // can't decode -- caller falls back to a short default below
  }
}

async function getTppToken() {
  if (cachedTppToken && Date.now() < cachedTppToken.expiresAtMs - 60000) return cachedTppToken.token;

  const apiKey = (process.env.TPP_API_KEY || '').trim();
  const secretKey = (process.env.TPP_SECRET || '').trim();
  if (!apiKey || !secretKey) return null; // not configured -- not an error, just nothing to do

  const res = await tppApiRequest('/jwt/auth/token/', { method: 'POST', body: { apiKey, secretKey } });
  const text = (await res.text()).trim();
  if (!res.ok) throw new Error(`TPP Wholesale auth failed: HTTP ${res.status} -- ${text.slice(0, 200)}`);

  const token = text.replace(/^"|"$/g, ''); // plain-text JWT, not JSON -- defensive strip in case that ever changes
  const expiresAtMs = decodeJwtExpiryMs(token) || Date.now() + 5 * 60000; // 5 min fallback if the token's own exp can't be read
  cachedTppToken = { token, expiresAtMs };
  return token;
}

// TXT content comes back from TPP wrapped in literal double-quote characters
// (confirmed against real DKIM/SPF records -- e.g. the raw JSON value is the
// 9-character string `"v=spf1"` rather than the 7-character `v=spf1`), unlike
// Cloudflare's own `content` field which never carries them -- stripped here
// so a caller doesn't render doubled-up quotes.
// Hostname-valued record types also come back with a trailing dot on their
// content (e.g. CNAME "pop3.partnerconsole.net.", MX exchange
// "mx1.mail-forwarder.io.") -- confirmed against real records -- stripped
// here too, so these values match the no-trailing-dot shape the guess-based
// (Node dns.promises) and Cloudflare paths both already produce elsewhere on
// this dashboard.
const TPP_HOSTNAME_VALUE_TYPES = new Set(['NS', 'CNAME', 'MX']);
function tppRecordValue(rec) {
  let content = rec.content || '';
  if (content.length >= 2 && content.startsWith('"') && content.endsWith('"')) content = content.slice(1, -1);
  if (TPP_HOSTNAME_VALUE_TYPES.has(rec.type)) content = content.replace(/\.$/, '');
  return content;
}

// The MX "priority" a reader actually wants is in TPP's own `preference`
// field -- confirmed against real MX records, where `priority` was 0 on
// every single one (TPP evidently reserves that field for something else,
// never populated on the records this account has).
function tppRecordInfo(rec) {
  const parts = [];
  if (rec.type === 'MX' && rec.preference !== undefined && rec.preference !== null) parts.push(`Priority ${rec.preference}`);
  if (rec.type === 'TXT' && /v=spf/i.test(rec.content || '')) parts.push('SPF');
  return parts.join(' -- ');
}

// TPP's own `name` field is the apex record's full "domain.tld." (trailing
// dot, confirmed against real NS/A/MX/TXT records at the zone root) for
// anything at the domain's root, or just the bare relative label ("ftp",
// "domains", "ns1") with no trailing dot for anything else -- qualified
// here into the one full-hostname-no-trailing-dot shape this dashboard's
// DNS entries already use everywhere else (matching dns.resolveNs()'s own
// Node behaviour, which likewise strips the trailing dot).
function tppRecordName(rec, domain) {
  const raw = rec.name || '';
  if (raw.endsWith('.')) return raw.slice(0, -1);
  return `${raw}.${domain}`;
}

// Tries the one configured TPP reseller account. Returns null (not an
// error) when TPP isn't configured at all, or when this specific domain
// genuinely isn't managed under this reseller account (TPP's own 403 for
// that case, confirmed against a real non-TPP domain: {"errorCode":"403",
// ...,"message":"Given Domain does not belong to Reseller"}) -- either way,
// the caller falls through to whatever it does for "not ours". Any OTHER
// failure (auth broken, network hiccup, unexpected shape) throws -- callers
// are expected to degrade, not fail their whole page, same as DNS Check's
// own handling of this already did before this code moved here.
async function tppFindDnsRecords(domain) {
  const token = await getTppToken();
  if (!token) return null;

  const res = await tppApiRequest(`/domains/${encodeURIComponent(domain)}/dns-records`, { token });
  if (res.status === 403) {
    const body = await res.json().catch(() => null);
    if (body && /does not belong to reseller/i.test(body.message || '')) return null;
    throw new Error(`TPP Wholesale DNS lookup failed: HTTP 403 -- ${body?.message || 'unknown'}`);
  }
  if (!res.ok) throw new Error(`TPP Wholesale DNS lookup failed: HTTP ${res.status}`);
  return await res.json();
}

// TPP mixes NS records into the same flat list everything else comes back
// in (unlike Cloudflare, which exposes them as separate zone-level
// `name_servers` metadata) -- split out here into a { ns, entries } shape.
// SOA is simply never present in this endpoint's response (confirmed
// against three real domains' worth of records).
function tppRecordsToNsAndEntries(records, domain) {
  const ns = [];
  const entries = [];
  for (const rec of records) {
    if (rec.type === 'NS') {
      ns.push(tppRecordValue(rec)); // already trailing-dot-stripped -- NS is in TPP_HOSTNAME_VALUE_TYPES
      continue;
    }
    entries.push({ type: rec.type, name: tppRecordName(rec, domain), value: tppRecordValue(rec), info: tppRecordInfo(rec) });
  }
  return { ns, entries };
}

// TPP's own whois endpoint (confirmed live) returns registration info
// (`expiryDate`, `registrationDate`, `nameServer`, `status`, registrant
// contact, etc.) and a 400 "Domain not found" for anything outside our
// reseller account -- a DIFFERENT error shape from the DNS-records
// endpoint's own 403 above (confirmed against a real non-TPP domain), so it
// gets its own "not ours" check rather than reusing tppFindDnsRecords'.
async function tppGetDomainWhois(domain) {
  const token = await getTppToken();
  if (!token) return null;

  const res = await tppApiRequest(`/domains/${encodeURIComponent(domain)}/whois`, { token });
  if (res.status === 400) {
    const body = await res.json().catch(() => null);
    const message = (body?.errors || []).map((e) => e.errorMsg).join('; ');
    if (/domain not found/i.test(message)) return null;
    throw new Error(`TPP Wholesale whois lookup failed: HTTP 400 -- ${message || 'unknown'}`);
  }
  if (!res.ok) throw new Error(`TPP Wholesale whois lookup failed: HTTP ${res.status}`);
  return await res.json();
}

// Every domain in our reseller account -- for Coming Soon's Domains section.
// Confirmed live: `GET /domains?page=N` is paginated, response shape
// `{domains, totalCount, page, pageCount}`. IMPORTANT: `pageCount` is NOT
// the total number of pages despite the name -- confirmed live it's actually
// the PAGE SIZE (always matched `domains.length` on a full page, 25 in this
// account) -- requesting the page number `pageCount` claims as "last" still
// returned a full page of real data in testing. The only reliable stopping
// conditions are therefore `totalCount` (from the first page) and an empty
// page, both checked below rather than trusting `pageCount` as a loop bound.
async function fetchAllDomains() {
  const token = await getTppToken();
  if (!token) return [];

  const all = [];
  let page = 1;
  let totalCount = Infinity;
  for (;;) {
    const res = await tppApiRequest(`/domains?page=${page}`, { token });
    if (!res.ok) throw new Error(`TPP Wholesale domain list failed: HTTP ${res.status}`);
    const body = await res.json();
    if (typeof body.totalCount === 'number') totalCount = body.totalCount;
    const batch = body.domains || [];
    all.push(...batch);
    if (batch.length === 0 || all.length >= totalCount) break;
    page += 1;
  }
  return all;
}

module.exports = {
  getTppToken,
  tppApiRequest,
  tppFindDnsRecords,
  tppRecordsToNsAndEntries,
  tppGetDomainWhois,
  fetchAllDomains,
};
