export const id = "find-passwords";
export const label = "Find Passwords";

// Module-scope, not inside mount() -- the shell fully tears down and re-mounts a
// page's DOM on every navigation away and back, but the dynamically-imported
// module itself is cached by the browser and stays alive for the session, so a
// module-level variable survives across re-mounts and lets the last result
// restore instantly instead of coming back blank.
let lastTerm = '';
let lastData = null;

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>Find Passwords</h1>
      <form id="filter-form" class="date-form">
        <label for="name-input">Password Name</label>
        <input type="text" id="name-input" name="name" placeholder="e.g. *M365*, *Admin* (wildcards with *)" required />
        <button type="submit" id="search-button">Search</button>
      </form>
    </header>
    <p id="status" class="status">Type a password name (wildcards with *) and click Search. Metadata only -- the password itself and any notes are never retrieved or shown here.</p>
    <div id="summary" class="summary" hidden></div>
    <div id="results" class="results"></div>
  `;

  const form = container.querySelector('#filter-form');
  const nameInput = container.querySelector('#name-input');
  const searchButton = container.querySelector('#search-button');
  const statusEl = container.querySelector('#status');
  const summaryEl = container.querySelector('#summary');
  const resultsEl = container.querySelector('#results');

  if (lastTerm) nameInput.value = lastTerm;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    load(nameInput.value);
  });

  async function load(term) {
    searchButton.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = `Searching for "${term}"...`;
    summaryEl.hidden = true;
    resultsEl.innerHTML = '';

    try {
      const params = new URLSearchParams({ name: term });
      const res = await fetch(`/api/find-passwords?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastTerm = term;
      lastData = data;
      render(data);
    } catch (err) {
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      searchButton.disabled = false;
    }
  }

  function render(data) {
    statusEl.hidden = true;
    summaryEl.hidden = false;
    summaryEl.innerHTML = `<strong>${data.totalCount}</strong> password${data.totalCount === 1 ? '' : 's'} matching "${escapeHtml(data.nameTerm)}"<span class="inline-subtext"> -- as of ${formatDateTime(data.asOf)}</span>`;

    resultsEl.innerHTML = '';
    if (data.results.length === 0) {
      resultsEl.innerHTML = `<p class="status">No passwords found matching "${escapeHtml(data.nameTerm)}".</p>`;
      return;
    }

    const wrap = document.createElement('div');
    wrap.className = 'resource-group';
    wrap.style.overflowX = 'auto';
    wrap.innerHTML = `
      <table>
        <thead>
          <tr class="shaded-row">
            <th>Client Name</th>
            <th>Password Name</th>
            <th>Username</th>
            <th>Shareable</th>
            <th>Type</th>
            <th>Category</th>
            <th>OTP Configured</th>
            <th>Date Last Changed</th>
          </tr>
        </thead>
        <tbody>
          ${data.results.map((p) => resultRowHtml(p)).join('')}
        </tbody>
      </table>
    `;
    resultsEl.appendChild(wrap);
  }

  function resultRowHtml(p) {
    const nameCell = p.itglueUrl
      ? `<a href="${escapeHtml(p.itglueUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(p.passwordName)}</a>`
      : escapeHtml(p.passwordName);
    return `
      <tr>
        <td>${escapeHtml(p.clientName || '')}</td>
        <td>${nameCell}</td>
        <td>${escapeHtml(p.username || '')}</td>
        <td>${p.shareable ? 'Yes' : 'No'}</td>
        <td>${escapeHtml(p.type || '')}</td>
        <td>${escapeHtml(p.category || '')}</td>
        <td>${p.otpConfigured ? 'Yes' : 'No'}</td>
        <td class="ticket-number">${formatDateTime(p.dateLastChanged)}</td>
      </tr>`;
  }

  if (lastData) render(lastData);

  function formatDateTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString();
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
