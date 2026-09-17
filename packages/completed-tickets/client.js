export const id = "completed-tickets";
export const label = "Completed Tickets";

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
let lastActiveQuickButtonId = 'ct-quick-today-button';

export function mount(container) {
  // From/To + the same 6 quick-date pill buttons Time Summaries uses, by
  // request ("use the From and To date style selectors and the 6 buttons
  // like on the Time Summaries Page on the Completed Tickets and Ticket
  // Times Pages. Both should default to Today") -- replaces the original
  // single date picker. Ids prefixed `ct-` (this page) so they don't
  // collide with Time Summaries'/Ticket Times' own identical ids if more
  // than one happened to be in the DOM at once (see lastParams' own
  // comment for why a navigated-away page's module can stay alive).
  container.innerHTML = `
    <header class="page-header">
      <h1>Completed Tickets by Technician</h1>
    </header>
    <form id="ct-date-form" class="date-form date-form--stacked">
      <div class="date-form-row">
        <label for="ct-from-input">From</label>
        <input type="date" id="ct-from-input" name="from" required />
        <label for="ct-to-input">To</label>
        <input type="date" id="ct-to-input" name="to" required />
        <div class="tm-quick-date-groups">
          <div class="tm-quick-date-group">
            <button type="button" class="button-link button-link--small" id="ct-quick-today-button">Today</button>
            <button type="button" class="button-link button-link--small" id="ct-quick-yesterday-button">Yesterday</button>
          </div>
          <div class="tm-quick-date-group">
            <button type="button" class="button-link button-link--small" id="ct-quick-this-week-button">This Week</button>
            <button type="button" class="button-link button-link--small" id="ct-quick-last-week-button">Last Week</button>
          </div>
          <div class="tm-quick-date-group">
            <button type="button" class="button-link button-link--small" id="ct-quick-this-month-button">This Month</button>
            <button type="button" class="button-link button-link--small" id="ct-quick-last-month-button">Last Month</button>
          </div>
        </div>
      </div>
      <div class="date-form-row">
        <button type="submit">Load</button>
      </div>
    </form>
    <p id="status" class="status">Pick a date range, then click Load.</p>
    <div id="summary" class="summary summary-line-compact" hidden>
      <div id="summary-text"></div>
      <p id="hours-dollars-note" class="inline-subtext">Hours and $$ on this page are for the whole ticket not the selected day only. The date selection is for tickets <em>closed</em> in that range.</p>
    </div>
    <div id="results" class="results"></div>
  `;

  const form = container.querySelector('#ct-date-form');
  const fromInput = container.querySelector('#ct-from-input');
  const toInput = container.querySelector('#ct-to-input');
  const statusEl = container.querySelector('#status');
  const summaryEl = container.querySelector('#summary');
  const summaryTextEl = container.querySelector('#summary-text');
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
    'ct-quick-today-button',
    'ct-quick-yesterday-button',
    'ct-quick-this-week-button',
    'ct-quick-last-week-button',
    'ct-quick-this-month-button',
    'ct-quick-last-month-button',
  ];
  function setActiveQuickButton(id) {
    lastActiveQuickButtonId = id;
    for (const btnId of QUICK_DATE_BUTTON_IDS) {
      container.querySelector(`#${btnId}`).classList.toggle('active', btnId === id);
    }
  }
  fromInput.addEventListener('input', () => setActiveQuickButton(null));
  toInput.addEventListener('input', () => setActiveQuickButton(null));

  container.querySelector('#ct-quick-today-button').addEventListener('click', () => {
    const today = todayISO();
    fromInput.value = today;
    toInput.value = today;
    setActiveQuickButton('ct-quick-today-button');
  });
  container.querySelector('#ct-quick-yesterday-button').addEventListener('click', () => {
    const yesterday = addDays(todayISO(), -1);
    fromInput.value = yesterday;
    toInput.value = yesterday;
    setActiveQuickButton('ct-quick-yesterday-button');
  });
  container.querySelector('#ct-quick-this-week-button').addEventListener('click', () => {
    fromInput.value = mondayOfWeek(todayISO());
    toInput.value = todayISO();
    setActiveQuickButton('ct-quick-this-week-button');
  });
  container.querySelector('#ct-quick-last-week-button').addEventListener('click', () => {
    const thisMonday = mondayOfWeek(todayISO());
    fromInput.value = addDays(thisMonday, -7);
    toInput.value = addDays(thisMonday, -1);
    setActiveQuickButton('ct-quick-last-week-button');
  });
  container.querySelector('#ct-quick-this-month-button').addEventListener('click', () => {
    fromInput.value = startOfMonth(todayISO(), 0);
    toInput.value = todayISO();
    setActiveQuickButton('ct-quick-this-month-button');
  });
  container.querySelector('#ct-quick-last-month-button').addEventListener('click', () => {
    const today = todayISO();
    fromInput.value = startOfMonth(today, -1);
    toInput.value = endOfMonth(today, -1);
    setActiveQuickButton('ct-quick-last-month-button');
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
    setActiveQuickButton('ct-quick-today-button');
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
    statusEl.textContent = `Loading tickets completed from ${from} to ${to}...`;
    summaryEl.hidden = true;
    resultsEl.innerHTML = '';

    try {
      const res = await fetch(`/api/completed-tickets?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
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

    // "{Date} - {Count} tickets - {total time summed} - {$ total}", by
    // request ("change the info line ... at the top of 'Completed
    // Tickets' to be like the one we just changed on 'Ticket Times'") --
    // same plain-text, one-uniform-style line as that page now uses
    // (previously "{Count} tickets completed on {Date} -- {total} logged
    // against them", with Count bold and the total in the smaller/muted
    // .inline-subtext look). The small-print note right underneath (by
    // request, "Hours and $$ on this page are for the whole ticket not
    // the selected day only...") lives INSIDE #summary as a second line,
    // not a separate sibling element -- .summary's own margin-bottom
    // (spacing before #results) would otherwise also land BETWEEN this
    // line and the note (margins collapse across sibling block elements),
    // producing a much bigger gap than intended; nesting both under one
    // container keeps that margin where it belongs, after both lines.
    // $ total split into 4 coloured figures -- Invoiced/Posted/Pending/TC
    // Elite, Green/Orange/Red/Blue respectively -- by request, went
    // through the same revisions @dashboard/ticket-times' own line did
    // (originally "To Invoice"/"TC Elite", then "Posted"/"Pending"/"TC
    // Elite", finally "Let's have Invoiced, Posted, Pending and TC
    // Elite. ... Colour the 4 types, Green, Orange, Red, and Blue"), via
    // the same .text-highlight-green/-orange/-red/-blue classes used
    // dashboard-wide. Date shows as a single "{from}" when From/To match
    // (the common case, still just one real date), else "{from} to
    // {to}" -- server.js echoes back whatever from/to it actually used,
    // same reasoning Ticket Times' own dateLabel follows. Whole line set
    // smaller (.summary-line-compact, styles.css), by request ("Make the
    // text of the whole line smaller so that it's not so long").
    const dateLabel = data.from === data.to ? data.from : `${data.from} to ${data.to}`;
    summaryEl.hidden = false;
    summaryTextEl.innerHTML = `${escapeHtml(dateLabel)} - ${data.totalCount} ticket${data.totalCount === 1 ? '' : 's'} - ${formatHours(data.totalHoursWorked)} (h:mm) total - <span class="text-highlight-green">Invoiced: ${formatCurrency(data.totalInvoicedDollars)}</span> - <span class="text-highlight-orange">Posted: ${formatCurrency(data.totalPostedDollars)}</span> - <span class="text-highlight-red">Pending: ${formatCurrency(data.totalPendingDollars)}</span> (<span class="text-highlight-blue">TC Elite: ${formatCurrency(data.totalTcEliteDollars)}</span>)`;

    if (data.totalCount === 0) {
      resultsEl.innerHTML = '<p class="status">No tickets completed in this date range.</p>';
      return;
    }

    resultsEl.innerHTML = '';
    for (const group of data.byResource) {
      const groupEl = document.createElement('div');
      groupEl.className = 'resource-group';

      // Collapsible, starting minimized once data is displayed, by request
      // -- same real .resource-group-header--toggle/.toggle-arrow
      // convention Ticket Times/Security Alerts' own "All Alerts" list
      // already use, reused here rather than invented fresh.
      const header = document.createElement('div');
      header.className = 'resource-group-header resource-group-header--toggle';
      header.innerHTML = `<span><span class="toggle-arrow">▸</span>${escapeHtml(group.resourceName)}</span><span class="count">${group.count} ticket${group.count === 1 ? '' : 's'} -- ${formatHours(group.hoursWorked)} -- ${formatCurrency(group.dollars)}</span>`;
      groupEl.appendChild(header);

      const contentEl = document.createElement('div');
      contentEl.hidden = true; // minimized by default -- by request

      // No column headers -- by request ("don't need the column headers
      // there either"), same reasoning Ticket Times' own table already
      // follows: Company/Ticket #/Title/Time/$/Review? is obvious from the
      // data itself once you've seen one row. $ column added, by request
      // ("use these data sources and formulas ... to show the dollar
      // value of the times shown (only for the specific person, not the
      // whole ticket)") -- each row's own $ is scoped to just this
      // group's own resource (server.js's own dollarsByTicketAndResource),
      // unlike the Time column beside it which stays the pre-existing
      // ticket-WIDE total across every technician who logged time on it
      // (that one's own long-standing meaning, unchanged). No separate
      // totals row -- by request, removed since the group header above
      // already shows this same count/hours/$ total (same reasoning
      // Ticket Times' own category tables already follow).
      const table = document.createElement('table');
      table.className = 'completed-tickets-table';
      table.innerHTML = `
        <tbody>
          ${group.tickets
            .map(
              (t) => `
            <tr>
              <td>${escapeHtml(t.company)}</td>
              <td class="ticket-number">${ticketLink(t)}</td>
              <td>${escapeHtml(t.title)}</td>
              <td class="ticket-number">${formatHours(t.hoursWorked)}</td>
              <td class="ticket-number">${formatCurrency(t.dollars)}</td>
              <td>${escapeHtml(t.askForReview || '')}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      `;
      contentEl.appendChild(table);
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

  // HH:MM, by request -- Autotask's hoursWorked is a decimal (e.g. 1.2667),
  // which doesn't read as a duration at a glance. Rounds to the nearest
  // minute (any sub-minute fraction Autotask itself carries is display noise
  // here); a minute count that rounds up to 60 rolls over into the next hour
  // rather than ever showing ":60".
  function formatHours(hours) {
    const totalMinutes = Math.round((hours || 0) * 60);
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  // Same $#,##0.00 (en-AU) convention @dashboard/times' own Billable $ box
  // and @dashboard/ticket-times' own table now use -- not invented fresh.
  function formatCurrency(n) {
    return `$${(n || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}