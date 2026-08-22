require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });

const fs = require('fs');
const path = require('path');
const express = require('express');
const { getClient } = require('@dashboard/autotask-client');
const { exchangeCodeForTokens, BASE_URL: STRETY_BASE_URL } = require('@dashboard/strety-client');
// A wholly separate Strety connection, deliberately -- its own limited-
// access account, own OAuth client id/secret (packages/strety-autotask-
// sync/.env, not the repo-root .env every other package shares), own token
// file. See that package's README for why. Requiring this module has the
// side effect of loading ITS .env into process.env (same pattern as this
// file's own dotenv.config() call above), which is what makes
// STRETY_AUTOMATION_CLIENT_ID below resolve correctly.
const stretyAutomationClient = require('@dashboard/strety-autotask-sync/client.js');
const { registerAuthRoutes, requireAuth } = require('./auth');

const PORT = process.env.PORT || 3000;
const packagesRoot = path.resolve(__dirname, '..');

// A "page" is any sibling package under packages/ whose package.json has a
// `dashboardPage` field. Drop a new package in and it shows up automatically --
// no shell code changes needed.
function discoverPages() {
  const dirs = fs
    .readdirSync(packagesRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'shell')
    .map((d) => d.name);

  const pages = [];
  for (const dir of dirs) {
    const pkgPath = path.join(packagesRoot, dir, 'package.json');
    if (!fs.existsSync(pkgPath)) continue;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (!pkg.dashboardPage) continue;
    pages.push({
      dir,
      root: path.join(packagesRoot, dir),
      ...pkg.dashboardPage,
    });
  }
  return pages;
}

const pages = discoverPages();

// Shared sidebar layout (categories + page order/grouping) -- one JSON file
// on disk, not per-browser localStorage, since the whole point is that
// everyone hitting the real dashboard URL sees the SAME arrangement. Not
// checked into git (see .gitignore) -- it's runtime-configured state, not
// source, and survives a `git pull` redeploy naturally as an untracked file
// already sitting in the working directory.
const NAV_LAYOUT_PATH = path.join(__dirname, 'nav-layout.json');

function readNavLayout() {
  try {
    return JSON.parse(fs.readFileSync(NAV_LAYOUT_PATH, 'utf8'));
  } catch {
    return null; // no file yet, or unreadable -- client falls back to its own built-in default
  }
}

function writeNavLayout(tree) {
  fs.writeFileSync(NAV_LAYOUT_PATH, JSON.stringify(tree, null, 2));
}

// The sidebar is only editable (drag-and-drop) when the app is reached via
// localhost -- either a local dev copy, or RDP'ing into the production
// server itself and hitting its own http://localhost:3000 directly
// (bypassing Caddy) to edit the LIVE shared layout everyone else sees via
// the real domain. `req.hostname` reflects the Host header the browser
// actually sent -- NOT the TCP peer address, which would be useless here
// since Caddy reverse-proxies every real request to this same box, making
// every request look locally-sourced at the socket level regardless of who
// is really on the other end of the public domain.
function isLocalhostRequest(req) {
  return req.hostname === 'localhost' || req.hostname === '127.0.0.1';
}

const app = express();

// Session + /auth/login, /auth/callback, /auth/logout, /api/me -- mounted
// first so sign-in itself is reachable while signed out. Everything
// registered after requireAuth() below (static files, pages-registry.js,
// per-page client.js, every /api/<page> router) requires a signed-in
// Microsoft 365 account from the tenant configured in .env.
registerAuthRoutes(app);
app.use(requireAuth);

// Strety connection -- a separate, occasional admin-level action (connect
// the shared Strety integration this dashboard's Strety-backed pages use),
// distinct from the dashboard's own Microsoft 365 sign-in above. Mounted
// AFTER requireAuth (unlike the dashboard's own /auth/* routes, which have
// to work while signed out) -- only an already-signed-in dashboard user can
// (re)connect Strety. Confirmed against the real API that Strety has no
// client_credentials grant, so this real browser round-trip is the only way
// to obtain a token at all, not just a nicety.
function stretyRedirectUriFor(req) {
  // Same request-derived-host reasoning as auth.js's redirectUriFor() --
  // works from localhost during dev and the real domain in production
  // without a fixed env var, as long as each host's own callback URL is
  // separately registered with Strety.
  return `${req.protocol}://${req.get('host')}/auth/strety/callback`;
}

