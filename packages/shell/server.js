require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });

const fs = require('fs');
const path = require('path');
const express = require('express');
const { getClient } = require('@dashboard/autotask-client');
const { exchangeCodeForTokens, BASE_URL: STRETY_BASE_URL, getPersonalClient } = require('@dashboard/strety-client');
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

// Per-page visibility gate, on top of the dashboard-wide Microsoft 365 sign-in
// every page already requires (requireAuth below) -- a page's package.json
// can set `dashboardPage.restrictedTo: [<lowercase email>, ...]` to hide it
// from everyone except those exact accounts (e.g. Ticket Dashboards (Test),
// while it's still being tried out). Checked in THREE places, not just the
// nav: /pages-registry.js (below) so an unauthorized browser's copy of
// registeredPages never even lists the page's id -- which also means
// app.js's own reconcileTree() can never auto-append it into that browser's
// sidebar, no separate nav-layout.json change needed; /pages/:id/client.js
// (below) so the page's own JS module can't be fetched directly by URL
// either; and the /api/<id> router mount (bottom of this file) so the
// underlying data can't be reached by a direct API call even by someone who
// somehow got the page id. All three answer 404, not 403 -- the point is
// that the page doesn't appear to exist at all for anyone not on the list,
// not merely that it's visibly locked.
function pageVisibleTo(page, email) {
  if (!page.restrictedTo) return true;
  return !!email && page.restrictedTo.includes(email.toLowerCase());
}

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

// Every Strety connect/callback route below (three separate connections --
// shared, personal, automation) used to just res.send() a bare line of
// text on success/failure, leaving whoever just finished the real browser
// OAuth round trip with no way back to the dashboard except the browser's
// own back button. By request: a real "Return to Dashboard" button,
// wrapped around whatever plain message each call site already had.
// Plain <a>, not a JS reload -- navigating back to "/" is itself already a
// full fresh page load, so whichever page they land on (the shell's
// default) re-mounts and re-fetches live, no separate "refresh" step
// needed on top of the navigation itself.
// req.query.error/.error_description (used below) come straight off the
// OAuth redirect's own query string -- attacker-craftable, unlike every
// other message passed to stretyConnectPage() below, which are all
// hardcoded strings. Escaped before ever reaching stretyConnectPage()'s
// raw HTML interpolation.
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function stretyConnectPage(message, returnHref = '/#whats-on') {
  // Lands specifically on What's On (#whats-on), not a bare "/" -- this is
  // a full browser navigation (not a SPA-internal route change), so it
  // resets every module-level JS variable client.js has, including
  // lastData/lastTodayTomorrowData. Landing on What's On this way means
  // its own mount() naturally re-fetches BOTH Scorecards and Today &
  // Tomorrow (including My Strety Tasks) fresh, correctly reflecting
  // whichever Strety connection was just (re)authorized -- by request, no
  // separate refresh-coupling code needed for that at all. A bare "/"
  // would instead land on whatever page happens to be first in the
  // sidebar (app.js's currentPageId() fallback), not necessarily this one.
  //
  // `returnHref`, when the caller passes one (the personal connect flow's
  // success case does), adds a real query flag on top of that --
  // confirmed necessary against real testing: Today & Tomorrow's own
  // /today-tomorrow response is cached server-side for 10 minutes per
  // email, so a plain fresh mount() still served the STALE
  // personalNotConnected result fetched before this connect happened,
  // even though the client-side reset alone was working correctly. See
  // whats-on/client.js's own handling of `?strety_connected=1`, which
  // force-bypasses that cache for this one load.
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Strety</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 3rem auto; padding: 0 1.5rem; text-align: center;">
  <p>${message}</p>
  <a href="${returnHref}" style="display: inline-block; padding: 0.6rem 1.4rem; background: #2563eb; color: white; border-radius: 6px; text-decoration: none; font-weight: 600;">Return to Dashboard</a>
</body>
</html>`;
}

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
    return res.status(403).send(stretyConnectPage(`Strety authorization failed: ${escapeHtml(req.query.error_description || req.query.error)}`));
  }
  try {
    await exchangeCodeForTokens(req.query.code, stretyRedirectUriFor(req));
    res.send(stretyConnectPage('Strety connected successfully.'));
  } catch (err) {
    console.error('Strety OAuth callback failed:', err);
    res.status(500).send(stretyConnectPage('Strety connection failed. Check server logs.'));
  }
});

// The signed-in dashboard user's OWN personal Strety connection -- see
// @dashboard/strety-client's getPersonalClient() for the full "why a
// second connection at all" story. Unlike /auth/strety/connect above
// (one shared connection, same for everyone), THIS one's whole point is
// that it's per-person: the callback below has to know WHICH dashboard
// user just authorized, so it can store the resulting token under their
// own file rather than one shared one. That comes from req.session.user
// itself, not a query param -- both routes only ever run inside the same
// signed-in browser session that started the redirect round trip (mounted
// after requireAuth below, same as /auth/strety/connect), so there's
// nothing to pass through Strety and back.
function stretyPersonalRedirectUriFor(req) {
  return `${req.protocol}://${req.get('host')}/auth/strety-personal/callback`;
}

