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
// and CATEGORY-level access (categoryAccessFor) both match by name, not
// email -- restrictedTo itself still matches by email, unchanged.
//
// A page also inherits whatever access rule its own sidebar CATEGORY
// currently has configured (see categoryAccessFor below) -- e.g. a page
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
    const access = categoryAccessFor(categoryId);
    if (access && !access.open) {
      const name = user?.name?.trim().toLowerCase();
      if (!name || !access.names.includes(name)) return false;
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

// Turns any free-text label into the suffix half of a MENUCATEGORY_ key --
// uppercased, any run of non-alphanumeric characters collapsed to one
// underscore, no leading/trailing underscore. Used both directions: to
// derive the key a category's own visible label maps to, and (in
// reconcileEnvCategories below) to derive a sensible title-cased label
// back out of a key that doesn't match anything yet.
function normalizeForEnvKey(text) {
  return text
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// A sidebar category can have its own access rule in .env -- the key is
// MENUCATEGORY_ followed by the category's own VISIBLE LABEL (not its
// internal id, which often doesn't match -- e.g. the "Client Financials"
// category's real id is "financials", "Contract Mgmt"'s is
// "update-contracts"), normalized per normalizeForEnvKey above (e.g.
// "Trackers - Complete" -> MENUCATEGORY_TRACKERS_COMPLETE, "Testing" ->
// MENUCATEGORY_TESTING). By request: matching against the id would have
// been an internal implementation detail Amber can't see or reason about
// day to day -- the label is what's actually on the menu, so that's what
// the .env key should mirror.
//
// CONFIRMED the hard way this matters: an earlier version of this
// function matched by id, so MENUCATEGORY_CLIENT_FINANCIALS (a
// perfectly reasonable guess at "Client Financials") matched nothing --
// the real id is "financials" -- and silently created a brand-new, empty,
// duplicate "client-financials" category instead of restricting the real
// one. Label matching still isn't typo-proof (a genuine misspelling, e.g.
// "Mgmnt" instead of "Mgmt", still won't match) -- see the console.log in
// reconcileEnvCategories below, which is the fastest way to notice a
// mismatch like that: a category being auto-CREATED on every restart
// generally means the .env key didn't match anything real.
//
// Returns one of three shapes, each meaning something different to a
// caller (pageVisibleTo below, stripHiddenForUser in server.js):
//   - null                          -- env var not set at all. No access
//                                      rule configured; caller falls back
//                                      to the plain hidden:true/
//                                      stripHidden behaviour instead.
//   - { open: true }                -- env var set but its value is blank
//                                      (or "DELETE" -- see
//                                      reconcileEnvCategories below for
//                                      why that can still reach here) --
//                                      by request, this means "no
//                                      individual lockdown needed, allow
//                                      everyone" rather than a real
//                                      restriction. Never hidden.
//   - { open: false, names: [...] } -- comma-separated exact Entra
//                                      display names, same format/
//                                      matching as ADMIN_FULL_ACCESS and
//                                      TRACKER_MANAGER. Restricted to
//                                      exactly this list (plus
//                                      ADMIN_FULL_ACCESS, who always
//                                      bypasses every category rule).
//                                      value = "ADMIN ONLY" is this same
//                                      shape with an EMPTY names list --
//                                      nobody's name can ever match an
//                                      empty array, so only
//                                      ADMIN_FULL_ACCESS (checked before
//                                      this function is ever consulted,
//                                      at each call site) gets through.
//                                      Deliberately reuses the ordinary
//                                      restricted-list mechanism rather
//                                      than a fourth return shape.
// This is what makes "any category mentioned in .env restricts itself
// automatically" work with zero code changes per category -- by request,
// so Amber can add more restricted categories later just by adding more
// lines to .env, never touching this file again.
//
// CONFIRMED the hard way this prefix matters and isn't optional: an
// earlier version of this function derived the bare key (TESTING, not
// MENUCATEGORY_TESTING) because that's what got pasted into this
// conversation at the time -- production's real .env had already been set
// up with the MENUCATEGORY_ prefix (matching Amber's own original
// description of this feature), so this function silently returned null
// there even though TESTING's actual intended value was sitting right
// there under a different key. No error anywhere -- it just read as "this
// category has no access rule configured" and fell back to plain
// hidden:true, invisible to anyone who wasn't already ADMIN_FULL_ACCESS.
// If this ever goes quiet again, check the exact env var name on THAT
// machine's real .env before assuming the code is wrong.
function categoryAccessFor(categoryId) {
  const tree = readNavLayout() || [];
  const node = tree.find((n) => n.type === 'category' && n.id === categoryId);
  // Falls back to the id itself only if the category has somehow vanished
  // out from under an already-resolved categoryId (a genuine race, not a
  // normal call shape -- every real caller resolves categoryId from a
  // page/category that's already known to exist in the tree it just read).
  const envKey = `MENUCATEGORY_${normalizeForEnvKey(node ? node.label : categoryId)}`;
  if (!(envKey in process.env)) return null;
  const raw = (process.env[envKey] || '').trim();
  if (raw === '' || raw.toUpperCase() === 'DELETE') return { open: true };
  if (raw.toUpperCase() === 'ADMIN ONLY') return { open: false, names: [] };
  const names = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return { open: false, names };
}

// Runs once at process startup (called right after `const pages =
// discoverPages()` above) -- scans every MENUCATEGORY_<LABEL> key in .env
// and reconciles the sidebar tree against it, matching against each
// existing category's own LABEL (normalizeForEnvKey'd -- see
// categoryAccessFor above for why label, not id), by request:
//   - No existing category's label matches -> creates a new empty one
//     (fresh id from the key's own words, hyphenated; label the same
//     words, title-cased -- e.g. MENUCATEGORY_AMBER_ONLY -> id
//     "amber-only", label "Amber Only"), landing at the root of the
//     sidebar, same "lands at root, drag into place" convention every
//     builder on this dashboard already uses. Runs regardless of the
//     value (blank, "DELETE", or a real name list) -- even a "DELETE"
//     for a category that doesn't exist yet is simply a no-op, never a
//     reason to create one just to immediately consider deleting it.
//     LOGGED to the console every time -- the fastest way to notice a
//     typo'd .env key (meant to restrict an EXISTING category, e.g.
//     "Mgmnt" instead of "Mgmt") is seeing an unexpected "Auto-created
//     Menu Category" line at startup for a category that should already
//     have existed.
//   - value is exactly "DELETE" (case-insensitive) AND a matching
//     category exists AND it's currently EMPTY (no children) -> removes
//     it outright. A category that still has real pages in it is left
//     completely alone, on purpose -- never force-deleted, so a stray
//     "DELETE" can't silently orphan or hide real pages. Once deleted,
//     later restarts just no-op on the same line forever (no more
//     matching category to find), so there's no need to remember to
//     clean up the .env line afterward.
//   - Otherwise (a matching category already exists, value isn't DELETE)
//     -- nothing to reconcile structurally; categoryAccessFor above is
//     what actually governs who can see it, checked fresh on every
//     request, not just at startup.
function reconcileEnvCategories() {
  const tree = readNavLayout();
  if (!tree) return; // no nav-layout.json yet -- nothing to reconcile against
  let changed = false;
  for (const key of Object.keys(process.env)) {
    const match = /^MENUCATEGORY_(.+)$/.exec(key);
    if (!match) continue;
    const suffix = match[1];
    const rawValue = (process.env[key] || '').trim();
    const existingIndex = tree.findIndex((n) => n.type === 'category' && normalizeForEnvKey(n.label) === suffix);

    if (rawValue.toUpperCase() === 'DELETE') {
      if (existingIndex !== -1 && tree[existingIndex].children.length === 0) {
        console.log(`[nav] Deleted Menu Category "${tree[existingIndex].label}" (${key}=DELETE, it was empty).`);
        tree.splice(existingIndex, 1);
        changed = true;
      }
      continue;
    }

    if (existingIndex === -1) {
      const words = suffix.toLowerCase().split('_').filter(Boolean);
      const label = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      const id = words.join('-');
      console.log(`[nav] Auto-created Menu Category "${label}" (${key}) -- new, no existing category's label matched "${suffix}". If you meant to restrict an EXISTING category instead, check its exact label in the sidebar and fix the .env key to match.`);
      tree.push({ type: 'category', id, label, children: [] });
      changed = true;
    }
  }
  if (changed) writeNavLayout(tree);
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

// Auto-creates/deletes sidebar categories purely from .env's own
// MENUCATEGORY_<ID> entries -- run ONCE, right here at module load (once
// per process start, same as every other env-configured thing on this
// dashboard needing a restart to take effect). By request: a brand-new
// restricted category can be stood up with nothing more than an .env
// line + a restart, no nav-layout.json hand-editing and no code change,
// from here on. Called down here, AFTER NAV_LAYOUT_PATH/readNavLayout/
// writeNavLayout above rather than right after discoverPages() near the
// top of this file -- confirmed the hard way that calling it any earlier
// hits those consts' temporal dead zone (readNavLayout's own try/catch
// swallows the ReferenceError and silently returns null, so this looked
// like "nothing happened" rather than a crash).
reconcileEnvCategories();

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
  categoryAccessFor,
  NAV_LAYOUT_PATH,
  readNavLayout,
  writeNavLayout,
  isAdminFullAccess,
  isDashboardAdmin,
};
