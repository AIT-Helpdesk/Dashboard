import { pages as registeredPages } from './pages-registry.js';

// Every page's client.js calls plain fetch() for its /api/* calls -- rather
// than teaching each one to handle an expired session, wrap fetch once here:
// a 401 (session expired/signed out server-side) bounces the whole page to
// Microsoft sign-in instead of surfacing as a confusing "Error: Not signed
// in." inside whatever page happened to be open.
const nativeFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const res = await nativeFetch(...args);
  if (res.status === 401) {
    window.location.href = '/auth/login';
  }
  return res;
};

const navList = document.getElementById('nav-list');
const content = document.getElementById('page-content');
const userInfoEl = document.getElementById('user-info');
const serverHostnameEl = document.getElementById('server-hostname');

// Light/dark toggle -- per-browser (localStorage), like expanded-categories
// above, not the shared server-side nav layout. No stored preference means
// "follow the OS setting" (styles.css's prefers-color-scheme media query),
// same as before this button existed; picking a theme here stores an
// explicit override that wins regardless of the OS setting from then on. The
// actual attribute for a RETURNING visit is applied by the inline script in
// index.html's <head>, before this module even runs, to avoid a flash of the
// wrong theme -- this only needs to handle the click itself and set the
// button's own label/icon to match on load.
const THEME_KEY = 'dashboard.theme';
const themeToggle = document.getElementById('theme-toggle');

function effectiveTheme() {
  const stored = document.documentElement.getAttribute('data-theme');
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function renderThemeToggle() {
  const isDark = effectiveTheme() === 'dark';
  themeToggle.textContent = isDark ? '☀️ Light Mode' : '🌙 Dark Mode';
  themeToggle.setAttribute('aria-label', isDark ? 'Switch to light mode' : 'Switch to dark mode');
}

themeToggle.addEventListener('click', () => {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // localStorage unavailable -- the choice still applies for this page load, just won't persist.
  }
  renderThemeToggle();
});

renderThemeToggle();

// Collapse the sidebar down to a slim rail -- per-browser (localStorage),
// same "personal viewing preference, not the shared server-side nav tree"
// reasoning as expandedCategories below, and the same flash-avoidance
// pattern as the theme toggle above: the actual attribute for a RETURNING
// visit is applied by the inline script in index.html's <head>, before this
// module even runs; this only handles the click itself and the button's own
// icon/label to match on load. The collapsed state hides the logo/nav
// list/user info/theme toggle via CSS (html[data-sidebar-collapsed="true"]
// rules in styles.css) -- this button stays visible either way, it's the
// only way back out of the collapsed state.
const SIDEBAR_COLLAPSED_KEY = 'dashboard.sidebarCollapsed';
const sidebarToggle = document.getElementById('sidebar-toggle');

function isSidebarCollapsed() {
  return document.documentElement.getAttribute('data-sidebar-collapsed') === 'true';
}

function renderSidebarToggle() {
  const collapsed = isSidebarCollapsed();
  sidebarToggle.textContent = collapsed ? '»' : '«';
  sidebarToggle.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
  sidebarToggle.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
}

// Shared by the toggle button's own click below AND the auto-minimize-on
// nav-click behaviour (see renderPageItem()) -- pulled out to one place so
// both go through the exact same persist/attribute/re-render steps.
function setSidebarCollapsed(next) {
  if (next) document.documentElement.setAttribute('data-sidebar-collapsed', 'true');
  else document.documentElement.removeAttribute('data-sidebar-collapsed');
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next));
  } catch {
    // localStorage unavailable -- the choice still applies for this page load, just won't persist.
  }
  renderSidebarToggle();
}

sidebarToggle.addEventListener('click', () => setSidebarCollapsed(!isSidebarCollapsed()));

renderSidebarToggle();

// Pin -- by request, clicking a nav item auto-collapses the sidebar (see
// renderPageItem() below) unless pinned open. Persisted per-browser
// (localStorage), same "personal viewing preference" reasoning as
// sidebarCollapsed/theme above -- no flash-avoidance head-script needed
// for this one, though, since the only thing it affects on load is this
// one button's own active-look, not a page layout that could visibly
// jump/flash.
const SIDEBAR_PINNED_KEY = 'dashboard.sidebarPinned';
const sidebarPinToggle = document.getElementById('sidebar-pin-toggle');

function isSidebarPinned() {
  return document.documentElement.getAttribute('data-sidebar-pinned') === 'true';
}

function renderSidebarPinToggle() {
  const pinned = isSidebarPinned();
  sidebarPinToggle.classList.toggle('sidebar-pin-toggle--active', pinned);
  sidebarPinToggle.setAttribute('aria-label', pinned ? 'Unpin sidebar (auto-minimize on click)' : 'Pin sidebar open (disable auto-minimize on click)');
  sidebarPinToggle.title = sidebarPinToggle.getAttribute('aria-label');
}

// Shared by the toggle button's own click below AND the rotation engine
// (startRotation()/stopRotation() further down, which unpins for the
// duration of a rotation and restores whatever it was afterward) -- pulled
// out to one place so both go through the exact same persist/attribute/
// re-render steps, same reasoning setSidebarCollapsed() above already uses.
function setSidebarPinned(next) {
  if (next) document.documentElement.setAttribute('data-sidebar-pinned', 'true');
  else document.documentElement.removeAttribute('data-sidebar-pinned');
  try {
    localStorage.setItem(SIDEBAR_PINNED_KEY, String(next));
  } catch {
    // localStorage unavailable -- the choice still applies for this page load, just won't persist.
  }
  renderSidebarPinToggle();
}

sidebarPinToggle.addEventListener('click', () => setSidebarPinned(!isSidebarPinned()));

// Restore a saved pin from a previous visit -- read directly here (unlike
// theme/sidebar-collapsed, this doesn't need the synchronous head-script
// trick, see the comment above).
try {
  if (localStorage.getItem(SIDEBAR_PINNED_KEY) === 'true') {
    document.documentElement.setAttribute('data-sidebar-pinned', 'true');
  }
} catch {
  // localStorage unavailable -- falls back to unpinned.
}
renderSidebarPinToggle();

// Preview as a regular user -- admin-only, by request. Hidden by default
// (index.html sets `hidden` on the button itself); shown/wired up from
// init() below once loadTree() has confirmed this is actually an
// admin's own session (`editable`), same "reveal only once the server
// has actually confirmed admin" timing as the rest of the admin-only UI
// in this file. See isAdminView() (near the top of this file) for what
// this flag actually gates everywhere else.
const previewUserToggle = document.getElementById('preview-user-toggle');

function renderPreviewUserToggle() {
  previewUserToggle.classList.toggle('preview-user-toggle--active', previewAsUser);
  previewUserToggle.setAttribute('aria-label', previewAsUser ? 'Exit user preview (show admin view again)' : 'Preview as a regular user');
  previewUserToggle.title = previewUserToggle.getAttribute('aria-label');
}

previewUserToggle.addEventListener('click', () => {
  previewAsUser = !previewAsUser;
  try {
    localStorage.setItem(PREVIEW_AS_USER_KEY, String(previewAsUser));
  } catch {
    // localStorage unavailable -- the choice still applies for this page load, just won't persist.
  }
  renderPreviewUserToggle();
  renderNav(currentPageId());
});

// Refresh the whole dashboard, by request -- next to the pin button. A
// real full browser reload (not an SPA-internal re-fetch of just the
// current page), by design: this app has no single "refresh everything"
// entry point of its own -- every page manages its own cached state
// (lastData/lastJobs/etc module-scope variables, each page's own
// server-side report caches) independently, so reaching into every one of
// them individually would be significantly more code for the same
// end result a plain reload already gives for free -- nav layout,
// current page's data, and every one of those caches all start fresh.
document.getElementById('sidebar-refresh').addEventListener('click', () => {
  window.location.reload();
});

