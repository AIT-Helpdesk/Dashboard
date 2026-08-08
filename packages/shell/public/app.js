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

async function renderUserInfo() {
  try {
    const res = await nativeFetch('/api/me');
    const data = await res.json();
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

// Sidebar nav is a two-level tree: top-level entries are either a page or a
// category, and a category holds pages (not further categories -- one level
// of grouping is all that's asked for). Shape:
//   { type: 'page', id: <pageId> }
//   { type: 'category', id: <categoryId>, label: <string>, children: [{type:'page', id}, ...] }
//
// The whole tree is a SHARED, server-side setting (GET/PUT /api/nav-layout)
// -- not per-browser localStorage -- because the point is that everyone
// hitting the real dashboard URL sees the same arrangement. Only editable
// (drag-and-drop) when the server says so, which it decides from the Host
// header: localhost only (a local dev copy, or someone RDP'd into the
// production box itself hitting its own localhost:3000 to edit the LIVE
// shared layout). `editable` here just mirrors what the server already
// enforces -- hiding the drag handles is a UX nicety, the server rejects a
// save from anywhere else regardless of what this value says.
let editable = false;
const pagesById = new Map(registeredPages.map((p) => [p.id, p]));

function defaultTree() {
  // Seeded with the two requested categories, empty -- pages start
  // ungrouped at the top level and get dragged in by hand, rather than
  // guessing which page belongs in which category.
  return [
    { type: 'category', id: 'client-info', label: 'Client Info', children: [] },
    { type: 'category', id: 'ticket-info', label: 'Ticket Info', children: [] },
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

function renderNav(activeId) {
  navList.innerHTML = '';
  tree.forEach((node, index) => {
    if (node.type === 'category') {
      navList.appendChild(renderCategory(node, index, activeId));
    } else {
      navList.appendChild(renderPageItem(node, { kind: 'root', index }, activeId));
    }
  });
  // Only meaningful as a drop target -- no point rendering it when nothing
  // on the page can be dragged.
  if (editable) navList.appendChild(renderRootDropZone());
}

function renderPageItem(node, loc, activeId) {
  const page = pagesById.get(node.id);
  const li = document.createElement('li');
  li.className = 'nav-item' + (loc.kind === 'category' ? ' nav-item--nested' : '') + (editable ? '' : ' nav-item--readonly');

  const a = document.createElement('a');
  a.href = `#${page.id}`;
  a.textContent = page.label;
  a.className = 'nav-link' + (page.id === activeId ? ' active' : '');
  li.appendChild(a);

  if (editable) {
    li.draggable = true;
    li.addEventListener('dragstart', (e) => {
      dragSrc = loc;
      li.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    li.addEventListener('dragend', () => li.classList.remove('dragging'));
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

  return li;
}

function renderCategory(node, index, activeId) {
  const li = document.createElement('li');
  li.className = 'nav-category';

  const header = document.createElement('div');
  header.className = 'nav-category-header';
  header.textContent = node.label;

  if (editable) {
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
      renderNav(activeId);
    });
  }
  li.appendChild(header);

  const childList = document.createElement('ul');
  childList.className = 'nav-category-children';
  node.children.forEach((child, childIndex) => {
    childList.appendChild(renderPageItem(child, { kind: 'category', categoryId: node.id, index: childIndex }, activeId));
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
  } catch (err) {
    content.innerHTML = `<p class="status error">Failed to load page: ${err.message}</p>`;
  }
}

async function init() {
  tree = await loadTree();
  window.addEventListener('hashchange', () => loadPage(currentPageId()));
  await loadPage(currentPageId());
  renderUserInfo();
}
init();
