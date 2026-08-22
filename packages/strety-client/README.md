# @dashboard/strety-client

Shared client for **Strety** (an EOS -- Entrepreneurial Operating System -- operating platform: Rocks, Scorecards, To-Dos, the Issues List/IDS), a wholly separate system from Autotask. Mirrors the shape of `@dashboard/ingram-client`/`@dashboard/itglue-client` (a thin `get()` wrapper other pages import), but with a real OAuth2 flow underneath instead of a static API key.

## Multiple independent connections -- `createClient()`

This module's default export (`get`/`post`/`fetchAllPages`/`exchangeCodeForTokens`/`isConnected`/`connectedIdentity`) is this dashboard's own single default connection -- unchanged behavior for every existing caller (My Strety Tasks, What's On, `packages/shell/server.js`'s `/auth/strety/*` routes). Under the hood it's just one call to `createClient({ clientId, clientSecret, tokenStorePath, connectPath })`, which anyone can call again to get a **fully independent** second (or third...) connection -- its own credentials, its own token file on disk, its own throttle/refresh state, unable to share, clobber, or leak into any other client created this way.

This exists specifically for `packages/strety-autotask-sync` (an automated Autotask -> Strety write job, by request using its own limited-access Strety account rather than sharing the dashboard's own broader access) -- see that package's README for a real second-connection example, including where its own `/connect`/`/callback` routes have to live (on this dashboard's own already-running server, since the automation's own code has no server of its own to catch an OAuth redirect with).

## Auth is real OAuth2, not a static key

Confirmed against the real API: Strety does **not** support the `client_credentials` grant (`POST /oauth/token` with that grant type returns `{"error":"unsupported_grant_type",...}`). Only `authorization_code` works -- a human has to approve access once via a real browser login before this package has any token to use at all. There's no simpler personal-access-token option either (checked).

- **Authorize**: `GET https://2.strety.com/api/v1/oauth/authorize?response_type=code&client_id=...&redirect_uri=...` -- a real browser redirect + login + consent screen.
- **Token exchange**: `POST https://2.strety.com/api/v1/oauth/token`, **form-encoded** (`application/x-www-form-urlencoded`), not JSON -- confirmed against the real API: a JSON body gets a 415. `grant_type=authorization_code` needs `client_id`/`client_secret`/`code`/`redirect_uri`; `grant_type=refresh_token` needs `client_id`/`client_secret`/`refresh_token`.
- Access tokens last 2 hours (`expires_in: 7200`, confirmed against real data) -- refreshed via the refresh token, not by re-doing the browser login.

`packages/shell/server.js`'s `/auth/strety/connect` (redirects to the authorize URL) and `/auth/strety/callback` (exchanges the resulting code) routes are the one-time (or occasional re-auth) setup step -- both gated behind the dashboard's own `requireAuth`, unlike the dashboard's own Microsoft 365 sign-in routes, which have to work while signed out.

## Token storage

Persisted to `packages/strety-client/.tokens.json` (gitignored -- real bearer credentials, never committed), not just kept in memory -- access tokens only last 2 hours, and this server process needs to keep working across restarts without a human re-doing the browser login every time. `getAccessToken()` reads the stored tokens, returns the access token directly if still valid, or refreshes (and re-persists) first if it's expired -- concurrent callers hitting a stale token share ONE refresh rather than each firing their own (`refreshInFlight`, same shape as Ingram's own token cache).

Calling `get()`/`fetchAllPages()` before anything has ever been connected throws an error tagged `err.strety_not_connected = true`, so a page's `server.js` can show a real "connect Strety first" message instead of a confusing raw 401 bubbling up from Strety itself.

**A stored refresh token can itself go stale or get revoked** -- confirmed against real data this happens periodically, surfacing as `400 invalid_grant` on the `grant_type=refresh_token` exchange. `refreshTokens()` tags this distinctly, `err.strety_reauth_required = true`, separate from `strety_not_connected` -- "never connected at all" and "was connected, now needs a human to redo the browser login" are different situations even though the fix is the same (`/auth/strety/connect` again), and a page should say which one it is rather than showing a raw error. See What's On's README for the concrete page-level implementation (a `reauth-required` status, distinct wording from `not-connected`).

## Recording WHICH Strety account a connection belongs to