// Full screen / focus mode -- hides the sidebar entirely so the current
// page fills the whole window, by request. Deliberately NOT persisted
// to localStorage (unlike theme/sidebar-collapsed above) -- this reads
// as a temporary presentation mode you step in and out of during a
// session, not a lasting preference, so a real page reload always comes
// back up in the normal layout. Esc exits from anywhere (not just via
// the floating focus-exit button), since typing Esc to "get out of
// something full-screen" is a near-universal expectation.
const focusToggle = document.getElementById('focus-toggle');
const focusExitBtn = document.getElementById('focus-exit');

function isFocusMode() {
  return document.documentElement.getAttribute('data-focus-mode') === 'true';
}

function setFocusMode(next) {
  if (next) document.documentElement.setAttribute('data-focus-mode', 'true');
  else document.documentElement.removeAttribute('data-focus-mode');
}

focusToggle.addEventListener('click', () => setFocusMode(true));
// Exiting full screen while a rotation is running -- either via this
// button or Escape below -- goes through stopRotation() instead of a bare
// setFocusMode(false): rotation entered full screen (and unpinned the
// sidebar) FOR you on start (see startRotation() further down), so
// deliberately leaving it is the same "I want out of this" signal a
// manual page navigation already is elsewhere -- stopRotation() itself
// restores focus mode/the pin to how they were before, not just focus
// mode alone.
focusExitBtn.addEventListener('click', () => {
  if (rotationActive) stopRotation();
  else setFocusMode(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !isFocusMode()) return;
  // Defer to a currently-open modal's own Escape-to-close (e.g.
  // Workshop's/TC Elite Rollout's history modal, .history-modal-overlay)
  // -- one Escape should close that first, not close it AND exit focus
  // mode at the same time. A second Escape (nothing left open) exits
  // focus mode as normal.
  if (document.querySelector('.history-modal-overlay')) return;
  if (rotationActive) stopRotation();
  else setFocusMode(false);
});

async function renderUserInfo() {
  try {
    const res = await nativeFetch('/api/me');
    const data = await res.json();
    // Set regardless of sign-in state (unlike the user-info block below,
    // which needs a real signed-in user) -- by request, small text under
    // the logo showing which real machine is currently serving the data,
    // useful even while troubleshooting sign-in itself.
    if (data.hostname && serverHostnameEl) serverHostnameEl.textContent = data.hostname;
    if (!data.user) return;
    userInfoEl.innerHTML = `
      <div class="user-name">${escapeHtml(data.user.name || data.user.email)}</div>
      <a href="/auth/logout" class="user-signout">Sign out</a>
    `;
  } catch {
    // Non-essential UI -- if this fails, the sidebar just shows no user info.
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Material "open_in_new" glyph -- see renderPageItem()'s own comment for
// where/why this is used.
const EXTERNAL_PAGE_ICON_SVG =
  '<svg class="nav-external-icon" viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7zM5 5h5V3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-5h-2v5H5V5z"/></svg>';

// Sidebar nav is a two-level tree: top-level entries are either a page or a
// category, and a category holds pages (not further categories -- one level
// of grouping is all that's asked for). Shape:
//   { type: 'page', id: <pageId> }
//   { type: 'category', id: <categoryId>, label: <string>, children: [{type:'page', id}, ...] }
//
// The whole tree is a SHARED, server-side setting (GET/PUT /api/nav-layout)
// -- not per-browser localStorage -- because the point is that everyone
// hitting the real dashboard URL sees the same arrangement. Only editable
// (drag-and-drop reorder, right-click hide/unhide) when the server says so,
// which it decides from the signed-in account -- one specific email
// (isNavAdmin() in server.js), not a hostname check. `editable` here just
// mirrors what the server already enforces -- hiding the drag handles/
// right-click menu is a UX nicety, the server rejects a save from anyone
// else regardless of what this value says.
let editable = false;

// "Preview as a regular user" -- admin-only, by request: lets Amber see
// the sidebar exactly as anyone else would (hidden items gone entirely,
// no drag/hide/rename affordances) without signing in as anyone else.
// Per-browser (localStorage), same "personal viewing preference"
// reasoning as sidebarCollapsed/theme -- it's just a rendering choice on
// top of an already-editable session, not a real permission change (the
// server enforces the real one regardless of this). Only ever matters
// when `editable` is also true -- see isAdminView() below, which is what
// every admin-only rendering/interaction decision in this file now goes
// through instead of the raw `editable` flag.
const PREVIEW_AS_USER_KEY = 'dashboard.previewAsUser';
let previewAsUser = false;
try {
  previewAsUser = localStorage.getItem(PREVIEW_AS_USER_KEY) === 'true';
} catch {
  // localStorage unavailable -- falls back to the normal admin view.
}
function isAdminView() {
  return editable && !previewAsUser;
}

const pagesById = new Map(registeredPages.map((p) => [p.id, p]));

function defaultTree() {
  // Seeded with the requested categories, empty -- pages start ungrouped at
  // the top level and get dragged in by hand, rather than guessing which
  // page belongs in which category.
  return [
    { type: 'category', id: 'client-info', label: 'Client Info', children: [] },
    { type: 'category', id: 'ticket-info', label: 'Ticket Info', children: [] },
    { type: 'category', id: 'financials', label: 'Client Financials', children: [] },
    { type: 'category', id: 'licensing', label: 'Licensing', children: [] },
    ...registeredPages.map((p) => ({ type: 'page', id: p.id })),
  ];
}

// Drops any page id no longer registered (a page package that got removed)
// and appends any registered page id missing from the tree entirely (a
// newly added page package) at the top level, in registeredPages order --
// keeps the saved layout in sync with whatever pages actually exist without
// losing the existing categorization/ordering of the rest.
function reconcileTree(rawTree) {
  const seen = new Set();
  const result = [];
  for (const node of rawTree) {
    if (node.type === 'page') {
      if (pagesById.has(node.id) && !seen.has(node.id)) {
        seen.add(node.id);
        result.push(node);
      }
    } else if (node.type === 'category') {
      const children = node.children.filter((c) => pagesById.has(c.id) && !seen.has(c.id));
      children.forEach((c) => seen.add(c.id));
      result.push({ ...node, children });
    }
  }
  // Admin-only, by request -- this fallback exists so a brand-new,
  // never-placed page still surfaces for the ADMIN to notice and drag
  // into a category; a non-admin has no ability to reorder/place
  // anything regardless, so there's nothing for them to gain from seeing
  // an orphaned page. Confirmed the hard way this was a real bug, not
  // just a theoretical one: for a NON-admin, `rawTree` here is the
  // server's own stripHidden() result (server.js), which removes a
  // hidden category (and every child under it) from the tree entirely
  // BEFORE this function ever runs -- so every one of those children was
  // never marked `seen` above, and this loop (unconditional before this
  // fix) silently re-added every single one of them as a loose top-level
  // page, undoing the hide entirely for anyone but the admin. Gated on
  // the real `editable` flag (server-authoritative), not the "preview as
  // user" toggle's own isAdminView() -- the real admin should still see
  // this fallback regardless of whether they're currently previewing,
  // since preview is just a rendering choice, not a change to what
  // they're actually able to fetch/edit.
  if (editable) {
    for (const p of registeredPages) {
      if (!seen.has(p.id)) result.push({ type: 'page', id: p.id });
    }
  }
  return result;
}

// Mirrors server.js's own stripHidden() (which is what a non-admin's
// browser actually receives) -- used client-side only while an admin has
// "preview as user" switched on, so the sidebar they're looking at is a
// true rendering of what everyone else sees, not just a dimmed version
// of the admin's own tree.
function stripHiddenForPreview(rawTree) {
  const result = [];
  for (const node of rawTree) {
    if (node.hidden) continue;
    if (node.type === 'category') {
      result.push({ ...node, children: node.children.filter((c) => !c.hidden) });
    } else {
      result.push(node);
    }
  }
  return result;
}

async function loadTree() {
  try {
    const res = await nativeFetch('/api/nav-layout');
    const data = await res.json();
    editable = !!data.editable;
    if (data.tree) return reconcileTree(data.tree);
  } catch {
    // fall through to default -- e.g. offline, or the endpoint erroring
  }
  return defaultTree();
}

async function saveTree() {
  if (!editable) return; // shouldn't be reachable -- drag is only wired up when editable -- but guard anyway
  try {
    await nativeFetch('/api/nav-layout', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tree }),
    });
  } catch {
    // Best-effort -- the in-memory tree still reflects the move for the rest
    // of this session even if the save itself failed to persist.
  }
}

