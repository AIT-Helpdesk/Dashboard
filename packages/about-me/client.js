export const id = "about-me";
export const label = "About Me";

// Module-scope, not inside mount() -- same "survives a navigate-away-and-
// back" convention every other page here follows (see @dashboard/times'
// own client.js for the fullest write-up).
let lastResourceId = null;
let lastData = null;
let allResources = null; // [{id, name}], fetched once, reused across remounts
// Whether the SIGNED-IN VIEWER (not whichever resource is currently shown)
// is allowed to pick someone else -- Leadership Team only, by request. Also
// cached from the same /resources fetch as allResources above, same
// "fetched once, reused across remounts" reasoning (this doesn't change
// within a session -- it's about who's signed in, not what's selected).
let canSelectOthers = null;
let ownResourceInPool = null;
let ownDefaultResourceId = null; // the viewer's own resourceId, for the locked (non-Leadership) label before any load() has run yet
// Completed Tickets/Ticket Times/Asked for Review/Accrued Time's own
// shared date range, by request ("Add date selectors and buttons to the
// 'About Me' page matching what we have on the Time Summaries page") --
// Service Calls/Deadlines/Strety Tasks/Shifts don't read this at all
// (their own fixed windows are untouched). Survives a navigate-away-and-
// back the same way every other module-scope "last real pick" on this
// page already does.
let lastFrom = null;
let lastTo = null;
let lastActiveQuickButtonId = 'am-quick-today-button';

// Deliberately at true MODULE scope, not inside mount() -- same real
// ReferenceError-on-revisit bug @dashboard/my-strety-tasks' own client.js
// hit and documented (a `const` declared inside mount() sits after the
// synchronous "restore from cache" call, which itself needs this table on
// a second-or-later visit). Used by formatShortDate() below.
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Same 5-minute allowed variance @dashboard/accrued-time's own row shading
// uses ("If the sum of --END times is less than --ING time - RED; If
// greater - Yellow"), reused verbatim for the Accrued Time card's table.
const ACCRUED_TIME_VARIANCE_HOURS = 5 / 60;

// Same fixed legend/category list @dashboard/whats-on's own client.js
// defines for its Team Shifts excerpt (see that file's own long comment
// for the full real-data confirmation story behind every pattern here) --
// duplicated, not imported, same "separate page package" convention every
// other small shared UI piece on this dashboard already follows. Reused
// here, by request, to colour the Shifts card's own entries "in a style
// similar to the buttons on this page" (the small pill shape) "but using
// the colour schemes for Shifts items from the Team Shifts section of the
// What's On page" -- see shiftPillHtml() below.
const SHIFT_CATEGORIES = [
  { key: 'onCall', label: 'On Call', color: '#eab308', match: (dn) => /^on\s*call/i.test(dn) },
  { key: 'helpdesk', label: 'Helpdesk Handler', color: '#3b82f6', match: (dn) => /helpdesk\s*handler/i.test(dn) },
  { key: 'vacation', label: 'Vacation', color: '#22c55e', match: (dn) => /vacation/i.test(dn) },
  { key: 'unpaidLeave', label: 'Unpaid leave', color: '#dc2626', match: (dn) => /unpaid/i.test(dn) },
  { key: 'sickOther', label: 'Sick/Other Leave', color: '#8b5cf6', match: (dn) => /\bsick\b|other\s*leave/i.test(dn) },
  // "floating holiday" folded in here, not into publicHoliday below --
  // confirmed against real data this tenant's real Autotask Leave billing
  // code is spelled literally "Floating Holiday" (see fetchLeaveEntries()
  // in server.js), and it doesn't say "public" so publicHoliday's own
  // regex wouldn't have caught it anyway; a floating/discretionary day
  // off is conceptually closer to RDO/Time in Lieu (an individually-
  // earned day off) than to an actual gazetted, company-wide Public
  // Holiday, so it's bucketed here rather than guessed into that one.
  { key: 'rdoTil', label: 'RDO/Time in Lieu', color: '#9ca3af', match: (dn) => /\brdo\b|time\s*in\s*lieu|floating\s*holiday/i.test(dn) },
  {
    key: 'publicHoliday',
    label: 'Public Holiday',
    color: '#ffffff',
    match: (dn) => /pub(lic)?\s*hol|australia\s*day|good\s*friday|easter\s*monday|labour\s*day|christmas|boxing\s*day|anzac\s*day|new\s*year/i.test(dn),
  },
];
function categorizeShift(displayName) {
  const dn = (displayName || '').trim();
  if (!dn) return null;
  return SHIFT_CATEGORIES.find((cat) => cat.match(dn)) || null;
}

