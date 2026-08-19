# @dashboard/strety-client

Shared client for **Strety** (an EOS -- Entrepreneurial Operating System -- operating platform: Rocks, Scorecards, To-Dos, the Issues List/IDS), a wholly separate system from Autotask. Mirrors the shape of `@dashboard/ingram-client`/`@dashboard/itglue-client` (a thin `get()` wrapper other pages import), but with a real OAuth2 flow underneath instead of a static API key.

## Auth is real OAuth2, not a static key

Confirmed against the real API: Strety does **not** support the `client_credentials` grant (`POST /oauth/token` with that grant type returns `{"error":"unsupported_grant_type",...}`). Only `authorization_code` works -- a human has to approve access once via a real browser login before this package has any token to use at all. There's no simpler personal-access-token option either (checked).

- **Authorize**: `GET https://2.strety.com/api/v1/oauth/authorize?response_type=code&client_id=...&redirect_uri=...` -- a real browser redirect + login + consent screen.
- **Token exchange**: `POST https://2.strety.com/api/v1/oauth/token`, **form-encoded** (`application/x-www-form-urlencoded`), not JSON -- confirmed against the real API: a JSON body gets a 415. `grant_type=authorization_code` needs `client_id`/`client_secret`/`code`/`redirect_uri`; `grant_type=refresh_token` needs `client_id`/`client_secret`/`refresh_token`.
- Access tokens last 2 hours (`expires_in: 7200`, confirmed against real data) -- refreshed via the refresh token, not by re-doing the browser login.

`packages/shell/server.js`'s `/auth/strety/connect` (redirects to the authorize URL) and `/auth/strety/callback` (exchanges the resulting code) routes are the one-time (or occasional re-auth) setup step -- both gated behind the dashboard's own `requireAuth`, unlike the dashboard's own Microsoft 365 sign-in routes, which have to work while signed out.

## Token storage

Persisted to `packages/strety-client/.tokens.json` (gitignored -- real bearer credentials, never committed), not just kept in memory -- access tokens only last 2 hours, and this server process needs to keep working across restarts without a human re-doing the browser login every time. `getAccessToken()` reads the stored tokens, returns the access token directly if still valid, or refreshes (and re-persists) first if it's expired -- concurrent callers hitting a stale token share ONE refresh rather than each firing their own (`refreshInFlight`, same shape as Ingram's own token cache).

Calling `get()`/`fetchAllPages()` before anything has ever been connected throws an error tagged `err.strety_not_connected = true`, so a page's `server.js` can show a real "connect Strety first" message instead of a confusing raw 401 bubbling up from Strety itself.

## Pagination -- confirmed quirks

- Max page size is **20** (`page[size]`/`page[number]`) -- confirmed against the real API: `page[size]: 100` returns `{"error":"page[size] must be between 1 and 20"}`. Much lower than Ingram's 500 or IT Glue's 1000.
- `fetchAllPages()` walks every page at that ceiling until the running total covers the response's own `meta.total_count`.
- The `sort` query param is **not reliable** when combined with `filter[...]` params -- confirmed against real data: a `GET /todos?filter[completed]=false&filter[assignee_id]=...&sort=due_date` request came back in no discernible order at all (verified: not ascending, not descending, not creation order). `fetchAllPages()` deliberately doesn't expose a `sort` passthrough at all -- callers collect the full result set and sort it themselves in JS (see My Strety Tasks).

## Confirmed filters (exact-match only, same limitation as IT Glue)

- `filter[email]` on `/people` -- exact match.
- `filter[completed]` on `/todos` -- `true`/`false`, the only working way to scope to open vs. done (`filter[status]=open` and `filter[completed_at]=null` both 400).
- `filter[assignee_id]` on `/todos` -- confirmed `/todos` is **account-wide**, not scoped to whichever person's login originally connected the integration; every real person's todos are visible through this one shared connection, filtered by whichever `assignee_id` a caller asks for.
