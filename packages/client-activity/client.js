export const id = "client-activity";
export const label = "Client Activity";

// Module-scope, not inside mount() -- the shell fully tears down and re-mounts a
// page's DOM on every navigation away and back, but the dynamically-imported
// module itself is cached by the browser and stays alive for the session, so a
// module-level variable survives across re-mounts and lets the last result
// restore instantly instead of coming back blank.
let lastQuery = null; // { client }
let lastData = null;

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>Client Activity</h1>
      <form id="filter-form" class="date-form">
        <label for="client-input">Client</label>
        <input type="text" id="client-input" name="client" placeholder="e.g. Cloud King Hosting" required />
        <button type="submit" id="search-button">Search</button>
      </form>
    </header>
    <p id="status" class="status">Type a client name (wildcards with *) and click Search. This report is single-client, so a wildcard must match exactly one company.</p>
    <div id="results" class="results"></div>
  `;

  const form = container.querySelector('#filter-form');
  const clientInput = container.querySelector('#client-input');
  const searchButton = container.querySelector('#search-button');
  const statusEl = container.querySelector('#status');
  const resultsEl = container.querySelector('#results');

  if (lastQuery) clientInput.value = lastQuery.client;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    load(clientInput.value);
  });

  async function load(clientName, companyId) {
    searchButton.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = 'Loading...';
    resultsEl.innerHTML = '';

    try {
      const params = new URLSearchParams({ client: clientName });
      if (companyId) params.set('companyId', companyId);
      const res = await fetch(`/api/client-activity?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastQuery = { client: clientName };
      lastData = data;
      if (data.status === 'ok') clientInput.value = data.companyName;
      render(data);
    } catch (err) {
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      searchButton.disabled = false;
    }
  }

  function render(data) {
    if (data.status === 'not-found') {
      statusEl.hidden = false;
      statusEl.className = 'status error';
      statusEl.textContent = `No client found matching "${data.client}".`;
      resultsEl.innerHTML = '';
      return;
    }
    if (data.status === 'ambiguous') {
      statusEl.hidden = false;
      statusEl.className = 'status';
      statusEl.textContent = `"${data.client}" matched ${data.matches.length} clients -- pick one:`;
      resultsEl.innerHTML = '';

      const list = document.createElement('div');
      list.className = 'resource-group';
      list.innerHTML = `
        <table>
          <tbody>
            ${data.matches
              .map((m) => `<tr><td><button type="button" class="link-button" data-company-id="${m.id}">${escapeHtml(m.companyName)}</button></td></tr>`)
              .join('')}
          </tbody>
        </table>
      `;
      list.querySelectorAll('button[data-company-id]').forEach((btn) => {
        btn.addEventListener('click', () => load(data.client, btn.dataset.companyId));
      });
      resultsEl.appendChild(list);
      return;
    }

    statusEl.hidden = true;
    resultsEl.innerHTML = '';

    const heading = document.createElement('div');
    heading.className = 'summary';
    heading.innerHTML = `<strong>${companyLink(data)}</strong> -- last 12 months`;
    resultsEl.appendChild(heading);

    resultsEl.appendChild(sectionHeading('Tickets'));
    resultsEl.appendChild(ticketVolumeTable(data));

    resultsEl.appendChild(sectionHeading('Hours Logged'));
    resultsEl.appendChild(hoursTable(data));

    resultsEl.appendChild(sectionHeading(`Currently Open (${data.openTotal})`));
    resultsEl.appendChild(openSnapshot(data));

    const incompleteTickets = data.recentTickets.filter((t) => !t.done);
    const completedTickets = data.recentTickets.filter((t) => t.done);

    resultsEl.appendChild(sectionHeading(`Recent Tickets -- Incomplete (${incompleteTickets.length})`));
    resultsEl.appendChild(recentTicketsTable(incompleteTickets));

    resultsEl.appendChild(sectionHeading(`Recent Tickets -- Completed (${completedTickets.length})`));
    resultsEl.appendChild(recentTicketsTable(completedTickets));
  }

  if (lastData) render(lastData);

  function sectionHeading(text) {
    const h = document.createElement('h2');
    h.textContent = text;
    h.style.fontSize = '1.1rem';
    h.style.margin = '1.5rem 0 0.75rem';
    return h;
  }

  function ticketVolumeTable(data) {
    const totalCreated = data.ticketMonths.reduce((s, m) => s + m.created, 0);
    const totalCompleted = data.ticketMonths.reduce((s, m) => s + m.completed, 0);
    const wrap = document.createElement('div');
    wrap.className = 'resource-group';
    wrap.style.overflowX = 'auto';
    wrap.innerHTML = `
      <table>
        <thead>
          <tr><th>Category</th>${data.ticketMonths.map((m) => `<th class="ticket-number">${escapeHtml(m.label)}</th>`).join('')}<th class="ticket-number">12-Month Total</th></tr>
        </thead>
        <tbody>
          <tr><td>Created</td>${data.ticketMonths.map((m) => `<td class="ticket-number">${m.created}</td>`).join('')}<td class="ticket-number">${totalCreated}</td></tr>
          <tr><td>Completed</td>${data.ticketMonths.map((m) => `<td class="ticket-number">${m.completed}</td>`).join('')}<td class="ticket-number">${totalCompleted}</td></tr>
        </tbody>
      </table>
    `;
    return wrap;
  }

  function hoursTable(data) {
    const wrap = document.createElement('div');
    wrap.className = 'resource-group';
    wrap.style.overflowX = 'auto';
    wrap.innerHTML = `
      <table>
        <thead>
          <tr><th>Category</th>${data.hourMonths.map((m) => `<th class="ticket-number">${escapeHtml(m.label)}</th>`).join('')}<th class="ticket-number">12-Month Total</th></tr>
        </thead>
        <tbody>
          <tr><td>Billable</td>${data.hourMonths.map((m) => `<td class="ticket-number">${formatHours(m.billable)}</td>`).join('')}<td class="ticket-number">${formatHours(data.hourTotals.billable)}</td></tr>
          <tr><td>Non-Billable</td>${data.hourMonths.map((m) => `<td class="ticket-number">${formatHours(m.nonBillable)}</td>`).join('')}<td class="ticket-number">${formatHours(data.hourTotals.nonBillable)}</td></tr>
          <tr style="font-weight: 600; border-top: 2px solid var(--border);"><td>Total</td>${data.hourMonths.map((m) => `<td class="ticket-number">${formatHours(m.total)}</td>`).join('')}<td class="ticket-number">${formatHours(data.hourTotals.total)}</td></tr>
        </tbody>
      </table>
    `;
    return wrap;
  }

  function openSnapshot(data) {
    const wrap = document.createElement('div');
    wrap.style.display = 'grid';
    wrap.style.gridTemplateColumns = 'repeat(auto-fit, minmax(260px, 1fr))';
    wrap.style.gap = '0.75rem';
    wrap.appendChild(breakdownTable('By Status', data.openByStatus));
    wrap.appendChild(breakdownTable('By Priority', data.openByPriority));
    return wrap;
  }

  function breakdownTable(title, rows) {
    const group = document.createElement('div');
    group.className = 'resource-group';
    if (rows.length === 0) {
      group.innerHTML = `<div class="resource-group-header"><span>${escapeHtml(title)}</span></div><p class="status" style="padding: 0.75rem 1rem;">None open.</p>`;
      return group;
    }
    group.innerHTML = `
      <div class="resource-group-header"><span>${escapeHtml(title)}</span></div>
      <table>
        <tbody>
          ${rows.map((r) => `<tr><td>${escapeHtml(r.label)}</td><td class="ticket-number">${r.count}</td></tr>`).join('')}
        </tbody>
      </table>
    `;
    return group;
  }

  function recentTicketsTable(tickets) {
    const wrap = document.createElement('div');
    wrap.className = 'resource-group';
    if (tickets.length === 0) {
      wrap.innerHTML = '<p class="status" style="padding: 0.75rem 1rem;">None.</p>';
      return wrap;
    }
    wrap.innerHTML = `
      <table>
        <thead>
          <tr><th>Ticket #</th><th>Title</th><th>Status</th><th>Priority</th><th title="From the Resolution Plan SLA event to the Resolved SLA event">Time to Close</th><th>Created</th></tr>
        </thead>
        <tbody>
          ${tickets
            .map(
              (t) => `
            <tr>
              <td class="ticket-number">${ticketLink(t)}</td>
              <td>${escapeHtml(t.title)}</td>
              <td>${escapeHtml(t.status)}</td>
              <td>${escapeHtml(priorityShort(t.priority))}</td>
              <td class="ticket-number">${escapeHtml(timeToClose(t))}</td>
              <td class="ticket-number">${formatDate(t.createDate)}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
    `;
    return wrap;
  }

  function companyLink(data) {
    const label = escapeHtml(data.companyName);
    if (!data.companyUrl) return label;
    return `<a href="${escapeHtml(data.companyUrl)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  }

  function ticketLink(t) {
    const label = escapeHtml(t.ticketNumber);
    if (!t.ticketUrl) return label;
    // A real popup window, not just a new tab -- specifying window features
    // (width/height/etc.) is what signals that to the browser. Same pattern
    // as Service Calls' own ticket links. target/rel kept as a fallback for
    // JS-disabled or a manual middle-click/right-click "open in new tab".
    return `<a href="${escapeHtml(t.ticketUrl)}" target="_blank" rel="noopener noreferrer" onclick="window.open(this.href, '_blank', 'noopener,noreferrer,width=1200,height=900'); return false;">${label}</a>`;
  }

  function formatDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString();
  }

  function formatHours(value) {
    if (value === null || value === undefined) return '';
    return Number(value).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  }

  // Shortens a priority label to its first word (e.g. "P2 - CLIENT ADVISED" ->
  // "P2", "!! SET PRIORITY" -> "!!") ONLY when that word is exactly 2
  // characters -- anything that doesn't reduce to a short code (e.g.
  // "Information", "ONBOARDING") shows blank instead.
  function priorityShort(label) {
    if (!label) return '';
    const firstWord = label.split(' ')[0];
    return firstWord.length === 2 ? firstWord : '';
  }

  // Time to close: from the (latest) Resolution Plan SLA event to the
  // Resolved SLA event. Blank when either never fired, or when Resolved
  // somehow precedes Resolution Plan (data anomaly, not a real duration).
  function timeToClose(t) {
    if (!t.resolutionPlanDateTime || !t.resolvedDateTime) return '';
    const ms = new Date(t.resolvedDateTime) - new Date(t.resolutionPlanDateTime);
    if (!(ms > 0)) return '';
    const totalHours = ms / 3600000;
    if (totalHours >= 24) {
      const days = Math.floor(totalHours / 24);
      const hours = Math.round(totalHours % 24);
      return `${days}d ${hours}h`;
    }
    const hours = Math.floor(totalHours);
    const minutes = Math.round((totalHours - hours) * 60);
    return `${hours}h ${minutes}m`;
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