// Each card's own "jump to the full page" button, by request -- {href,
// label} passed straight into cardHtml()'s own fullPageLink param (see
// its own comment). "<Item> Page" labels, by request ("instead of
// labelling the buttons 'Show All {Item}' call them '{Item} Page'") --
// Deadlines keeps its own original "Open Tickets Dashboard" label
// instead, by request ("Leave the two 'Open Tickets Dashboard' as they
// are"). Points at #tickets-dashboard -- Deadlines is a narrower view of
// that exact same Critical (P1) data, there's no separate "Deadlines"
// page of its own. Strety Tasks points at My Strety Tasks (#my-strety-
// tasks), same real target What's On's own "Show All of My Strety Tasks"
// link already uses -- worth knowing that page always shows the SIGNED-
// IN VIEWER's own tasks, not necessarily the resource currently selected
// here (see this package's own README).
//
// No entries for Tickets Dashboard or Subscriptions Expiring -- both
// cards were removed from this page entirely, by request ("Leave off
// 'Tickets Dashboard' section and 'Subscriptions Expiring'"). The second
// original "Open Tickets Dashboard" button (Tickets Dashboard's own) was
// removed along with that card.
const FULL_PAGE_LINKS = {
  serviceCalls: { href: '#service-calls', label: 'Service Calls Page' },
  deadlines: { href: '#tickets-dashboard', label: 'Open Tickets Dashboard' },
  completedTickets: { href: '#completed-tickets', label: 'Completed Tickets Page' },
  ticketTimes: { href: '#ticket-times', label: 'Ticket Times Page' },
  askedForReview: { href: '#asked-for-review', label: 'Asked for Review Page' },
  accruedTime: { href: '#accrued-time', label: 'Accrued Time Page' },
  stretyTasks: { href: '#my-strety-tasks', label: 'My Strety Tasks Page' },
  shifts: { href: '#teams-shifts', label: 'Shifts Page' },
};

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>About Me</h1>
    </header>
    <form id="about-me-form" class="date-form">
      <label id="resource-label" for="resource-input">Resource</label>
      <select id="resource-input"></select>
      <span id="resource-locked-name" class="inline-subtext" hidden></span>
    </form>
    <form id="about-me-date-form" class="date-form date-form--stacked">
      <div class="date-form-row">
        <label for="am-from-input">From</label>
        <input type="date" id="am-from-input" name="from" required />
        <label for="am-to-input">To</label>
        <input type="date" id="am-to-input" name="to" required />
        <div class="tm-quick-date-groups">
          <div class="tm-quick-date-group">
            <button type="button" class="button-link button-link--small" id="am-quick-today-button">Today</button>
            <button type="button" class="button-link button-link--small" id="am-quick-yesterday-button">Yesterday</button>
          </div>
          <div class="tm-quick-date-group">
            <button type="button" class="button-link button-link--small" id="am-quick-this-week-button">This Week</button>
            <button type="button" class="button-link button-link--small" id="am-quick-last-week-button">Last Week</button>
          </div>
          <div class="tm-quick-date-group">
            <button type="button" class="button-link button-link--small" id="am-quick-this-month-button">This Month</button>
            <button type="button" class="button-link button-link--small" id="am-quick-last-month-button">Last Month</button>
          </div>
        </div>
      </div>
      <div class="date-form-row">
        <button type="submit">Load</button>
        <span class="inline-subtext">Applies to Completed Tickets, Ticket Times, Asked for Review, and Accrued Time only -- Service Calls, Deadlines, Strety Tasks, and Shifts keep their own fixed windows.</span>
      </div>
    </form>
    <p id="status" class="status">Loading...</p>
    <div id="results" class="about-me-columns"></div>
  `;

  const resourceLabelEl = container.querySelector('#resource-label');
  const resourceInput = container.querySelector('#resource-input');
  const resourceLockedNameEl = container.querySelector('#resource-locked-name');
  const dateForm = container.querySelector('#about-me-date-form');
  const fromInput = container.querySelector('#am-from-input');
  const toInput = container.querySelector('#am-to-input');
  const statusEl = container.querySelector('#status');
  const resultsEl = container.querySelector('#results');

  // Real popup window, not a plain new-tab link -- same window.open
  // features string every ticket link on this dashboard already uses.
  resultsEl.addEventListener('click', (e) => {
    const link = e.target.closest('a.ticket-link');
    if (link) {
      e.preventDefault();
      window.open(link.href, '_blank', 'noopener,noreferrer,width=1200,height=900');
    }
  });

  resourceInput.addEventListener('change', () => {
    const id = parseInt(resourceInput.value, 10);
    if (Number.isInteger(id)) load(id);
  });

  async function loadResourceList() {
    if (allResources) {
      renderResourceOptions();
      if (!canSelectOthers && !ownResourceInPool) return; // already showed the "not available" status below, nothing to load
      if (lastResourceId) load(lastResourceId);
      else if (allResources.length > 0) load(allResources[0].id);
      return;
    }
    try {
      const res = await fetch('/api/about-me/resources');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      allResources = data.resources;
      canSelectOthers = !!data.canSelectOthers;
      ownResourceInPool = !!data.ownResourceInPool;
      ownDefaultResourceId = data.defaultResourceId || null;
      renderResourceOptions();
      // Not Leadership and no resource record of your own in Support Desk
      // or Professional Services -- genuinely nothing to show, by design
      // (see server.js's own comment on defaultResourceId) rather than
      // silently falling back to someone else's page.
      if (!canSelectOthers && !ownResourceInPool) {
        statusEl.hidden = false;
        statusEl.className = 'status error';
        statusEl.textContent = 'About Me isn’t available for your account (not in Support Desk or Professional Services).';
        return;
      }
      const startId = lastResourceId || data.defaultResourceId || (allResources[0] && allResources[0].id);
      if (startId) load(startId);
      else {
        statusEl.hidden = false;
        statusEl.textContent = 'No resources found in Support Desk or Professional Services.';
      }
    } catch (err) {
      statusEl.hidden = false;
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    }
  }
  // The dropdown itself is Leadership Team only, by request ("Allow the
  // Resource dropdown at the top only for people logged in who are
  // members of the leadership team") -- everyone else gets a plain label
  // naming their own resource instead of a <select>, since there's
  // nothing else they're allowed to pick anyway (also enforced server-
  // side, see server.js's own "/" route -- this isn't just a client-side
  // hide).
  function renderResourceOptions() {
    if (canSelectOthers) {
      resourceLabelEl.textContent = 'Resource';
      resourceInput.hidden = false;
      resourceLockedNameEl.hidden = true;
      resourceInput.innerHTML = allResources.map((r) => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('');
      return;
    }
    resourceLabelEl.textContent = 'Viewing';
    resourceInput.hidden = true;
    if (ownResourceInPool) {
      const own = allResources.find((r) => r.id === (lastResourceId || ownDefaultResourceId));
      resourceLockedNameEl.hidden = false;
      resourceLockedNameEl.textContent = own ? own.name : '';
    } else {
      resourceLockedNameEl.hidden = true;
    }
  }

  // Completed Tickets/Ticket Times/Asked for Review/Accrued Time's own
  // shared date range, by request ("Add date selectors and buttons to the
  // 'About Me' page matching what we have on the Time Summaries page") --
  // same quick-date buttons/highlighting/date-arithmetic helpers as
  // @dashboard/times' own client.js, duplicated here (not imported, same
  // "separate page package" convention every other small shared UI piece
  // on this dashboard follows) rather than reproduced from memory --
  // matches that page's own implementation exactly.
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
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n + 1, 0)).toISOString().slice(0, 10);
  }
  const QUICK_DATE_BUTTON_IDS = [
    'am-quick-today-button',
    'am-quick-yesterday-button',
    'am-quick-this-week-button',
    'am-quick-last-week-button',
    'am-quick-this-month-button',
    'am-quick-last-month-button',
  ];
  function setActiveQuickButton(id) {
    lastActiveQuickButtonId = id;
    for (const btnId of QUICK_DATE_BUTTON_IDS) {
      container.querySelector(`#${btnId}`).classList.toggle('active', btnId === id);
    }
  }
  fromInput.addEventListener('input', () => setActiveQuickButton(null));
  toInput.addEventListener('input', () => setActiveQuickButton(null));

  container.querySelector('#am-quick-today-button').addEventListener('click', () => {
    const today = todayISO();
    fromInput.value = today;
    toInput.value = today;
    setActiveQuickButton('am-quick-today-button');
  });
  container.querySelector('#am-quick-yesterday-button').addEventListener('click', () => {
    const yesterday = addDays(todayISO(), -1);
    fromInput.value = yesterday;
    toInput.value = yesterday;
    setActiveQuickButton('am-quick-yesterday-button');
  });
  container.querySelector('#am-quick-this-week-button').addEventListener('click', () => {
    fromInput.value = mondayOfWeek(todayISO());
    toInput.value = todayISO();
    setActiveQuickButton('am-quick-this-week-button');
  });
  container.querySelector('#am-quick-last-week-button').addEventListener('click', () => {
    const thisMonday = mondayOfWeek(todayISO());
    fromInput.value = addDays(thisMonday, -7);
    toInput.value = addDays(thisMonday, -1);
    setActiveQuickButton('am-quick-last-week-button');
  });
  container.querySelector('#am-quick-this-month-button').addEventListener('click', () => {
    fromInput.value = startOfMonth(todayISO(), 0);
    toInput.value = todayISO();
    setActiveQuickButton('am-quick-this-month-button');
  });
  container.querySelector('#am-quick-last-month-button').addEventListener('click', () => {
    const today = todayISO();
    fromInput.value = startOfMonth(today, -1);
    toInput.value = endOfMonth(today, -1);
    setActiveQuickButton('am-quick-last-month-button');
  });

  if (lastFrom) {
    fromInput.value = lastFrom;
    toInput.value = lastTo;
    setActiveQuickButton(lastActiveQuickButtonId);
  } else {
    const today = todayISO();
    fromInput.value = today;
    toInput.value = today;
    setActiveQuickButton('am-quick-today-button');
  }

  dateForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (Number.isInteger(lastResourceId)) load(lastResourceId);
  });

  async function load(resourceId) {
    lastResourceId = resourceId;
    resourceInput.value = String(resourceId);
    const from = fromInput.value || todayISO();
    const to = toInput.value || from;
    if (to < from) {
      statusEl.hidden = false;
      statusEl.className = 'status error';
      statusEl.textContent = 'Error: "To" must not be before "From".';
      return;
    }
    lastFrom = from;
    lastTo = to;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = 'Loading...';
    resultsEl.innerHTML = '';
    try {
      const qs = new URLSearchParams({ resourceId, from, to });
      const res = await fetch(`/api/about-me?${qs.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastData = data;
      render(data);
    } catch (err) {
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    }
  }

  // Two columns -- swapped, by request ("Put all the sections currently
  // on the right on the left and all the left items onto the right"):
  // left is now the date-range-scoped activity (Completed Tickets,
  // Accrued Time, Ticket Times, Asked for Review), right is Shifts
  // (moved to the TOP of this side, by request) followed by the four
  // sections the date range above doesn't touch (Service Calls,
  // Deadlines, Strety Tasks). No column heading on either side, by
  // request (the original "Upcoming" label was removed earlier). Tickets
  // Dashboard and Subscriptions Expiring were both removed from this
  // page entirely, by request ("Leave off 'Tickets Dashboard' section
  // and 'Subscriptions Expiring'").
  function render(data) {
    statusEl.hidden = true;
    const leftHtml = [
      completedTicketsCardHtml(data.completedTickets, data.from, data.to),
      accruedTimeCardHtml(data.accruedTime, data.from, data.to),
      ticketTimesCardHtml(data.ticketTimesToday, data.from, data.to),
      askedForReviewCardHtml(data.askedForReview, data.from, data.to),
    ].join('');
    const rightHtml = [
      shiftsCardHtml(data.shifts),
      serviceCallsCardHtml(data.serviceCalls),
      deadlinesCardHtml(data.deadlines),
      stretyTasksCardHtml(data.stretyTasks),
    ].join('');
    resultsEl.innerHTML = `
      <div class="about-me-column">${leftHtml}</div>
      <div class="about-me-column">${rightHtml}</div>
    `;
  }

  // Shared card shell -- title (blue, styles.css -- "like most other
  // pages in the dashboard", same accent blue Today & Tomorrow's own
  // column headings use), and either the section's own real content or a
  // small explanatory note (a failed section, "nothing right now", or a
  // not-connected/no-data status), never a blank hole in the grid.
  // `fullPageLink` ({href, label}), when given, adds a pill button right
  // after the subtitle -- same .button-link.button-link--small pill look/
  // colouring What's On's own "Show All Service Calls" (etc.) footer
  // links already use, by request, just placed inline here instead of a
  // footer below the list. An inline <a> INSIDE the same <h2> as the
  // title/subtitle (not a separate flex sibling) is deliberate -- by
  // request ("put those buttons on the same line as the description
  // instead of below it"): a flex row split the button onto its own
  // visual line whenever the title+subtitle text wrapped to two lines on
  // a narrower card; inline flow keeps the button immediately following
  // the subtitle text no matter how the heading itself wraps. Shown
  // regardless of the card's state (error/empty/populated), same
  // reasoning What's On's own footerLink already established -- jumping
  // to the full page is useful in every case, not just when there's data
  // to show.
  function cardHtml(title, subtitle, innerHtml, fullPageLink) {
    const buttonHtml = fullPageLink
      ? ` <a class="button-link button-link--small about-me-card-full-link" href="${escapeHtml(fullPageLink.href)}">${escapeHtml(fullPageLink.label)}</a>`
      : '';
    return `
      <div class="about-me-card">
        <h2 class="section-heading">${escapeHtml(title)}${subtitle ? ` <span class="inline-subtext">${escapeHtml(subtitle)}</span>` : ''}${buttonHtml}</h2>
        ${innerHtml}
      </div>
    `;
  }
  function errorNote(section) {
    return `<p class="status error">Couldn't load this: ${escapeHtml(section.error || 'unknown error')}</p>`;
  }
  function emptyNote(text) {
    return `<p class="status">${escapeHtml(text)}</p>`;
  }

  // Just the linked Ticket # (not the title -- that's its own table
  // column, matching every other ticket-table on this dashboard, e.g.
  // Completed Tickets/Ticket Times/Asked for Review's own ticketLink()).
  // Click handling is delegated once, up on #results (see above), same
  // convention as those pages' own a.ticket-link.
  function ticketNumberHtml(row) {
    const label = escapeHtml(row.ticketNumber);
    if (!row.ticketUrl) return label;
    return `<a href="${escapeHtml(row.ticketUrl)}" class="ticket-link" target="_blank" rel="noopener noreferrer">${label}</a>`;
  }

  // ---- Service Calls -- table per group (Allocated/Unallocated), same
  // red = unallocated / green = allocated convention used dashboard-wide
  // (.text-highlight-red for "Unallocated" everywhere else, .section-
  // heading--red/--green elsewhere for a terminating/renewing-style
  // split). ----
  function serviceCallsCardHtml(section) {
    if (!section.ok) return cardHtml('Service Calls', 'Today & tomorrow', errorNote(section), FULL_PAGE_LINKS.serviceCalls);
    const { allocated, unallocated } = section.data;
    const total = allocated.length + unallocated.length;
    if (total === 0) return cardHtml(`Service Calls (0)`, 'Today & tomorrow', emptyNote('None.'), FULL_PAGE_LINKS.serviceCalls);
    const parts = [];
    if (allocated.length > 0) parts.push(serviceCallsGroupHtml('ALLOCATED', 'section-heading--green', allocated));
    if (unallocated.length > 0) parts.push(serviceCallsGroupHtml('UNALLOCATED', 'section-heading--red', unallocated));
    return cardHtml(`Service Calls (${total})`, 'Today & tomorrow', parts.join(''), FULL_PAGE_LINKS.serviceCalls);
  }
  function serviceCallsGroupHtml(label, headingClass, rows) {
    return `
      <div class="section-heading ${headingClass}">${escapeHtml(label)} (${rows.length})</div>
      <div class="about-me-table-wrap"><table class="about-me-table about-me-table--wide">
        <thead><tr class="shaded-row"><th>Time</th><th>Client</th><th>Description</th></tr></thead>
        <tbody>${rows
          .map(
            (sc) => `
          <tr>
            <td>${escapeHtml(formatDateTime(sc.startDateTime))}</td>
            <td>${escapeHtml(sc.companyName)}</td>
            <td>${escapeHtml(sc.description || '—')}</td>
          </tr>`
          )
          .join('')}</tbody>
      </table></div>`;
  }

  // ---- Deadlines -- company-wide (every resource), by request. Same
  // real Critical (P1) selection criteria as the Tickets Dashboard card
  // below (statusColored red -- every ticket here IS Critical), narrowed
  // to just the ones due today or already overdue (server.js). Same
  // table shape as Tickets Dashboard's own groups, with a "Due" subtext
  // instead of a create-time one. ----
  function deadlinesCardHtml(section) {
    if (!section.ok) return cardHtml('Deadlines', 'Due today or earlier — everyone', errorNote(section), FULL_PAGE_LINKS.deadlines);
    if (section.data.length === 0)
      return cardHtml('Deadlines (0)', 'Due today or earlier — everyone', emptyNote('Nothing overdue or due today.'), FULL_PAGE_LINKS.deadlines);
    return cardHtml(
      `Deadlines (${section.data.length})`,
      'Due today or earlier — everyone',
      `<div class="about-me-table-wrap"><table class="about-me-table about-me-table--wide">
        <thead><tr class="shaded-row"><th>Status</th><th>Ticket #</th><th>Client</th><th>Title</th><th>Resource</th></tr></thead>
        <tbody>${section.data
          .map(
            (t) => `
          <tr>
            <td>${ticketsDashboardStatusCellHtml(t.status, true)}</td>
            <td class="ticket-number">${ticketNumberHtml(t)}<br><span class="inline-subtext">Due ${escapeHtml(formatShortDateFromIso(t.dueDateTime))}</span></td>
            <td>${escapeHtml(t.company)}</td>
            <td>${escapeHtml(t.title)}</td>
            <td>${ticketsDashboardResourceCellHtml(t.resourceName)}</td>
          </tr>`
          )
          .join('')}</tbody>
      </table></div>`,
      FULL_PAGE_LINKS.deadlines
    );
  }

  // ---- Completed Tickets -- same 3 columns @dashboard/completed-tickets'
  // own table shows (Company, Ticket #, Title), minus its Time/Ask-for-
  // Review columns (not tracked by this section, and Asked for Review is
  // already its own card below). ----
  function completedTicketsCardHtml(section, from, to) {
    const rangeLabel = dateRangeLabel(from, to);
    if (!section.ok) return cardHtml('Completed Tickets', rangeLabel, errorNote(section), FULL_PAGE_LINKS.completedTickets);
    if (section.data.length === 0) return cardHtml('Completed Tickets (0)', rangeLabel, emptyNote('None in this range.'), FULL_PAGE_LINKS.completedTickets);
    return cardHtml(
      `Completed Tickets (${section.data.length})`,
      rangeLabel,
      `<div class="about-me-table-wrap"><table class="about-me-table">
        <thead><tr class="shaded-row"><th>Company</th><th>Ticket #</th><th>Title</th></tr></thead>
        <tbody>${section.data
          .map(
            (t) => `
          <tr>
            <td>${escapeHtml(t.company)}</td>
            <td class="ticket-number">${ticketNumberHtml(t)}</td>
            <td>${escapeHtml(t.title)}</td>
          </tr>`
          )
          .join('')}</tbody>
      </table></div>`,
      FULL_PAGE_LINKS.completedTickets
    );
  }

  // ---- Ticket Times -- same 5 columns @dashboard/ticket-times' own table
  // shows, reordered by request (Time, Ticket #, Status, Title, Client),
  // minus its by-technician/by-category grouping (redundant here -- this
  // card is already one resource). Time in h:mm, same rounding convention
  // that page's own formatHours() uses. ----
  function ticketTimesCardHtml(section, from, to) {
    const rangeLabel = dateRangeLabel(from, to);
    if (!section.ok) return cardHtml('Ticket Times', rangeLabel, errorNote(section), FULL_PAGE_LINKS.ticketTimes);
    if (section.data.length === 0) return cardHtml('Ticket Times (0)', rangeLabel, emptyNote('No time logged in this range.'), FULL_PAGE_LINKS.ticketTimes);
    // Sum up in the card's own title, alongside the row count, by
    // request ("REMOVE THIS [the column-header sum]. I WANT IT UP IN THE
    // HEADING WHERE the sum of items is") -- moved out of the "Time"
    // column's own <th>.
    const totalHours = section.data.reduce((sum, t) => sum + (t.hours || 0), 0);
    return cardHtml(
      `Ticket Times (${section.data.length}, ${formatHoursHM(totalHours)})`,
      rangeLabel,
      `<div class="about-me-table-wrap"><table class="about-me-table about-me-table--wide">
        <thead><tr class="shaded-row"><th>Time</th><th>Ticket #</th><th>Status</th><th>Title</th><th>Client</th></tr></thead>
        <tbody>${section.data
          .map(
            (t) => `
          <tr>
            <td class="ticket-number">${formatHoursHM(t.hours)}</td>
            <td class="ticket-number">${ticketNumberHtml(t)}</td>
            <td>${escapeHtml(t.status)}</td>
            <td>${escapeHtml(t.title)}</td>
            <td>${escapeHtml(t.company)}</td>
          </tr>`
          )
          .join('')}</tbody>
      </table></div>`,
      FULL_PAGE_LINKS.ticketTimes
    );
  }

  // ---- Asked for Review -- same Company/Ticket #/Title columns
  // @dashboard/asked-for-review's own table shows, including its blue
  // .cell-flag-blue Title flag for a Billing - Contract ticket. Its own
  // Completed By column is dropped -- redundant here, this card is
  // already scoped to one resource. ----
  function askedForReviewCardHtml(section, from, to) {
    const rangeLabel = dateRangeLabel(from, to);
    if (!section.ok) return cardHtml('Asked for Review', rangeLabel, errorNote(section), FULL_PAGE_LINKS.askedForReview);
    if (section.data.length === 0) return cardHtml('Asked for Review (0)', rangeLabel, emptyNote('None in this range.'), FULL_PAGE_LINKS.askedForReview);
    return cardHtml(
      `Asked for Review (${section.data.length})`,
      rangeLabel,
      `<div class="about-me-table-wrap"><table class="about-me-table about-me-table--wide">
        <thead><tr class="shaded-row"><th>Company</th><th>Ticket #</th><th>Title</th></tr></thead>
        <tbody>${section.data
          .map(
            (t) => `
          <tr>
            <td>${escapeHtml(t.company)}</td>
            <td class="ticket-number">${ticketNumberHtml(t)}</td>
            <td${t.billingContract ? ' class="cell-flag-blue"' : ''}>${escapeHtml(t.title)}</td>
          </tr>`
          )
          .join('')}</tbody>
      </table></div>`,
      FULL_PAGE_LINKS.askedForReview
    );
  }

  // ---- Accrued Time -- already a table; adds the same green END/NO Bill
  // column shading (.accrued-time-end-col) and red/yellow row shading
  // (.accrued-time-red-row/--yellow-row, same 5-minute-variance rule)
  // @dashboard/accrued-time's own table uses, plus that same table's .STD
  // and Other columns (right after NO Bill) and Client/Ticket Status
  // columns (after all the time columns, by request -- @dashboard/
  // accrued-time's own table puts Client/Title/Status BEFORE the time
  // columns instead, but this card orders them after). Ticket Title is
  // deliberately left out, by request ("to save space") -- Client +
  // Ticket Status carry most of the same context more compactly. Every
  // time column (ING/END/NO Bill/STD/Other) reads h:mm, not a decimal, by
  // request ("show as HH:MM instead of decimal equivalent") -- unlike
  // @dashboard/accrued-time's own table, which stays decimal. NOT
  // widened like the other tables on this page (.about-me-table--auto
  // instead of --wide) -- by request, forcing it wider just dumped the
  // extra space as blank padding in the Ticket column; same "don't force
  // width: 100%" fix @dashboard/accrued-time's own
  // `.accrued-time-table { width: auto; }` already uses for this
  // identical shape of table. ----
  function accruedTimeEndTotal(r) {
    return r.accrueEnd + r.accrueEndNoBill;
  }
  function accruedTimeIsRed(r) {
    return accruedTimeEndTotal(r) < r.accrueIng - ACCRUED_TIME_VARIANCE_HOURS;
  }
  function accruedTimeIsYellow(r) {
    return accruedTimeEndTotal(r) > r.accrueIng + ACCRUED_TIME_VARIANCE_HOURS;
  }
  function accruedTimeCardHtml(section, from, to) {
    const rangeLabel = dateRangeLabel(from, to) ? `${dateRangeLabel(from, to)}, Complete tickets` : 'Complete tickets';
    if (!section.ok) return cardHtml('Accrued Time', rangeLabel, errorNote(section), FULL_PAGE_LINKS.accruedTime);
    if (section.data.length === 0)
      return cardHtml('Accrued Time (0)', rangeLabel, emptyNote('No qualifying tickets in this range.'), FULL_PAGE_LINKS.accruedTime);
    // Just the discrepancy now, by request ("just show the discrepancy
    // (--INGs minus --END*) only including the lines ... where the
    // --END* [is] less than the --INGs ... sum them only") -- replaces
    // the previous per-column sums entirely. Same real "Diff" figure
    // @dashboard/accrued-time's own heading already shows (its own
    // diffSumHtml()): only rows where accruedTimeIsRed(r) is true (END*
    // -- accrueEnd + accrueEndNoBill -- below accrueIng by more than the
    // 5-minute variance) contribute, each as accrueIng - endTotal(r),
    // which is positive by construction for exactly those rows; rows
    // that are yellow (END* bigger) or within variance contribute
    // nothing, not a negative.
    const discrepancy = section.data.filter(accruedTimeIsRed).reduce((sum, t) => sum + (t.accrueIng - accruedTimeEndTotal(t)), 0);
    const title = `Accrued Time (${section.data.length}, Discrepancy ${formatHoursHM(discrepancy)})`;
    return cardHtml(
      title,
      rangeLabel,
      `<div class="about-me-table-wrap"><table class="about-me-table about-me-table--auto">
        <thead><tr class="shaded-row">
          <th>Ticket</th>
          <th class="col-center">ING</th>
          <th class="col-center accrued-time-end-col">END</th>
          <th class="col-center accrued-time-end-col">NO Bill</th>
          <th class="col-center">STD</th>
          <th class="col-center">Other</th>
          <th>Client</th>
          <th>Ticket Status</th>
        </tr></thead>
        <tbody>${section.data
          .map((t) => {
            const rowClass = accruedTimeIsRed(t) ? ' class="accrued-time-red-row"' : accruedTimeIsYellow(t) ? ' class="accrued-time-yellow-row"' : '';
            return `
          <tr${rowClass}>
            <td class="ticket-number">${ticketNumberHtml(t)}</td>
            <td class="col-center">${formatHoursHM(t.accrueIng)}</td>
            <td class="col-center accrued-time-end-col">${formatHoursHM(t.accrueEnd)}</td>
            <td class="col-center accrued-time-end-col">${formatHoursHM(t.accrueEndNoBill)}</td>
            <td class="col-center">${formatHoursHM(t.standardSupport)}</td>
            <td class="col-center">${formatHoursHM(t.other)}</td>
            <td>${escapeHtml(t.clientName)}</td>
            <td>${escapeHtml(t.status)}</td>
          </tr>`;
          })
          .join('')}</tbody>
      </table></div>`,
      FULL_PAGE_LINKS.accruedTime
    );
  }

  // ---- Strety Tasks -- same Due/Title/Priority/Description columns
  // @dashboard/my-strety-tasks' own table shows, including its coloured
  // Today/Tomorrow/Overdue due-date tag (.tt-tag/--today/--tomorrow/
  // --overdue). Its own per-team grouping is dropped -- this section
  // doesn't carry a space per task, and it's already one resource's tasks
  // in one flat list. ----
  function stretyTasksCardHtml(section) {
    if (!section.ok) return cardHtml('Strety Tasks', null, errorNote(section), FULL_PAGE_LINKS.stretyTasks);
    const s = section.data;
    if (s.status === 'no-resource-email')
      return cardHtml('Strety Tasks', null, emptyNote('This resource has no Autotask email on file.'), FULL_PAGE_LINKS.stretyTasks);
    if (s.status === 'not-connected')
      return cardHtml(
        'Strety Tasks',
        null,
        emptyNote('Connect your own Strety account to see this (Personal group on What’s On has the link).'),
        FULL_PAGE_LINKS.stretyTasks
      );
    if (s.status === 'reauth-required')
      return cardHtml(
        'Strety Tasks',
        null,
        emptyNote('Your Strety connection needs reconnecting (Personal group on What’s On has the link).'),
        FULL_PAGE_LINKS.stretyTasks
      );
    if (s.status === 'person-not-found')
      return cardHtml('Strety Tasks', null, emptyNote('No matching Strety person found for this resource.'), FULL_PAGE_LINKS.stretyTasks);
    if (s.tasks.length === 0) return cardHtml('Strety Tasks (0)', s.personName, emptyNote('Nothing open.'), FULL_PAGE_LINKS.stretyTasks);
    const todayKey = todayAestKey();
    const tomorrowKey = tomorrowAestKey();
    // "-- as of TIME", same convention @dashboard/my-strety-tasks' own
    // summary line already uses.
    const subtitle = `${s.personName} -- as of ${formatCreateTime(s.asOf)}`;
    return cardHtml(
      `Strety Tasks (${s.tasks.length})`,
      subtitle,
      `<div class="about-me-table-wrap"><table class="about-me-table about-me-table--wide">
        <thead><tr class="shaded-row"><th>Due</th><th>Title</th><th>Priority</th><th>Description</th></tr></thead>
        <tbody>${s.tasks
          .map(
            (t) => `
          <tr>
            <td>${stretyDueDateTagHtml(t, todayKey, tomorrowKey)}</td>
            <td>${escapeHtml(t.title)}</td>
            <td>${escapeHtml(capitalize(t.priority))}</td>
            <td>${escapeHtml(t.description || '')}</td>
          </tr>`
          )
          .join('')}</tbody>
      </table></div>`,
      FULL_PAGE_LINKS.stretyTasks
    );
  }
  // Same tag shape/colours as @dashboard/my-strety-tasks' own
  // dueDateTagHtml() -- today green, tomorrow amber, genuinely overdue
  // red with just the short date, anything further out plain with the
  // short date, no due date renders nothing. The tag itself is the link
  // to Strety when a todoUrl resolved, same href-on-the-tag convention.
  function stretyDueDateTagHtml(t, todayKey, tomorrowKey) {
    if (!t.dueDate) return '';
    let colorClass;
    let dueLabel;
    if (t.dueDate === todayKey) {
      colorClass = 'tt-tag--today';
      dueLabel = 'Today';
    } else if (t.dueDate === tomorrowKey) {
      colorClass = 'tt-tag--tomorrow';
      dueLabel = 'Tomorrow';
    } else if (t.dueDate < todayKey) {
      colorClass = 'tt-tag--overdue';
      dueLabel = formatShortDate(t.dueDate);
    } else {
      colorClass = '';
      dueLabel = formatShortDate(t.dueDate);
    }
    const cls = `tt-tag${colorClass ? ` ${colorClass}` : ''}`;
    if (!t.todoUrl) return `<span class="${cls}">${escapeHtml(dueLabel)}</span>`;
    return `<a class="${cls}" href="${escapeHtml(t.todoUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(dueLabel)}</a>`;
  }

  // ---- Shifts -- plain list, window widened from 7 to 30 days, by
  // request. Consecutive days carrying the SAME description (e.g. 5
  // straight days of "On Call") are merged into one "from date to date
  // [pill]" line rather than one line per day, by request. Each entry's
  // own pill is coloured by SHIFT_CATEGORIES (top of file), by request
  // ("Colour the Shifts Items in a style similar to the buttons on this
  // page but using the colour schemes for Shifts items from the Team
  // Shifts section of the What's On page") -- no legend on THIS page
  // though, by request ("but not on the 'About Me' page"); see
  // @dashboard/teams-shifts' own client.js for where the legend went
  // instead. ----
  function shiftsCardHtml(section) {
    if (!section.ok) return cardHtml('Shifts', 'Next 30 days', errorNote(section), FULL_PAGE_LINKS.shifts);
    const s = section.data;
    // 'team-not-found-leave-only' means the real Graph Shifts schedule
    // itself couldn't be reached, but real Autotask Leave (see
    // fetchLeaveEntries() in server.js) is independent of that and still
    // came through -- so this only falls back to the old empty-state
    // message when there's truly nothing at all to show, not just because
    // the Shifts half specifically failed.
    if (s.status === 'team-not-found-leave-only' && s.entries.length === 0) {
      return cardHtml('Shifts', 'Next 30 days', emptyNote('General team schedule not found.'), FULL_PAGE_LINKS.shifts);
    }
    if (s.entries.length === 0) return cardHtml('Shifts (0)', 'Next 30 days', emptyNote('None scheduled.'), FULL_PAGE_LINKS.shifts);
    const groups = shiftsGroupConsecutiveDays(s.entries);
    return cardHtml(
      `Shifts (${s.entries.length})`,
      'Next 30 days',
      `<ul>${groups
        .map((g) => {
          const dateLabel =
            g.fromDayKey === g.toDayKey ? escapeHtml(formatShortDate(g.fromDayKey)) : `${escapeHtml(formatShortDate(g.fromDayKey))} to ${escapeHtml(formatShortDate(g.toDayKey))}`;
          return `<li>${dateLabel} ${shiftPillHtml(g.label)}</li>`;
        })
        .join('')}</ul>`,
      FULL_PAGE_LINKS.shifts
    );
  }
  // Same small .button-link.button-link--small pill shape every other
  // button on this page uses, by request ("in a style similar to the
  // buttons on this page"), but coloured per SHIFT_CATEGORIES instead of
  // the default accent tint -- same real category match/colour/Public-
  // Holiday-special-case @dashboard/whats-on's own shiftEntryHtml() uses,
  // just a light-mode-pinned tint (color-mix toward white, not
  // transparent) matching this page's own "everything stays light
  // regardless of theme" table policy rather than that page's own
  // full-theme-following calendar cell. An unmatched label (no real
  // category match) still gets the pill SHAPE for visual consistency,
  // just none of the inline colour override -- it falls back to
  // .button-link--small's own plain default tint.
  function shiftPillHtml(label) {
    const cat = categorizeShift(label);
    const style = !cat
      ? ''
      : cat.key === 'publicHoliday'
        ? ' style="background: #ffffff; color: #1a1a1a; border: 1px solid #e5e7eb;"'
        : ` style="background: color-mix(in srgb, ${cat.color} 22%, white); color: #1a1a1a;"`;
    // Public Holiday keeps its own already-composed "Public Holiday,
    // {Set(s)}, {Name}" text (see shiftsGroupConsecutiveDays()) rather
    // than collapsing to the category's plain "Public Holiday" label --
    // every other category still shows its own clean cat.label as before.
    const text = cat && cat.key === 'publicHoliday' ? label : cat ? cat.label : label;
    return `<span class="button-link button-link--small about-me-shift-pill"${style}>${escapeHtml(text)}</span>`;
  }
  // Entries arrive one-per-day (server.js) -- sorted by day, then merged
  // whenever the SAME label (displayName, or the same Shift/Time off
  // fallback) runs on truly consecutive calendar days. `isNextAestDay()`
  // does real date arithmetic (month/year rollover included), not a
  // string comparison, since "next day" isn't just "+1" on the day digit.
  function shiftsGroupConsecutiveDays(entries) {
    const labeled = entries
      .map((e) => ({
        dayKey: e.dayKey,
        // Public Holiday entries show as "Public Holiday, {Holiday
        // Set(s)}, {Holiday Name}", by request -- richer than the generic
        // Public Holiday category label shiftPillHtml() would otherwise
        // fall back to, since About Me has no separate line2/tooltip slot
        // the way Teams Shifts/What's On's own calendar cells do for
        // "which Holiday Set it's from". Still starts with "Public
        // Holiday" so categorizeShift()'s own regex still matches it for
        // the white/bordered styling.
        label: e.kind === 'publicHoliday' ? `Public Holiday, ${e.holidaySetName}, ${e.holidayName}` : e.displayName || (e.kind === 'timeOff' ? 'Time off' : 'Shift'),
      }))
      .sort((a, b) => a.dayKey.localeCompare(b.dayKey) || a.label.localeCompare(b.label));
    const groups = [];
    for (const e of labeled) {
      const last = groups[groups.length - 1];
      if (last && last.label === e.label && isNextAestDay(last.toDayKey, e.dayKey)) {
        last.toDayKey = e.dayKey;
      } else {
        groups.push({ fromDayKey: e.dayKey, toDayKey: e.dayKey, label: e.label });
      }
    }
    return groups;
  }
  function isNextAestDay(dayKey, candidateDayKey) {
    const [y, m, d] = dayKey.split('-').map(Number);
    const expected = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
    return expected === candidateDayKey;
  }

  // ---- Tickets Dashboard's own two small cell helpers -- kept even
  // though the Tickets Dashboard card itself was removed from this page,
  // by request ("Leave off 'Tickets Dashboard' section and 'Subscriptions
  // Expiring'"), because Deadlines above still uses them (it's built from
  // the exact same real Critical (P1) selection criteria). ----
  function ticketsDashboardStatusCellHtml(status, statusColored) {
    if (status === 'License Update (CRITICAL)') return `<span class="text-highlight-yellow">License Update</span>`;
    if (!statusColored) return escapeHtml(status);
    return `<span class="text-highlight-red">${escapeHtml(status)}</span>`;
  }
  function ticketsDashboardResourceCellHtml(resourceName) {
    const resLabel = escapeHtml(resourceName);
    return resourceName === 'Unassigned' ? `<span class="text-highlight-red">${resLabel}</span>` : resLabel;
  }

  function formatDateTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  }
  // h:mm, same rounding/rollover convention every other hours-worked
  // column on this dashboard uses (Completed Tickets/Ticket Times' own
  // formatHours()) -- rounds to the nearest minute, rolling a 60-minute
  // remainder into the next hour rather than ever showing ":60".
  function formatHoursHM(hours) {
    const totalMinutes = Math.round((hours || 0) * 60);
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
  // Small grey text under the Ticket # (.inline-subtext), same real
  // Tickets.createDate field and plain browser-local formatting
  // @dashboard/tickets-dashboard's own formatCreateDate() already uses.
  // Also reused for Strety Tasks' own "-- as of TIME" subtitle -- same
  // plain HH:MM reading, just a different ISO field.
  function formatCreateTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  // "D Mon" from a full timestamp (Tickets.dueDateTime), for the
  // Deadlines card's own "Due" subtext -- same short-date shape
  // formatShortDate() below uses for a plain YYYY-MM-DD day key, just
  // reading the day/month straight off a real Date instead of a key
  // string (a due date is a genuine timestamp, no AEST-anchored day-key
  // parsing needed).
  function formatShortDateFromIso(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return `${d.getDate()} ${MONTH_SHORT[d.getMonth()]}`;
  }
  function formatShortDate(dateKey) {
    if (!dateKey) return '';
    const d = new Date(`${dateKey}T00:00:00`);
    return `${d.getDate()} ${MONTH_SHORT[d.getMonth()]}`;
  }
  // Completed Tickets/Ticket Times/Asked for Review/Accrued Time's own
  // shared subtitle -- "16 Sep" for a single day, "16 Sep to 20 Sep" for a
  // real range, echoing back whatever the server actually used (see
  // server.js's own from/to defaulting), not just re-reading the inputs
  // client-side -- keeps the subtitle honest even in the moment right
  // after a resource switch, before this card's own from/to have been
  // re-confirmed.
  function dateRangeLabel(from, to) {
    if (!from || !to) return '';
    return from === to ? formatShortDate(from) : `${formatShortDate(from)} to ${formatShortDate(to)}`;
  }
  function capitalize(str) {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
  }
  // AEST (UTC+10, no DST in Queensland) "today"/"tomorrow", same
  // convention every other date-scoped page on this dashboard uses.
  function todayAestKey() {
    return new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }
  function tomorrowAestKey() {
    return new Date(Date.now() + 10 * 60 * 60 * 1000 + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }
  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  if (lastData) render(lastData);
  loadResourceList();
}
