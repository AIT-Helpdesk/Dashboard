import { pages } from './pages-registry.js';

const navList = document.getElementById('nav-list');
const content = document.getElementById('page-content');

function renderNav(activeId) {
  navList.innerHTML = '';
  for (const page of pages) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `#${page.id}`;
    a.textContent = page.label;
    a.className = 'nav-link' + (page.id === activeId ? ' active' : '');
    li.appendChild(a);
    navList.appendChild(li);
  }
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