app.get('/auth/strety/connect', (req, res) => {
  if (!process.env.STRETY_CLIENT_ID) {
    return res.status(500).send('STRETY_CLIENT_ID is not configured in .env.');
  }
  const url = new URL(`${STRETY_BASE_URL}/oauth/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', process.env.STRETY_CLIENT_ID);
  url.searchParams.set('redirect_uri', stretyRedirectUriFor(req));
  // Both scopes, not just `read` -- confirmed the token this connection had
  // been issuing was read-only: a real write attempt (POST a check-in) got
  // a 403 INVALID_SCOPE, "re-authorize the app with the required scopes."
  // What's On only ever reads, but this connection is shared account-wide
  // (see this package's own README), so a page that DOES need to write
  // (a one-time Autotask -> Strety check-in write) needs the token itself
  // to carry write access too.
  url.searchParams.set('scope', 'read write');
  // A hint, not a hard requirement -- Strety's own login page uses whatever
  // Strety session is already active in the browser doing the reconnect
  // (real, confirmed behavior: a browser already signed into strety.com as
  // a personal account reuses that session instead of prompting fresh), so
  // this connection's `connectedAs` can end up recording a real employee's
  // personal login rather than the shared helpdesk account, purely by
  // accident of whichever browser/session did the reconnecting. `login_hint`
  // is the standard OAuth2/OIDC convention for "please pre-fill this
  // address" -- NOT independently confirmed against Strety's own OAuth
  // implementation (this is a browser-rendered login page, not something
  // scriptable to verify), but a standards-compliant provider either honors
  // it or silently ignores an unrecognized param -- no working case gets
  // worse either way. Doesn't override an existing active session by
  // itself; logging out of Strety (or using a private window) first is
  // still the reliable way to guarantee a fresh prompt.
  url.searchParams.set('login_hint', 'helpdesk@ambientit.com.au');
  res.redirect(url.toString());
});

app.get('/auth/strety/callback', async (req, res) => {
  if (req.query.error) {
    return res.status(403).send(`Strety authorization failed: ${req.query.error_description || req.query.error}`);
  }
  try {
    await exchangeCodeForTokens(req.query.code, stretyRedirectUriFor(req));
    res.send('Strety connected successfully -- you can close this tab.');
  } catch (err) {
    console.error('Strety OAuth callback failed:', err);
    res.status(500).send('Strety connection failed. Check server logs.');
  }
});

// The Autotask -> Strety automation's OWN connect/callback pair -- same
// shape as /auth/strety/connect above, just pointed at the automation's
// separate client id/token file (see stretyAutomationClient, above). Lives
// here (on this already-running, already-HTTPS-terminated server) rather
// than in packages/strety-autotask-sync itself, because the automation's
// own code is a periodic standalone script with no server of its own to
// catch an OAuth redirect with -- this one-time browser round-trip needs a
// real running endpoint, and this server already is one.
function stretyAutomationRedirectUriFor(req) {
  return `${req.protocol}://${req.get('host')}/auth/strety-automation/callback`;
}

app.get('/auth/strety-automation/connect', (req, res) => {
  if (!process.env.STRETY_AUTOMATION_CLIENT_ID) {
    return res.status(500).send('STRETY_AUTOMATION_CLIENT_ID is not configured in packages/strety-autotask-sync/.env.');
  }
  const url = new URL(`${STRETY_BASE_URL}/oauth/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', process.env.STRETY_AUTOMATION_CLIENT_ID);
  url.searchParams.set('redirect_uri', stretyAutomationRedirectUriFor(req));
  url.searchParams.set('scope', 'read write');
  res.redirect(url.toString());
});

app.get('/auth/strety-automation/callback', async (req, res) => {
  if (req.query.error) {
    return res.status(403).send(`Strety authorization failed: ${req.query.error_description || req.query.error}`);
  }
  try {
    await stretyAutomationClient.exchangeCodeForTokens(req.query.code, stretyAutomationRedirectUriFor(req));
    res.send('Strety (Autotask sync automation account) connected successfully -- you can close this tab.');
  } catch (err) {
    console.error('Strety automation OAuth callback failed:', err);
    res.status(500).send('Strety automation connection failed. Check server logs.');
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/pages-registry.js', (req, res) => {
  const entries = pages
    .map(
      (p) =>
        `  { id: ${JSON.stringify(p.id)}, label: ${JSON.stringify(p.label)}, module: () => import('/pages/${p.id}/client.js') },`
    )
    .join('\n');
  res.type('application/javascript').send(`export const pages = [\n${entries}\n];\n`);
});

app.get('/pages/:id/client.js', (req, res) => {
  const page = pages.find((p) => p.id === req.params.id);
  if (!page || !page.client) return res.status(404).end();
  res.type('application/javascript').sendFile(path.join(page.root, page.client));
});

app.get('/api/nav-layout', (req, res) => {
  res.json({ tree: readNavLayout(), editable: isLocalhostRequest(req) });
});

app.put('/api/nav-layout', express.json(), (req, res) => {
  // Enforced here too, not just hidden in the UI (a hidden drag handle is
  // not access control) -- a request to save a layout from anywhere other
  // than localhost is rejected outright, regardless of what the client sent.
  if (!isLocalhostRequest(req)) {
    return res.status(403).json({ error: 'The sidebar layout can only be edited via localhost.' });
  }
  if (!Array.isArray(req.body?.tree)) {
    return res.status(400).json({ error: 'Body must be { tree: [...] }.' });
  }
  writeNavLayout(req.body.tree);
  res.json({ ok: true });
});

app.get('/api/health', async (req, res) => {
  try {
    const client = await getClient();
    const ok = await client.testConnection();
    res.json({ ok });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

for (const page of pages) {
  if (!page.server) continue;
  const router = require(path.join(page.root, page.server));
  app.use(`/api/${page.id}`, router);
}

// Bound to localhost-only, not every network interface -- the intended path
// in is always through a reverse proxy (Caddy in production, terminating
// real HTTPS) in front of this port, never this raw HTTP port directly.
// HOST is overridable via env var for the rare case that's not true (e.g. a
// container where the proxy is a separate host), but 127.0.0.1 is the safe
// default so a firewall misconfiguration doesn't expose plain-HTTP sign-in
// straight to the internet.
const HOST = process.env.HOST || '127.0.0.1';
app.listen(PORT, HOST, () => {
  console.log(`Dashboard shell running at http://${HOST}:${PORT}`);
  console.log(`Pages loaded: ${pages.map((p) => p.id).join(', ') || '(none)'}`);
});