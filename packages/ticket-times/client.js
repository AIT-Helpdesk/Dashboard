export const id = "ticket-times";
export const label = "Ticket Times";

// Module-scope, not inside mount() -- the shell fully tears down and re-mounts a
// page's DOM on every navigation away and back, but the dynamically-imported
// module itself is cached by the browser and stays alive for the session, so a
// module-level variable survives across re-mounts and lets the last result
// restore instantly instead of coming back blank.
let lastParams = null; // { from, to }
let lastData = null;
// Same "remember which quick-date button produced the current From/To"
// convention Time Summaries' own page uses -- see that page's own
// lastActiveQuickButtonId comment for the full reasoning.
let lastActiveQuickButtonId = 'tt-quick-today-button';

export function mount(container) {
  // From/To + the same 6 quick-date pill buttons Time Summaries uses, by
  // request ("use the From and To date style selectors and the 6 buttons
  // like on the Time Summaries Page on the Completed Tickets and Ticket
  // Times Pages. Both should default to Today") -- replaces the original
  // single date picker. Ids prefixed `tt-` (this page) so they don't
  // collide with Time Summaries' own identical ids if both happened to be
  // in the DOM at once (they aren't, normally, but the shell keeps a
  // navigated-away page's module alive -- see lastParams' own comment).
  container.innerHTML = `
    <header class="page-header">
      <h1>Ticket Times by Technician</h1>
    </header>
    <form id="tt-date-form" class="date-form date-form--stacked">
      <div class="date-form-row">
        <label for="tt-from-input">From</label>
        <input type="date" id="tt-from-input" name="from" required />
        <label for="tt-to-input">To</label>
        <input type="date" id="tt-to-input" name="to" required />
        <div class="tm-quick-date-groups">
          <div class="tm-quick-date-group">
            <button type="button" class="button-link button-link--small" id="tt-quick-today-button">Today</button>
            <button type="button" class="button-link button-link--small" id="tt-quick-yesterday-button">Yesterday</button>
          </div>
          <div class="tm-quick-date-group">
            <button type="button" class="button-link button-link--small" id="tt-quick-this-week-button">This Week</button>
            <button type="button" class="button-link button-link--small" id="tt-quick-last-week-button">Last Week</button>
          </div>
          <div class="tm-quick-date-group">
            <button type="button" class="button-link button-link--small" id="tt-quick-this-month-button">This Month</button>
            <button type="button" class="button-link button-link--small" id="tt-quick-last-month-button">Last Month</button>
          </div>
        </div>
      </div>
      <div class="date-form-row">
        <button type="submit">Load</button>
      </div>
    </form>
    <p id="status" class="status">Pick a date range, then click Load.</p>
    <div id="summary" class="summary summary-line-compact" hidden></div>
    <div id="results" class="results"></div>
  `;

  const form = container.querySelector('#tt-date-form');
  const fromInput = container.querySelector('#tt-from-input');
  const toInput = container.querySelector('#tt-to-input');
  const statusEl = container.querySelector('#status');
  const summaryEl = container.querySelector('#summary');
  const resultsEl = container.querySelector('#results');

  // AEST (UTC+10, no DST in Queensland) "today", not the browser's own local
  // timezone -- same helper/reasoning as Time Summaries' own todayISO().
  function todayISO() {
    return new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }
  function mondayOfWeek(iso) {
    const d = new Date(`${iso}T00:00:00Z`);
    const day = d.getUTCDay(); // 0 Sun .. 6 Sat
    const diff = day === 0 ? -6 : 1 - day; // back up to Monday
    d.setUTCDate(d.getUTCDate() + diff);
    return d.toISOString().slice(0, 10);
  }
  function addDays(iso, n) {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function startOfMonth(iso, n) {
    const d = new Date(`${iso}T00:00:00Z`);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)).toISOString().slice(0, 10);
  }
  function endOfMonth(iso, n) {
    const d = new Date(`${iso}T00:00:00Z`);
    // Day 0 of the FOLLOWING month is the last day of the target month.
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n + 1, 0)).toISOString().slice(0, 10);
  }

  // Same paired/stacked pill buttons, same "This Week"/"This Month" run
  // only up to today (not the rest of the still-in-progress period), same
  // "highlight clears the moment a field's hand-edited" behaviour as Time
  // Summaries' own quick-date buttons -- copied from that page's client.js
  // rather than reimplemented.
  const QUICK_DATE_BUTTON_IDS = [
    'tt-quick-today-button',
    'tt-quick-yesterday-button',
    'tt-quick-this-week-button',
    'tt-quick-last-week-button',
    'tt-quick-this-month-button',
    'tt-quick-last-month-button',
  ];
  function setActiveQuickButton(id) {
    lastActiveQuickButtonId = id;
    for (const btnId of QUICK_DATE_BUTTON_IDS) {
      container.querySelector(`#${btnId}`).classList.toggle('active', btnId === id);
    }
  }
  fromInput.addEventListener('input', () => setActiveQuickButton(null));
  toInput.addEventListener('input', () => setActiveQuickButton(null));

  container.querySelector('#tt-quick-today-button').addEventListener('click', () => {
    const today = todayISO();
    fromInput.value = today;
    toInput.value = today;
    setActiveQuickButton('tt-quick-today-button');
  });
  container.querySelector('#tt-quick-yesterday-button').addEventListener('click', () => {
    const yesterday = addDays(todayISO(), -1);
    fromInput.value = yesterday;
    toInput.value = yesterday;
    setActiveQuickButton('tt-quick-yesterday-button');
  });
  container.querySelector('#tt-quick-this-week-button').addEventListener('click', () => {
    fromInput.value = mondayOfWeek(todayISO());
    toInput.value = todayISO();
    setActiveQuickButton('tt-quick-this-week-button');
  });
  container.querySelector('#tt-quick-last-week-button').addEventListener('click', () => {
    const thisMonday = mondayOfWeek(todayISO());
    fromInput.value = addDays(thisMonday, -7);
    toInput.value = addDays(thisMonday, -1);
    setActiveQuickButton('tt-quick-last-week-button');
  });
  container.querySelector('#tt-quick-this-month-button').addEventListener('click', () => {
    fromInput.value = startOfMonth(todayISO(), 0);
    toInput.value = todayISO();
    setActiveQuickButton('tt-quick-this-month-button');
  });
  container.querySelector('#tt-quick-last-month-button').addEventListener('click', () => {
    const today = todayISO();
    fromInput.value = startOfMonth(today, -1);
    toInput.value = endOfMonth(today, -1);
    setActiveQuickButton('tt-quick-last-month-button');
  });

  if (lastParams) {
    fromInput.value = lastParams.from;
    toInput.value = lastParams.to;
    setActiveQuickButton(lastActiveQuickButtonId);
  } else {
    // Today, by request ("Both should default to Today").
    const today = todayISO();
    fromInput.value = today;
    toInput.value = today;
    setActiveQuickButton('tt-quick-today-button');
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    load();
  });

  async function load() {
    const from = fromInput.value;
    const to = toInput.value;
    if (!from || !to) return;
    if (to < from) {
      statusEl.hidden = false;
      statusEl.className = 'status error';
      statusEl.textContent = 'Error: "To" must not be before "From".';
      return;
    }

    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = `Loading time entries for ${from} to ${to}...`;
    summaryEl.hidden = true;
    resultsEl.innerHTML = '';

    try {
      const res = await fetch(`/api/ticket-times?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastParams = { from, to };
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

    // "{Date range} - {Count} tickets - {total time summed} - {4 coloured
    // $ figures}", by request -- went through a few revisions (originally
    // plain "{Count} tickets with time logged on {Date} -- {total}", then
    // one blended $ total, then "To Invoice"/"TC Elite", then "Posted"/
    // "Pending"/"TC Elite", finally settled as "Invoiced, Posted, Pending
    // and TC Elite" -- Green/Orange/Red/Blue respectively, by request
    // ("Colour the 4 types, Green, Orange, Red, and Blue"). Date shows as
    // a single "{from}" when From/To match (the common case, still just
    // one real date), else "{from} to {to}" -- server.js echoes back
    // whatever from/to it actually used, same "don't just re-read the
    // inputs client-side" reasoning About Me's own dateRangeLabel()
    // already follows. Date/Count/Hours stay plain text (no colour) --
    // only the 4 $ figures are coloured, via the same
    // .text-highlight-green/-orange/-red/-blue classes used dashboard-
    // wide, not one-off colours. Whole line set smaller (.summary-line-
    // compact, styles.css), by request ("Make the text of the whole line
    // smaller so that it's not so long") -- 4 $ figures made this line
    // noticeably longer than it used to be.
    const dateLabel = data.from === data.to ? data.from : `${data.from} to ${data.to}`;
    summaryEl.hidden = false;
    summaryEl.innerHTML = `${escapeHtml(dateLabel)} - ${data.totalCount} ticket${data.totalCount === 1 ? '' : 's'} - ${formatHours(data.totalHoursWorked)} (h:mm) total - <span class="text-highlight-green">Invoiced: ${formatCurrency(data.totalInvoicedDollars)}</span> - <span class="text-highlight-orange">Posted: ${formatCurrency(data.totalPostedDollars)}</span> - <span class="text-highlight-red">Pending: ${formatCurrency(data.totalPendingDollars)}</span> (<span class="text-highlight-blue">TC Elite: ${formatCurrency(data.totalTcEliteDollars)}</span>)`;

    if (data.totalCount === 0) {
      resultsEl.innerHTML = '<p class="status">No time entries logged against tickets in this date range.</p>';
      return;
    }

    resultsEl.innerHTML = '';
    for (const group of data.byResource) {
      const groupEl = document.createElement('div');
      groupEl.className = 'resource-group';

      // Collapsible, starting minimized once data is displayed, by request
      // -- same real .resource-group-header--toggle/.toggle-arrow
      // convention Security Alerts' own "All Alerts" list already uses,
      // reused here rather than invented fresh (see that page's client.js).
      const header = document.createElement('div');
      header.className = `resource-group-header resource-group-header--toggle${group.isCurrentUser ? ' resource-group-header--me' : ''}`;
      const nameLabel = escapeHtml(group.resourceName) + (group.isCurrentUser ? ' (You)' : '');
      header.innerHTML = `<span><span class="toggle-arrow">▸</span>${nameLabel}</span><span class="count">${group.count} ticket${group.count === 1 ? '' : 's'} -- ${formatHours(group.hoursWorked)} -- ${formatCurrency(group.dollars)}</span>`;
      groupEl.appendChild(header);

      const contentEl = document.createElement('div');
      contentEl.hidden = true; // minimized by default -- by request

      // Sub-grouped by Ticket Category (already ordered Z->A by the server),
      // each with its own small heading and its own table -- same fixed-width
      // column CSS (.ticket-times-table) as every other table on this page,
      // so categories stack in alignment just like the technician tables do.
      for (const cat of group.categories) {
        // Totals shown right on the green header itself now, by request --
        // same left-label/right-figures split .resource-group-header
        // already uses (.section-heading--split, see styles.css). Replaces
        // the separate "Total" row that used to close out each table.
        const catHeader = document.createElement('div');
        catHeader.className = 'section-heading section-heading--green section-heading--split';
        catHeader.innerHTML = `<span>${escapeHtml(cat.category)} (${cat.tickets.length})</span><span class="count">${formatHours(cat.hoursWorked)} -- ${formatCurrency(cat.dollars)}</span>`;
        contentEl.appendChild(catHeader);

        // No column headers -- by request ("we don't need the column
        // headers. The content is intuitively known."): Company/Status/
        // Ticket #/Title/Time/$ is obvious from the data itself once
        // you've seen one row. The shared .ticket-times-table column-width
        // CSS still applies (it targets td:nth-child, not just
        // th:nth-child), so dropping <thead> doesn't touch alignment.
        const table = document.createElement('table');
        table.className = 'ticket-times-table';
        table.innerHTML = `
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
                <td class="ticket-number">${formatCurrency(t.dollars)}</td>
              </tr>`
              )
              .join('')}
          </tbody>
        `;
        table.querySelectorAll('a.ticket-link').forEach((a) => a.addEventListener('click', openTicketInNewWindow));
        contentEl.appendChild(table);
      }
      groupEl.appendChild(contentEl);

      const arrow = header.querySelector('.toggle-arrow');
      header.addEventListener('click', () => {
        contentEl.hidden = !contentEl.hidden;
        arrow.textContent = contentEl.hidden ? '▸' : '▾';
      });

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

  // Same $#,##0.00 (en-AU) convention @dashboard/times' own Billable $ box
  // already uses -- not invented fresh here.
  function formatCurrency(n) {
    return `$${(n || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