// Populated by init() before first render; mutated in place by
// drag-and-drop, so it stays a stable reference for currentPageId()/
// loadPage() rather than needing re-fetching.
let tree = [];

function flattenPageIds() {
  const ids = [];
  for (const node of tree) {
    if (node.type === 'page') ids.push(node.id);
    else ids.push(...node.children.map((c) => c.id));
  }
  return ids;
}

function findCategory(categoryId) {
  return tree.find((n) => n.type === 'category' && n.id === categoryId);
}

// Location descriptors address where a page node currently sits:
//   { kind: 'root', index }                    -- top level of the tree
//   { kind: 'category', categoryId, index }     -- inside a category's children
function listForLocation(loc) {
  return loc.kind === 'root' ? tree : findCategory(loc.categoryId).children;
}

function removeAt(loc) {
  return listForLocation(loc).splice(loc.index, 1)[0];
}

function insertAt(node, loc) {
  listForLocation(loc).splice(loc.index, 0, node);
}

function sameList(a, b) {
  return a.kind === 'root' ? b.kind === 'root' : b.kind === 'category' && a.categoryId === b.categoryId;
}

// Which categories are expanded -- purely a per-browser viewing preference,
// deliberately separate from the shared/server-side nav tree above: everyone
// sees the same categories and pages (admin-controlled), but whether YOU
// currently have a given category open is personal and doesn't need admin
// access to change. Defaults to nothing expanded (minimized) -- a category
// only opens because you clicked it, or because it contains the page
// you're currently on (see renderCategory()).
const EXPANDED_KEY = 'dashboard.expandedCategories';
function loadExpanded() {
  try {
    return new Set(JSON.parse(localStorage.getItem(EXPANDED_KEY) || '[]'));
  } catch {
    return new Set();
  }
}
function saveExpanded() {
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expandedCategories]));
  } catch {
    // localStorage unavailable (private browsing, storage full, etc.) -- expand/collapse state just won't persist.
  }
}
let expandedCategories = loadExpanded();

// "Rotate" -- a personal shortcuts category, by request: ANY user (not
// just the nav admin) can right-click a page anywhere in the sidebar to
// add it here, and right-click it again inside Rotate to remove it.
// Per-browser (localStorage), same "personal viewing preference, not the
// shared server-side nav tree" reasoning as expandedCategories/theme/
// sidebarCollapsed above -- this never touches nav-layout.json at all, so
// it can't collide with (or be overwritten by) the admin's own shared
// layout, and works identically for every signed-in user regardless of
// `editable`. A plain array in storage (Set only in memory), same
// JSON<->Set idiom loadExpanded()/saveExpanded() already use.
const ROTATE_KEY = 'dashboard.rotatePageIds';
// A synthetic category id, never a real one from nav-layout.json -- reused
// as this category's own key into expandedCategories (see
// renderRotateCategory() below), sharing that same Set/localStorage entry
// rather than needing a second one just for this.
const ROTATE_CATEGORY_ID = '__rotate__';
function loadRotateIds() {
  try {
    return new Set(JSON.parse(localStorage.getItem(ROTATE_KEY) || '[]'));
  } catch {
    return new Set();
  }
}
function saveRotateIds() {
  try {
    localStorage.setItem(ROTATE_KEY, JSON.stringify([...rotateIds]));
  } catch {
    // localStorage unavailable (private browsing, storage full, etc.) -- Rotate just won't persist.
  }
}
let rotateIds = loadRotateIds();

function toggleRotate(pageId) {
  if (rotateIds.has(pageId)) rotateIds.delete(pageId);
  else rotateIds.add(pageId);
  saveRotateIds();
  // If the page just REMOVED from Rotate happens to be the one currently
  // playing, advanceRotation() (below) already tolerates a stale/missing
  // current-page entry (falls back to index 0), so no special-casing
  // needed here beyond the normal re-render.
  renderNav(currentPageId());
}

// Same id list every render needs (renderRotateCategory() below, and the
// rotation engine's own advanceRotation()) -- pulled out to one place
// rather than repeating the same filter/spread in both. Order is
// insertion order (Set preserves it), i.e. the order pages were added to
// Rotate -- also what the engine cycles through.
function orderedRotatePageIds() {
  return [...rotateIds].filter((id) => pagesById.has(id));
}

