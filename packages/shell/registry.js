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
//
// Takes the whole `user` object ({email, name} -- req.session.user, or
// null when signed out), not just an email, since ADMIN_FULL_ACCESS below
// and CATEGORY-level access (categoryAllowedNames) both match by name, not
// email -- restrictedTo itself still matches by email, unchanged.
//
// A page also inherits whatever access list its own sidebar CATEGORY
// currently has configured (see categoryAllowedNames below) -- e.g. a page
// filed under "Trackers - Complete" is only visible to whoever
// MENUCATEGORY_TRACKERS_COMPLETE lists, on top of (not instead of) any restrictedTo the
// page has of its own. Both checks are ANDed together deliberately: a
// page's own narrower restrictedTo (e.g. Ticket Dashboards (Test), still
// Amber-only) is never silently loosened just because its category grants
// broader access to more people.
function pageVisibleTo(page, user) {
  if (isAdminFullAccess(user)) return true;
  if (page.restrictedTo) {
    const email = user?.email;
    if (!email || !page.restrictedTo.includes(email.toLowerCase())) return false;
  }
  const categoryId = categoryIdForPage(page.id);
  if (categoryId) {
    const allowed = categoryAllowedNames(categoryId);
    if (allowed !== null) {
      const name = user?.name?.trim().toLowerCase();
      if (!name || !allowed.includes(name)) return false;
    }
  }
  return true;
}

// Which sidebar category (if any) a page currently sits directly under --
// read fresh from nav-layout.json every call (same "no separate cache to
// invalidate" tradeoff as reading `pages` itself), since which category a
// page is filed under can change at runtime (drag-and-drop reorder, or
// Rollout Tracker Builder's own Hide Complete/Un-Complete This moving a
// tracker between "Trackers" and "Trackers - Complete"). Only ever one
// level deep -- nav-layout.json never nests a category inside another.
function categoryIdForPage(pageId) {
  const tree = readNavLayout() || [];
  for (const node of tree) {
    if (node.type === 'category' && Array.isArray(node.children) && node.children.some((c) => c.id === pageId)) {
      return node.id;
    }
  }
  return null;
}

// A sidebar category can have its own access list in .env -- the key is
// MENUCATEGORY_ followed by the category's id, uppercased with hyphens
// turned to underscores (e.g. "trackers-complete" ->
// MENUCATEGORY_TRACKERS_COMPLETE, "testing" -> MENUCATEGORY_TESTING),
// value a comma-separated list of exact Entra display names, same
// format/matching as ADMIN_FULL_ACCESS and TRACKER_MANAGER. Returns null
// when that env var isn't set at all -- the category has NO explicit
// access list configured, so callers fall back to the plain hidden:true/
// stripHidden behaviour instead. This is what makes "any category
// mentioned in .env restricts itself automatically" work with zero code
// changes per category -- by request, so Amber can add more restricted
// categories later just by adding more lines to .env, never touching this
// file again.
//
// CONFIRMED the hard way this prefix matters and isn't optional: an
// earlier version of this function derived the bare key (TESTING, not
// MENUCATEGORY_TESTING) because that's what got pasted into this
// conversation at the time -- production's real .env had already been set
// up with the MENUCATEGORY_ prefix (matching Amber's own original
// description of this feature), so categoryAllowedNames('testing')
// silently returned null there even though TESTING's actual intended
// value was sitting right there under a different key. No error anywhere
// -- it just read as "this category has no access list configured" and
// fell back to plain hidden:true, invisible to anyone who wasn't already
// ADMIN_FULL_ACCESS. If this ever goes quiet again, check the exact env
// var name on THAT machine's real .env before assuming the code is wrong.
function categoryAllowedNames(categoryId) {
  const envKey = `MENUCATEGORY_${categoryId.toUpperCase().replace(/-/g, '_')}`;
  if (!(envKey in process.env)) return null;
  return (process.env[envKey] || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
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

// Dashboard-wide full-access allowlist, driven by .env's ADMIN_FULL_ACCESS
// -- comma-separated exact Entra display names, same format/matching as
// TRACKER_MANAGER (rollout-tracker-permissions.js) and every category
// access list above. This is now the SINGLE source of truth for "only
// Amber can change this SHARED setting" across the whole dashboard --
// the sidebar layout (reorder + hide/unhide), Ticket Info's own permanent
// tabs (ticket-info-tabs/server.js), TC Elite Rollout's own column-admin
// gate, Contract Checks' note-template editor, What's On's automation
// status banner, the Strety automation reconnect flow, and every
// category-level access list above (an ADMIN_FULL_ACCESS name always
// bypasses those too) -- replacing what used to be a separately
// hardcoded 'amber@ambientit.com.au' email constant in each of those
// files. Matched by NAME (req.session.user.name, Entra's own displayName
// -- see auth.js), not email, the one deliberate departure from
// restrictedTo's own email matching, same reasoning TRACKER_MANAGER
// already established: a human-editable .env list beats maintaining
// exact emails everywhere.
function adminFullAccessNames() {
  return (process.env.ADMIN_FULL_ACCESS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}
function isAdminFullAccess(user) {
  const name = user?.name?.trim().toLowerCase();
  return !!name && adminFullAccessNames().includes(name);
}
function isDashboardAdmin(req) {
  return isAdminFullAccess(req.session?.user);
}

module.exports = {
  pages,
  discoverPages,
  registerPage,
  setMountPageRouterImpl,
  mountPageRouter,
  pageVisibleTo,
  categoryIdForPage,
  categoryAllowedNames,
  NAV_LAYOUT_PATH,
  readNavLayout,
  writeNavLayout,
  isAdminFullAccess,
  isDashboardAdmin,
};
