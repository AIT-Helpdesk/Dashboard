# @dashboard/dns-check

Dashboard page: type a domain, see everything findable about its DNS, registration, and mail security setup in one place -- a technician's quick "what's this domain's DNS actually doing" tool. No external DNS integration is treated as a single source of truth by default: for most domains this runs a curated set of best-effort lookups (common record types, known DKIM selectors, Microsoft 365 hostnames, mail security records) via Node's own `dns.promises` resolvers, plus an optional Certificate Transparency (crt.sh) sweep to catch anything the curated list wouldn't think to check. When the domain turns out to be one we actually manage ourselves (our own Cloudflare account, or our TPP Wholesale reseller account), it instead pulls the complete, authoritative record set straight from that system's own API.

- `client.js` - frontend module. Exports `id`, `label`, and `mount(container)`.
- `server.js` - Express router mounted by the shell at `/api/dns-check`, with three routes: `GET /` (the main lookup), `GET /live-lookup` (re-check one record against live DNS), and `GET /propagation-check` (re-check one record across several public resolvers).

## Where the data comes from, and in what order

For a given domain, three sources are tried in sequence, each one a complete replacement for the others, not merged together:

1. **Our own Cloudflare account(s)** -- if any `CLOUDFLARE_<LABEL>_API_TOKEN` is configured in `.env` and one of those accounts holds a matching zone, every DNS record is pulled live from Cloudflare's own API (`cloudflareFetchAllRecords()`). Cloudflare accounts are discovered dynamically from `.env` key names (mirrors a pattern used elsewhere on this dashboard), so adding another managed account later is just new `.env` lines, no code change.
2. **Our own TPP Wholesale reseller account** -- via `@dashboard/tpp-client`'s `tppFindDnsRecords()`, if the domain's DNS is hosted there instead.
3. **Guess-based public lookups** -- the fallback for everything else: real Node DNS resolver calls (A/MX/TXT/CNAME/CAA/SOA/NS) plus a curated list of common DKIM selectors, Microsoft 365 CNAME/SRV records, mail security TXT records (MTA-STS, TLS-RPT, BIMI), legacy mail hostnames (`mail.`, `smtp.`, `imap.`, etc.), and `www`. This path is explicitly a guess, not a complete record list, and the page says so.

**Gotcha confirmed live and guarded against:** a domain can stay configured as a zone in our Cloudflare account, or keep old records in our TPP account, long after its real NS delegation has moved elsewhere. Before either source is trusted as "the complete record set," its own reported nameservers are checked against a genuine live NS lookup (`nsMatchesLiveDelegation()`) -- a mismatch falls through to the next source in the list instead of serving stale data as if it were authoritative.

## Certificate Transparency (crt.sh)

An on-by-default checkbox runs a crt.sh query for every hostname that's ever had a public HTTPS certificate issued under this domain, to catch unusual/custom hostnames the curated DKIM/M365/security lists wouldn't think to check. It's not itself a DNS mechanism -- it only proves a hostname existed at some point -- so every discovered hostname still gets a live CNAME/A lookup to confirm it resolves today, and only the ones that do get added to the results table (tagged "Found via Certificate Transparency"). Results are capped at 50 hostnames checked per domain to keep the page responsive; a truncated count is reported back, not silently dropped. Skipped entirely (not just ignored) for the Cloudflare/TPP-sourced paths, since there's nothing left to guess once the real record set is already in hand.

Confirmed the hard way: crt.sh has a real `AAAA` record, and this network blackholes outbound IPv6, so Node's `fetch()` was hanging 20+ seconds trying IPv6 first before falling back. `server.js` sets `dns.setDefaultResultOrder('ipv4first')` process-wide to fix it -- which also means every other outbound HTTPS call this whole dashboard process makes was likely paying the same silent IPv6 tax before this fix.

## Domain Registration (WHOIS)

Registrar, expiry, status, registrant, and contact info -- a separate question from "who serves the DNS," shown in its own section. Expiry/status/registrant prefer our own TPP Wholesale data when the domain is in our reseller account (authoritative for our own domains, and some registries, auDA's `.au` included, don't publish an expiry via public WHOIS at all); the Registrar field itself always comes from public WHOIS regardless, because TPP is a reseller, not the accredited registrar of record -- a TPP-managed domain's real registrar name is tagged `(TPP)` so it still reads as recognizably ours. Public WHOIS is a raw port-43 WHOIS protocol query (`net.createConnection`), not a REST API, with a curated server list by TLD and an IANA referral fallback for anything unmapped.

## Autotask Client resolution

The bracketed client name next to the domain is resolved via IT Glue's own Domain Tracker: the domain is looked up against every IT Glue domain (`@dashboard/domain-itglue-gap`'s own bulk fetch, reused rather than duplicated -- confirmed live that IT Glue's `/domains` endpoint ignores a `filter[name]` param entirely, so there's no way to ask for just one domain server-side), then that organisation's name is matched to a real Autotask Company by exact, case-insensitive name. A domain found in IT Glue whose organisation name doesn't match any real Autotask Company still shows the IT Glue link, just not an Autotask one.

## Per-record live re-check and propagation check

Any single row in the results table (even one sourced from Cloudflare/TPP's own stored config) can be re-checked: a magnifying-glass icon re-queries that one record live via this server's own resolver, and a globe icon checks it across eight named public resolvers (Google, Cloudflare, Quad9, OpenDNS, etc.) in a popup window, catching a resolver-specific stale-cache case a single lookup wouldn't show.

## Non-obvious bits

- The domain input defaults a bare, extension-less entry to `.com.au` (this MSP's client base is mostly Australian) before running the lookup, and reflects the appended TLD back into the input field.
- DKIM/DMARC/SPF record names get a green highlight in the results table (mail security only -- the root A record, `www`, and MX used to be highlighted too, dropped per request).
- Any occurrence of "easydmarc" anywhere in the page's rendered text is bolded and colored warning-orange.
- "DNS records found" and "hostnames discovered" via crt.sh are reported as two different numbers on purpose -- one hostname can carry several resolving records.
- There is no caching anywhere in this package -- every lookup (DNS, WHOIS, Cloudflare/TPP API calls, crt.sh) is live on every request.
