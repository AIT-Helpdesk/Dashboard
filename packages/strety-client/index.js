const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Strety (EOS operating-system software) API -- a wholly separate system
// from Autotask, mirroring the shape of @dashboard/ingram-client/
// @dashboard/itglue-client (thin get() wrapper), but with a real OAuth2
// authorization_code flow underneath instead of a static API key --
// confirmed against the real API that Strety does NOT support the simpler
// client_credentials grant (`{"error":"unsupported_grant_type",...}`), so a
// human has to approve access once via a real browser login before this
// package has anything to work with at all. See packages/shell/auth.js's
// /auth/strety/connect + /auth/strety/callback routes for that one-time (or
// occasional re-auth) step.
const BASE_URL = 'https://2.strety.com/api/v1';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Confirmed against real use: even with every caller in this dashboard
// already made sequential (no Promise.all firing multiple Strety requests
// at once -- see My Strety Tasks' and What's On's own server.js), a single
// page load still fires a dozen-plus calls back-to-back in well under a
// second, and that BURST alone is enough to make Strety return a
// successful-looking 200 with an empty/short result (not even a 429) --
// removing simultaneity wasn't enough on its own. Every client created by
// createClient() gets its OWN throttle state (deliberately -- two separate
// Strety connections, e.g. this dashboard's own and the Autotask -> Strety
// automation's limited-access one, are two separate accounts and shouldn't
// have to share a rate-limit budget that doesn't actually apply across them).
const MIN_REQUEST_INTERVAL_MS = 300;

// Confirmed against the real API: Strety enforces a real rate limit (a
// 429 "Too Many Requests" -- {"errors":[{"status":"429",...}]} -- under
// normal, non-abusive use of this dashboard, not just synthetic load
// testing). Rather than let a transient 429 fail an entire page (several of
// this dashboard's Strety-backed pages make a dozen-plus calls per load,
// see What's On's README), a 429 here is retried a few times with backoff
// before giving up -- honoring a real `Retry-After` header if Strety sends
// one, falling back to a short exponential wait otherwise. Any other error
// status is NOT retried (retrying a 401/404/etc. would just waste time
// before failing the same way anyway).
const MAX_RETRIES = 3;

