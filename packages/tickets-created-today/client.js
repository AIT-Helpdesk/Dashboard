export const id = "tickets-created-today";
export const label = "Tickets Created";

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
      <h1>Tickets Created</h1>
      <form id="date-form" class="date-form">
        <label for="date-input">Date</label>
        <input type="date" id="date-input" name="date" required />
        <button type="submit">Load</button>
      </form>
    </header>
    <p id="status" class="status">Pick a date and click Load.</p>
    <div id="summary" class="summary" hidden></div>
    <div id="results" class="results"></div>
  `;

  const form = container.querySelector('#date-form');
  const dateInput = container.querySelector('#date-input');
  const statusEl = container.querySelector('#status');
  const summaryEl = container.querySelector('#summary');
  const resultsEl = container.querySelector('#results');

  // AEST (UTC+10, no DST in Queensland) "today", not the browser's own local
  // timezone -- computed explicitly so the date picker defaults to the
  // business's calendar day regardless of where the browser happens to be.
  function todayISO() {
    return new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString().slice(0, 10);
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
    statusEl.textContent = `Loading tickets created on ${date}...`;
    summaryEl.hidden = true;
    resultsEl.innerHTML = '';

    try {
      const res = await fetch(`/api/tickets-created-today?date=${encodeURIComponent(date)}`);
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
    summaryEl.innerHTML = `<strong>${data.totalCount}</strong> ticket${data.totalCount === 1 ? '' : 's'} created on ${data.date}`;

    if (data.totalCount === 0) {
      resultsEl.innerHTML = '<p class="status">No tickets created on this date.</p>';
      return;
    }

    resultsEl.innerHTML = '';
    for (const group of data.byCompany) {
      const groupEl = document.createElement('div');
      groupEl.className = 'resource-group';

      const header = document.createElement('div');
      header.className = 'resource-group-header';
      header.innerHTML = `<span>${escapeHtml(group.companyName)}</span><span class="count">${group.count} ticket${group.count === 1 ? '' : 's'}</span>`;
      groupEl.appendChild(header);

      const table = document.createElement('table');
      table.className = 'tickets-created-table';
      table.innerHTML = `
        <thead>
          <tr><th>Client</th><th>Ticket #</th><th>Created</th><th>Title</th></tr>
        </thead>
        <tbody>
          ${group.tickets
            .map(
              (t) => `
            <tr>
              <td>${escapeHtml(group.companyName)}</td>
              <td class="ticket-number">${ticketLink(t)}</td>
              <td class="ticket-number">${formatTime(t.createDate)}</td>
              <td>${escapeHtml(t.title)}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      `;
      groupEl.appendChild(table);
      resultsEl.appendChild(groupEl);
    }
  }

  if (lastData) render(lastData);

  function formatTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function ticketLink(t) {
    const label = escapeHtml(t.ticketNumber);
    if (!t.ticketUrl) return label;
    return `<a href="${escapeHtml(t.ticketUrl)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
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