// ---- Rotation timing -- default 20s, right-click override per page, by
// request. Per-browser (localStorage), same reasoning as rotateIds itself.
// A plain {pageId: seconds} object holding ONLY actual overrides (a page
// left at the default has no entry at all) -- getRotateSeconds() below is
// the one place that ever needs to know the effective value either way. ----
const ROTATE_TIMES_KEY = 'dashboard.rotateTimes';
const DEFAULT_ROTATE_SECONDS = 20;
function loadRotateTimes() {
  try {
    const parsed = JSON.parse(localStorage.getItem(ROTATE_TIMES_KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
function saveRotateTimes() {
  try {
    localStorage.setItem(ROTATE_TIMES_KEY, JSON.stringify(rotateTimes));
  } catch {
    // localStorage unavailable -- overrides just won't persist.
  }
}
let rotateTimes = loadRotateTimes();
function getRotateSeconds(pageId) {
  const override = rotateTimes[pageId];
  return Number.isFinite(override) && override > 0 ? override : DEFAULT_ROTATE_SECONDS;
}

// Right-click action, Rotate entries only (see the contextmenu wiring in
// renderPageItem() below) -- a plain prompt() is the simplest reliable
// input for a transient popup menu action, same reasoning the tabbed
// pages' own Rename already uses this for. Blank input resets to the
// default (removes the override rather than storing 20 explicitly) --
// entering the default's own value (20) does the same, so there's always
// exactly one way an unmodified page is represented in storage.
function setRotateTime(pageId) {
  const current = getRotateSeconds(pageId);
  const input = prompt('Rotation time in seconds for this page (blank resets to the default):', String(current));
  if (input === null) return; // cancelled
  const trimmed = input.trim();
  if (trimmed === '') {
    delete rotateTimes[pageId];
  } else {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      alert('Enter a positive number of seconds.');
      return;
    }
    const rounded = Math.round(seconds);
    if (rounded === DEFAULT_ROTATE_SECONDS) delete rotateTimes[pageId];
    else rotateTimes[pageId] = rounded;
  }
  saveRotateTimes();
  // Re-arms the timer immediately when the change is for whichever page is
  // CURRENTLY showing while actively rotating -- otherwise the new value
  // wouldn't take effect until this page comes around again on some LATER
  // cycle, by which point the stale duration would already be running.
  if (rotationActive && pageId === currentPageId()) scheduleNextRotation();
}

// ---- Rotation engine -- cycles through Rotate's own pages, each for its
// own getRotateSeconds() duration, looping back to the first after the
// last. Deliberately NOT persisted to localStorage/across a reload -- same
// "temporary presentation mode you step in and out of during a session"
// reasoning Full Screen/focus mode above already uses, not a lasting
// preference. Started/stopped via the play/pause button on the Rotate
// category's own header (renderRotateCategory() below). ----
let rotationActive = false;
let rotationTimer = null;
// Set right before the engine ITSELF changes window.location.hash, and
// read (then cleared) the moment loadPage() sees the resulting navigation
// -- the one thing that lets loadPage() tell "this hashchange is the
// engine advancing to the next page" apart from "the user clicked
// somewhere else / used back-forward / typed a new hash", which stops
// rotation instead of hijacking wherever they just went (see loadPage()
// below).
let rotationNavInProgress = false;

// Loads the NEXT page off-screen before switching to it, by request ("do
// the refresh and then switch") -- rather than switching first and letting
// that page's own mount() start fetching only once it's already visible
// (which is what a plain navigation does). Set by preloadAndAdvance()
// below right before it swaps a prewarmed page in; consumed (and cleared)
// by loadPage() the moment that swap's own hashchange arrives. `container`
// is a real, live DOM node with that page's module already mounted onto
// it -- moved into #page-content wholesale (not cloned), so its event
// listeners stay bound.
let pendingPrewarmedPage = null;
// How long a page gets to fetch/render off-screen before it's shown
// regardless, by request/trade-off -- there's no shared "I'm done
// loading" signal across this dashboard's ~40 independently-authored page
// modules to wait on instead, so this is a fixed timed guess: enough for
// most pages' own API calls to settle, not a guarantee for a slower one.
// Comes out of the NEXT page's own on-screen time as extra time added on
// top of its configured rotation duration, not carved out of it -- e.g. a
// page configured for 20s is actually on screen for roughly 20s + this.
const ROTATE_PRELOAD_BUFFER_MS = 1500;

function scheduleNextRotation() {
  clearTimeout(rotationTimer);
  rotationTimer = null;
  if (!rotationActive) return;
  rotationTimer = setTimeout(advanceRotation, getRotateSeconds(currentPageId()) * 1000);
}

// Mounts `pageId`'s module onto a real, detached-but-in-document DOM node
// positioned off-screen (not display:none/visibility:hidden -- some pages'
// own layout math, e.g. anything sizing a chart/canvas off its own
// clientWidth, can come out wrong for an element the browser never
// actually laid out) so it starts fetching immediately, exactly like a
// normal mount would, just not visible yet. Always resolves (a failed
// mount shows the same "Failed to load page" text a normal navigation's
// own try/catch already would) -- there's nothing left for a caller to
// meaningfully retry on error either way.
async function preloadPage(pageId) {
  const page = pagesById.get(pageId);
  const container = document.createElement('div');
  container.className = 'page-content'; // same base styling loadPage()'s real container gets
  container.style.cssText = 'position:absolute; left:-9999px; top:0; width:1px; height:1px; overflow:hidden;';
  document.body.appendChild(container);
  if (page) {
    try {
      const mod = await page.module();
      mod.mount(container);
      // Forces a genuinely fresh fetch, not just whatever mount() showed --
      // confirmed the hard way this actually mattered: most pages here
      // (Service Calls included) restore instantly from their own
      // module-scope last-fetched data on mount (a deliberate perf/UX
      // choice elsewhere on this dashboard -- no blank flash on a revisit
      // within the same session), which on its own means a rotated-to
      // page would show the EXACT SAME data it already had, not a
      // refreshed one -- "the refresh isn't working" was a completely
      // accurate report, not user error. #refresh-button is this
      // dashboard's own established convention for the force-refetch
      // button every page with one uses -- clicking it here, off-screen,
      // is the only generic hook available across independently-authored
      // page modules with no shared "refresh me" API of their own. A page
      // with no such button (mostly search/lookup pages, less likely
      // Rotate candidates anyway) just shows whatever mount() rendered,
      // same as before this change.
      //
      // `[id="refresh-button"]`, deliberately NOT the `#refresh-button`
      // CSS id-selector shorthand -- confirmed the hard way (a real,
      // reproducible bug caught before this ever shipped) that
      // querySelector('#id') is unreliable once the SAME id exists
      // anywhere else in the document, which is exactly the situation
      // here: the currently-VISIBLE page's own #refresh-button and this
      // off-screen container's #refresh-button coexist in the document at
      // the same time on every single rotation step. An id-indexed lookup
      // some engines use as a #id-selector optimization assumes document-
      // wide uniqueness and silently returns nothing once that's
      // violated, even when queried from an element whose own subtree
      // genuinely contains a match. The plain attribute-selector form
      // isn't affected by that shortcut and correctly stays scoped to
      // this container's own subtree regardless of what else exists
      // elsewhere in the document.
      const refreshButton = container.querySelector('[id="refresh-button"]');
      if (refreshButton && !refreshButton.disabled) refreshButton.click();
    } catch (err) {
      container.innerHTML = `<p class="status error">Failed to load page: ${err.message}</p>`;
    }
  }
  return { id: pageId, container };
}

// The actual "preload, then switch" sequencing -- used both by
// advanceRotation() below (mid-rotation) and startRotation() (the very
// first page a rotation switches to), so both go through the identical
// preload-buffer-swap steps.
async function preloadAndAdvance(nextId) {
  const prewarmed = await preloadPage(nextId);
  await new Promise((resolve) => setTimeout(resolve, ROTATE_PRELOAD_BUFFER_MS));
  // Rotation may have been stopped (a manual navigation elsewhere, the
  // play/pause button, Escape/Exit Full Screen) while this was preloading
  // off-screen -- discard rather than swapping in a page nobody's
  // rotating to anymore.
  if (!rotationActive) {
    prewarmed.container.remove();
    return;
  }
  pendingPrewarmedPage = prewarmed;
  rotationNavInProgress = true;
  window.location.hash = `#${nextId}`;
  // loadPage() (fired via the hashchange listener below) picks up
  // pendingPrewarmedPage and swaps it straight in -- and calls
  // scheduleNextRotation() itself once it's showing, so the timer always
  // reflects the page just arrived AT, not the one just left.
}

function advanceRotation() {
  if (!rotationActive) return;
  const list = orderedRotatePageIds();
  if (list.length === 0) {
    stopRotation();
    return;
  }
  const curIndex = list.indexOf(currentPageId());
  const nextId = list[(curIndex + 1) % list.length] ?? list[0];
  if (nextId === currentPageId()) {
    // Only one page (or the current one, if it dropped out of the list
    // mid-rotation) to cycle through -- re-arm for the same duration
    // rather than navigating (and there's nothing meaningful to preload
    // either -- it's the page already showing).
    scheduleNextRotation();
    return;
  }
  preloadAndAdvance(nextId);
}

// Remembers the sidebar pin state from right before rotation started, so
// stopping restores it exactly -- by request, rotation unpins (and enters
// full screen) for a clean, sidebar-free kiosk display while it runs, but
// someone who normally keeps the sidebar pinned open shouldn't find that
// preference silently overwritten once they stop.
let pinStateBeforeRotation = null;

function startRotation() {
  const list = orderedRotatePageIds();
  if (list.length === 0) return;
  rotationActive = true;
  // By request -- gets the sidebar fully out of the way for the duration:
  // unpinned (so it can't stay open) AND full screen (hides it outright,
  // same as the existing Full Screen button). Order matters here only in
  // that both must happen before the renderNav() below, which is what
  // actually reflects the unpinned state in the pin button's own look.
  pinStateBeforeRotation = isSidebarPinned();
  if (pinStateBeforeRotation) setSidebarPinned(false);
  setFocusMode(true);
  // Real browser fullscreen (F11-equivalent), by request -- on top of this
  // app's own Focus Mode above, which only hides the sidebar via CSS, not
  // the browser's own tab bar/address bar. Must be called synchronously
  // from this same click -- browsers reject requestFullscreen() called
  // from anywhere that isn't a direct, fresh user gesture (a timer, code
  // after an earlier await, etc). `?.()` guards a browser/context where
  // it doesn't exist at all; .catch() swallows a rejection (fullscreen
  // disabled by policy, e.g. inside an iframe with no
  // allow="fullscreen") rather than an unhandled rejection -- either way,
  // the rest of rotation still starts regardless.
  document.documentElement.requestFullscreen?.().catch(() => {});
  const startId = list.includes(currentPageId()) ? currentPageId() : list[0];
  if (startId === currentPageId()) {
    // Same "force a genuinely fresh fetch" reasoning preloadPage() uses
    // for every LATER page (see its own comment) -- this first one is
    // already live and visible rather than reached through the off-screen
    // preload dance, so refreshed in place instead. Same `[id="..."]`
    // attribute-selector form too, for the same reason -- no off-screen
    // container exists yet at this exact moment (this runs before any
    // preload begins), so a duplicate id isn't actually possible here
    // today, but staying consistent costs nothing and doesn't depend on
    // that staying true.
    const refreshButton = content.querySelector('[id="refresh-button"]');
    if (refreshButton && !refreshButton.disabled) refreshButton.click();
    scheduleNextRotation();
  } else {
    // Same preload-then-switch treatment as every later advance -- the
    // very first page a rotation switches to gets refreshed before it's
    // shown too, not just the ones after it.
    preloadAndAdvance(startId);
  }
  renderNav(currentPageId());
}

function stopRotation() {
  rotationActive = false;
  clearTimeout(rotationTimer);
  rotationTimer = null;
  // Restores exactly what startRotation() changed -- re-pins only if it
  // was ACTUALLY pinned before (never force-pins someone who runs
  // normally unpinned), and always exits full screen regardless, since
  // that's unconditionally entered on start.
  if (pinStateBeforeRotation) setSidebarPinned(true);
  pinStateBeforeRotation = null;
  setFocusMode(false);
  // Exits real browser fullscreen too, if actually in it right now --
  // guarded, since calling exitFullscreen() while NOT in fullscreen
  // throws (e.g. the user already exited it themselves via Escape/F11,
  // which is also independently caught by the fullscreenchange listener
  // below, so this guard also avoids a redundant no-op call in that
  // case).
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  renderNav(currentPageId());
}

// Any way real browser fullscreen ends OTHER than stopRotation() itself
// causing it (Escape, F11, clicking the browser's own "exit fullscreen"
// affordance) -- stops rotation to match, same "manual navigation/manual
// focus-mode-exit stops rotation" philosophy every other rotation-exit
// path already follows. Guarded on rotationActive so this is a no-op for
// someone using real fullscreen outside of rotation entirely. Never
// double-fires with stopRotation()'s own exitFullscreen() call above --
// that call already sets rotationActive = false FIRST, so by the time
// this listener's fullscreenchange event actually arrives, the condition
// below is already false.
document.addEventListener('fullscreenchange', () => {
  if (rotationActive && !document.fullscreenElement) stopRotation();
});

// Looks up the REAL tree node for a rotated page id, when there is one --
// so a Rotate entry shows the same label override/tabbed marker/hidden
// badge (renderPageItem() below) the page's real sidebar entry currently
// has, rather than always falling back to its plain default label. Falls
// back to a bare {type:'page', id} when the id isn't (or is no longer)
// anywhere in the real tree -- e.g. a page that was live when added to
// Rotate but has since been removed from nav-layout.json entirely; still
// renders fine as long as the page itself is still registered
// (pagesById), which is what actually gates whether it shows at all -- see
// renderRotateCategory().
function findTreeNodeForPage(pageId) {
  for (const n of tree) {
    if (n.type === 'page' && n.id === pageId) return n;
    if (n.type === 'category') {
      const found = n.children.find((c) => c.id === pageId);
      if (found) return found;
    }
  }
  return { type: 'page', id: pageId };
}

// Rendered last in the sidebar (see renderNav()), by request. Returns null
// (renders nothing) when empty, same "don't show an empty category"
// reasoning renderNav() already applies to a real one with zero visible
// children -- unlike that case, this never has anything ADMIN-only to
// reveal by staying visible regardless, so there's no exception to make
// here. Deliberately its own function, not a special-cased branch inside
// renderCategory() -- Rotate never participates in the admin's own
// drag-to-reorder tree (see renderPageItem()'s own isRotateLoc guards) or
// right-click Hide/Rename (those apply to the real shared node, not this
// synthetic copy of it), so reusing that function would mean threading a
// handful of conditionals through code that otherwise has nothing to do
// with Rotate at all.
function renderRotateCategory(activeId, admin) {
  const rotatePageIds = orderedRotatePageIds();
  if (rotatePageIds.length === 0) {
    // Nothing left to cycle through (e.g. every rotated page's package was
    // removed) -- stop a still-running engine rather than leaving it
    // ticking toward a list that no longer exists.
    if (rotationActive) stopRotation();
    return null;
  }

  const li = document.createElement('li');
  li.className = 'nav-category';
  const isExpanded = expandedCategories.has(ROTATE_CATEGORY_ID);
  const header = document.createElement('div');
  // .nav-category-header--rotate carries the play/pause button's own
  // layout (flex, space-between) -- scoped to just this header rather than
  // touching every other category's header, which has no button to lay
  // out (see styles.css).
  header.className = 'nav-category-header nav-category-header--rotate';
  header.innerHTML =
    `<span><span class="nav-category-toggle">${isExpanded ? '▾' : '▸'}</span>Rotate</span>` +
    `<button type="button" class="nav-rotate-play-btn" aria-label="${rotationActive ? 'Stop rotating' : 'Start rotating'}" title="${
      rotationActive ? 'Stop rotating' : 'Start rotating'
    }">${rotationActive ? '⏸' : '▶'}</button>`;
  header.addEventListener('click', (e) => {
    // The play/pause button has its own click handler below -- a click
    // that lands on it (or bubbles up from it) shouldn't ALSO toggle
    // expand/collapse in the same gesture.
    if (e.target.closest('.nav-rotate-play-btn')) return;
    if (expandedCategories.has(ROTATE_CATEGORY_ID)) expandedCategories.delete(ROTATE_CATEGORY_ID);
    else expandedCategories.add(ROTATE_CATEGORY_ID);
    saveExpanded();
    renderNav(activeId);
  });
  header.querySelector('.nav-rotate-play-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    if (rotationActive) stopRotation();
    else startRotation();
  });
  li.appendChild(header);

  const childList = document.createElement('ul');
  childList.className = 'nav-category-children';
  childList.hidden = !isExpanded;
  rotatePageIds.forEach((pageId, index) => {
    childList.appendChild(renderPageItem(findTreeNodeForPage(pageId), { kind: 'rotate', index }, activeId, admin));
  });
  li.appendChild(childList);

  return li;
}

// Drag state lives across the dragstart/drop event pair -- native HTML5 DnD
// doesn't hand you the source element in the drop event, only in dragstart.
let dragSrc = null; // a location descriptor, set on dragstart

function moveTo(targetLoc) {
  if (!dragSrc) return;
  const node = removeAt(dragSrc);
  // Removing the source shifts everything after it down by one -- if the
  // target is later in the SAME list, its index needs the same adjustment,
  // otherwise the dragged item lands one slot past where it was dropped.
  const insertIndex = sameList(dragSrc, targetLoc) && dragSrc.index < targetLoc.index ? targetLoc.index - 1 : targetLoc.index;
  insertAt(node, { ...targetLoc, index: insertIndex });
  dragSrc = null;
  saveTree();
}

// Right-click hide/unhide, by request -- same admin-only editing this
// sidebar's drag-and-drop reorder already is (see server.js's
// isDashboardAdmin, which now gates both). `node.hidden` rides along on
// the SAME shared nav-layout.json/saveTree() drag-and-drop already uses
// -- no separate save path. A non-admin's own tree never contains a
// hidden node in the first place (server.js strips them before sending),
// so this toggle and its dimmed rendering only ever matter in an
// editable session.
function toggleHidden(node) {
  if (node.hidden) delete node.hidden;
  else node.hidden = true;
  renderNav(currentPageId());
  saveTree();
}

// Rename a TABBED page's own sidebar label, by request -- admin-only,
// offered only for a page with dashboardPage.tabbed set (see
// renderPageItem() below). Stores the override directly on the page's own
// node in the shared tree (node.label, read by renderPageItem() ahead of
// the page's own default pagesById label) -- same "just another field on
// the node, saved through the exact same saveTree() drag-and-drop
// already uses" approach as node.hidden above, so this needed no new
// server route at all.
function renamePage(node, page) {
  const next = prompt('Rename this page:', node.label || page.label);
  if (next === null) return; // cancelled
  const trimmed = next.trim();
  if (!trimmed) return;
  node.label = trimmed;
  renderNav(currentPageId());
  saveTree();
}

// A small floating right-click menu -- a list of {label, onClick} actions
// (Hide/Unhide always; Rename too, for a tabbed page -- see
// renderPageItem() below for how that list is built). Exactly one open
// at a time; closeNavContextMenu() is the ONE place that tears down both
// the menu element and whichever dismiss listeners are currently
// attached, so however it closes (a button click, a click elsewhere,
// Escape, or scrolling) always leaves a clean slate for the next one --
// rather than leftover once-only listeners from an Escape-closed menu
// firing unexpectedly on a LATER menu's own first click.
let openContextMenu = null;
let contextMenuDismissListeners = null;
function closeNavContextMenu() {
  if (!openContextMenu) return;
  openContextMenu.remove();
  openContextMenu = null;
  if (contextMenuDismissListeners) {
    document.removeEventListener('click', contextMenuDismissListeners.onDismiss);
    document.removeEventListener('scroll', contextMenuDismissListeners.onDismiss, true);
    document.removeEventListener('keydown', contextMenuDismissListeners.onKeydown);
    contextMenuDismissListeners = null;
  }
}
// `actions` is [{label, onClick}, ...] -- rendered as one button per
// action, top to bottom, in the order given.
function showNavContextMenu(x, y, actions) {
  closeNavContextMenu();

  const menu = document.createElement('div');
  menu.className = 'nav-context-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  for (const action of actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nav-context-menu-item';
    btn.textContent = action.label;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeNavContextMenu();
      action.onClick();
    });
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);
  openContextMenu = menu;

  const onDismiss = () => closeNavContextMenu();
  const onKeydown = (e) => {
    if (e.key === 'Escape') closeNavContextMenu();
  };
  contextMenuDismissListeners = { onDismiss, onKeydown };
  // Deferred by one tick -- otherwise the same right-click that OPENED
  // this menu (contextmenu fires before any click) could immediately
  // trigger its own dismiss listener before the menu's even visible.
  setTimeout(() => {
    document.addEventListener('click', onDismiss);
    document.addEventListener('scroll', onDismiss, true);
    document.addEventListener('keydown', onKeydown);
  }, 0);
}

