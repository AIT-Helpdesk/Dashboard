# @dashboard/misc-info-tabs

Dashboard page: "MISC INFO" -- a tabbed bundle, currently holding one tab, for lookup tools that don't fit any other category. The actual tab-strip mechanism (drag-to-reorder, admin-only add/remove/reorder -- including how an admin can drag more sidebar pages in as extra tabs) lives in `@dashboard/shell`'s `tab-page-client.js`/`tab-page-server.js`, reused by every tabbed page on this dashboard -- see those files for the full implementation, not repeated here.

- `client.js` - calls `createTabbedPageMount()` with this page's own `id`/`label`/`apiBase` and its one default tab.
- `server.js` - re-exports `createTabPageRouter(__dirname)`.

## Default tabs

- **DNS Check** (`dns-check`) -- type a domain (a bare name with no TLD defaults to `.com.au`), see its DNS records (A/MX/TXT/NS/SOA, etc. -- pulled live and complete from Cloudflare or TPP Wholesale when we manage that domain's DNS ourselves, otherwise a best-effort check of known common records), with SPF/DKIM/DMARC rows highlighted; domain registration/registrar/expiry details; an optional Certificate Transparency (crt.sh) scan to catch hostnames outside the usual checklist; a per-record live-lookup button; and a DNS-propagation check across several public resolvers. Also resolves and links the domain's matching Autotask company / IT Glue organisation (via IT Glue's Domain Tracker) when one is found.

`packages/dns-check` has no README of its own yet -- the description above is drawn directly from `dns-check/client.js`, not from a separate writeup.