// Creates a fully independent Strety client -- its own OAuth credentials,
// its own token file on disk, its own throttle/refresh state, entirely
// isolated from any other client created this way. This dashboard's own
// default connection (the plain `get`/`post`/etc. this module exports
// directly, below) is just one instance of this; the Autotask -> Strety
// automation (packages/strety-autotask-sync) creates a SEPARATE instance
// with its own limited-access credentials and its own token file, so the
// two connections can never share, clobber, or leak into each other.
function createClient({ clientId, clientSecret, tokenStorePath, connectPath = '/auth/strety/connect' }) {
  // Tokens are real credentials (bearer access to whichever Strety account
  // connected), so this file is NOT committed -- see .gitignore. Persisted
  // to disk, not just kept in memory, because access tokens only last 2
  // hours (confirmed against the real API: `expires_in: 7200`) and this
  // server process needs to keep working across restarts without a human
  // re-doing the browser login every time -- the refresh_token is what
  // makes that possible, but only if it survives a restart itself.
  function readTokens() {
    try {
      return JSON.parse(fs.readFileSync(tokenStorePath, 'utf8'));
    } catch {
      return null; // not connected yet -- see connectPath above
    }
  }

  function writeTokens(tokens) {
    fs.writeFileSync(tokenStorePath, JSON.stringify(tokens));
  }

  // Called by this connection's own /callback route after a real browser
  // authorization -- the ONE place a fresh authorization_code gets exchanged.
  async function exchangeCodeForTokens(code, redirectUri) {
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    });
    const res = await axios.post(`${BASE_URL}/oauth/token`, form, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    persistTokenResponse(res.data);
    // Confirmed against the real API: GET /me returns the real person
    // behind whichever token is used (name/email/role). Recorded now, at
    // connect time, not looked up on demand later -- a BROKEN connection
    // can no longer call the API to ask who it is, so this is the only
    // point where it's askable at all. Non-fatal if it fails for some
    // reason -- the connection itself still works either way, it just
    // won't have a friendly identity to show on a later reauth-required
    // message.
    try {
      const me = await get('/me', {});
      persistTokenResponse(res.data, `${me.data.attributes.name} (${me.data.attributes.email})`);
    } catch {
      // See above -- not fatal.
    }
    return res.data;
  }

  function persistTokenResponse(data, connectedAs) {
    // connectedAs is only ever passed at connect time (see above) -- a
    // refresh (see refreshTokens() below) calls this WITHOUT it, and needs
    // to preserve whatever identity was already recorded rather than
    // wiping it out, since the identity doesn't change just because the
    // access token itself was renewed.
    const existing = readTokens();
    writeTokens({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      // Refreshed 5 minutes before actual expiry, same "don't hand out a
      // token that dies mid-flight" reasoning as Ingram's own token cache.
      expiresAt: Date.now() + (data.expires_in - 300) * 1000,
      connectedAs: connectedAs || existing?.connectedAs || null,
    });
  }

  let refreshInFlight = null;

  async function refreshTokens(refreshToken) {
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    });
    try {
      const res = await axios.post(`${BASE_URL}/oauth/token`, form, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      persistTokenResponse(res.data);
      return res.data.access_token;
    } catch (err) {
      // Confirmed against real data this happens periodically (a stored
      // refresh token going stale/revoked, `400 invalid_grant`) -- tagged
      // distinctly from strety_not_connected (which means "never connected
      // at all") so a caller can tell "this WAS working and now needs a
      // human to redo the browser login" apart from "nobody has connected
      // yet" and show the right message for each, rather than lumping both
      // into one generic error.
      err.strety_reauth_required = true;
      throw err;
    }
  }

  // Returns a currently-valid access token, refreshing (and re-persisting)
  // first if the stored one is expired or close to it. Throws a clearly-
  // labeled error if nothing has ever been connected yet, so a caller (a
  // page's server.js) can show a real "connect Strety first" message
  // instead of a confusing raw 401 from Strety itself.
  //
  // `force` bypasses the expiresAt check and refreshes unconditionally --
  // confirmed necessary against real production data: Strety can reject a
  // real API call with a genuine `401 INVALID_TOKEN` for a token this
  // client's own bookkeeping still believes has time left (`expiresAt`
  // hasn't passed), if Strety itself invalidated it server-side for some
  // reason not visible from here. The proactive expiry check alone can't
  // catch that -- only a real 401 from Strety can -- see get()/post()/
  // patch()'s own one-time force-refresh-and-retry below, which is what
  // actually calls this with force: true.
  async function getAccessToken(force = false) {
    const tokens = readTokens();
    if (!tokens) {
      const err = new Error(`Strety is not connected yet -- visit ${connectPath} while signed in to the dashboard.`);
      err.strety_not_connected = true;
      throw err;
    }
    if (!force && Date.now() < tokens.expiresAt) return tokens.accessToken;
    // Concurrent requests landing while the token is stale share ONE
    // refresh rather than each firing their own -- same shape as Ingram's
    // own token cache.
    if (!refreshInFlight) {
      refreshInFlight = refreshTokens(tokens.refreshToken).finally(() => {
        refreshInFlight = null;
      });
    }
    return refreshInFlight;
  }

  function isConnected() {
    return readTokens() !== null;
  }

  // The recorded "name (email)" for whichever Strety person this
  // connection belongs to (see exchangeCodeForTokens()), or null if never
  // connected or the identity lookup never succeeded. Deliberately just a
  // file read, no API call -- this needs to work even when the connection
  // itself is broken, which is exactly the situation a caller wants this
  // for (naming which account needs reconnecting on a reauth-required
  // message).
  function connectedIdentity() {
    return readTokens()?.connectedAs || null;
  }

  // Deletes the token file outright, by request -- a real "Disconnect"
  // action (packages/shell/server.js's /auth/strety-automation/disconnect)
  // rather than the only previous way to force a stale/wrong-account
  // connection off, which was deleting the file by hand on the production
  // box. Tolerant of the file already being gone (already disconnected, or
  // never connected at all) -- disconnecting something that isn't
  // connected isn't an error. The connection just goes back to
  // "not connected yet" -- isConnected()/connectedIdentity() both read
  // straight off this same file, so nothing else needs telling.
  function clearTokens() {
    try {
      fs.unlinkSync(tokenStorePath);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  let earliestNextRequestAt = 0;
  async function throttle() {
    const now = Date.now();
    const waitMs = earliestNextRequestAt - now;
    earliestNextRequestAt = Math.max(now, earliestNextRequestAt) + MIN_REQUEST_INTERVAL_MS;
    if (waitMs > 0) await sleep(waitMs);
  }

  async function get(path, params, retriedAuth = false) {
    const accessToken = await getAccessToken();
    for (let attempt = 0; ; attempt++) {
      await throttle();
      try {
        const res = await axios.get(`${BASE_URL}${path}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
          params,
        });
        return res.data;
      } catch (err) {
        // Confirmed against real production data -- see getAccessToken()'s
        // own comment on `force`. One retry only (retriedAuth guards
        // against looping if Strety keeps saying 401 even with a freshly
        // forced token): force a real refresh, then retry the WHOLE
        // request once. If the refresh token itself is also dead,
        // refreshTokens() throws its own strety_reauth_required-tagged
        // error from inside getAccessToken(), which is the right thing to
        // surface either way -- this isn't swallowed, just given one real
        // chance to self-heal first.
        if (err.response?.status === 401 && !retriedAuth) {
          await getAccessToken(true);
          return get(path, params, true);
        }
        if (err.response?.status !== 429 || attempt >= MAX_RETRIES) throw err;
        const retryAfterHeader = err.response.headers?.['retry-after'];
        const waitMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : 1000 * 2 ** attempt;
        await sleep(waitMs);
      }
    }
  }

  // Writes -- same throttle/retry treatment as get(), since a write can hit
  // the same rate limit a read can. Confirmed against the real API: a
  // plain `application/json` body gets a 415 -- Strety's write endpoints
  // are real JSON:API and require the actual `application/vnd.api+json`
  // media type (unlike the OAuth token endpoint, which needs
  // form-encoding -- a different, unrelated quirk of that one specific
  // endpoint).
  async function post(path, body, retriedAuth = false) {
    const accessToken = await getAccessToken();
    for (let attempt = 0; ; attempt++) {
      await throttle();
      try {
        const res = await axios.post(`${BASE_URL}${path}`, body, {
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/vnd.api+json' },
        });
        return res.data;
      } catch (err) {
        // Same one-time force-refresh-and-retry as get() -- see that
        // function's own comment, and getAccessToken()'s, for why.
        if (err.response?.status === 401 && !retriedAuth) {
          await getAccessToken(true);
          return post(path, body, true);
        }
        if (err.response?.status !== 429 || attempt >= MAX_RETRIES) throw err;
        const retryAfterHeader = err.response.headers?.['retry-after'];
        const waitMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : 1000 * 2 ** attempt;
        await sleep(waitMs);
      }
    }
  }

  // Updates -- confirmed necessary against the real API: Strety enforces
  // ONE check-in per metric per period (a second POST for a period that
  // already has one gets a real `409 CONFLICT`, "Fetch and update it if
  // needed" -- helpfully including the existing check-in's id in the error
  // body). Same throttle/retry/Content-Type treatment as post().
  //
  // `If-Match: *` -- confirmed necessary too: PATCH alone gets a real `428
  // PRECONDITION_REQUIRED` ("requires an If-Match header for concurrency
  // control... use If-Match: * to skip the check"). Always skipping the
  // check (not fetching a real ETag first) is a deliberate choice -- this
  // dashboard is the only writer to any check-in it manages, so there's no
  // real concurrent-edit case worth the extra fetch-then-conditional-update
  // complexity for.
  async function patch(path, body, retriedAuth = false) {
    const accessToken = await getAccessToken();
    for (let attempt = 0; ; attempt++) {
      await throttle();
      try {
        const res = await axios.patch(`${BASE_URL}${path}`, body, {
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/vnd.api+json', 'If-Match': '*' },
        });
        return res.data;
      } catch (err) {
        // Same one-time force-refresh-and-retry as get() -- see that
        // function's own comment, and getAccessToken()'s, for why.
        if (err.response?.status === 401 && !retriedAuth) {
          await getAccessToken(true);
          return patch(path, body, true);
        }
        if (err.response?.status !== 429 || attempt >= MAX_RETRIES) throw err;
        const retryAfterHeader = err.response.headers?.['retry-after'];
        const waitMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : 1000 * 2 ** attempt;
        await sleep(waitMs);
      }
    }
  }

  // Walks every page of a list endpoint via `page[size]`/`page[number]` --
  // confirmed against the real API that `page[size]` is capped at 20
  // ("page[size] must be between 1 and 20", a much lower ceiling than
  // Ingram's 500 or IT Glue's 1000), and that the `sort` query param is NOT
  // reliable when combined with `filter[...]` params (confirmed against
  // real data: a `sort=due_date` request came back in no discernible order
  // at all) -- so this deliberately does NOT expose a `sort` passthrough;
  // callers sort the fully-collected results themselves in JS instead of
  // trusting the API to.
  async function fetchAllPages(path, params = {}) {
    const all = [];
    let page = 1;
    for (;;) {
      const res = await get(path, { ...params, 'page[size]': 20, 'page[number]': page });
      all.push(...res.data);
      if (all.length >= res.meta.total_count || res.data.length === 0) break;
      page++;
    }
    return all;
  }

  return { get, post, patch, fetchAllPages, exchangeCodeForTokens, isConnected, connectedIdentity, clearTokens };
}

// This dashboard's own default, pre-existing connection -- unchanged
// behavior for every existing caller (My Strety Tasks, What's On,
// packages/shell/server.js's /auth/strety/* routes). Backward compatible:
// `require('@dashboard/strety-client')` still gives get/post/etc. directly,
// spread onto module.exports below, exactly as before this file supported
// more than one connection at all.
const defaultClient = createClient({
  clientId: process.env.STRETY_CLIENT_ID,
  clientSecret: process.env.STRETY_CLIENT_SECRET,
  tokenStorePath: path.join(__dirname, '.tokens.json'),
  connectPath: '/auth/strety/connect',
});

// Per-signed-in-dashboard-user connections -- for anything scoped to an
// individual's own personal Strety space (their own todos, their own
// personal scorecard check-ins), as opposed to the single shared
// `defaultClient` above (kept on the shared helpdesk@ account, used for
// TEAM-scoped data only). Confirmed against real PRODUCTION data: the
// shared account has ZERO visibility into personal-space data at all --
// an unfiltered `/todos` query (no assignee filter) returned 0 rows,
// despite `filter[email]` on `/people` still finding the person fine (the
// directory itself is visible; personal-space content isn't). By request,
// the fix is NOT "connect the shared account to a more privileged Strety
// account" -- that would mean one connection with visibility into every
// technician's own tasks, including anything HR/management-sensitive,
// which was explicitly rejected as too high a risk. Instead each dashboard
// user connects THEIR OWN Strety account, once, the first time a personal-
// data feature needs it -- their own login only ever has visibility into
// their own stuff, so there's no shared elevated-access account at all.
//
// One createClient() instance per email, created lazily and cached for the
// life of this process (not recreated per request) so a given user's own
// throttle/refresh-in-flight state persists across their own repeated
// calls -- same reasoning createClient()'s own comment gives for why every
// connection needs its own state.
const personalClientsByEmail = new Map();
const PERSONAL_TOKENS_DIR = path.join(__dirname, '.personal-tokens');

// Tokens are named after the email (so a restart can find the right file
// back without a database), but an email isn't a safe filename verbatim on
// every filesystem -- kept to a conservative, unambiguous charset instead
// of trusting @ and friends to always be fine.
function sanitizeEmailForFilename(email) {
  return email.toLowerCase().replace(/[^a-z0-9.]/g, '_');
}

function getPersonalClient(email) {
  const key = email.toLowerCase();
  if (!personalClientsByEmail.has(key)) {
    if (!fs.existsSync(PERSONAL_TOKENS_DIR)) fs.mkdirSync(PERSONAL_TOKENS_DIR, { recursive: true });
    personalClientsByEmail.set(
      key,
      createClient({
        // Same registered Strety app/client id as the shared connection --
        // no separate Strety-side app registration needed just to support
        // a different real person authorizing it. OAuth's authorization_code
        // grant already lets many different people each authorize the same
        // client id, producing their own separate token -- that's exactly
        // what this is using it for. (The redirect_uri below DOES need to
        // be added to that Strety app's allowed redirect URIs, same as any
        // new callback route would.)
        clientId: process.env.STRETY_CLIENT_ID,
        clientSecret: process.env.STRETY_CLIENT_SECRET,
        tokenStorePath: path.join(PERSONAL_TOKENS_DIR, `${sanitizeEmailForFilename(key)}.json`),
        connectPath: '/auth/strety-personal/connect',
      })
    );
  }
  return personalClientsByEmail.get(key);
}

// Deep link to a to-do in Strety's own web app -- takes the todo's real
// (UUID) id. NOT derivable from the API: a real todo's raw JSON:API shape
// (type/id/attributes/relationships) carries no `links`/`permalink`/
// `web_url` field at all, confirmed via a live round-trip. WEB_ACCOUNT_ID
// is Ambient iT's own fixed Strety workspace id -- the leading path
// segment in every strety.com web-app URL, confirmed against a real URL a
// signed-in user pasted from their own browser
// (https://2.strety.com/<WEB_ACCOUNT_ID>/todos/<todoId>) -- not something
// this package can look up itself, so it's a plain constant here, same
// "2.strety.com" host BASE_URL's own API already points at (just the
// browser-facing app instead of /api/v1).
const WEB_ACCOUNT_ID = '714f93d7-437d-4d8d-a4f4-94f5da9c09ef';
function getTodoUrl(todoId) {
  if (!todoId) return null;
  return `https://2.strety.com/${WEB_ACCOUNT_ID}/todos/${todoId}`;
}

module.exports = { ...defaultClient, createClient, getPersonalClient, BASE_URL, getTodoUrl };