// Auto-opens the category containing `activeId`, but only the first time a
// given page becomes active -- not on every re-render. Without that guard,
// clicking a category's header to collapse it while viewing one of its
// pages would immediately get overridden right back open on the next
// render (any drag-and-drop, or even just re-rendering after the click
// itself), since it'd still "contain the active page" -- this is what made
// collapsing not seem to work at all.
let lastAutoOpenedFor = null;
function autoOpenCategoryFor(activeId) {
  if (activeId === lastAutoOpenedFor) return;
  lastAutoOpenedFor = activeId;
  const owner = tree.find((n) => n.type === 'category' && n.children.some((c) => c.id === activeId));
  if (owner && !expandedCategories.has(owner.id)) {
    expandedCategories.add(owner.id);
    saveExpanded();
  }
}

function renderNav(activeId) {
  autoOpenCategoryFor(activeId);
  navList.innerHTML = '';
  // Every admin-only rendering/interaction decision below goes through
  // this one computed flag, not the raw `editable` -- see isAdminView()'s
  // own comment. While previewing as a user, the tree itself is also
  // stripped of hidden nodes first (stripHiddenForPreview), so what's
  // rendered is a true match for what a non-admin's own browser would
  // receive from the server, not just an admin tree with the affordances
  // switched off.
  const admin = isAdminView();
  const renderTree = admin ? tree : stripHiddenForPreview(tree);
  renderTree.forEach((node, index) => {
    if (node.type === 'category') {
      // A category with zero children isn't necessarily really empty -- it
      // can be a category whose every page is restrictedTo someone else
      // (see server.js's pageVisibleTo/reconcileTree above), in which case
      // showing an empty header would out its existence to a viewer who
      // isn't supposed to know it's there at all. Admin view is the one
      // exception -- the whole point there is to drag a page INTO an
      // otherwise-empty category, so keep it visible while editing.
      if (node.children.length === 0 && !admin) return;
      navList.appendChild(renderCategory(node, index, activeId, admin));
    } else {
      navList.appendChild(renderPageItem(node, { kind: 'root', index }, activeId, admin));
    }
  });
  // Rotate last, by request (originally rendered first) -- see
  // renderRotateCategory()'s own comment for why this is a dedicated
  // function rather than a branch inside renderCategory() above. Personal
  // (per-browser localStorage), so this renders identically here
  // regardless of `admin`/preview-as-user -- there's nothing about it the
  // real nav-layout.json tree or its own admin gating has any say over.
  const rotateEl = renderRotateCategory(activeId, admin);
  if (rotateEl) navList.appendChild(rotateEl);
  // Only meaningful as a drop target -- no point rendering it when nothing
  // on the page can be dragged.
  if (admin) navList.appendChild(renderRootDropZone());
}

