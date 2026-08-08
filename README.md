# Ambient IT Dashboard

Small internal multi-page dashboard, backed by the Autotask API. It's an npm workspaces monorepo: each sidebar page is its own package under `packages/`, discovered automatically by the shell at startup. Different people can work on different pages in isolation and merge via normal git branches/PRs, without touching shared code.

## Structure

```
packages/
  shell/               the Express app + sidebar frontend (the "host")
  autotask-client/      shared library: Autotask API client + name-resolution caches
  completed-tickets/    a dashboard page (frontend + its own backend router)
```

- **shell** serves the sidebar shell UI, discovers page packages, and mounts each page's router at `/api/<page-id>`. The sidebar is a two-level tree -- pages sit at the top level or inside a category (e.g. "Client Info", "Ticket Info"). The whole layout (categories, their labels, and which pages are in which, in what order) is a **shared** setting, one JSON file on the server (`packages/shell/nav-layout.json`, gitignored -- runtime state, not source) via `GET`/`PUT /api/nav-layout` -- not per-browser `localStorage`, so everyone hitting the real dashboard URL sees the same arrangement. It's only **editable** (drag-and-drop -- drop a page onto a category's header to file it there, drop it beside another page to reorder, drop it on the thin strip below everything to pull it back out to the top level) when the app is reached via `localhost`: either a local dev copy, or RDP'ing into the production server itself and hitting its own `http://localhost:3000` directly (bypassing Caddy) to edit the *live* shared layout everyone else sees read-only via the real domain. Enforced server-side (`isLocalhostRequest()`, checked against the Host header, not the TCP peer -- which would be useless behind Caddy's reverse proxy, since every real request arrives locally-sourced at the socket level regardless of who's actually on the other end of the public domain), not just hidden in the UI. New page packages appear ungrouped at the top level on first load; a page package that's removed quietly drops out of the saved layout.
- **autotask-client** is shared plumbing (`getClient()`, `resolveResourceName()`, `resolveCompanyName()`) that any page needing Autotask data can depend on, so connection/rate-limit/name-resolution logic isn't duplicated per page.
- Each page package (e.g. **completed-tickets**) owns its own frontend module and, optionally, its own Express router - a self-contained unit one person can build and review independently.

## Pages

- **Completed Tickets** (`packages/completed-tickets`) - pick a date, see every ticket completed that day across all clients, grouped by the technician who closed it. Excludes tickets with issue type "Monitoring Alert".
- **Tickets Created** (`packages/tickets-created-today`) - pick a date, see every ticket created that day, grouped by company. Same "Monitoring Alert" exclusion as Completed Tickets.
- **Contract Services** (`packages/contract-services`) - pick a month (and optionally filter by client and/or service name, with `*` wildcards), see every active service/service-bundle line item on contracts covering that month, grouped by company. See its own README for the data model -- it's the most involved page, spanning six Autotask entities.
- **Client Details** (`packages/client-details`) - pick a criteria from a dropdown (active, inactive, any, no primary contact, no main billing contact, no invoice since a moving two-year-ago cutoff), see the matching companies with classification, last invoice, and contact info. Not date-scoped -- a live snapshot rather than a per-period report.
- **Client Contacts** (`packages/client-contacts`) - pick which contacts to show (primary, main billing, both, or all active), optionally filter by Client / Company Type / Classification (`*` wildcards against the resolved picklist label, not the raw code), see matching contacts across active clients. Not date-scoped.
- **Clients by Classification** (`packages/classification-summary`) - a horizontal bar chart, one bar per classification, counting active clients; click a bar to drill into that classification's client list. Auto-loads on open (with a Refresh button) rather than waiting for a Search click, since there's no criteria to fill in first -- the one page on this dashboard that intentionally breaks from that convention.
- **Client Financials** (`packages/client-financials`) - type a client name (must resolve to exactly one company, via the shared `resolveSingleCompany()`), see a 12-month invoiced-amounts summary (Labour / Recurring Services / Charges, by month plus a total) and that window's invoice list.
- **Client Activity** (`packages/client-activity`) - type a client name (single-company, same resolution flow as Client Financials), see 12-month ticket volume (created/completed) and logged hours (billable/non-billable), a currently-open ticket snapshot by status and priority, and the list of tickets created in that window.
- **Asked for Review** (`packages/asked-for-review`) - pick any date, see every ticket asked for a Google review (the "Ask For Review" UDF = `ASK`) that week, Monday through Sunday, broken into a section per day.
- **Ingram Subscriptions** (`packages/ingram-subscriptions`) - every active and pending Ingram Micro Cloud Marketplace subscription, grouped by client. Not Autotask data -- its own API client and credentials (Ingram's Cloud Marketplace API, not the Autotask REST API). Not date-scoped -- a live snapshot, auto-loads on open with a Refresh button.

### Adding a new page

1. Create a new folder under `packages/`, e.g. `packages/my-page/`.
2. Add a `package.json` with a `dashboardPage` field:
   ```json
   {
     "name": "@dashboard/my-page",
     "private": true,
     "dashboardPage": {
       "id": "my-page",
       "label": "My Page",
       "client": "client.js",
       "server": "server.js"
     }
   }
   ```
3. Write `client.js` exporting `id`, `label`, and `mount(container)` (renders your UI into the given DOM element).
4. Optionally write `server.js` exporting an Express `Router` - the shell mounts it at `/api/my-page`.
5. If you need Autotask data, add `"@dashboard/autotask-client": "*"` to your dependencies and `require('@dashboard/autotask-client')`.
6. Run `npm install` from the repo root so the new workspace package gets linked.

That's it - no shell code changes needed. The sidebar and routing pick up the new page automatically on next server start.

## Setup

1. Install dependencies. The `autotask-node` package (used by `@dashboard/autotask-client`) lives on GitHub Packages, so you need a GitHub personal access token with `read:packages` scope for the `wyre-technology` org:

   ```powershell
   $env:NPM_GITHUB_TOKEN = "ghp_your_token_here"
   npm install
   ```

   This installs and links every package in `packages/` in one go (npm workspaces).

2. Copy `.env.example` to `.env` (at the repo root) and fill in your Autotask API credentials:

   ```
   AUTOTASK_USERNAME=...
   AUTOTASK_SECRET=...
   AUTOTASK_INTEGRATION_CODE=...
   ```

3. Start the server:

   ```powershell
   npm start
   ```

4. Open http://localhost:3000

## Securing the dashboard

Every page and every `/api/*` route requires signing in with a Microsoft 365 account from your own tenant (`packages/shell/auth.js`, wired in `packages/shell/server.js`). It's Microsoft Entra ID (Azure AD) via OpenID Connect - there's no separate local username/password, so access is exactly whoever can sign in to your Microsoft 365 tenant (further narrowed if you use the options below).

### One-time setup in the Entra admin center

1. **App registrations -> New registration.**
   - Name: anything recognizable, e.g. "Ambient IT Dashboard".
   - Supported account types: **Accounts in this organizational directory only (Single tenant)** - this alone is what restricts sign-in to your org; anyone outside the tenant is rejected by Microsoft before your app ever sees them.
   - Redirect URI: platform **Web**. Add **one per address this app is reached at** - both `http://localhost:3000/auth/callback` (local dev, and editing the shared sidebar layout - see below) and the real production one, e.g. `https://dashboard.ambientit.com.au/auth/callback`. An app registration can hold several; the app itself picks whichever one matches the request it's currently handling (see "Multiple addresses" below), so all of them need to be registered up front, not just the one you're deploying to right now.
2. **Certificates & secrets -> New client secret.** Copy the secret's **value** immediately - Entra only shows it once.
3. **API permissions**: Microsoft Graph -> Delegated -> `openid`, `profile`, `email`, `User.Read`. These are typically pre-consented; no admin-consent button needed for just these four.
4. Note the **Application (client) ID** and **Directory (tenant) ID** from the app's Overview page.
5. Optional, for a smaller allowed group than "anyone in the tenant": on the app registration, **Properties -> "Assignment required?" = Yes**, then assign specific users/groups under **Enterprise applications -> (this app) -> Users and groups**. This is enforced by Microsoft at sign-in time, before your app is involved.

### Config

Fill these into `.env` (see `.env.example` for the full list): `AUTH_CLIENT_ID`, `AUTH_CLIENT_SECRET`, `AUTH_TENANT_ID`, `SESSION_SECRET` (any long random string - `openssl rand -hex 32`), and optionally `AUTH_ALLOWED_USERS` (comma-separated exact emails, a second layer of narrowing enforced in the app itself rather than Entra, on top of whatever the "Assignment required" setting above does). There's deliberately no `APP_BASE_URL` - see "Multiple addresses" below.

### Multiple addresses (localhost AND the production domain)

This app is reachable at more than one address **at the same time** - `http://localhost:3000` directly, and the real dashboard domain via Caddy - and needs sign-in to work correctly from both (the sidebar's drag-and-drop editing, further down this README, specifically depends on being able to stay signed in on `localhost` through a full Microsoft sign-in, not get bounced elsewhere). Two things in `auth.js` are derived from each request's own Host header rather than a single fixed value, so this works automatically:

- **Redirect URI** (`redirectUriFor(req)`) - `${req.protocol}://${req.get('host')}/auth/callback`. An earlier version of this pinned the redirect URI to one fixed `APP_BASE_URL` env var; signing in from `localhost:3000` still got redirected to the production URL by Microsoft (Entra sends the browser to whatever redirect URI it was told, and it was always told the production one), silently defeating localhost-only editing. Fixed by computing it per-request instead - both addresses are already registered in Entra (above), so Microsoft accepts either.
- **Session cookie's `secure` flag** (`cookie.secure: 'auto'`) - same reasoning: a fixed `true` (right for HTTPS production) would mean the browser silently refuses to send the cookie back over plain HTTP on localhost; a fixed `false` would weaken the production cookie. `'auto'` decides per-request from `req.secure`, which respects `X-Forwarded-Proto` (Caddy sends this) since `trust proxy` is enabled.

### How it behaves

- Visiting any page while signed out redirects to Microsoft's sign-in page, then back to whatever URL was originally requested (`/auth/login`, `/auth/callback` in `auth.js`).
- Every `/api/*` call from a page's `client.js` goes through a shared `fetch` wrapper (`packages/shell/public/app.js`) that treats a `401` (session expired, or signed out server-side) as "bounce the whole page to sign-in" rather than surfacing it as an error inside whatever page happened to be open.
- Sessions last 8 hours (`cookie.maxAge` in `auth.js`) - an internal work tool, not a long-lived login.
- The sidebar shows who's signed in (bottom of the nav) with a **Sign out** link, which also ends the Microsoft session (not just this app's), so it doesn't silently sign back in via SSO on a shared machine. Signing out returns you to whichever address (localhost or the real domain) you were actually signed in from, same request-derived logic as sign-in.
- Rejects tokens from any tenant other than `AUTH_TENANT_ID` as defense-in-depth, even though the app registration being single-tenant should already prevent that.

## Notes

- "Completed" (for the Completed Tickets page) means Autotask ticket status ID 5 (Complete).
- Resource and company names are resolved via the Autotask API and cached in memory for the life of the server process.
- `GET /api/completed-tickets?date=YYYY-MM-DD` returns the raw JSON if you want to consume it elsewhere.