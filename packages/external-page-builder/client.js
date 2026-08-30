export const id = "external-page-builder";
export const label = "External Page Builder";

// Publishing writes real files under packages/ and appends to the shared
// nav-layout.json -- module-scope, not inside mount(), so the last-typed
// name/URL survives a remount the same way other pages' lastQuery-style
// state does, in case of an accidental navigation away mid-edit.
let lastLabel = '';
let lastUrl = '';

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>External Page Builder</h1>
    </header>
    <p class="status">
      Paste a URL, click Preview to confirm it actually embeds (some sites block being framed outright --
      if the preview below stays blank, that's the site refusing, not a bug here), then Publish once you're
      happy. Publishing writes a real new page -- just this embed, none of this page's own controls -- straight
      into the <strong>Testing</strong> category, live immediately (no restart needed). Drag it into its real
      category yourself via the sidebar's drag-and-drop editor (localhost only) once you're ready.
    </p>
    <div class="resource-group">
      <div class="resource-group-header"><span>New Page</span></div>
      <form id="builder-form" style="display:flex; flex-direction:column; gap:0.75rem; padding:0.75rem 1rem;">
        <label>
          Page name
          <input type="text" id="label-input" placeholder="e.g. Vendor Status Portal" required style="display:block; width:100%; max-width:28rem; margin-top:0.25rem;" />
        </label>
        <label>
          URL to embed
          <input type="url" id="url-input" placeholder="https://..." required style="display:block; width:100%; max-width:28rem; margin-top:0.25rem;" />
        </label>
        <div class="date-form" style="margin:0;">
          <button type="button" id="preview-button">Preview</button>
          <button type="submit" id="publish-button">Publish as New Page</button>
        </div>
      </form>
      <p id="preview-status" class="status" style="margin: 0 1rem 0.5rem;" hidden></p>
      <iframe id="preview-frame" class="pgb-preview-frame" style="margin: 0 1rem 1rem; display:block;" hidden></iframe>
      <p id="publish-result" class="status" style="margin: 0 1rem 1rem;" hidden></p>
    </div>
  `;

  const form = container.querySelector('#builder-form');
  const labelInput = container.querySelector('#label-input');
  const urlInput = container.querySelector('#url-input');
  const previewButton = container.querySelector('#preview-button');
  const publishButton = container.querySelector('#publish-button');
  const previewStatusEl = container.querySelector('#preview-status');
  const previewFrameEl = container.querySelector('#preview-frame');
  const publishResultEl = container.querySelector('#publish-result');

  labelInput.value = lastLabel;
  urlInput.value = lastUrl;
  labelInput.addEventListener('input', () => { lastLabel = labelInput.value; });
  urlInput.addEventListener('input', () => { lastUrl = urlInput.value; });

  previewButton.addEventListener('click', () => {
    const url = urlInput.value.trim();
    if (!url) {
      previewStatusEl.hidden = false;
      previewStatusEl.className = 'status error';
      previewStatusEl.textContent = 'Enter a URL first.';
      previewFrameEl.hidden = true;
      return;
    }
    previewStatusEl.hidden = true;
    previewFrameEl.hidden = false;
    previewFrameEl.src = url;
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const label = labelInput.value.trim();
    const url = urlInput.value.trim();
    if (!label || !url) return; // native `required` already covers this, belt-and-braces
    if (!confirm(`Publish "${label}" as a new page, embedding:\n${url}\n\nIt'll appear in the Testing category immediately.`)) return;

    publishButton.disabled = true;
    publishResultEl.hidden = false;
    publishResultEl.className = 'status';
    publishResultEl.textContent = 'Publishing...';

    try {
      const res = await fetch('/api/external-page-builder/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label, url }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);

      publishResultEl.className = 'status';
      publishResultEl.innerHTML = `<strong>${escapeHtml(data.label)}</strong> published (id: <code>${escapeHtml(data.id)}</code>) -- now in the Testing category. Refresh the sidebar (or reload the page) to see it, then drag it into place when you're ready.`;

      // Cleared, not just left as-is -- by request, so another one can be
      // built right away without navigating away and back first. The
      // preview stays as it was; there's no reason to blank a preview that
      // was just confirmed working.
      lastLabel = '';
      lastUrl = '';
      labelInput.value = '';
      urlInput.value = '';
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
