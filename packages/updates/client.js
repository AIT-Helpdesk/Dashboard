export const id = 'updates';
export const label = 'Updates';

// Module-scope, not inside mount() -- the shell tears down and re-mounts a
// page's DOM on every navigation, but the imported module itself stays
// alive for the browser tab's session, so this survives across re-mounts,
// same "restore instantly on revisit" pattern every other page on this
// dashboard already uses.
let lastData = null; // { entries, editable }

// Every constant below is deliberately at true MODULE scope, not declared
// inside mount() -- a real, twice-confirmed bug class in this codebase
// (see What's On's own client.js, MONTH_SHORT/TEAM_ICON_HTML): a `const`
// declared inside mount() but AFTER an early "restore from cache" render
// call throws `ReferenceError: Cannot access 'X' before initialization` on
// a second-or-later visit within the same browser session. Module scope
// sidesteps this entirely regardless of where inside mount() these end up
// being referenced.

// Rich-text toolbar -- same command set/approach (contenteditable +
// document.execCommand, mousedown-preventDefault to keep the selection
// alive) as the tabbed pages' own Help notes editor
// (@dashboard/shell/public/tab-page-client.js) and What's On's own Update
// editor -- duplicated here, not imported, since this is a separate page
// package and none of these editors otherwise share code.
const UPDATES_TOOLBAR_COMMANDS = [
  { label: 'B', title: 'Bold', command: 'bold', style: 'font-weight:700;' },
  { label: 'U', title: 'Underline', command: 'underline', style: 'text-decoration:underline;' },
  { label: '• List', title: 'Bulleted list', command: 'insertUnorderedList' },
  { label: '🔗 Link', title: 'Link', command: 'createLink', promptForUrl: true },
];

