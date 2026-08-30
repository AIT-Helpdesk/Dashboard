import { pages as registeredPages } from '/pages-registry.js';

export const id = "tab-page-builder";
export const label = "Tab Page Builder";

export function mount(container) {
  // Every page currently visible to THIS viewer (already filtered
  // server-side by pageVisibleTo), minus this tool itself -- picking
  // "Tab Page Builder" as a starting tab of a new tabbed page would be
  // nonsensical. Sorted alphabetically, since pages-registry.js's own
  // order has no particular meaning.
  const pickablePages = registeredPages.filter((p) => p.id !== id).sort((a, b) => a.label.localeCompare(b.label));

  container.innerHTML = `
    <header class="page-header">
      <h1>Tab Page Builder</h1>
    </header>
    <p class="status">
      Creates a new tabbed page (like Ticket Info, Client Info, ...) -- a name plus a starting set of tabs, each
      mounting a real existing page exactly as-is. Lands at the root of the sidebar immediately (no restart needed)
      -- drag it into whichever category it belongs in yourself once it's there. Anyone can drag more tabs onto it
      later, and you (as admin) can make any of those permanent for everyone, or rename the page itself, both from
      the sidebar's own right-click menu.
    </p>
    <div class="resource-group">
      <div class="resource-group-header"><span>New Tabbed Page</span></div>
      <form id="builder-form" style="display:flex; flex-direction:column; gap:0.75rem; padding:0.75rem 1rem;">
        <label>
          Page name
          <input type="text" id="label-input" placeholder="e.g. Reporting" required style="display:block; width:100%; max-width:28rem; margin-top:0.25rem;" />
        </label>
        <div>
          <div style="margin-bottom:0.35rem;">Starting tabs</div>
          <div id="tab-picker" style="max-height: 320px; overflow-y: auto; border: 1px solid var(--border); border-radius: 6px; padding: 0.5rem 0.75rem; max-width: 28rem;">
            ${pickablePages
              .map(
                (p) => `
              <label class="inline-checkbox-label">
                <input type="checkbox" name="tab-id" value="${escapeHtml(p.id)}" />
                ${escapeHtml(p.label)}
              </label>`
              )
              .join('')}
          </div>
        </div>
        <div class="date-form" style="margin:0;">
          <button type="submit" id="publish-button">Publish</button>
        </div>
      </form>
      <p id="publish-result" class="status" style="margin: 0 1rem 1rem;" hidden></p>
    </div>
  `;

  const form = container.querySelector('#builder-form');
  const labelInput = container.querySelector('#label-input');
  const publishButton = container.querySelector('#publish-button');
  const publishResultEl = container.querySelector('#publish-result');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const pageLabel = labelInput.value.trim();
    const tabIds = [...container.querySelectorAll('input[name="tab-id"]:checked')].map((el) => el.value);
    if (!pageLabel) return; // native `required` already covers this, belt-and-braces
    if (tabIds.length === 0) {
      alert('Pick at least one starting tab.');
      return;
    }
    if (!confirm(`Publish "${pageLabel}" as a new tabbed page with ${tabIds.length} starting tab${tabIds.length === 1 ? '' : 's'}?\n\nIt'll appear at the top of the sidebar immediately.`)) {
      return;
    }

    publishButton.disabled = true;
    publishResultEl.hidden = false;
    publishResultEl.className = 'status';
    publishResultEl.textContent = 'Publishing...';

    try {
      const res = await fetch('/api/tab-page-builder/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: pageLabel, tabIds }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);

      publishResultEl.className = 'status';
      publishResultEl.innerHTML = `<strong>${escapeHtml(data.label)}</strong> published (id: <code>${escapeHtml(data.id)}</code>) -- now at the top of the sidebar. Refresh the sidebar (or reload the page) to see it, then drag it into place when you're ready.`;

      labelInput.value = '';
      container.querySelectorAll('input[name="tab-id"]:checked').forEach((el) => (el.checked = false));
    } catch (err) {
      publishResultEl.className = 'status error';
      publishResultEl.textContent = `Error: ${err.message}`;
    } finally {
      publishButton.disabled = false;
    }
  });

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
