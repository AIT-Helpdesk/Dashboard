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
const ORDER_KEY = 'dashboard.pageOrder';

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

function loadOrder() {
  try {
    const raw = localStorage.getItem(ORDER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveOrder() {
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(pages.map((p) => p.id)));
  } catch {
    // localStorage unavailable (private browsing, storage full, etc.) -- order just won't persist.
  }
}

function applyStoredOrder(list) {
  const savedOrder = loadOrder();
  if (!savedOrder) return [...list];
  const byId = new Map(list.map((p) => [p.id, p]));
  const ordered = savedOrder.map((id) => byId.get(id)).filter(Boolean);
  for (const p of list) {
    if (!savedOrder.includes(p.id)) ordered.push(p);
  }
  return ordered;
}

// Mutated in place by drag-and-drop reordering below, so `pages` stays a stable
// reference for currentPageId()/loadPage() rather than needing to be re-imported.
const pages = applyStoredOrder(registeredPages);

let dragSrcIndex = null;

function renderNav(activeId) {
  navList.innerHTML = '';
  pages.forEach((page, index) => {
    const li = document.createElement('li');
    li.className = 'nav-item';
    li.draggable = true;

    const a = document.createElement('a');
    a.href = `#${page.id}`;
    a.textContent = page.label;
    a.className = 'nav-link' + (page.id === activeId ? ' active' : '');
    li.appendChild(a);

    li.addEventListener('dragstart', (e) => {
      dragSrcIndex = index;
      li.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    li.addEventListener('dragend', () => {
      li.classList.remove('dragging');
    });
    li.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      li.classList.add('drag-over');
    });
    li.addEventListener('dragleave', () => {
      li.classList.remove('drag-over');
    });
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      li.classList.remove('drag-over');
      if (dragSrcIndex === null || dragSrcIndex === index) return;
      const [moved] = pages.splice(dragSrcIndex, 1);
      // Removing the source shifts everything after it down by one, so a
      // target index that was after the source needs the same adjustment --
      // otherwise the dragged item lands one slot past where it was dropped.
      const insertAt = dragSrcIndex < index ? index - 1 : index;
      pages.splice(insertAt, 0, moved);
      dragSrcIndex = null;
      saveOrder();
      renderNav(activeId);
    });

    navList.appendChild(li);
  });
}

function currentPageId() {
  const hash = window.location.hash.replace(/^#/, '');
  return pages.some((p) => p.id === hash) ? hash : pages[0]?.id;
}

async function loadPage(id) {
  const page = pages.find((p) => p.id === id) || pages[0];
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

window.addEventListener('hashchange', () => loadPage(currentPageId()));
loadPage(currentPageId());
renderUserInfo();