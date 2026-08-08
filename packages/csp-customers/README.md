# @dashboard/csp-customers

Dashboard page: every CSP customer's company name and Microsoft tenant ID. Not date-scoped -- a live snapshot, auto-loads on open (the whole list is cheap to fetch in full) with a Refresh button and an instant client-side name filter.

- `client.js` - frontend module. Exports `id`, `label`, and `mount(container)`, picked up automatically by the shell.
- `server.js` - Express router mounted by the shell at `/api/csp-customers`.

## Data source: Microsoft Graph `/contracts`, not the Partner Center REST API

This deliberately does **not** use the legacy Partner Center REST API (`api.partnercenter.microsoft.com`), even though that's the API most CSP tooling and documentation defaults to. Confirmed against the real account, extensively: every call to it returns a bare `403` with an empty body, regardless of the app registration, auth pattern (App+User via username/password, or App-only via client credentials), or Azure AD permissions granted -- because **Microsoft doesn't support Partner Center API access for Indirect Resellers at all** ("API access to Partner Center for indirect resellers isn't supported," per Microsoft's own docs). That's a hard platform restriction tied to the CSP account's tier (Direct Bill Partner and Indirect *Provider* only), not a configuration gap -- no amount of app/permission tweaking fixes it for an Indirect Reseller account.

**Microsoft Graph's `/contracts` endpoint** is a different, modern API that works fine for this same account: it lists the reseller's customer relationships (`contractType: "ResellerPartner"` in the real data), each with a `customerId` (the customer's Microsoft/Entra tenant ID) and `displayName` (company name). It only needs the **`Contract.Read.All`** Graph application permission, admin-consented once.

## Credentials (`.env`)

`CSP_CLIENT_ID`, `CSP_CLIENT_SECRET`, `CSP_TENANT_ID` -- a dedicated Entra app registration, separate from the dashboard's own Microsoft 365 sign-in app (`AUTH_CLIENT_ID` etc. in `packages/shell/auth.js`), registered directly in the CSP tenant via Partner Center's own "App management" page (Settings -> Account settings -> App management -> add a new web app), which is the reliable way to get an app Partner Center actually recognizes -- creating the app registration purely in the Azure Portal first and linking it after was tried and didn't work as cleanly.

**Auth**: app-only client credentials against the Microsoft identity platform v2.0 token endpoint (`https://login.microsoftonline.com/{CSP_TENANT_ID}/oauth2/v2.0/token`, `grant_type=client_credentials`, `scope=https://graph.microsoft.com/.default`) -- this is plain Microsoft Graph auth, nothing CSP-specific about the token request itself. Token cached in-process (`tokenCache`), refreshed 60s before actual expiry.

## Pagination

Graph paginates via a full `@odata.nextLink` URL in the response body (not offset/limit like Ingram's API, and not a cursor param you build yourself) -- `fetchAllContracts()` just follows it until there isn't one. Confirmed against the real account: 374 contracts across 2 pages at `$top=200`.

## Why this loads differently from Ingram Subscriptions

Ingram Subscriptions doesn't auto-load and needs an on-demand per-client fetch for license counts, because getting that data requires one API call *per subscription* (hundreds). This page has no equivalent per-row cost -- the whole ~374-customer list comes back in 2 requests -- so it auto-loads on open like most other live-snapshot pages on this dashboard, cached in-process for 20 minutes (`CACHE_TTL_MS`), with **Refresh** bypassing that cache. The name filter runs entirely client-side against the already-loaded list (instant, no round trip) rather than the "type a filter, click a button, wait" pattern used on pages where a fresh server round trip is genuinely expensive.

## Data quirk

A `displayName` has been seen in real data with a leading space (e.g. `" Columbia Tower"`) -- trimmed server-side (`(c.displayName || '').trim()`) rather than left for the client to notice and work around.
