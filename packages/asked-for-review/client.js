export const id = "asked-for-review";
export const label = "Asked for Review";

// Module-scope, not inside mount() -- the shell fully tears down and re-mounts a
// page's DOM on every navigation away and back, but the dynamically-imported
// module itself is cached by the browser and stays alive for the session, so a
// module-level variable survives across re-mounts and lets the last result
// restore instantly instead of coming back blank.
let lastDate = null;
let lastData = null;

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>Asked for Review</h1>
      <form id="date-form" class="date-form">
        <label for="date-input">Date</label>
        <input type="date" id="date-input" name="date" required />
        <button type="submit">Load</button>
      </form>
    </header>
    <p id="status" class="status">Pick any date and click Load -- shows the whole Monday-Sunday week that date falls in.</p>
    <div id="summary" class="summary" hidden></div>
    <div id="results" class="results"></div>
  `;

  const form = container.querySelector('#date-form');
  const dateInput = container.querySelector('#date-input');
  const statusEl = container.querySelector('#status');
  const summaryEl = container.querySelector('#summary');
  const resultsEl = container.querySelector('#results');

  function todayISO() {
    const now = new Date();
    const offset = now.getTimezoneOffset();
    const local = new Date(now.getTime() - offset * 60000);
    return local.toISOString().slice(0, 10);
  }
  dateInput.value = todayISO();

  if (lastDate) dateInput.value = lastDate;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    loadDate(dateInput.value);
  });

  async function loadDate(date) {
    const button = form.querySelector('button');
    button.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = `Loading tickets asked for review for the week of ${date}...`;
    summaryEl.hidden = true;
    resultsEl.innerHTML = '';

    try {
      const res = await fetch(`/api/asked-for-review?date=${encodeURIComponent(date)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastDate = date;
      lastData = data;
      render(data);
    } catch (err) {
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      button.disabled = false;
    }
  }

  function render(data) {
    statusEl.hidden = true;

    summaryEl.hidden = false;
    summaryEl.innerHTML = `<strong>${data.totalCount}</strong> ticket${data.totalCount === 1 ? '' : 's'} asked for review, week of ${formatDate(data.weekStart)} - ${formatDate(data.weekEnd)}`;

    resultsEl.innerHTML = '';
    for (const day of data.days) {
      const dayEl = document.createElement('div');
      dayEl.className = 'resource-group';

      const header = document.createElement('div');
      header.className = 'resource-group-header';
      header.innerHTML = `<span>${escapeHtml(day.label)} -- ${formatDate(day.date)}</span><span class="count">${day.count} ticket${day.count === 1 ? '' : 's'}</span>`;
      dayEl.appendChild(header);

      if (day.count === 0) {
        dayEl.insertAdjacentHTML('beforeend', '<p class="status" style="margin: 0.75rem 1rem;">None.</p>');
        resultsEl.appendChild(dayEl);
        continue;
      }

      const table = document.createElement('table');
      table.innerHTML = `
        <thead>
          <tr><th>Company</th><th>Ticket #</th><th>Title</th><th>Completed By</th></tr>
        </thead>
        <tbody>
          ${day.tickets
            .map(
              (t) => `
            <tr>
              <td>${escapeHtml(t.company)}</td>
              <td class="ticket-number">${ticketLink(t)}</td>
              <td>${escapeHtml(t.title)}</td>
              <td>${escapeHtml(t.completedBy)}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      `;
      dayEl.appendChild(table);
      resultsEl.appendChild(dayEl);
    }
  }

  if (lastData) render(lastData);

  function ticketLink(t) {
    const label = escapeHtml(t.ticketNumber);
    if (!t.ticketUrl) return label;
    return `<a href="${escapeHtml(t.ticketUrl)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  }

  function formatDate(isoDateOnly) {
    if (!isoDateOnly) return '';
    // isoDateOnly is a plain YYYY-MM-DD (no time), so parse it as UTC-midnight
    // explicitly -- new Date('YYYY-MM-DD') is already UTC-midnight per spec,
    // but toLocaleDateString below needs timeZone: 'UTC' to match, otherwise
    // a negative UTC offset rolls it back a day.
    const d = new Date(`${isoDateOnly}T00:00:00.000Z`);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
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
