// Shared, MUTABLE page/nav-layout state -- split out of server.js so a
// page's own server.js (a separate sibling package, e.g.
// external-page-builder, tab-page-builder) can register a brand-new page
// package at runtime and have it appear immediately, without a process
// restart. See that package's own comment for the full reasoning; the
// short version: the `pages` array below is read fresh on every request
// by both /pages-registry.js and /pages/:id/client.js in server.js, so
// pushing a new descriptor into it here is enough -- there is no separate
// cache to invalidate. A page with its own server.js ALSO gets its own
// /api/<id> router mounted immediately by registerPage() below (via
// mountPageRouter(), wired up by server.js at startup) -- Tab Page
// Builder's own generated pages need this (their own permanent-tabs
// GET/PUT), unlike External Page Builder's, which never ship a server.js
// at all.
const fs = require('fs');
const path = require('path');

const packagesRoot = path.resolve(__dirname, '..');

// A "page" is any sibling package under packages/ whose package.json has a
// `dashboardPage` field. Drop a new package in and it shows up automatically
// on the next process start -- no shell code changes needed. (A page added
// at RUNTIME, after this initial scan, is instead added directly to the
// `pages` array below via registerPage() -- this function itself is only
// ever called once, at module load.)
function discoverPages() {
  const dirs = fs
    .readdirSync(packagesRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'shell')
    .map((d) => d.name);

  const found = [];
  for (const dir of dirs) {
    const pkgPath = path.join(packagesRoot, dir, 'package.json');
    if (!fs.existsSync(pkgPath)) continue;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (!pkg.dashboardPage) continue;
    found.push({
      dir,
      root: path.join(packagesRoot, dir),
      ...pkg.dashboardPage,
    });
  }
  return found;
}

const pages = discoverPages();

// Appends a newly-created page package's descriptor to the live registry --
// mutates `pages` IN PLACE (push, not reassignment) so every existing
// holder of this array reference (server.js's destructured `pages`
// included) sees the addition immediately. `pageDescriptor` should have the
// same shape discoverPages() produces: { dir, root, id, label, client,
// server?, restrictedTo? }. Also mounts that page's own /api/<id> router
// (see mountPageRouter()/setMountPageRouterImpl() below) if it has one --
// so a page created at runtime with its own server.js works exactly as if
// it had existed at boot, on both the client and server side.
function registerPage(pageDescriptor) {
  pages.push(pageDescriptor);
  mountPageRouter(pageDescriptor);
}

// Indirection so this module (which has no Express `app` of its own --
// that lives in server.js) can still trigger mounting a page's own
// router. server.js calls setMountPageRouterImpl() once, right after it
// builds `app`, with the real implementation; every OTHER page's
// server.js (that creates NEW pages at runtime, e.g. External Page
// Builder, Tab Page Builder) just calls registerPage() as normal and gets
// this for free, without needing its own reference to `app` at all.
let mountPageRouterImpl = null;
function setMountPageRouterImpl(fn) {
  mountPageRouterImpl = fn;
}
function mountPageRouter(page) {
  if (mountPageRouterImpl) mountPageRouterImpl(page);
}

// Per-page visibility gate, on top of the dashboard-wide Microsoft 365 sign-in
// every page already requires (requireAuth in server.js) -- a page's package.json
// can set `dashboardPage.restrictedTo: [<lowercase email>, ...]` to hide it
// from everyone except those exact accounts (e.g. Ticket Dashboards (Test),
// while it's still being tried out). Checked in THREE places, not just the
// nav: /pages-registry.js (server.js) so an unauthorized browser's copy of
// registeredPages never even lists the page's id -- which also means
// app.js's own reconcileTree() can never auto-append it into that browser's
// sidebar, no separate nav-layout.json change needed; /pages/:id/client.js
// (server.js) so the page's own JS module can't be fetched directly by URL
// either; and the /api/<id> router mount (server.js) so the underlying data
// can't be reached by a direct API call even by someone who somehow got the
// page id. All three answer 404, not 403 -- the point is that the page
// doesn't appear to exist at all for anyone not on the list, not merely
// that it's visibly locked.
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

// One-person allowlist for every "only Amber can change this SHARED
// setting" gate across the dashboard -- originally just the sidebar
// layout (reorder + hide/unhide), now also Ticket Info's own permanent
// tabs (see ticket-info-tabs/server.js), so it lives here rather than
// inside shell/server.js, the same reason `pages`/pageVisibleTo/nav-layout
// live here: any sibling package's own server.js needs to reach it too.
// Same one-person-allowlist pattern as COLUMN_ADMIN_EMAIL/isColumnAdmin()
// in TC Elite Rollout.
const DASHBOARD_ADMIN_EMAIL = 'amber@ambientit.com.au';
function isDashboardAdmin(req) {
  const email = req.session.user?.email;
  return !!email && email.toLowerCase() === DASHBOARD_ADMIN_EMAIL;
}

module.exports = {
  pages,
  discoverPages,
  registerPage,
  setMountPageRouterImpl,
  mountPageRouter,
  pageVisibleTo,
  NAV_LAYOUT_PATH,
  readNavLayout,
  writeNavLayout,
  DASHBOARD_ADMIN_EMAIL,
  isDashboardAdmin,
};
