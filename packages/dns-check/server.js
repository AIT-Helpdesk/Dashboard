const express = require('express');
const dnsCallbacks = require('dns');
const dns = dnsCallbacks.promises;

// Confirmed the hard way: crt.sh (below) has a real AAAA record, and this
// network blackholes outbound IPv6 -- Node's fetch() tried IPv6 first every
// time, hung for the OS's own TCP connect timeout (20s+, well past this
// file's own CT_FETCH_TIMEOUT_MS), and only then would have fallen back to
// IPv4 if given long enough. This is Node's own documented fix for exactly
// that situation. It's process-wide (every page's server.js shares this one
// Node process), which is a feature here, not a side effect -- any OTHER
// outbound HTTPS call this dashboard makes to a host with an AAAA record
// was almost certainly paying the same silent multi-second IPv6 tax.
dnsCallbacks.setDefaultResultOrder('ipv4first');

const router = express.Router();

// Accepts a domain as typed -- a bare domain, or something pasted straight out
// of a browser/email ("https://example.com/path", "user@example.com") --
// and normalizes down to just the hostname DNS actually needs. All DNS
// lookups below go through Node's own dns.promises resolvers, never a
// shelled-out nslookup call, so there's no need to worry about this value
// ending up on a shell command line in the first place.
function normalizeDomain(input) {
  let domain = (input || '').trim().toLowerCase();
  domain = domain.replace(/^[a-z]+:\/\//, ''); // strip a scheme, if pasted as a URL
  domain = domain.split('/')[0]; // strip any path/query
  domain = domain.split('@').pop(); // in case someone pastes an email address
  domain = domain.replace(/\.$/, ''); // strip a trailing root dot
  return domain;
}

// Runs one dns.promises resolver and normalizes its result/failure into one
// shape the rest of this file can handle uniformly. A resolver REJECTING is
// often not a real failure -- ENOTFOUND/ENODATA just mean "no record of
// this type/name exists", which is the normal case for most of the
// best-effort lookups below (e.g. most domains have no CNAME at their apex,
// most domains don't run every DKIM selector or every Microsoft 365
// record).
async function lookup(fn, name) {
  try {
    const records = await fn(name);
    return { ok: true, records: Array.isArray(records) ? records : [records] };
  } catch (err) {
    return { ok: false, code: err.code || 'ERROR', message: err.message };
  }
}

// TXT records come back as string[][] -- each record can be split into
// multiple chunks by the resolver -- joined back into the one string it
// actually represents (e.g. a real SPF/DMARC/DKIM value reads as the single
// line it is, not several).
function joinTxt(records) {
  return records.map((chunks) => chunks.join(''));
}

// Best-effort "who hosts this domain's DNS" guess from its NS records' own
// hostnames -- common DNS/registrar providers (global, plus a handful of
// Australian ones relevant to this MSP's own client base), matched by
// nameserver hostname suffix. Deliberately not exhaustive -- an unmatched
// nameserver just means no guess, not an error.
const NS_PROVIDER_PATTERNS = [
  [/\.cloudflare\.com$/i, 'Cloudflare'],
  [/\.awsdns-\d+\.(com|net|org|co\.uk)$/i, 'Amazon Route 53'],
  [/\.domaincontrol\.com$/i, 'GoDaddy'],
  [/\.azure-dns\.(com|net|org|info)$/i, 'Microsoft Azure DNS'],
  [/\.googledomains\.com$/i, 'Google Domains'],
  [/\.registrar-servers\.com$/i, 'Namecheap'],
  [/\.dnsmadeeasy\.com$/i, 'DNS Made Easy'],
  [/\.digitalocean\.com$/i, 'DigitalOcean'],
  [/\.he\.net$/i, 'Hurricane Electric'],
  [/\.ultradns\.(net|org|com|biz|info)$/i, 'UltraDNS / Neustar'],
  [/\.markmonitor\.com$/i, 'MarkMonitor'],
  [/\.wixdns\.net$/i, 'Wix'],
  [/\.squarespacedns\.com$/i, 'Squarespace'],
  [/\.dreamhost\.com$/i, 'DreamHost'],
  [/\.bluehost\.com$/i, 'Bluehost'],
  [/\.hostgator\.com$/i, 'HostGator'],
  [/\.networksolutions\.com$/i, 'Network Solutions'],
  [/\.name\.com$/i, 'Name.com'],
  [/\.ovh\.(net|com)$/i, 'OVH'],
  [/\.linode\.com$/i, 'Linode (Akamai)'],
  [/\.vultr\.com$/i, 'Vultr'],
  // Australian registrars/hosts, since most of this dashboard's own client base is AU.
  [/\.ventraip\.net\.au$/i, 'VentraIP'],
  [/\.crazydomains\.(com|net)$/i, 'Crazy Domains'],
  [/\.netregistry\.net$/i, 'Netregistry'],
  [/\.digitalpacific\.com\.au$/i, 'Digital Pacific'],
  [/\.melbourneit\.com(\.au)?$/i, 'Melbourne IT'],
  [/\.tppwholesale\.com\.au$/i, 'TPP Wholesale'],
  [/\.uberglobal\.com(\.au)?$/i, 'UberGlobal'],
  [/\.anchor\.net\.au$/i, 'Anchor'],
  [/\.webcentral\.com\.au$/i, 'Webcentral'],
];
function identifyHoster(nsHosts) {
  for (const host of nsHosts) {
    for (const [pattern, label] of NS_PROVIDER_PATTERNS) {
      if (pattern.test(host)) return label;
    }
  }
  return null;
}

// Common DKIM selectors across the mail/ESP platforms this MSP's clients
// are actually likely to be running, by request ("find any other common
// DKIM records"). A DKIM selector is just the subdomain prefix on
// "<selector>._domainkey.<domain>" -- there's no way to enumerate every
// selector in use short of guessing well-known ones, so this checks each
// of these in parallel and only reports the ones that actually resolve.
const DKIM_SELECTORS = [
  { selector: 'google', label: 'Google Workspace' },
  { selector: 'selector1', label: 'Microsoft 365' },
  { selector: 'selector2', label: 'Microsoft 365' },
  { selector: 'default', label: 'Generic / cPanel / many ESPs' },
  { selector: 'dkim', label: 'Generic' },
  { selector: 'k1', label: 'Mailchimp / Mandrill' },
  { selector: 'k2', label: 'Mailchimp / Mandrill' },
  { selector: 'mandrill', label: 'Mandrill' },
  { selector: 's1', label: 'SparkPost / generic ESP' },
  { selector: 's2', label: 'SparkPost / generic ESP' },
  { selector: 'pm', label: 'Postmark' },
  { selector: 'zoho', label: 'Zoho Mail' },
  { selector: 'mail', label: 'Generic' },
  { selector: 'smtp', label: 'Generic' },
  { selector: 'em', label: 'SendGrid' },
];

// The classic set of CNAME records Microsoft has clients add when onboarding
// a custom domain to Microsoft 365 -- Exchange autodiscover, Skype for
// Business/Teams SIP, Intune/Azure AD device enrollment, and (still
// commonly present even though it's legacy) the old Office 365
// sign-in federation record.
const M365_CNAME_CHECKS = [
  { name: 'autodiscover', label: 'Outlook Autodiscover' },
  { name: 'sip', label: 'Skype for Business / Teams SIP' },
  { name: 'lyncdiscover', label: 'Skype for Business / Teams Discover' },
  { name: 'enterpriseregistration', label: 'Azure AD / Intune Device Registration' },
  { name: 'enterpriseenrollment', label: 'Intune Enrollment' },
  { name: 'msoid', label: 'Microsoft Online Sign-in (legacy federation)' },
];

// The two SRV records that go with the SIP CNAMEs above, for Skype for
// Business/Teams federation and client auto-configuration.
const M365_SRV_CHECKS = [
  { name: '_sip._tls', label: 'Teams/Skype for Business SIP (TLS)' },
  { name: '_sipfederationtls._tcp', label: 'Teams/Skype for Business Federation' },
];

// Other commonly-checked mail security TXT records, beyond SPF/DMARC/DKIM
// above: MTA-STS and TLS-RPT (both increasingly standard for transport
// security/reporting) and BIMI (brand logo in supporting inboxes) at its
// standard "default" selector.
const MAIL_SECURITY_TXT_CHECKS = [
  { name: '_mta-sts', label: 'MTA-STS Policy Indicator' },
  { name: '_smtp._tls', label: 'TLS-RPT (TLS Reporting)' },
  { name: 'default._bimi', label: 'BIMI (Brand Indicator)' },
];

// Old-style mail hostnames from the pre-cloud-email era, when a business ran
// its own mail server and told clients to connect to an explicit hostname
// like mail.<domain> or smtp.<domain> -- by request. Checked as BOTH a
// CNAME and an A record, since some setups pointed these at a shared
// platform (CNAME) and others ran the mail server directly off that
// hostname's own A record.
const LEGACY_MAIL_HOSTNAME_CHECKS = [
  { name: 'mail', label: 'Generic Mail Server' },
  { name: 'webmail', label: 'Webmail Portal' },
  { name: 'smtp', label: 'SMTP Server' },
  { name: 'pop', label: 'POP3 Server' },
  { name: 'pop3', label: 'POP3 Server' },
  { name: 'imap', label: 'IMAP Server' },
  { name: 'imap4', label: 'IMAP Server' },
  { name: 'exchange', label: 'On-Prem Exchange Server' },
  { name: 'owa', label: 'Outlook Web Access' },
  { name: 'email', label: 'Generic Mail Hostname' },
];

// The website itself -- checked directly and unconditionally, by request,
// rather than left dependent on Certificate Transparency (crt.sh) actually
// finding/returning it. crt.sh is an external service that can time out,
// rate-limit, or simply have no logged cert for this one name -- "does
// www.<domain> resolve" shouldn't hinge on any of that.
const WWW_HOSTNAME_CHECK = { name: 'www', label: 'Website (www)' };

// Every curated hostname this file already checks by name, used to filter
// Certificate Transparency's own discoveries below down to genuinely NEW
// hostnames -- otherwise a name we already have a definitive answer for
// (found or not found) would show up a second time as a CT "discovery".
function knownHostnames(domain) {
  return new Set(
    [
      domain,
      `_dmarc.${domain}`,
      `${WWW_HOSTNAME_CHECK.name}.${domain}`,
      ...DKIM_SELECTORS.map((d) => `${d.selector}._domainkey.${domain}`),
      ...M365_CNAME_CHECKS.map((c) => `${c.name}.${domain}`),
      ...M365_SRV_CHECKS.map((s) => `${s.name}.${domain}`),
      ...MAIL_SECURITY_TXT_CHECKS.map((s) => `${s.name}.${domain}`),
      ...LEGACY_MAIL_HOSTNAME_CHECKS.map((m) => `${m.name}.${domain}`),
    ].map((h) => h.toLowerCase())
  );
}

// Certificate Transparency (crt.sh) -- by request, to catch genuinely
// unusual/custom hostnames our curated guess-lists above would never think
// to check. Any hostname that's ever had a public HTTPS certificate issued
// for it gets permanently logged here, searchable with no auth and no cost.
// This is NOT a DNS mechanism (it's a public log of certificate issuance),
// so it only tells us a hostname EXISTED at some point -- each one still
// gets a normal CNAME/A lookup afterward to confirm it resolves today.
const CT_FETCH_TIMEOUT_MS = 20000;
// crt.sh can return thousands of certs for a long-lived domain -- capped so
// one unusual domain can't make every lookup slow; truncation is reported
// back to the client rather than silently dropped.
const CT_MAX_HOSTS_TO_CHECK = 50;

async function fetchCertTransparencyHostnames(domain) {
  const url = `https://crt.sh/?q=${encodeURIComponent(`%.${domain}`)}&output=json`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CT_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`crt.sh returned HTTP ${res.status}`);
    const rows = await res.json();
    const suffix = `.${domain}`;
    const hostnames = new Set();
    for (const row of Array.isArray(rows) ? rows : []) {
      const raw = `${row.common_name || ''}\n${row.name_value || ''}`;
      for (let line of raw.split('\n')) {
        line = line.trim().toLowerCase();
        if (!line) continue;
        if (line.startsWith('*.')) line = line.slice(2); // wildcard cert -- check the base name it covers
        if (line === domain || !line.endsWith(suffix)) continue; // apex already covered elsewhere; ignore unrelated names
        hostnames.add(line);
      }
    }
    return { ok: true, hostnames: [...hostnames].sort() };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'Timed out' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function certTransparencyExtras(domain, known) {
  const ct = await fetchCertTransparencyHostnames(domain);
  if (!ct.ok) return { ok: false, error: ct.error, totalDiscovered: 0, checkedCount: 0, truncated: false, entries: [] };

  const candidates = ct.hostnames.filter((h) => !known.has(h));
  const truncated = candidates.length > CT_MAX_HOSTS_TO_CHECK;
  const toCheck = candidates.slice(0, CT_MAX_HOSTS_TO_CHECK);

  const results = await Promise.all(
    toCheck.map(async (host) => {
      const [cnameResult, aResult] = await Promise.all([lookup(dns.resolveCname, host), lookup(dns.resolve4, host)]);
      return { host, cnameResult, aResult };
    })
  );

  const entries = [];
  for (const { host, cnameResult, aResult } of results) {
    if (cnameResult.ok) for (const rec of cnameResult.records) entries.push({ type: 'CNAME', name: host, value: rec, info: 'Found via Certificate Transparency' });
    if (aResult.ok) for (const ip of aResult.records) entries.push({ type: 'A', name: host, value: ip, info: 'Found via Certificate Transparency' });
  }

  return { ok: true, totalDiscovered: candidates.length, checkedCount: toCheck.length, truncated, entries };
}

// ---- Cloudflare (authoritative, when we manage the zone ourselves) ------
//
// By request -- when a domain's DNS is actually managed in one of OUR OWN
// Cloudflare accounts, pull the complete, real record set straight from
// Cloudflare's API instead of the guess-based checks above. There's
// nothing left to guess at that point, so Certificate Transparency and the
// "checked, not found" lists are both skipped entirely for this path (see
// the early return in the route handler below) -- not because they
// failed, but because they'd have nothing to add.
//
// Credentials are discovered dynamically from .env, one Cloudflare account
// per CLOUDFLARE_<LABEL>_API_TOKEN found (mirrors registry.js's own
// MENUCATEGORY_<LABEL> discovery pattern) -- by request, so adding another
// managed Cloudflare account later ("we will be adding more API info for
// the others") is just new .env lines following the same naming, no code
// change here. An account with no token configured yet is silently
// skipped, not an error -- this dashboard's real .env has
// CLOUDFLARE_AMBIENTIT_* present but commented out/blank right now, so
// zero accounts are discovered until a real token is filled in, and this
// whole feature is a no-op (falls through to the guess-based path below)
// until then.
const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';
const CLOUDFLARE_FETCH_TIMEOUT_MS = 10000;

function discoverCloudflareAccounts() {
  const accounts = [];
  const seen = new Set();
  for (const key of Object.keys(process.env)) {
    const match = /^CLOUDFLARE_(.+)_API_TOKEN$/.exec(key);
    if (!match) continue;
    const label = match[1];
    if (seen.has(label)) continue;
    seen.add(label);
    const token = (process.env[key] || '').trim();
    if (!token) continue; // not configured yet -- skip, not an error
    // ACCOUTN_ID (not ACCOUNT_ID) is the real spelling in this dashboard's
    // .env right now -- matched as-is since env var names have to match
    // exactly, but ACCOUNT_ID is also accepted so this keeps working if
    // that typo ever gets fixed there without a matching code change here.
    const accountId = (process.env[`CLOUDFLARE_${label}_ACCOUTN_ID`] || process.env[`CLOUDFLARE_${label}_ACCOUNT_ID`] || '').trim();
    // FRIENDLY_NAME is what's actually shown to a reader (e.g. "Ambient iT")
    // -- API_NAME is Cloudflare's own internal token name (e.g.
    // "Dashboard-lively-water-c6c5"), kept only as a fallback for an
    // account that hasn't set FRIENDLY_NAME yet, so nothing breaks for an
    // account added before this existed.
    const displayName = (process.env[`CLOUDFLARE_${label}_FRIENDLY_NAME`] || process.env[`CLOUDFLARE_${label}_API_NAME`] || label).trim();
    accounts.push({ label, token, accountId, displayName });
  }
  return accounts;
}

async function cloudflareApiGet(url, token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLOUDFLARE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    if (!data.success) throw new Error((data.errors || []).map((e) => e.message).join('; ') || `Cloudflare API returned HTTP ${res.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// Tries every discovered Cloudflare account in turn (a token/account that
// errors -- bad token, no access -- just moves on to the next one rather
// than failing the whole lookup) and returns the first exact zone-name
// match found, or null if this domain isn't managed in any of them.
async function cloudflareFindZone(domain) {
  for (const account of discoverCloudflareAccounts()) {
    try {
      const url = new URL(`${CLOUDFLARE_API_BASE}/zones`);
      url.searchParams.set('name', domain);
      if (account.accountId) url.searchParams.set('account.id', account.accountId);
      const data = await cloudflareApiGet(url, account.token);
      const zone = (data.result || [])[0];
      if (zone) return { account, zone };
    } catch (err) {
      console.error(`DNS Check: Cloudflare zone lookup failed for account "${account.label}":`, err.message);
    }
  }
  return null;
}

async function cloudflareFetchAllRecords(zoneId, token) {
  const records = [];
  let page = 1;
  for (;;) {
    const url = new URL(`${CLOUDFLARE_API_BASE}/zones/${zoneId}/dns_records`);
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', String(page));
    const data = await cloudflareApiGet(url, token);
    records.push(...(data.result || []));
    const totalPages = data.result_info?.total_pages || 1;
    if (page >= totalPages) break;
    page += 1;
  }
  return records;
}

// Cloudflare's own `content` field is already a human-readable value for
// every record type (synthesized by Cloudflare itself, including the
// structured ones like SRV/CAA) -- preferred as-is rather than hand-
// rebuilding it from the structured `data` object, so this doesn't need to
// keep up with every record type's own sub-fields; `data` is only a
// fallback for the unexpected case where `content` is missing.
function cloudflareRecordValue(rec) {
  if (typeof rec.content === 'string' && rec.content) return rec.content;
  if (rec.data) return JSON.stringify(rec.data);
  return '';
}

function cloudflareRecordInfo(rec) {
  const parts = [];
  if (rec.type === 'MX' && rec.priority !== undefined && rec.priority !== null) parts.push(`Priority ${rec.priority}`);
  // Same SPF tag the guess-based path's own TXT handling already applies --
  // kept consistent across both sources, even though the client's own
  // SPF-detection (vertical token split, green highlight) now reads the
  // record's actual value rather than relying on this label.
  if (rec.type === 'TXT' && /v=spf/i.test(rec.content || '')) parts.push('SPF');
  if (rec.proxied) parts.push('Proxied via Cloudflare');
  return parts.join(' -- ');
}

// SOA is pulled out of the raw record list and reshaped into the exact
// same { ok, records: [{ nsname, hostmaster, serial, ... }] } shape the
// guess-based path's own dns.resolveSoa() produces, so the client's
// existing soaHtml() renders it with no changes needed either way.
function cloudflareRecordsToEntriesAndSoa(records) {
  const entries = [];
  let soa = { ok: false, code: 'ENODATA', message: 'No SOA record' };
  for (const rec of records) {
    if (rec.type === 'SOA' && rec.data) {
      soa = {
        ok: true,
        records: [
          {
            nsname: rec.data.mname,
            hostmaster: rec.data.rname,
            serial: rec.data.serial,
            refresh: rec.data.refresh,
            retry: rec.data.retry,
            expire: rec.data.expire,
            minttl: rec.data.minimum,
          },
        ],
      };
      continue;
    }
    entries.push({ type: rec.type, name: rec.name, value: cloudflareRecordValue(rec), info: cloudflareRecordInfo(rec) });
  }
  return { entries, soa };
}

// ---- TPP Wholesale (authoritative, when we manage the zone ourselves) ----
//
// Same "pull the real record set instead of guessing" treatment as the
// Cloudflare block above, by request ("still don't use [crt.sh] if we've
// accessed all the records from our own DNS CloudFlare or TPP") -- this is
// TPP Wholesale's newer REST/JSON API (confirmed live against our own
// reseller account, not the older auth.pl/order.pl/query.pl API, which has
// no DNS-record capability at all). One reseller account only (TPP_API_KEY/
// TPP_SECRET in .env, no per-account label the way CLOUDFLARE_<LABEL>_*
// supports) -- nothing in this dashboard's own TPP account suggests more
// than one is coming, so this stays simple rather than pre-building
// multi-account discovery Cloudflare's own block needed.
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
// it actually expires, rather than fetched fresh on every DNS Check search.
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
// so the client doesn't render doubled-up quotes.
// Hostname-valued record types also come back with a trailing dot on their
// content (e.g. CNAME "pop3.partnerconsole.net.", MX exchange
// "mx1.mail-forwarder.io.") -- confirmed against real records -- stripped
// here too, same reasoning as tppRecordName() above, so these values match
// the no-trailing-dot shape the guess-based (Node dns.promises) and
// Cloudflare paths both already produce.
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
// here into the one full-hostname-no-trailing-dot shape this file's entries
// already use everywhere else (matching dns.resolveNs()'s own Node
// behaviour, which likewise strips the trailing dot).
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
// the caller falls through to the normal guess-based lookups. Any OTHER
// failure (auth broken, network hiccup, unexpected shape) throws, same
// "degrade, don't fail the whole page" handling the route's own try/catch
// around this call already gives the equivalent Cloudflare lookup.
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
// `name_servers` metadata) -- split out here into the exact same { ns,
// entries } shape the route handler already builds from either source, and
// SOA is simply never present in this endpoint's response (confirmed
// against three real domains' worth of records) -- same "No SOA record"
// fallback the Cloudflare path already uses for the same reason.
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

router.get('/', async (req, res) => {
  const domain = normalizeDomain(req.query.domain);
  if (!domain) return res.status(400).json({ error: 'A domain is required.' });
  // Certificate Transparency (crt.sh), by request -- on by default, opted
  // OUT of per-request via this query param (only the client's own
  // checkbox sends it as 'false'; a request with no `ct` param at all --
  // e.g. the API called directly -- defaults to on).
  const ctEnabled = req.query.ct !== 'false' && req.query.ct !== '0';

  try {
    const cfMatch = await cloudflareFindZone(domain).catch((err) => {
      console.error('DNS Check: Cloudflare zone lookup failed:', err.message);
      return null;
    });

    if (cfMatch) {
      try {
        const records = await cloudflareFetchAllRecords(cfMatch.zone.id, cfMatch.account.token);
        const { entries, soa } = cloudflareRecordsToEntriesAndSoa(records);
        return res.json({
          domain,
          asOf: new Date().toISOString(),
          source: 'cloudflare',
          hoster: `Cloudflare (managed in our "${cfMatch.account.displayName}" account)`,
          ns: { ok: true, records: cfMatch.zone.name_servers || [] },
          entries,
          notFound: { dkim: [], m365: [], security: [], legacyMail: [], website: [] },
          soa,
          certTransparency: null,
        });
      } catch (err) {
        // Zone was found but pulling its records failed (rate limit, token
        // permission gap, network hiccup) -- falls through to the normal
        // guess-based lookups below rather than erroring the whole page,
        // same "degrade, don't fail" reasoning as every lookup in this file.
        console.error(`DNS Check: Cloudflare records fetch failed for zone "${domain}", falling back to guess-based lookups:`, err.message);
      }
    }

    const tppRecords = await tppFindDnsRecords(domain).catch((err) => {
      console.error('DNS Check: TPP Wholesale DNS lookup failed, falling back to guess-based lookups:', err.message);
      return null;
    });

    if (tppRecords) {
      const { ns, entries } = tppRecordsToNsAndEntries(tppRecords, domain);
      return res.json({
        domain,
        asOf: new Date().toISOString(),
        source: 'tpp',
        hoster: 'TPP Wholesale (managed in our reseller account)',
        ns: { ok: true, records: ns },
        entries,
        notFound: { dkim: [], m365: [], security: [], legacyMail: [], website: [] },
        soa: { ok: false, code: 'ENODATA', message: 'No SOA record' },
        certTransparency: null,
      });
    }

    const [ns, soa, a, mx, txt, dmarcTxt, cname, caa] = await Promise.all([
      lookup(dns.resolveNs, domain),
      lookup(dns.resolveSoa, domain),
      lookup(dns.resolve4, domain),
      lookup(dns.resolveMx, domain),
      lookup(dns.resolveTxt, domain),
      lookup(dns.resolveTxt, `_dmarc.${domain}`),
      lookup(dns.resolveCname, domain),
      lookup(dns.resolveCaa, domain),
    ]);

    // CNAME+A lookup for one hostname -- shared by the legacy mail checks,
    // the www check, and (via a loop) Certificate Transparency's own
    // discoveries, since all three ask exactly this same question about a
    // different hostname.
    const cnameAndA = async (host) => {
      const [cnameResult, aResult] = await Promise.all([lookup(dns.resolveCname, host), lookup(dns.resolve4, host)]);
      return { cnameResult, aResult };
    };

    const [dkimResults, m365CnameResults, m365SrvResults, securityTxtResults, legacyMailResults, ctResult, wwwResult] = await Promise.all([
      Promise.all(DKIM_SELECTORS.map(async (d) => ({ ...d, result: await lookup(dns.resolveTxt, `${d.selector}._domainkey.${domain}`) }))),
      Promise.all(M365_CNAME_CHECKS.map(async (c) => ({ ...c, result: await lookup(dns.resolveCname, `${c.name}.${domain}`) }))),
      Promise.all(M365_SRV_CHECKS.map(async (s) => ({ ...s, result: await lookup(dns.resolveSrv, `${s.name}.${domain}`) }))),
      Promise.all(MAIL_SECURITY_TXT_CHECKS.map(async (s) => ({ ...s, result: await lookup(dns.resolveTxt, `${s.name}.${domain}`) }))),
      Promise.all(LEGACY_MAIL_HOSTNAME_CHECKS.map(async (m) => ({ ...m, ...(await cnameAndA(`${m.name}.${domain}`)) }))),
      // Skipped entirely (not just "run but ignored") when the toggle is off
      // -- ctResult stays null, and certTransparency below follows suit, the
      // same "null means not checked" shape the client already understands
      // from the Cloudflare path (see certTransparencyNoteHtml's own `if
      // (!ct) return '';`).
      ctEnabled ? certTransparencyExtras(domain, knownHostnames(domain)) : Promise.resolve(null),
      (async () => ({ ...WWW_HOSTNAME_CHECK, ...(await cnameAndA(`${WWW_HOSTNAME_CHECK.name}.${domain}`)) }))(),
    ]);

    const hoster = ns.ok ? identifyHoster(ns.records) : null;

    // One flat list -- Type/Name/Value/Other Info -- rather than a box per
    // record type, by request, now that there are 20+ things being checked.
    // Only records that actually exist go in here; the "not found" lists
    // below cover the best-effort checks (DKIM/M365/security) that came up
    // empty, so it's still clear what was looked for.
    const entries = [];
    const notFound = { dkim: [], m365: [], security: [], legacyMail: [], website: [] };

    if (a.ok) for (const ip of a.records) entries.push({ type: 'A', name: domain, value: ip, info: '' });

    if (mx.ok) for (const rec of mx.records) entries.push({ type: 'MX', name: domain, value: rec.exchange, info: `Priority ${rec.priority}` });

    if (txt.ok) {
      for (const rec of joinTxt(txt.records)) entries.push({ type: 'TXT', name: domain, value: rec, info: /v=spf/i.test(rec) ? 'SPF' : '' });
    }

    if (dmarcTxt.ok) {
      for (const rec of joinTxt(dmarcTxt.records)) entries.push({ type: 'TXT', name: `_dmarc.${domain}`, value: rec, info: 'DMARC' });
    }

    {
      const { name, label, cnameResult, aResult } = wwwResult;
      let found = false;
      if (cnameResult.ok && cnameResult.records.length > 0) {
        for (const rec of cnameResult.records) entries.push({ type: 'CNAME', name: `${name}.${domain}`, value: rec, info: label });
        found = true;
      }
      if (aResult.ok && aResult.records.length > 0) {
        for (const ip of aResult.records) entries.push({ type: 'A', name: `${name}.${domain}`, value: ip, info: label });
        found = true;
      }
      if (!found) notFound.website.push(`${name} (${label})`);
    }

    if (cname.ok) for (const rec of cname.records) entries.push({ type: 'CNAME', name: domain, value: rec, info: '' });

    for (const { selector, label, result } of dkimResults) {
      if (result.ok && result.records.length > 0) {
        for (const rec of joinTxt(result.records)) entries.push({ type: 'TXT', name: `${selector}._domainkey.${domain}`, value: rec, info: `DKIM -- ${label}` });
      } else {
        notFound.dkim.push(`${selector} (${label})`);
      }
    }

    for (const { name, label, result } of m365CnameResults) {
      if (result.ok && result.records.length > 0) {
        for (const rec of result.records) entries.push({ type: 'CNAME', name: `${name}.${domain}`, value: rec, info: label });
      } else {
        notFound.m365.push(label);
      }
    }

    for (const { name, label, result } of m365SrvResults) {
      if (result.ok && result.records.length > 0) {
        for (const rec of result.records) {
          entries.push({ type: 'SRV', name: `${name}.${domain}`, value: rec.name, info: `${label} -- priority ${rec.priority}, weight ${rec.weight}, port ${rec.port}` });
        }
      } else {
        notFound.m365.push(label);
      }
    }

    for (const { name, label, result } of securityTxtResults) {
      if (result.ok && result.records.length > 0) {
        for (const rec of joinTxt(result.records)) entries.push({ type: 'TXT', name: `${name}.${domain}`, value: rec, info: label });
      } else {
        notFound.security.push(label);
      }
    }

    if (caa.ok && caa.records.length > 0) {
      for (const rec of caa.records) {
        const tag = rec.issue !== undefined ? 'issue' : rec.issuewild !== undefined ? 'issuewild' : 'iodef';
        entries.push({ type: 'CAA', name: domain, value: rec[tag], info: `${tag}${rec.critical ? ', critical' : ''}` });
      }
    } else {
      notFound.security.push('CAA (Certificate Authority Authorization)');
    }

    for (const { name, label, cnameResult, aResult } of legacyMailResults) {
      let found = false;
      if (cnameResult.ok && cnameResult.records.length > 0) {
        for (const rec of cnameResult.records) entries.push({ type: 'CNAME', name: `${name}.${domain}`, value: rec, info: label });
        found = true;
      }
      if (aResult.ok && aResult.records.length > 0) {
        for (const ip of aResult.records) entries.push({ type: 'A', name: `${name}.${domain}`, value: ip, info: label });
        found = true;
      }
      if (!found) notFound.legacyMail.push(`${name} (${label})`);
    }

    // Certificate Transparency's own discoveries, appended last -- genuinely
    // new hostnames found via crt.sh, each already confirmed to actually
    // resolve (that's what certTransparencyExtras() does the CNAME/A lookup
    // for), not just a hostname that once had a cert issued. ctResult is
    // null when the toggle was off (see the Promise.all above) -- nothing
    // to append, and certTransparency stays null too.
    if (ctResult) entries.push(...ctResult.entries);
    const certTransparency = ctResult
      ? {
          ok: ctResult.ok,
          error: ctResult.error || null,
          totalDiscovered: ctResult.totalDiscovered,
          checkedCount: ctResult.checkedCount,
          truncated: ctResult.truncated,
          foundCount: ctResult.entries.length,
        }
      : null;

    // ns and soa are both kept separate from `entries` -- ns shown in its
    // own section at the TOP (next to the hoster guess, by request), soa in
    // its own section at the bottom -- rather than as just more rows in the
    // flat table.
    res.json({ domain, asOf: new Date().toISOString(), source: 'guess', hoster, ns, entries, notFound, soa, certTransparency });
  } catch (err) {
    console.error('DNS Check: lookup failed for', domain, '--', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
