require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });

const fs = require('fs');
const path = require('path');
const express = require('express');
const { getClient } = require('@dashboard/autotask-client');
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