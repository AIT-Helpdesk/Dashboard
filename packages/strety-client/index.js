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
const { STRETY_CLIENT_ID: CLIENT_ID, STRETY_CLIENT_SECRET: CLIENT_SECRET } = process.env;

// Tokens are real credentials (bearer access to whichever Strety account
// connected), so this file is NOT committed -- see .gitignore. Persisted to
// disk, not just kept in memory, because access tokens only last 2 hours
// (confirmed against the real API: `expires_in: 7200`) and this server
// process needs to keep working across restarts without a human re-doing
// the browser login every time -- the refresh_token is what makes that
// possible, but only if it survives a restart itself.
const TOKEN_STORE_PATH = path.join(__dirname, '.tokens.json');

function readTokens() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_STORE_PATH, 'utf8'));
  } catch {
    return null; // not connected yet -- see /auth/strety/connect
  }
}

function writeTokens(tokens) {
  fs.writeFileSync(TOKEN_STORE_PATH, JSON.stringify(tokens));
}

// Called by the /auth/strety/callback route after a real browser
// authorization -- the ONE place a fresh authorization_code gets exchanged.
async function exchangeCodeForTokens(code, redirectUri) {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    redirect_uri: redirectUri,
  });
  const res = await axios.post(`${BASE_URL}/oauth/token`, form, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  persistTokenResponse(res.data);
  // Confirmed against the real API: GET /me returns the real person behind
  // whichever token is used (name/email/role). Recorded now, at connect
  // time, not looked up on demand later -- a BROKEN connection can no
  // longer call the API to ask who it is, so this is the only point where
  // it's askable at all. Non-fatal if it fails for some reason -- the
  // connection itself still works either way, it just won't have a
  // friendly identity to show on a later reauth-required message.
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
  // refresh (see refreshTokens() below) calls this WITHOUT it, and needs to
  // preserve whatever identity was already recorded rather than wiping it
  // out, since the identity doesn't change just because the access token
  // itself was renewed.
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
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
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
    // distinctly from strety_not_connected (which means "never connected at
    // all") so a caller can tell "this WAS working and now needs a human to
    // redo the browser login" apart from "nobody has connected yet" and
    // show the right message for each, rather than lumping both into one
    // generic error.
    err.strety_reauth_required = true;
    throw err;
  }
}

// Returns a currently-valid access token, refreshing (and re-persisting)
// first if the stored one is expired or close to it. Throws a clearly-
// labeled error if nothing has ever been connected yet, so a caller (a
// page's server.js) can show a real "connect Strety first" message instead
// of a confusing raw 401 from Strety itself.
async function getAccessToken() {
  const tokens = readTokens();
  if (!tokens) {
    const err = new Error('Strety is not connected yet -- visit /auth/strety/connect while signed in to the dashboard.');
    err.strety_not_connected = true;
    throw err;
  }
  if (Date.now() < tokens.expiresAt) return tokens.accessToken;
  // Concurrent requests landing while the token is stale share ONE refresh
  // rather than each firing their own -- same shape as Ingram's token cache.
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

// The recorded "name (email)" for whichever Strety person this connection
// belongs to (see exchangeCodeForTokens()), or null if never connected or
// the identity lookup never succeeded. Deliberately just a file read, no
// API call -- this needs to work even when the connection itself is
// broken, which is exactly the situation a caller wants this for (naming
// which account needs reconnecting on a reauth-required message).
function connectedIdentity() {
  return readTokens()?.connectedAs || null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Confirmed against real use: even with every caller in this dashboard
// already made sequential (no Promise.all firing multiple Strety requests
// at once -- see My Strety Tasks' and What's On's own server.js), a single
// page load still fires a dozen-plus calls back-to-back in well under a
// second, and that BURST alone is enough to make Strety return a
// successful-looking 200 with an empty/short result (not even a 429) --
// removing simultaneity wasn't enough on its own. This throttle enforces a
// real minimum gap between the START of any two outgoing requests through
// this shared client, regardless of which page/function is calling it, so
// a page's own sequential loop naturally spreads out over real time instead
// of firing as fast as Node/the network allow.
const MIN_REQUEST_INTERVAL_MS = 300;
let earliestNextRequestAt = 0;
async function throttle() {
  const now = Date.now();
  const waitMs = earliestNextRequestAt - now;
  earliestNextRequestAt = Math.max(now, earliestNextRequestAt) + MIN_REQUEST_INTERVAL_MS;
  if (waitMs > 0) await sleep(waitMs);
}

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
async function get(path, params) {
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
      if (err.response?.status !== 429 || attempt >= MAX_RETRIES) throw err;
      const retryAfterHeader = err.response.headers?.['retry-after'];
      const waitMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : 1000 * 2 ** attempt;
      await sleep(waitMs);
    }
  }
}

// Writes -- same throttle/retry treatment as get(), since a write can hit
// the same rate limit a read can. Confirmed against the real API: a plain
// `application/json` body gets a 415 -- Strety's write endpoints are real
// JSON:API and require the actual `application/vnd.api+json` media type
// (unlike the OAuth token endpoint, which needs form-encoding -- a
// different, unrelated quirk of that one specific endpoint).
async function post(path, body) {
  const accessToken = await getAccessToken();
  for (let attempt = 0; ; attempt++) {
    await throttle();
    try {
      const res = await axios.post(`${BASE_URL}${path}`, body, {
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/vnd.api+json' },
      });
      return res.data;
    } catch (err) {
      if (err.response?.status !== 429 || attempt >= MAX_RETRIES) throw err;
      const retryAfterHeader = err.response.headers?.['retry-after'];
      const waitMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : 1000 * 2 ** attempt;
      await sleep(waitMs);
    }
  }
}

// Walks every page of a list endpoint via `page[size]`/`page[number]` --
// confirmed against the real API that `page[size]` is capped at 20
// ("page[size] must be between 1 and 20", a much lower ceiling than Ingram's
// 500 or IT Glue's 1000), and that the `sort` query param is NOT reliable
// when combined with `filter[...]` params (confirmed against real data: a
// `sort=due_date` request came back in no discernible order at all) -- so
// this deliberately does NOT expose a `sort` passthrough; callers sort the
// fully-collected results themselves in JS instead of trusting the API to.
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

module.exports = { get, post, fetchAllPages, exchangeCodeForTokens, isConnected, connectedIdentity, BASE_URL };