function renderPageItem(node, loc, activeId, admin) {
  const page = pagesById.get(node.id);
  // Rotate entries never participate in the admin's own shared-tree
  // drag-to-reorder (dragSrc/moveTo below have no idea what a 'rotate'
  // location even means -- listForLocation() only handles 'root'/
  // 'category') or the admin-only Hide/Rename context-menu actions further
  // down (both act on the REAL tree node; a Rotate entry is either that
  // same node, borrowed for display only, or a bare fallback -- see
  // findTreeNodeForPage() -- never something safe to hide/rename through).
  const isRotateLoc = loc.kind === 'rotate';
  // node.label, when present, is an admin-set rename override (see
  // renamePage() above) -- takes precedence over the page's own default
  // package.json label. Shared (rides along in the same tree everyone's
  // own GET /api/nav-layout returns), not a per-viewer thing.
  const displayLabel = node.label || page.label;
  const li = document.createElement('li');
  li.className =
    'nav-item' +
    // Rotate entries get the same nested/indented look as a real
    // category's own children -- they're rendered inside their own
    // <ul class="nav-category-children"> too (see renderRotateCategory()).
    (loc.kind === 'category' || isRotateLoc ? ' nav-item--nested' : '') +
    (admin ? '' : ' nav-item--readonly') +
    // node.hidden only ever appears in an admin's own tree -- see
    // server.js's stripHidden(), which removes it before a non-admin's
    // browser ever receives it. A Rotate entry can only ever carry this
    // when it's the admin's OWN rotate list AND the underlying page is
    // currently hidden from everyone else -- accurate to show (it really
    // is hidden from the shared sidebar), and impossible for a non-admin
    // to have added in the first place, since they can never see/right-click
    // a hidden page to begin with.
    (node.hidden ? ' nav-item--hidden' : '');

  const a = document.createElement('a');
  a.href = `#${page.id}`;
  // A real <a href> is natively draggable by default in every browser
  // (that's what lets you drag a link to a new tab/the bookmarks bar).
  // Left alone, the browser can pick THIS element as the actual drag
  // source (it's the closest draggable ancestor-or-self to the
  // pointer-down target) instead of the parent <li> below -- meaning the
  // <li>'s own custom dragstart/dataTransfer payload never fires, and
  // what actually drags is the browser's own native link data (a URL/
  // plain text) instead, which no custom drop target (e.g. Ticket Info's
  // own tab bar) recognises. Prime suspect for "drag starts but nothing
  // will accept the drop" -- not independently confirmed against a live
  // browser (no browser access from here), but a real, well-documented
  // gotcha of nesting a draggable ancestor around a naturally-draggable
  // child. Explicitly turned off either way, since a plain nav link never
  // had any legitimate reason to keep its own native drag behaviour.
  a.draggable = false;
  // page.external (from that page's own package.json dashboardPage.external,
  // see registry.js) marks a page that's just a direct embed of an outside
  // site -- Automation Forms, Rewst Form Test, and anything published via
  // External Page Builder, by request. A small "opens an external site"
  // icon (Material "open_in_new" glyph, fill="currentColor" so it follows
  // the link's own colour/theme rather than a fixed one) after the label,
  // not before -- reads as "this page -> external" left-to-right. Wrapped
  // together with the label in one white-space:nowrap span (.nav-link-label,
  // see styles.css) -- without it, a plain adjacent inline SVG is a real
  // line-break opportunity in its own right, so a label right at the
  // sidebar's width limit could wrap with the icon left stranded alone on
  // its own line, by request that it never do that. The "(hidden)" badge
  // (admin-only, see above) sits OUTSIDE that nowrap span, as its own
  // separate sibling -- it's not part of the "never split from the icon"
  // constraint that span exists for.
  // A tabbed page gets a leading marker sized/spaced the same as a
  // category header's own toggle (.nav-tabbed-icon mirrors
  // .nav-category-toggle's own width/margin -- see styles.css), so its
  // label lines up with the category headings it sits next to instead of
  // starting flush left like a plain page link. A small square, not the
  // same triangle a category uses (▸/▾) -- by request, kept visually
  // distinct from that toggle since this one isn't expand/collapse-able,
  // it's a static marker. Empty span, not a "▪"/"■" character -- a
  // Unicode square glyph's own font metrics (left bearing, baseline)
  // don't reliably match the triangle glyph's, which is exactly what threw
  // the two out of alignment; the actual square is drawn in CSS instead
  // (.nav-tabbed-icon::before) so its size/position is pinned exactly,
  // not left to the font.
  a.innerHTML =
    (page.tabbed ? '<span class="nav-tabbed-icon"></span>' : '') +
    `<span class="nav-link-label">${escapeHtml(displayLabel)}${page.external ? EXTERNAL_PAGE_ICON_SVG : ''}</span>` +
    (node.hidden ? '<span class="nav-hidden-badge">(hidden)</span>' : '');
  // page.tabbed (dashboardPage.tabbed, see registry.js/tab-page-client.js)
  // marks a tabbed-layout page (Ticket Info, and anything built the same
  // way since) -- coloured blue/bold in the sidebar, by request, same
  // treatment for every tabbed page rather than one hardcoded href
  // selector per page.
  a.className = 'nav-link' + (page.id === activeId ? ' active' : '') + (page.tabbed ? ' nav-link--tabbed' : '');
  // Auto-minimize the sidebar on click, by request -- unless pinned open.
  // A plain click listener alongside the href navigation itself (not
  // something in loadPage()/hashchange), so this only fires for an actual
  // nav-item click -- not the initial page load, browser back/forward, or
  // any other programmatic hash change elsewhere on this dashboard.
  a.addEventListener('click', () => {
    if (!isSidebarPinned()) setSidebarCollapsed(true);
  });
  li.appendChild(a);

  // Draggable for EVERYONE now, not just the nav admin -- by request,
  // dragging a sidebar page out to drop it as a tab on a tabbed page (e.g.
  // Ticket Info) is a per-browser personal action anyone can do, unlike
  // actually REORDERING the shared sidebar itself, which stays admin-only
  // below (dragSrc, the thing that makes a sidebar-internal drop actually
  // move something, is still only ever set in admin view).
  li.draggable = true;
  li.addEventListener('dragstart', (e) => {
    // Read via the browser's own native drag-and-drop data channel by any
    // drop target a currently-mounted PAGE sets up for itself (e.g.
    // ticket-info-tabs/client.js's own tab bar) -- this works across
    // module boundaries with zero direct JS coupling between app.js and
    // whatever page happens to be mounted; the MIME-ish string itself is
    // just a convention shared by both sides (see that file's own
    // matching comment).
    e.dataTransfer.setData('application/x-dashboard-page-id', node.id);
    // 'copyMove', not a single fixed effect -- this one drag can end up
    // used for either purpose depending on where it's dropped (a sidebar
    // slot -> reorder, handled as 'move' below; a tabbed page's own drop
    // zone, e.g. Ticket Info -> add a tab, handled as 'copy' there), and
    // the source has no way to know which in advance. A drop target
    // requesting an effect NOT included in effectAllowed is silently
    // rejected by the browser itself (shown as the "not allowed" cursor)
    // regardless of that target's own preventDefault() -- confirmed the
    // hard way: 'move'-only here (this used to be admin-only 'move' vs.
    // everyone-else 'copy') was exactly why Ticket Info's own 'copy'
    // drop zone could never accept a drag from an admin's own account.
    e.dataTransfer.effectAllowed = 'copyMove';
    li.classList.add('dragging');
    // Never set from a Rotate entry -- loc is {kind:'rotate', index} there,
    // which moveTo()/listForLocation() below have no notion of at all (only
    // 'root'/'category'); setting it anyway would crash the NEXT
    // successful sidebar-internal drop, wherever that lands, not this one.
    if (admin && !isRotateLoc) dragSrc = loc;
  });
  li.addEventListener('dragend', () => li.classList.remove('dragging'));

  if (admin && !isRotateLoc) {
    li.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      li.classList.add('drag-over');
    });
    li.addEventListener('dragleave', () => li.classList.remove('drag-over'));
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      li.classList.remove('drag-over');
      if (!dragSrc) return;
      moveTo(loc);
      renderNav(activeId);
    });
  }

  // Right-click menu -- ALWAYS wired (not just admin), by request: any
  // signed-in user can right-click any page anywhere in the sidebar to add
  // it to their own Rotate shortcuts, and remove it the same way from
  // inside Rotate. Hide/Rename stay admin-only AND excluded for a Rotate
  // entry (isRotateLoc) -- see this function's own comment on that flag --
  // so the menu differs by context: admin sees Hide (+Rename for a tabbed
  // page) here at the page's real location, everyone sees Add/Remove
  // Rotate everywhere, and a Rotate entry itself only ever offers Remove.
  li.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const actions = [];
    if (admin && !isRotateLoc) {
      actions.push({ label: node.hidden ? 'Unhide' : 'Hide', onClick: () => toggleHidden(node) });
      // Rename is offered only for a tabbed page (page.tabbed) -- by
      // request, renaming any other page's sidebar label wasn't asked
      // for, so this stays scoped rather than generalised to every page.
      if (page.tabbed) actions.push({ label: 'Rename', onClick: () => renamePage(node, page) });
    }
    if (isRotateLoc) {
      // Set Rotation Time only makes sense from inside Rotate itself --
      // it's meaningless at the page's real (non-Rotate) location, by
      // request ("right click on the menu item [inside Rotate] to set a
      // changed time different for each page").
      actions.push({ label: 'Set Rotation Time', onClick: () => setRotateTime(node.id) });
      actions.push({ label: 'Remove from Rotate', onClick: () => toggleRotate(node.id) });
    } else {
      // The SAME toggle either way -- whether right-clicked at the page's
      // real location or (in principle) from inside Rotate itself, the
      // label just reflects whichever state is currently true.
      const inRotate = rotateIds.has(node.id);
      actions.push({ label: inRotate ? 'Remove from Rotate' : 'Add to Rotate', onClick: () => toggleRotate(node.id) });
    }
    showNavContextMenu(e.clientX, e.clientY, actions);
  });

  return li;
}

