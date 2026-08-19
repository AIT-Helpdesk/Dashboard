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
  return res.data;
}

function persistTokenResponse(data) {
  // expires_in is seconds-from-now at the moment of THIS response, not an
  // absolute time -- converted to a real timestamp once, here, so every
  // later read just compares against Date.now() rather than needing to
  // remember when the response itself arrived.
  writeTokens({
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    // Refreshed 5 minutes before actual expiry, same "don't hand out a
    // token that dies mid-flight" reasoning as Ingram's own token cache.
    expiresAt: Date.now() + (data.expires_in - 300) * 1000,
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
  const res = await axios.post(`${BASE_URL}/oauth/token`, form, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  persistTokenResponse(res.data);
  return res.data.access_token;
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

async function get(path, params) {
  const accessToken = await getAccessToken();
  const res = await axios.get(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    params,
  });
  return res.data;
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

module.exports = { get, fetchAllPages, exchangeCodeForTokens, isConnected, BASE_URL };