// Same screenshot downscale/recompress settings (and reasoning) as What's
// On's own Update editor -- capped to MAX_IMAGE_DIMENSION on its longest
// side, re-encoded as JPEG at IMAGE_JPEG_QUALITY, whichever of
// original/resized actually comes out smaller wins. Duplicated here for the
// same "separate page package" reason as the toolbar above.
const MAX_IMAGE_DIMENSION = 1400;
const IMAGE_JPEG_QUALITY = 0.82;

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>Updates</h1>
    </header>
    <p id="status" class="status">Loading...</p>
    <div id="updates-toolbar" class="updates-page-toolbar" hidden>
      <button type="button" id="add-update-button" class="button-link">+ Add Update</button>
    </div>
    <div id="updates-list" class="updates-list"></div>
  `;

  const statusEl = container.querySelector('#status');
  const toolbarEl = container.querySelector('#updates-toolbar');
  const addButton = container.querySelector('#add-update-button');
  const listEl = container.querySelector('#updates-list');

  addButton.addEventListener('click', () => {
    // Only one compose/edit row open at a time, by request-adjacent
    // simplicity -- same "only one open at a time" convention the Open
    // ticket/Mark Complete popup elsewhere on this dashboard follows.
    // Re-rendering the whole list first guarantees any other row that was
    // mid-edit reverts to plain view before this new one opens.
    render();
    // The empty-state placeholder (when there are no entries yet at all)
    // would otherwise sit stranded below the compose form -- cleared here
    // rather than special-cased inside render() itself, since prepending
    // beats an empty list only in this one "about to compose" moment.
    if (lastData.entries.length === 0) listEl.innerHTML = '';
    const row = buildEditRow(null, {
      onSaved: (entry) => {
        lastData.entries.unshift(entry);
        render();
      },
      onCancel: () => render(),
    });
    listEl.prepend(row);
    row.querySelector('.updates-rich-editor').focus();
  });

  if (lastData) render();
  else load();

  async function load() {
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = 'Loading...';
    toolbarEl.hidden = true;
    listEl.innerHTML = '';
    try {
      const data = await fetchJson('/api/updates', 'GET');
      lastData = data;
      render();
    } catch (err) {
      statusEl.hidden = false;
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    }
  }

  function render() {
    if (!lastData) return;
    statusEl.hidden = true;
    toolbarEl.hidden = !lastData.editable;
    if (lastData.entries.length === 0) {
      listEl.innerHTML = '<p class="status">No updates yet.</p>';
    } else {
      listEl.innerHTML = lastData.entries.map((entry) => entryViewRowHtml(entry, lastData.editable)).join('');
    }
    if (lastData.editable) wireRowActions();
    scrollToDeepLinkedEntry();
  }

  function wireRowActions() {
    listEl.querySelectorAll('.updates-edit-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const entryId = Number(btn.dataset.id);
        const entry = lastData.entries.find((e) => e.id === entryId);
        if (!entry) return;
        const viewEl = listEl.querySelector(`#update-entry-${entryId}`);
        const editEl = buildEditRow(entry, {
          onSaved: (saved) => {
            const idx = lastData.entries.findIndex((e) => e.id === entryId);
            if (idx !== -1) lastData.entries[idx] = saved;
            render();
          },
          onCancel: () => render(),
        });
        viewEl.replaceWith(editEl);
      });
    });
    listEl.querySelectorAll('.updates-delete-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const entryId = Number(btn.dataset.id);
        if (!confirm('Delete this update entry? This cannot be undone.')) return;
        try {
          await fetchJson(`/api/updates/entries/${entryId}`, 'DELETE');
          lastData.entries = lastData.entries.filter((e) => e.id !== entryId);
          render();
        } catch (err) {
          alert(`Error: ${err.message}`);
        }
      });
    });
  }

  // Jumps to (and briefly highlights) one specific entry, reached via
  // Start Here's own excerpt links -- see @dashboard/start-here/client.js's
  // buildUpdatesColumnHtml(). Uses a real `?entry=<id>` query-string param
  // (not another level of hash), since window.location.hash already means
  // "which page" everywhere on this dashboard (app.js's currentPageId()) --
  // stacking a second meaning onto it here would break that. A query-string
  // link (unlike a plain `#updates` one) changes the URL's own `search`,
  // which forces a real full page load rather than an in-app hash-only
  // navigation -- same deliberate "real browser navigation, not a SPA
  // route change" choice server.js's own stretyConnectPage() already makes
  // for its "Return to Dashboard" link.
  function scrollToDeepLinkedEntry() {
    const params = new URLSearchParams(window.location.search);
    const entryId = params.get('entry');
    if (!entryId) return;
    // Removed immediately via replaceState, same "don't linger and force a
    // re-trigger on a later plain reload" reasoning What's On's own
    // ?strety_connected cleanup uses.
    params.delete('entry');
    const newSearch = params.toString();
    history.replaceState(null, '', `${window.location.pathname}${newSearch ? `?${newSearch}` : ''}${window.location.hash}`);
    const rowEl = listEl.querySelector(`#update-entry-${CSS.escape(entryId)}`);
    if (!rowEl) return;
    rowEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    rowEl.classList.add('updates-row--highlight');
    setTimeout(() => rowEl.classList.remove('updates-row--highlight'), 3000);
  }

  async function fetchJson(url, method, body) {
    const res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    if (res.status !== 204) data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
    return data;
  }

  function entryViewRowHtml(entry, isAdmin) {
    const imageHtml = entry.imageDataUrl
      ? `<img src="${escapeHtml(entry.imageDataUrl)}" class="updates-thumb" alt="" />`
      : '';
    const actionsHtml = isAdmin
      ? `<div class="updates-row-actions">
          <button type="button" class="link-button updates-edit-btn" data-id="${entry.id}">Edit</button>
          <button type="button" class="link-button updates-delete-btn" data-id="${entry.id}">Delete</button>
        </div>`
      : '';
    return `
      <div class="updates-row" id="update-entry-${entry.id}">
        <div class="updates-col updates-col-date">${escapeHtml(formatDisplayDate(entry.entryDate))}</div>
        <div class="updates-col updates-col-image">${imageHtml}</div>
        <div class="updates-col updates-col-text">${entry.contentHtml || '<span class="cell-subtext">No details.</span>'}</div>
        ${actionsHtml}
      </div>
    `;
  }

  // Builds the SAME 3-field editable row for both "Add Update" (entry is
  // null) and editing an existing one -- one form, two callers, rather than
  // a separate add-only form duplicating this. Returns a real detached DOM
  // node (not an HTML string) since the toolbar/paste handlers below need
  // to be wired directly onto it before it's inserted.
  function buildEditRow(entry, { onSaved, onCancel }) {
    const isNew = !entry;
    const wrapper = document.createElement('div');
    wrapper.className = 'updates-row updates-edit-row';
    if (entry) wrapper.id = `update-entry-${entry.id}`;
    wrapper.innerHTML = `
      <div class="updates-col updates-col-date">
        <input type="date" class="updates-date-input" value="${escapeHtml(entry ? entry.entryDate : todayKey())}" />
      </div>
      <div class="updates-col updates-col-image">
        <div class="updates-image-preview" tabindex="0" title="Click here, then paste (Ctrl+V) a screenshot">
          ${entry?.imageDataUrl ? `<img src="${escapeHtml(entry.imageDataUrl)}" alt="" />` : '<span class="updates-image-placeholder">Click, then paste a screenshot</span>'}
        </div>
        <button type="button" class="link-button updates-image-remove-btn" ${entry?.imageDataUrl ? '' : 'hidden'}>Remove image</button>
      </div>
      <div class="updates-col updates-col-text">
        <div class="updates-editor-toolbar">
          ${UPDATES_TOOLBAR_COMMANDS.map(
            (c) =>
              `<button type="button" class="updates-toolbar-btn" data-command="${c.command}" data-prompt="${c.promptForUrl ? '1' : ''}" title="${escapeHtml(c.title)}" style="${c.style || ''}">${c.label}</button>`
          ).join('')}
        </div>
        <div class="updates-rich-editor" contenteditable="true">${entry ? entry.contentHtml || '' : ''}</div>
        <p class="status error updates-row-error" hidden></p>
        <div class="updates-row-form-actions">
          <button type="button" class="button-link updates-save-btn">Save</button>
          <button type="button" class="updates-cancel-btn">Cancel</button>
        </div>
      </div>
    `;

    const dateInput = wrapper.querySelector('.updates-date-input');
    const imagePreview = wrapper.querySelector('.updates-image-preview');
    const removeImageBtn = wrapper.querySelector('.updates-image-remove-btn');
    const richEditor = wrapper.querySelector('.updates-rich-editor');
    const errorEl = wrapper.querySelector('.updates-row-error');
    const saveBtn = wrapper.querySelector('.updates-save-btn');
    const cancelBtn = wrapper.querySelector('.updates-cancel-btn');

    let currentImageDataUrl = entry?.imageDataUrl || null;

    wrapper.querySelectorAll('.updates-toolbar-btn').forEach((btn) => {
      // mousedown (not click) preventDefault -- keeps the editor's current
      // text selection alive; a click alone would blur the contenteditable
      // FIRST (losing the selection execCommand needs to act on) before the
      // click handler even runs. Same trick the Help tab's own toolbar uses.
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', () => {
        richEditor.focus();
        if (btn.dataset.prompt) {
          const url = prompt('Link URL:', 'https://');
          if (!url) return;
          document.execCommand('createLink', false, url);
        } else {
          document.execCommand(btn.dataset.command, false, null);
        }
      });
    });

    // Screenshot paste -- same FileReader + resizeImageDataUrl round-trip
    // What's On's own Update editor uses, just landing in this row's own
    // image column (a fixed single thumbnail slot) instead of inserted
    // inline into flowing rich text.
    imagePreview.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items || [];
      const imageItem = [...items].find((item) => item.type.startsWith('image/'));
      if (!imageItem) return;
      e.preventDefault();
      const file = imageItem.getAsFile();
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        let src = reader.result;
        try {
          const resized = await resizeImageDataUrl(reader.result);
          if (dataUrlByteLength(resized) < file.size) src = resized;
        } catch {
          // Best-effort -- fall through with the original, un-shrunk data: URL.
        }
        currentImageDataUrl = src;
        imagePreview.innerHTML = `<img src="${escapeHtml(src)}" alt="" />`;
        removeImageBtn.hidden = false;
      };
      reader.readAsDataURL(file);
    });

    removeImageBtn.addEventListener('click', () => {
      currentImageDataUrl = null;
      imagePreview.innerHTML = '<span class="updates-image-placeholder">Click, then paste a screenshot</span>';
      removeImageBtn.hidden = true;
    });

    cancelBtn.addEventListener('click', () => onCancel());

    saveBtn.addEventListener('click', async () => {
      errorEl.hidden = true;
      const body = {
        entryDate: dateInput.value || todayKey(),
        imageDataUrl: currentImageDataUrl,
        contentHtml: isHtmlBlank(richEditor.innerHTML) ? '' : richEditor.innerHTML,
      };
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
      try {
        const result = isNew
          ? await fetchJson('/api/updates/entries', 'POST', body)
          : await fetchJson(`/api/updates/entries/${entry.id}`, 'PATCH', body);
        onSaved(result.entry);
      } catch (err) {
        errorEl.hidden = false;
        errorEl.textContent = `Error: ${err.message}`;
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save';
      }
    });

    return wrapper;
  }

  function resizeImageDataUrl(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
          const scale = MAX_IMAGE_DIMENSION / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', IMAGE_JPEG_QUALITY));
      };
      img.onerror = reject;
      img.src = dataUrl;
    });
  }

  function dataUrlByteLength(dataUrl) {
    const base64 = dataUrl.split(',')[1] || '';
    try {
      return atob(base64).length;
    } catch {
      return Math.round((base64.length * 3) / 4);
    }
  }
}

// Same blank-detection helper as the Help tab's own isHelpTextBlank() --
// contenteditable leaves stray `<div><br></div>` markup behind even when
// the user never typed anything, so a tag-stripped textContent check is
// what actually tells "genuinely blank" apart from that.
function isHtmlBlank(html) {
  if (!html) return true;
  const probe = document.createElement('div');
  probe.innerHTML = html;
  return probe.textContent.trim() === '';
}

// Browser-local "today" as "YYYY-MM-DD" -- close enough for a new entry's
// default date (our users are all in Queensland, so this is AEST in
// practice anyway), same reasoning Service Calls' own client.js uses for
// its calendar's initial month guess. The admin can always change it before
// saving regardless.
function todayKey() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatDisplayDate(dateKey) {
  if (!dateKey) return '';
  const d = new Date(`${dateKey}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateKey;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