function renderCategory(node, index, activeId, admin) {
  const li = document.createElement('li');
  li.className = 'nav-category';

  // Auto-opening for the active page is handled once, on navigation, by
  // autoOpenCategoryFor() (called from renderNav()) -- expandedCategories is
  // the sole source of truth here, so an explicit collapse click sticks even
  // while still viewing a page inside this category.
  const isExpanded = expandedCategories.has(node.id);

  const header = document.createElement('div');
  // node.hidden only ever appears in an admin's own tree -- see server.js's
  // stripHidden(), which removes it before a non-admin's browser ever
  // receives it.
  header.className = 'nav-category-header' + (node.hidden ? ' nav-category-header--hidden' : '');
  header.innerHTML =
    `<span class="nav-category-toggle">${isExpanded ? '▾' : '▸'}</span>${escapeHtml(node.label)}` +
    (node.hidden ? '<span class="nav-hidden-badge">(hidden)</span>' : '');
  header.addEventListener('click', () => {
    if (expandedCategories.has(node.id)) expandedCategories.delete(node.id);
    else expandedCategories.add(node.id);
    saveExpanded();
    renderNav(activeId);
  });

  if (admin) {
    // The header itself is the "drop into this category" target -- lands
    // the page at the end of this category's children, regardless of where
    // in the header you drop (there's no per-position meaning for a header drop).
    header.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      header.classList.add('drag-over');
    });
    header.addEventListener('dragleave', () => header.classList.remove('drag-over'));
    header.addEventListener('drop', (e) => {
      e.preventDefault();
      header.classList.remove('drag-over');
      if (!dragSrc) return;
      moveTo({ kind: 'category', categoryId: node.id, index: node.children.length });
      // Open it afterward -- otherwise a page just dropped into a collapsed
      // category would silently disappear from view.
      expandedCategories.add(node.id);
      saveExpanded();
      renderNav(activeId);
    });
    header.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showNavContextMenu(e.clientX, e.clientY, [{ label: node.hidden ? 'Unhide' : 'Hide', onClick: () => toggleHidden(node) }]);
    });
  }
  li.appendChild(header);

  const childList = document.createElement('ul');
  childList.className = 'nav-category-children';
  childList.hidden = !isExpanded;
  node.children.forEach((child, childIndex) => {
    childList.appendChild(renderPageItem(child, { kind: 'category', categoryId: node.id, index: childIndex }, activeId, admin));
  });
  li.appendChild(childList);

  return li;
}

