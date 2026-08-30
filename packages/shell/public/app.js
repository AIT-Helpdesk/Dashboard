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

sidebarPinToggle.addEventListener('click', () => {
  const next = !isSidebarPinned();
  if (next) document.documentElement.setAttribute('data-sidebar-pinned', 'true');
  else document.documentElement.removeAttribute('data-sidebar-pinned');
  try {
    localStorage.setItem(SIDEBAR_PINNED_KEY, String(next));
  } catch {
    // localStorage unavailable -- the choice still applies for this page load, just won't persist.
  }
  renderSidebarPinToggle();
});

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
focusExitBtn.addEventListener('click', () => setFocusMode(false));
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !isFocusMode()) return;
  // Defer to a currently-open modal's own Escape-to-close (e.g.
  // Workshop's/TC Elite Rollout's history modal, .history-modal-overlay)
  // -- one Escape should close that first, not close it AND exit focus
  // mode at the same time. A second Escape (nothing left open) exits
  // focus mode as normal.
  if (document.querySelector('.history-modal-overlay')) return;
  setFocusMode(false);
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
  for (const p of registeredPages) {
    if (!seen.has(p.id)) result.push({ type: 'page', id: p.id });
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
  // Only meaningful as a drop target -- no point rendering it when nothing
  // on the page can be dragged.
  if (admin) navList.appendChild(renderRootDropZone());
}

function renderPageItem(node, loc, activeId, admin) {
  const page = pagesById.get(node.id);
  // node.label, when present, is an admin-set rename override (see
  // renamePage() above) -- takes precedence over the page's own default
  // package.json label. Shared (rides along in the same tree everyone's
  // own GET /api/nav-layout returns), not a per-viewer thing.
  const displayLabel = node.label || page.label;
  const li = document.createElement('li');
  li.className =
    'nav-item' +
    (loc.kind === 'category' ? ' nav-item--nested' : '') +
    (admin ? '' : ' nav-item--readonly') +
    // node.hidden only ever appears in an admin's own tree -- see
    // server.js's stripHidden(), which removes it before a non-admin's
    // browser ever receives it.
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
    if (admin) dragSrc = loc;
  });
  li.addEventListener('dragend', () => li.classList.remove('dragging'));

  if (admin) {
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
    li.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const actions = [{ label: node.hidden ? 'Unhide' : 'Hide', onClick: () => toggleHidden(node) }];
      // Rename is offered only for a tabbed page (page.tabbed) -- by
      // request, renaming any other page's sidebar label wasn't asked
      // for, so this stays scoped rather than generalised to every page.
      if (page.tabbed) actions.push({ label: 'Rename', onClick: () => renamePage(node, page) });
      showNavContextMenu(e.clientX, e.clientY, actions);
    });
  }

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
  renderNav(page.id);
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
