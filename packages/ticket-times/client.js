export const id = "ticket-times";
export const label = "Ticket Times";

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
      <h1>Ticket Times by Technician</h1>
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
    statusEl.textContent = `Loading time entries for ${date}...`;
    summaryEl.hidden = true;
    resultsEl.innerHTML = '';

    try {
      const res = await fetch(`/api/ticket-times?date=${encodeURIComponent(date)}`);
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
    summaryEl.innerHTML = `<strong>${data.totalCount}</strong> ticket${data.totalCount === 1 ? '' : 's'} with time logged on ${data.date}<span class="inline-subtext"> -- ${formatHours(data.totalHoursWorked)} (h:mm) total</span>`;

    if (data.totalCount === 0) {
      resultsEl.innerHTML = '<p class="status">No time entries logged against tickets on this date.</p>';
      return;
    }

    resultsEl.innerHTML = '';
    for (const group of data.byResource) {
      const groupEl = document.createElement('div');
      groupEl.className = 'resource-group';

      const header = document.createElement('div');
      header.className = group.isCurrentUser ? 'resource-group-header resource-group-header--me' : 'resource-group-header';
      const nameLabel = escapeHtml(group.resourceName) + (group.isCurrentUser ? ' (You)' : '');
      header.innerHTML = `<span>${nameLabel}</span><span class="count">${group.count} ticket${group.count === 1 ? '' : 's'} -- ${formatHours(group.hoursWorked)}</span>`;
      groupEl.appendChild(header);

      // Sub-grouped by Ticket Category (already ordered Z->A by the server),
      // each with its own small heading and its own table -- same fixed-width
      // column CSS (.ticket-times-table) as every other table on this page,
      // so categories stack in alignment just like the technician tables do.
      for (const cat of group.categories) {
        const catHeader = document.createElement('div');
        catHeader.className = 'section-heading section-heading--green';
        catHeader.textContent = `${cat.category} (${cat.tickets.length})`;
        groupEl.appendChild(catHeader);

        const table = document.createElement('table');
        table.className = 'ticket-times-table';
        table.innerHTML = `
          <thead>
            <tr><th>Company</th><th>Status</th><th>Ticket #</th><th>Title</th><th>Time</th></tr>
          </thead>
          <tbody>
            ${cat.tickets
              .map(
                (t) => `
              <tr>
                <td>${escapeHtml(t.company)}</td>
                <td>${escapeHtml(t.status)}</td>
                <td class="ticket-number">${ticketLink(t)}</td>
                <td>${escapeHtml(t.title)}</td>
                <td class="ticket-number">${formatHours(t.hoursWorked)}</td>
              </tr>`
              )
              .join('')}
          </tbody>
        `;
        table.querySelectorAll('a.ticket-link').forEach((a) => a.addEventListener('click', openTicketInNewWindow));
        groupEl.appendChild(table);
      }
      resultsEl.appendChild(groupEl);
    }
  }

  if (lastData) render(lastData);

  // HH:MM, same as Completed Tickets -- Autotask's hoursWorked is a decimal
  // (e.g. 1.2667), which doesn't read as a duration at a glance. Rounds to
  // the nearest minute; a minute count that rounds up to 60 rolls over into
  // the next hour rather than ever showing ":60".
  function formatHours(hours) {
    const totalMinutes = Math.round((hours || 0) * 60);
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  function ticketLink(t) {
    const label = escapeHtml(t.ticketNumber);
    if (!t.ticketUrl) return label;
    // No inline onclick here, unlike the other pages' own ticketLink() --
    // this page already gets the same real-popup-window treatment via
    // openTicketInNewWindow(), bound with addEventListener to every
    // a.ticket-link after the table renders (see below). Adding an inline
    // onclick too would double-fire and open two windows per click.
    return `<a href="${escapeHtml(t.ticketUrl)}" class="ticket-link" target="_blank" rel="noopener noreferrer">${label}</a>`;
  }

  // A bare target="_blank" opens as a new TAB under every modern browser's
  // default settings, by request this page wants an actual new WINDOW --
  // passing explicit size features to window.open() is what makes browsers
  // treat it as a window instead. target="_blank"/rel stay on the <a> itself
  // as a plain-tab fallback for anything that reaches the link without a
  // click event (e.g. "open link in new tab" from a context menu).
  function openTicketInNewWindow(e) {
    e.preventDefault();
    window.open(e.currentTarget.href, '_blank', 'noopener,noreferrer,width=1200,height=900');
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