// A thin strip below everything -- lets a page be dragged back out to the
// top level (out of any category) or moved to the very end of the root
// list, which no single top-level item's dragover target covers. Only
// rendered at all when editable (see renderNav()).
function renderRootDropZone() {
  const li = document.createElement('li');
  li.className = 'nav-root-dropzone';
  li.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    li.classList.add('drag-over');
  });
  li.addEventListener('dragleave', () => li.classList.remove('drag-over'));
  li.addEventListener('drop', (e) => {
    e.preventDefault();
    li.classList.remove('drag-over');
    if (!dragSrc) return;
    moveTo({ kind: 'root', index: tree.length });
    renderNav(currentPageId());
  });
  return li;
}

function currentPageId() {
  const hash = window.location.hash.replace(/^#/, '');
  const ids = flattenPageIds();
  return ids.includes(hash) ? hash : ids[0];
}

// Auto-enters Mobile View + Full Screen whenever a page that HAS a Mobile
// View checkbox is opened on a narrow screen, by request. Viewport width
// (not user-agent sniffing) -- reacts to actual available space, same
// breakpoint Workshop Board's own .wsp-bottom-panels responsive stacking
// already uses, rather than trying to label specific devices as "mobile"
// or not.
//
// Fully generic, not Workshop-specific: ANY page can opt in just by
// giving its own mobile-view checkbox a `data-auto-mobile-view` attribute
// -- no shell code changes needed per page. Workshop Board is the only
// page with one today (`#mobile-view-toggle` in its own client.js).
// Dispatches a real `change` event (not just flipping `.checked`) so the
// page's own existing change handler does the actual work exactly as if
// the checkbox had been clicked -- this function only decides WHEN to
// trigger it, never re-implements what checking it does.
//
// Runs on every navigation TO such a page while the viewport is narrow
// (not just once per session) -- simplest behavior matching "opening the
// page on a mobile phone", though that does mean it re-applies even after
// manually turning Mobile View or Full Screen back off and navigating
// away and back. Worth revisiting if that turns out to be annoying in
// practice.
const MOBILE_VIEWPORT_QUERY = '(max-width: 720px)';
function applyAutoMobileView() {
  const checkbox = content.querySelector('[data-auto-mobile-view]');
  if (!checkbox || !window.matchMedia(MOBILE_VIEWPORT_QUERY).matches) return;
  if (!checkbox.checked) {
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
  }
  setFocusMode(true);
}

// Also re-applies when the viewport BECOMES narrow without a fresh page
// navigation -- e.g. the page was already open on a desktop-width window
// (or a phone in landscape) and the window gets resized/rotated narrow
// afterward. loadPage() below only ever calls applyAutoMobileView() once,
// right after mounting a page -- confirmed the hard way (a real user
// report: "works if I click Mobile View" but not automatically) that this
// left a real gap, not just a theoretical one -- a MediaQueryList's own
// `change` event is the correct primitive for this (fires only when the
// query's boolean result actually flips, unlike a raw `resize` listener,
// which would fire on every pixel of drag). Deliberately does NOT undo
// anything when the query stops matching (narrow -> wide again) -- by the
// same "runs on every navigation, doesn't fight a manual toggle-back-off"
// reasoning applyAutoMobileView()'s own comment above already documents,
// this is additive only, same direction that comment already commits to.
window.matchMedia(MOBILE_VIEWPORT_QUERY).addEventListener('change', (e) => {
  if (e.matches) applyAutoMobileView();
});

async function loadPage(id) {
  const page = pagesById.get(id) || pagesById.get(flattenPageIds()[0]);
  if (!page) {
    content.innerHTML = '<p class="status">No dashboard pages configured.</p>';
    return;
  }
  // Rotation engine bookkeeping -- this is the ONE place every navigation
  // (a sidebar click, browser back/forward, a hashchange fired from
  // anywhere, and the engine's own advanceRotation()/startRotation())
  // eventually passes through, so it's the right spot to decide whether a
  // still-running rotation continues or gets cancelled. rotationNavInProgress
  // is only ever true when THIS navigation is the engine's own -- anything
  // else while rotating means the user (or something else) took over, so
  // stop rather than silently hijacking wherever they just went.
  if (rotationActive) {
    if (rotationNavInProgress) {
      rotationNavInProgress = false;
    } else {
      stopRotation();
    }
  }
  renderNav(page.id);
  // Re-armed for THIS page's own duration, not the one just left -- always
  // after the rotationActive check/renderNav above, never before, so a
  // stopRotation() call just above (the "hijacked" branch) is correctly
  // reflected here rather than arming a timer for a rotation that no
  // longer exists.
  if (rotationActive) scheduleNextRotation();

  // Rotation's own pre-warmed container -- already mounted (and given its
  // buffer to fetch/render) off-screen by preloadAndAdvance() above, so
  // this navigation moves its already-rendered content straight into view
  // instead of mounting the SAME page again from scratch, which would
  // both waste that head start and show a blank flash while it
  // re-fetches. The actual child NODES are moved (not innerHTML copied
  // across, and not `content` itself replaced -- it's a `const` besides),
  // so whatever event listeners that mount() call already wired up stay
  // bound.
  if (pendingPrewarmedPage && pendingPrewarmedPage.id === page.id) {
    const prewarmed = pendingPrewarmedPage;
    pendingPrewarmedPage = null;
    content.innerHTML = '';
    while (prewarmed.container.firstChild) {
      content.appendChild(prewarmed.container.firstChild);
    }
    prewarmed.container.remove();
    applyAutoMobileView();
    return;
  }
  // Any OTHER stale pre-warmed container (e.g. rotation was stopped and
  // restarted, or the list changed, before this one's buffer finished)
  // never gets used for this navigation -- clean it up rather than
  // leaking it in the DOM.
  if (pendingPrewarmedPage) {
    pendingPrewarmedPage.container.remove();
    pendingPrewarmedPage = null;
  }

  content.innerHTML = '';
  try {
    const mod = await page.module();
    mod.mount(content);
    applyAutoMobileView();
  } catch (err) {
    content.innerHTML = `<p class="status error">Failed to load page: ${err.message}</p>`;
  }
}

async function init() {
  tree = await loadTree();
  // Only actually reveal the preview-user button once loadTree() has come
  // back and confirmed this session is the real dashboard admin --
  // `editable` is exactly that confirmation (see its own comment).
  previewUserToggle.hidden = !editable;
  if (editable) renderPreviewUserToggle();
  window.addEventListener('hashchange', () => loadPage(currentPageId()));
  await loadPage(currentPageId());
  renderUserInfo();
}
init();
