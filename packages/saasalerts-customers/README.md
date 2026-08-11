# @dashboard/saasalerts-customers

Dashboard page: every customer under the SaaS Alerts partner account, with an instant client-side name filter. Live snapshot, not date-scoped -- same shape as CSP Customers (cheap single API call, auto-loads, no per-row on-demand fetch needed).

- `client.js` - frontend module. Exports `id`, `label`, and `mount(container)`, picked up automatically by the shell.
- `server.js` - Express router mounted by the shell at `/api/saasalerts-customers`.

## Data source

SaaS Alerts REST API (Kaseya's SaaS Alerts -- M365/Google Workspace security monitoring for MSPs), via the shared `@dashboard/saasalerts-client` package. `GET /reports/customers` returns every customer for the authenticated partner in one call (confirmed against the real API: 214 customers, no pagination needed, no query params supported) -- see that package's README/comments for the base URL and `api_key` header auth, which needed real testing to pin down (the vendor's own marketing domain, `api.saasalerts.com`, doesn't even resolve; the real production base URL is a Google Cloud Functions endpoint, discovered from the vendor's actual OpenAPI spec).

## Table columns

**Customer** (linked to the matching Autotask company's Detail page, when mapped -- see below), **Domain**, **Status** (red-flagged when not `active`), **Products** (Microsoft/Google Workspace, from each product's `name`), **Monitored Users** (`billingUsers.count` -- how many users SaaS Alerts is actively monitoring/billing for that customer, NOT a license SKU count).

## Autotask company link

SaaS Alerts customers carry a `mappedToPSA` array when the Autotask integration is configured on the SaaS Alerts side -- `{product: "autotaskpsa", mappedTo: "<Autotask companyID>"}`. Where present, the customer name links to that company's Detail page in Autotask (`getCompanyUrl()`, shared, `@dashboard/autotask-client`). Not every customer has this mapping (the SaaS Alerts customer might not have a matching Autotask company, or the mapping was just never set up on the SaaS Alerts side) -- those rows show as plain text instead of a link.

## Caching

Cached in-process for 20 minutes (`CACHE_TTL_MS`), same convention as CSP Customers and every other external-API snapshot page. The page's Refresh button sends `force=true`, bypassing the cache. Concurrent cold-cache requests share one in-flight build rather than each kicking off their own fetch.
