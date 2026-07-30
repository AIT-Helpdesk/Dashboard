const form = document.getElementById('date-form');
const dateInput = document.getElementById('date-input');
const statusEl = document.getElementById('status');
const summaryEl = document.getElementById('summary');
const resultsEl = document.getElementById('results');

function todayISO() {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  const local = new Date(now.getTime() - offset * 60000);
  return local.toISOString().slice(0, 10);
}
dateInput.value = todayISO();

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  await loadDate(dateInput.value);
});

async function loadDate(date) {
  const button = form.querySelector('button');
  button.disabled = true;
  statusEl.hidden = false;
  statusEl.className = 'status';
  statusEl.textContent = `Loading tickets completed on ${date}...`;
  summaryEl.hidden = true;
  resultsEl.innerHTML = '';

  try {
    const res = await fetch(`/api/completed-tickets?date=${encodeURIComponent(date)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
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
  summaryEl.innerHTML = `<strong>${data.totalCount}</strong> ticket${data.totalCount === 1 ? '' : 's'} completed on ${data.date}`;

  if (data.totalCount === 0) {
    resultsEl.innerHTML = '<p class="status">No tickets completed on this date.</p>';
    return;
  }

  resultsEl.innerHTML = '';
  for (const group of data.byResource) {
    const groupEl = document.createElement('div');
    groupEl.className = 'resource-group';

    const header = document.createElement('div');
    header.className = 'resource-group-header';
    header.innerHTML = `<span>${escapeHtml(group.resourceName)}</span><span class="count">${group.count} ticket${group.count === 1 ? '' : 's'}</span>`;
    groupEl.appendChild(header);

    const table = document.createElement('table');
    table.innerHTML = `
      <thead>
        <tr><th>Ticket #</th><th>Company</th><th>Title</th></tr>
      </thead>
      <tbody>
        ${group.tickets
          .map(
            (t) => `
          <tr>
            <td class="ticket-number">${escapeHtml(t.ticketNumber)}</td>
            <td>${escapeHtml(t.company)}</td>
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

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

loadDate(dateInput.value);