Confirmed against the real API: `GET /me` returns the real person behind whatever token is used (`name`/`email`/`role`, same shape as a `/people` row). `exchangeCodeForTokens()` calls this once, right after a fresh connect, and persists `name (email)` as `connectedAs` alongside the tokens -- **not** looked up on demand later, because a BROKEN connection (the exact situation this is meant to help with) can no longer call the API to ask who it is. `refreshTokens()` preserves whatever `connectedAs` is already on file rather than needing to re-look-it-up every ~2-hour refresh (the identity doesn't change just because the access token was renewed).

`connectedIdentity()` reads this back -- a plain file read, no API call, no auth required, works even when the connection itself is dead -- for exactly the "which account needs reconnecting" message this exists for. A token issued before this feature existed has no `connectedAs` recorded (`connectedIdentity()` returns `null` for it) -- it only starts populating from the next real reconnect onward, not retroactively.

## OAuth scope -- `read write`, not just `read`

`/auth/strety/connect` requests `scope=read write` -- confirmed against the real API this is necessary: a connection that only had `read` (the scope every connection before this had, since nothing had ever written before) got a real `403 INVALID_SCOPE` ("Missing or invalid scopes... re-authorize the app with the required scopes") on a genuine write attempt. **Refreshing an existing token does NOT pick up a newly-added scope** -- a token only carries whatever scope it was originally issued with, so upgrading an existing connection needs a fresh browser re-authorization via `/auth/strety/connect`, not just waiting for the next automatic refresh.

## Writing -- `post()`/`patch()`, real JSON:API, confirmed against real writes

`post(path, body)` and `patch(path, body)` mirror `get()`'s throttle/retry handling (same shared rate-limit defenses -- see below -- apply to writes too). Confirmed against the real API by actually creating and updating real check-ins (see `packages/strety-autotask-sync`):

- Needs the real JSON:API Content-Type, `application/vnd.api+json` -- confirmed a plain `application/json` body gets a `415 UNSUPPORTED_MEDIA_TYPE`. Both set this by default; callers don't need to.
- Body shape follows the JSON:API write convention: `{ data: { type: '<resource-type>', attributes: { ... } } }` -- confirmed against real successful `POST`/`PATCH /metrics/:id/check_ins[/:id]` calls (`type: 'metric_check_in'`).
- **`patch()` always sends `If-Match: *`** -- confirmed necessary against the real API: a PATCH without it gets a real `428 PRECONDITION_REQUIRED` ("requires an If-Match header for concurrency control... use If-Match: * to skip the check"). Always skipping the check (not fetching a real ETag first) is deliberate -- this dashboard is the only writer to any check-in it manages, so there's no real concurrent-edit case worth the extra fetch-then-conditional-update complexity for.
- **Strety enforces ONE check-in per metric per period** -- confirmed against the real API: a second `POST` for a period that already has a check-in (e.g. a second automated run the same day) gets a real `409 CONFLICT`, "Fetch and update it if needed" -- and helpfully includes the existing check-in's id directly in the error body (`errors[0].meta.existing_check_in.id`), so a caller can catch the 409 and `PATCH` that id instead of needing a separate lookup. See `packages/strety-autotask-sync/sync.js`'s `createOrUpdateCheckIn()` for the concrete pattern -- this isn't optional upsert-for-convenience, without it every run after the first for a given period would simply fail.

## Rate limiting -- confirmed real, retried with backoff

Confirmed against the real API: Strety enforces a genuine rate limit -- a 429 `{"errors":[{"status":"429","code":"TOO_MANY_REQUESTS",...}]}` under real, non-abusive dashboard use, not just synthetic load testing (What's On, which makes a dozen-plus Strety calls per page load, hit this repeatedly). `get()` retries a 429 up to 3 times with backoff (a real `Retry-After` header if Strety sends one, otherwise a short exponential wait) before giving up -- any other error status is NOT retried.

**A tight burst of requests can come back 200 with an empty/short result, not just a clean 429** -- confirmed against real use, and this is the more important finding: even after every page was made fully sequential (no `Promise.all` firing multiple Strety requests at once -- see My Strety Tasks' and What's On's own `server.js`), a single real page load still fired a dozen-plus calls back-to-back in well under a second, and Strety still returned successful-looking-but-empty responses. Retries can't fix that (nothing technically failed to retry) -- the actual fix was pacing, not just serializing: `get()` now enforces a real minimum gap (`MIN_REQUEST_INTERVAL_MS`, 300ms) between the start of any two outgoing requests through this shared client, via a module-level `throttle()`. Every caller benefits automatically regardless of which page/function is making the calls -- a page's own sequential loop now naturally spreads out over real time instead of firing as fast as Node/the network allow. The visible cost is a slower page load (a dozen-plus calls at ~300ms apart adds up), which is the deliberate tradeoff for reliability over speed here.

## Pagination -- confirmed quirks

- Max page size is **20** (`page[size]`/`page[number]`) -- confirmed against the real API: `page[size]: 100` returns `{"error":"page[size] must be between 1 and 20"}`. Much lower than Ingram's 500 or IT Glue's 1000.
- `fetchAllPages()` walks every page at that ceiling until the running total covers the response's own `meta.total_count`.
- The `sort` query param is **not reliable** when combined with `filter[...]` params -- confirmed against real data: a `GET /todos?filter[completed]=false&filter[assignee_id]=...&sort=due_date` request came back in no discernible order at all (verified: not ascending, not descending, not creation order). `fetchAllPages()` deliberately doesn't expose a `sort` passthrough at all -- callers collect the full result set and sort it themselves in JS (see My Strety Tasks).

## Confirmed filters (exact-match only, same limitation as IT Glue)

- `filter[email]` on `/people` -- exact match.
- `filter[completed]` on `/todos` -- `true`/`false`, the only working way to scope to open vs. done (`filter[status]=open` and `filter[completed_at]=null` both 400).
- `filter[assignee_id]` on `/todos` -- confirmed `/todos` is **account-wide**, not scoped to whichever person's login originally connected the integration; every real person's todos are visible through this one shared connection, filtered by whichever `assignee_id` a caller asks for.