app.get('/auth/strety-personal/connect', (req, res) => {
  if (!process.env.STRETY_CLIENT_ID) {
    return res.status(500).send('STRETY_CLIENT_ID is not configured in .env.');
  }
  const url = new URL(`${STRETY_BASE_URL}/oauth/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', process.env.STRETY_CLIENT_ID);
  url.searchParams.set('redirect_uri', stretyPersonalRedirectUriFor(req));
  // Read-only -- every personal-data feature this connection powers (My
  // Strety Tasks, Today & Tomorrow, Personal scorecards) only ever reads.
  url.searchParams.set('scope', 'read');
  // Hints Strety's login page toward the CURRENT dashboard user's own
  // email, so the right account is pre-filled -- same "hint, not a hard
  // requirement" caveat as the shared connection's own login_hint above
  // (an already-active Strety session in that browser gets reused
  // regardless). Unlike that one, this hint is genuinely correct for
  // whoever's clicking it, not a fixed guess.
  url.searchParams.set('login_hint', req.session.user.email);
  res.redirect(url.toString());
});

app.get('/auth/strety-personal/callback', async (req, res) => {
  if (req.query.error) {
    return res.status(403).send(stretyConnectPage(`Strety authorization failed: ${escapeHtml(req.query.error_description || req.query.error)}`));
  }
  try {
    await getPersonalClient(req.session.user.email).exchangeCodeForTokens(req.query.code, stretyPersonalRedirectUriFor(req));
    res.send(stretyConnectPage('Your Strety account is connected.', '/?strety_connected=1#whats-on'));
  } catch (err) {
    console.error('Strety personal OAuth callback failed:', err);
    res.status(500).send(stretyConnectPage('Strety connection failed. Check server logs.'));
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

// CONFIRMED root cause (2026-08-28), not just a theoretical risk: this
// route being reachable by any signed-in dashboard user, surfaced via a
// "Reconnect" link on What's On to everyone, is exactly how the shared
// automation connection ended up authorized as a real employee (Melissa)
// instead of helpdesk@ -- she clicked a "fix the stale numbers" banner on
// her own Helpdesk/Personal Scorecards view, and Strety's login page
// silently reused her own already-active session rather than the
// login_hint below. Every automated check-in since then was correctly,
// faithfully attributed to her -- there was no bug in what Strety recorded,
// only in who was allowed to trigger the reconnect. Gated to Amber only
// for now (both here and its matching visibility gate in
// packages/whats-on/server.js's canSeeAutomationStatus) while a permanent
// design gets decided. This token store (packages/strety-autotask-sync/
// .tokens.json, via stretyAutomationClient) is read ONLY by sync.js's
// scheduled writes -- confirmed nothing dashboard-facing requires this
// module anywhere else, so reconnecting it here never affects what Strety
// data any user's own dashboard session sees.
const STRETY_AUTOMATION_ADMIN_EMAIL = 'amber@ambientit.com.au';
function isStretyAutomationAdmin(req) {
  const email = req.session.user?.email;
  return !!email && email.toLowerCase() === STRETY_AUTOMATION_ADMIN_EMAIL;
}

// The admin gate above (isStretyAutomationAdmin) fixed "wrong PERSON
// triggers the reconnect" -- it does NOT fix "the right person's own
// browser happens to already have a different Strety session active",
// which is a second, separate way this has gone wrong (Strety's login page
// silently reuses whatever session is already active, ignoring
// login_hint). By request, a real interstitial page now sits in front of
// the actual redirect -- shown by default; the redirect itself only fires
// from THIS page's own "Continue to Strety" link (`?go=1`), never directly
// from a bookmark/banner link straight into Strety. Also surfaces the
// currently-connected identity (connectedIdentity() -- a plain file read,
// works even mid-outage) so whoever's here can see at a glance whether
// it's already wrong, and a direct "Disconnect Only" link/route (below)
// for forcing it off without needing production file-system access.
function stretyAutomationConnectInterstitialPage() {
  const connectedAs = stretyAutomationClient.connectedIdentity();
  const currentLine = connectedAs
    ? `<p>Currently connected as: <strong>${escapeHtml(connectedAs)}</strong></p>`
    : `<p>Not currently connected.</p>`;
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Strety</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 34rem; margin: 3rem auto; padding: 0 1.5rem; text-align: center;">
  <h2>Reconnect Helpdesk Automation</h2>
  ${currentLine}
  <p style="text-align: left; background: #fef3c7; border: 1px solid #f59e0b; border-radius: 6px; padding: 0.75rem 1rem;">
    <strong>Before continuing:</strong> make sure THIS browser is not already logged into Strety as
    anyone else -- Strety's own login page silently reuses whatever Strety session is already
    active, regardless of which account this tries to hint at. Log out of Strety first, or use a
    private/incognito window, then log in as <strong>helpdesk@ambientit.com.au</strong> when
    prompted.
  </p>
  <p>
    <a href="/auth/strety-automation/connect?go=1" style="display: inline-block; padding: 0.6rem 1.4rem; background: #2563eb; color: white; border-radius: 6px; text-decoration: none; font-weight: 600; margin: 0.3rem;">Continue to Strety</a>
    <a href="/auth/strety-automation/disconnect" style="display: inline-block; padding: 0.6rem 1.4rem; background: #b91c1c; color: white; border-radius: 6px; text-decoration: none; font-weight: 600; margin: 0.3rem;">Disconnect Only</a>
  </p>
  <p><a href="/#whats-on">Return to Dashboard</a></p>
</body>
</html>`;
}

app.get('/auth/strety-automation/connect', (req, res) => {
  if (!isStretyAutomationAdmin(req)) {
    return res.status(403).send(stretyConnectPage('Reconnecting the Helpdesk automation account is restricted to Amber for now.'));
  }
  if (!process.env.STRETY_AUTOMATION_CLIENT_ID) {
    return res.status(500).send('STRETY_AUTOMATION_CLIENT_ID is not configured in packages/strety-autotask-sync/.env.');
  }
  if (req.query.go !== '1') {
    return res.send(stretyAutomationConnectInterstitialPage());
  }
  const url = new URL(`${STRETY_BASE_URL}/oauth/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', process.env.STRETY_AUTOMATION_CLIENT_ID);
  url.searchParams.set('redirect_uri', stretyAutomationRedirectUriFor(req));
  url.searchParams.set('scope', 'read write');
  // A hint, not a hard requirement -- Strety's login page reuses whatever
  // Strety session is already active in the connecting browser regardless
  // of this hint. Doesn't override an existing active session by itself;
  // logging out of Strety (or using a private window) first is still the
  // reliable way to guarantee helpdesk@ gets prompted fresh. The admin gate
  // above is what actually prevents the wrong PERSON from reconnecting this
  // -- this hint alone never was that guarantee, which is exactly how it
  // went wrong last time.
  url.searchParams.set('login_hint', 'helpdesk@ambientit.com.au');
  res.redirect(url.toString());
});

app.get('/auth/strety-automation/callback', async (req, res) => {
  // Same admin gate as /connect above, checked again here rather than
  // trusted from that earlier request -- STRETY_AUTOMATION_CLIENT_ID isn't
  // treated as a secret (it's a plain OAuth query param, visible in this
  // very URL), so someone could in principle reach this callback with a
  // real code without ever passing through our own /connect route.
  if (!isStretyAutomationAdmin(req)) {
    return res.status(403).send(stretyConnectPage('Reconnecting the Helpdesk automation account is restricted to Amber for now.'));
  }
  if (req.query.error) {
    return res.status(403).send(stretyConnectPage(`Strety authorization failed: ${escapeHtml(req.query.error_description || req.query.error)}`));
  }
  try {
    await stretyAutomationClient.exchangeCodeForTokens(req.query.code, stretyAutomationRedirectUriFor(req));
    // Names the identity it actually just connected as, by request -- the
    // whole point of the interstitial above is checking this BEFORE
    // authorizing; this closes the loop by confirming it AFTER, so a wrong
    // reconnect (the browser's own Strety session wasn't actually helpdesk@,
    // despite the warning) is caught immediately rather than discovered
    // later from a wrongly-attributed check-in.
    const connectedAs = stretyAutomationClient.connectedIdentity();
    res.send(
      stretyConnectPage(
        connectedAs
          ? `Strety (Autotask sync automation account) connected successfully, as ${escapeHtml(connectedAs)}.`
          : 'Strety (Autotask sync automation account) connected successfully.'
      )
    );
  } catch (err) {
    console.error('Strety automation OAuth callback failed:', err);
    res.status(500).send(stretyConnectPage('Strety automation connection failed. Check server logs.'));
  }
});

// A real "Disconnect" action, by request -- the only previous way to force
// a stale/wrong-account connection off was deleting .tokens.json by hand on
// the production box. Same admin gate as connect/callback above. The
// scheduled sync (sync.js) will start failing on its next run until
// reconnected -- that's the point, not a side effect: better a loud,
// visible failure on What's On than continuing to write as the wrong
// account.
app.get('/auth/strety-automation/disconnect', (req, res) => {
  if (!isStretyAutomationAdmin(req)) {
    return res.status(403).send(stretyConnectPage('Disconnecting the Helpdesk automation account is restricted to Amber for now.'));
  }
  stretyAutomationClient.clearTokens();
  res.send(
    `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Strety</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 3rem auto; padding: 0 1.5rem; text-align: center;">
  <p>Helpdesk automation account disconnected. The scheduled sync will fail (visibly, on What's On) until reconnected.</p>
  <p>
    <a href="/auth/strety-automation/connect" style="display: inline-block; padding: 0.6rem 1.4rem; background: #2563eb; color: white; border-radius: 6px; text-decoration: none; font-weight: 600; margin: 0.3rem;">Reconnect Now</a>
    <a href="/#whats-on" style="display: inline-block; padding: 0.6rem 1.4rem; background: #6b7280; color: white; border-radius: 6px; text-decoration: none; font-weight: 600; margin: 0.3rem;">Return to Dashboard</a>
  </p>
</body>
</html>`
  );
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/pages-registry.js', (req, res) => {
  const entries = pages
    .filter((p) => pageVisibleTo(p, req.session.user?.email))
    .map(
      (p) =>
        `  { id: ${JSON.stringify(p.id)}, label: ${JSON.stringify(p.label)}, module: () => import('/pages/${p.id}/client.js') },`
    )
    .join('\n');
  res.type('application/javascript').send(`export const pages = [\n${entries}\n];\n`);
});

app.get('/pages/:id/client.js', (req, res) => {
  const page = pages.find((p) => p.id === req.params.id);
  if (!page || !page.client || !pageVisibleTo(page, req.session.user?.email)) return res.status(404).end();
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
  // Same restrictedTo check as the page-serving routes above -- otherwise a
  // page hidden from the sidebar/client.js would still leak its real data to
  // anyone who guessed its /api/<id> path.
  app.use(`/api/${page.id}`, (req, res, next) => {
    if (!pageVisibleTo(page, req.session.user?.email)) return res.status(404).json({ error: 'Not found.' });
    next();
  }, router);
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