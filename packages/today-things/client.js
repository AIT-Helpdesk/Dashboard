export const id = "today-things";
export const label = "Today Things";

// A TV Boards page, by request -- meant to be glanced at on a wall
// display, not clicked through like a normal work page. Service Calls is
// the first section ("Let's put Service calls on this page first"), more
// to follow later. Three day-scoped groups -- Today, Tomorrow, and
// Overdue (calls before today, still incomplete, whose ticket is still
// open -- see server.js) -- each shown as two views side by side,
// by request: chronological (left, the same default order Service Calls'
// own page and What's On both already use) and grouped by Allocated
// Resource with Unallocated first (right). Every row's own click-to-open
// popup (Open ticket/Change Date/Time/Mark Complete/Mark as Onsite TBA/
// Mark as Onsite Arranged) is a straight port of What's On's own Service
// Calls section (ttDayTag()/serviceCallRowHtml()/openServiceCallMenu()
// there) -- same cross-page calls to Service Calls' own already-live
// routes (packages/service-calls/server.js), not a duplicated write; this
// page has no writes of its own at all.

let lastData = null; // module-scope, survives the shell's teardown/re-mount, same convention every other page here uses
// The real ServiceCalls.status picklist (see GET /api/service-calls/statuses
// in that page's own server.js for the full "why"/live-vs-stale story),
// fetched ONCE per page load (see fetchServiceCallStatusOptions() below)
// and reused for every later "Change Status" submenu open within the same
// session -- module-scope, same "survives a remount, never refetched
// needlessly" convention as lastData above, and exactly what "definitely
// don't [fetch] every time a user clicks" requires. null until the first
// fetch resolves.
let cachedServiceCallStatusOptions = null;

// Module scope, not declared inside mount() -- same fix What's On's own
// MONTH_SHORT/TEAM_ICON_HTML needed (see that file's own comment for the
// full story): mount()'s own `if (lastData) render(lastData)` early-
// restore call sits BEFORE either of these would be declared as a local
// const inside mount(), and render() reaches straight into both on that
// same synchronous call -- a real `ReferenceError: Cannot access before
// initialization` on every SECOND-OR-LATER mount within one browser
// session (not the first, since lastData is still null then). A const's
// temporal dead zone covers its whole enclosing scope, not just "before
// this line textually", and mount() re-runs top-to-bottom on every
// revisit -- module scope sidesteps it entirely, fully initialized once
// before mount() is ever called the first time.
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Same module-scope-not-inside-mount() reasoning as MONTH_SHORT above --
// used by Tomorrow's own Sat/Sun/Mon weekday label (see
// formatWeekdayShort()/tomorrowMultiDay below).
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// Column heading pill -- same green/amber/red 3-color
// .tt-tag--today/--tomorrow/--overdue palette What's On's own day tags
// already use, reused here as the column TITLE itself rather than a
// per-row tag, by request.
const DAY_SCOPE_PILLS = {
  today: { cls: 'tt-tag--today', label: 'Today' },
  tomorrow: { cls: 'tt-tag--tomorrow', label: 'Tomorrow' },
  overdue: { cls: 'tt-tag--overdue', label: 'Overdue' },
};

export function mount(container) {
  // No <h1> page heading, by request -- a wall-display TV board doesn't
  // need its own title the way a normal work page does. The Refresh
  // button stays, just without the heading it used to sit beside.
  //
  // Wrapped in .today-things-page so styles.css can scale the WHOLE page
  // up via `zoom` (by request, "make all the text twice as big") -- same
  // convention Workshop's own Rotation View uses for this identical need
  // (see .wsp-page.wsp-rotation-view's own comment): most of this page's
  // font-sizes are in rem, which is always relative to the document ROOT
  // font-size, not any ancestor's, so a plain font-size bump here would
  // only hit text that happens to inherit it directly and leave
  // everything else (pills, gaps, padding) untouched. zoom scales the
  // whole rendered subtree as one multiplier, which is what "everything"
  // actually needs.
  container.innerHTML = `
    <div class="today-things-page">
      <header class="page-header today-things-header">
        <div class="date-form">
          <button type="button" id="refresh-button">Refresh</button>
        </div>
      </header>
      <p id="status" class="status">Loading...</p>
      <div id="results"></div>
    </div>
  `;

  const refreshButton = container.querySelector('#refresh-button');
  const statusEl = container.querySelector('#status');
  const resultsEl = container.querySelector('#results');

  refreshButton.addEventListener('click', () => load(true));

  // Delegated once on the stable #results container, not re-wired per
  // render -- render() replaces its innerHTML on every load, but a
  // listener on the ancestor itself keeps working regardless (event
  // delegation), same convention What's On's own #tt-columns listener
  // uses for this identical row-click-opens-a-popup behaviour.
  resultsEl.addEventListener('click', (e) => {
    const row = e.target.closest('[data-sc-id]');
    if (!row) return;
    e.preventDefault();
    openServiceCallMenu(row, {
      id: row.dataset.scId,
      isComplete: row.dataset.scComplete === 'true',
      ticketUrl: row.dataset.scTicketUrl || null,
      startDateTime: row.dataset.scStart || null,
      endDateTime: row.dataset.scEnd || null,
    });
  });

  if (lastData) render(lastData);
  else load(false);
  // Fire-and-forget, not awaited -- primes cachedServiceCallStatusOptions
  // (see its own module-scope comment) well before anyone actually opens
  // a row's own "Change Status" submenu, without blocking this page's own
  // main load. A no-op once already cached from an earlier mount this
  // session.
  fetchServiceCallStatusOptions();

  async function load(force) {
    refreshButton.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = 'Loading...';
    resultsEl.innerHTML = '';

    try {
      const res = await fetch(`/api/today-things${force ? '?force=true' : ''}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastData = data;
      render(data);
    } catch (err) {
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      refreshButton.disabled = false;
    }
  }

  function render(data) {
    statusEl.hidden = true;
    resultsEl.innerHTML = `
      <div class="today-things-columns">
        ${serviceCallColumnHtml('today', data.today)}
        ${serviceCallColumnHtml('today', data.today, { byResource: true })}
      </div>
      <div class="today-things-columns">
        ${serviceCallColumnHtml('tomorrow', data.tomorrow, { showWeekday: data.tomorrowMultiDay })}
        ${serviceCallColumnHtml('tomorrow', data.tomorrow, { byResource: true, showWeekday: data.tomorrowMultiDay })}
      </div>
      <div class="today-things-columns">
        ${serviceCallColumnHtml('overdue', data.overdue)}
        ${serviceCallColumnHtml('overdue', data.overdue, { byResource: true })}
      </div>
    `;
  }

  // One column's card -- shared shell for both the chronological and
  // resource-grouped views, same "empty vs. populated reads consistently"
  // reasoning What's On's own ttColumn() follows for its three columns.
  // Overdue's rows additionally fold their own date into the time text
  // (showDate, derived from dayScope) -- Today's and Tomorrow's own
  // tables are each USUALLY single-day (the header pill already says
  // which), but Overdue spans up to 2 weeks of different dates, so its
  // rows need their own date shown to tell them apart. Tomorrow is the
  // one exception to "usually" -- on a Friday it widens to Saturday
  // through Monday (see server.js's own comment), so its rows get their
  // own short weekday label instead (showWeekday, from the caller's own
  // `data.tomorrowMultiDay` -- server-told, not inferred from how many
  // distinct dates happen to show up, so a sparse Friday with only one
  // Monday call still gets labelled correctly). The chronological (left)
  // list shows each row's full ticket/service-call detail line
  // (showDetails); the by-Resource (right) list doesn't repeat it and
  // additionally drops the allocation text before the description
  // (hideAllocation) -- both by request, since the resource-group heading
  // already says who's allocated there.
  function serviceCallColumnHtml(dayScope, rows, { byResource = false, showWeekday = false } = {}) {
    const showDate = dayScope === 'overdue';
    let body;
    if (!rows || rows.length === 0) {
      // Empty box, no "Nothing scheduled." message, by request -- a wall
      // display reads an empty box as "nothing here" on its own; the text
      // was just extra noise across all three day-scopes.
      body = '';
    } else if (byResource) {
      body = groupedByResourceHtml(rows, { showDate, showWeekday });
    } else {
      body = `<ul class="today-things-list">${rows.map((row) => serviceCallRowHtml(row, { showDate, showWeekday, showDetails: true })).join('')}</ul>`;
    }
    const pill = DAY_SCOPE_PILLS[dayScope];
    const titleHtml = `
      <span class="today-things-column-title">
        <span class="tt-tag ${pill.cls}">${escapeHtml(pill.label)}</span>
        ${byResource ? '<span class="today-things-column-title-suffix">by Resource</span>' : ''}
      </span>`;
    return `
      <div class="resource-group today-things-column">
        <div class="resource-group-header">${titleHtml}<span class="count"> (${rows ? rows.length : 0})</span></div>
        <div class="today-things-column-body">${body}</div>
      </div>`;
  }

  // Grouped by resourceNames.join(', ') -- a call with more than one
  // resource forms its own combined-name group rather than being split
  // across each individual resource's group, same "picking one grouping
  // key per call, not fanning it out" simplicity every other join on this
  // dashboard defaults to absent a specific request to do otherwise.
  // Unallocated sorts first (by request), every named group after it
  // alphabetically. Every real resource-name heading is blue (by request
  // -- reverted from an earlier per-day-scope green/amber/red tint), same
  // var(--accent) blue .text-highlight-blue uses for an allocated name
  // everywhere else on this dashboard; "Unallocated" stays red, same
  // #dc2626 .text-highlight-red uses for that everywhere else too.
  function groupedByResourceHtml(rows, { showDate = false, showWeekday = false } = {}) {
    const byGroup = new Map(); // group label -> rows[]
    for (const row of rows) {
      const key = row.allocated ? row.resourceNames.join(', ') : 'Unallocated';
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key).push(row);
    }
    const groupNames = [...byGroup.keys()].sort((a, b) => {
      if (a === 'Unallocated') return -1;
      if (b === 'Unallocated') return 1;
      return a.localeCompare(b);
    });
    return groupNames
      .map((name) => {
        const groupRows = byGroup.get(name);
        const headingModifier = name === 'Unallocated' ? 'today-things-resource-group-heading--unallocated' : 'today-things-resource-group-heading--resource';
        return `
        <div class="today-things-resource-group">
          <div class="today-things-resource-group-heading ${headingModifier}">${escapeHtml(name)}</div>
          <ul class="today-things-list">${groupRows.map((row) => serviceCallRowHtml(row, { showDate, showWeekday, hideAllocation: true })).join('')}</ul>
        </div>`;
      })
      .join('');
  }

  // Same row shape as What's On's own serviceCallRowHtml() -- blue
  // <resource names> / red "Unallocated" allocation text, the ticket
  // number/title/status + service call status hover tooltip, the whole
  // row as the click target for the popup menu below. NO day tag on
  // Today/Tomorrow normally (unlike What's On's copy) -- those two
  // tables are each usually already split by day, so a tag would just
  // repeat what the column heading already says. Overdue is one
  // exception -- `showDate` shows the row's date+time together in the
  // same red `.tt-tag--overdue` pill (instead of the plain `.tt-time`
  // every other row uses), by request, since that table alone can span
  // up to 2 weeks of different dates. Tomorrow-on-a-Friday is the other
  // -- `showWeekday` prefixes the plain time with a short weekday label
  // (e.g. "Sat, 11:30 am"), by request, no pill -- that table only ever
  // spans the 3 days of one long weekend, not weeks of unrelated dates,
  // so a plain text prefix reads as "this row's own day" rather than
  // needing the same visual weight as Overdue's colored badge.
  //
  // `hideAllocation` (by-Resource lists only, by request) drops the blue/
  // red allocation text before the description -- the resource-group
  // heading above already says who's allocated, so repeating it on every
  // row is redundant there. `showDetails` (chronological lists only, by
  // request) adds two visible lines -- Ticket Number/Title, then Service
  // Call/Ticket Status -- previously only available on hover via the
  // tooltip below, which stays in place (still useful for the by-Resource
  // rows, which don't get these visible lines).
  function serviceCallRowHtml(row, { showDate = false, showWeekday = false, hideAllocation = false, showDetails = false } = {}) {
    const allocation = row.allocated
      ? `<span class="text-highlight-blue">&lt;${escapeHtml(row.resourceNames.join(', '))}&gt;</span>`
      : '<span class="text-highlight-red">Unallocated</span>';
    const tooltipLines = [];
    if (row.ticketNumber) {
      tooltipLines.push(`${row.ticketNumber}: ${row.ticketTitle || ''}`.trim());
      tooltipLines.push(`Ticket Status: ${row.ticketStatus}`);
    }
    tooltipLines.push(`Service call status: ${row.serviceCallStatus}`);
    const tooltip = tooltipLines.join('\n');

    let timeHtml;
    if (showDate) {
      timeHtml = `<span class="tt-tag tt-tag--overdue">${escapeHtml(formatShortDate(row.dayKey))}, ${escapeHtml(formatTime(row.startDateTime))}</span>`;
    } else if (showWeekday) {
      timeHtml = `<span class="tt-time">${escapeHtml(formatWeekdayShort(row.dayKey))}, ${formatTime(row.startDateTime)}</span>`;
    } else {
      timeHtml = `<span class="tt-time">${formatTime(row.startDateTime)}</span>`;
    }

    const descriptionLine = hideAllocation
      ? row.description
        ? `<span class="cell-subtext">${escapeHtml(row.description)}</span>`
        : ''
      : `<span class="cell-subtext">${allocation}${row.description ? ` -- ${escapeHtml(row.description)}` : ''}</span>`;

    // Two separate labeled lines, by request -- 1. Ticket Number: Ticket
    // Title, 2. Service Call / Ticket Status, bold labels on both. When
    // there's no linked ticket at all, line 1 says so and line 2 drops
    // its "/ Ticket Status" half (there's no ticket status to show).
    let detailLines = '';
    if (showDetails) {
      const ticketLine = row.ticketNumber
        ? `<strong>Ticket Number:</strong> ${escapeHtml(row.ticketNumber)} -- ${escapeHtml(row.ticketTitle || '')}`
        : `<strong>Ticket Number:</strong> No ticket linked`;
      const statusValue = row.ticketStatus ? `${escapeHtml(row.serviceCallStatus)} / ${escapeHtml(row.ticketStatus)}` : escapeHtml(row.serviceCallStatus);
      const statusLine = `<strong>Service Call / Ticket Status:</strong> ${statusValue}`;
      detailLines = `
        <span class="cell-subtext today-things-detail-line">${ticketLine}</span>
        <span class="cell-subtext today-things-detail-line">${statusLine}</span>`;
    }

    return `
      <li class="tt-service-call-row" data-sc-id="${row.id}" data-sc-complete="${row.isComplete ? 'true' : 'false'}" data-sc-ticket-url="${escapeHtml(row.ticketUrl || '')}" data-sc-start="${escapeHtml(row.startDateTime || '')}" data-sc-end="${escapeHtml(row.endDateTime || '')}" title="${escapeHtml(tooltip)}">
        ${timeHtml}
        <strong>${escapeHtml(row.companyName)}</strong>
        ${descriptionLine}
        ${detailLines}
      </li>`;
  }

  // ---- Open ticket / Change Date/Time / Mark Complete / Onsite status
  // popup -- a direct port of What's On's own identical component
  // (openServiceCallMenu() there), including the SAME cross-page calls to
  // Service Calls' own routes. Only one open at a time. ----
  let openEntryMenuEl = null;
  function closeServiceCallMenu() {
    if (!openEntryMenuEl) return;
    openEntryMenuEl.remove();
    openEntryMenuEl = null;
    document.removeEventListener('click', onServiceCallMenuOutsideClick, true);
    document.removeEventListener('keydown', onServiceCallMenuKeydown);
  }
  function onServiceCallMenuOutsideClick(e) {
    if (openEntryMenuEl && !openEntryMenuEl.contains(e.target)) closeServiceCallMenu();
  }
  function onServiceCallMenuKeydown(e) {
    if (e.key === 'Escape') closeServiceCallMenu();
  }
  // GET /api/service-calls/statuses -- fetched once (see
  // cachedServiceCallStatusOptions' own module-scope comment), not
  // refetched on every "Change Status" click. `force` (used only by the
  // submenu's own retry-on-failure below) bypasses that cache for one
  // real attempt when the eager mount-time prefetch itself failed. A
  // cross-page call to Service Calls' own route, same as
  // setServiceCallStatus() below already is.
  async function fetchServiceCallStatusOptions(force) {
    if (cachedServiceCallStatusOptions && !force) return cachedServiceCallStatusOptions;
    try {
      const res = await fetch('/api/service-calls/statuses');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      cachedServiceCallStatusOptions = data.statuses;
      return cachedServiceCallStatusOptions;
    } catch {
      // Best-effort -- the submenu below shows its own "Could not load"
      // state and offers Back; cachedServiceCallStatusOptions stays null
      // so the NEXT attempt (another menu open, or this same submenu's
      // own retry) tries again rather than caching a permanent failure.
      return null;
    }
  }

  function openServiceCallMenu(anchorEl, entry) {
    closeServiceCallMenu();
    const menu = document.createElement('div');
    menu.className = 'entry-popup-menu';
    document.body.appendChild(menu);
    openEntryMenuEl = menu;

    // Re-run after every render (the menu's own size changes between the
    // main view and the status submenu) -- keeps it anchored under
    // anchorEl and on-screen either way.
    function positionMenu() {
      const rect = anchorEl.getBoundingClientRect();
      menu.style.top = `${rect.bottom + window.scrollY + 4}px`;
      menu.style.left = `${rect.left + window.scrollX}px`;
      const menuRect = menu.getBoundingClientRect();
      if (menuRect.right > window.innerWidth) {
        menu.style.left = `${Math.max(4, window.innerWidth - menuRect.width - 4)}px`;
      }
    }

    function renderMainMenu() {
      menu.innerHTML = `
        ${entry.ticketUrl ? `<button type="button" class="entry-popup-menu-item" data-action="open-ticket">Open ticket</button>` : ''}
        <button type="button" class="entry-popup-menu-item" data-action="change-datetime">Change Date/Time</button>
        ${entry.isComplete ? '' : `<button type="button" class="entry-popup-menu-item" data-action="mark-complete">Mark As Complete</button>`}
        <button type="button" class="entry-popup-menu-item" data-action="change-status">Change Status</button>
      `;
      positionMenu();
      if (entry.ticketUrl) {
        menu.querySelector('[data-action="open-ticket"]').addEventListener('click', () => {
          window.open(entry.ticketUrl, '_blank', 'noopener,noreferrer,width=1200,height=900');
          closeServiceCallMenu();
        });
      }
      menu.querySelector('[data-action="change-datetime"]').addEventListener('click', () => openChangeDateTimeModal(entry));
      // No "Mark Incomplete" any more, by request -- never offered at all,
      // in either direction. "Mark As Complete" itself only shows when
      // the call isn't already complete (see the conditional button
      // above) -- undoing a completed call is Change Status' own job now
      // (the user picks a real status, not a blunt isComplete flip back
      // to an undifferentiated "not complete" with no status context).
      if (!entry.isComplete) {
        menu.querySelector('[data-action="mark-complete"]').addEventListener('click', () => toggleServiceCallComplete(entry.id, true));
      }
      menu.querySelector('[data-action="change-status"]').addEventListener('click', () => renderStatusSubmenu());
    }

    // "Change Status" -> one option per real ServiceCalls.status picklist
    // value (minus "New"), by request -- replaces the old fixed "Mark as
    // Onsite TBA"/"Mark as Onsite Arranged" pair. A drill-down within the
    // SAME menu element (swap its content, plus a "‹ Back" item), not a
    // separate flyout submenu -- avoids a second round of viewport-edge
    // positioning math for what's still just one small popup.
    async function renderStatusSubmenu() {
      if (!cachedServiceCallStatusOptions) {
        menu.innerHTML = `<button type="button" class="entry-popup-menu-item" data-action="back">‹ Back</button><p class="entry-popup-menu-loading">Loading...</p>`;
        positionMenu();
        menu.querySelector('[data-action="back"]').addEventListener('click', renderMainMenu);
        const statuses = await fetchServiceCallStatusOptions(true);
        // The menu may have been closed, or Back already clicked, by the
        // time this resolves -- bail rather than clobbering whatever's
        // showing now (or nothing at all).
        if (openEntryMenuEl !== menu || !menu.querySelector('[data-action="back"]')) return;
        if (!statuses) {
          menu.innerHTML = `<button type="button" class="entry-popup-menu-item" data-action="back">‹ Back</button><p class="entry-popup-menu-loading">Could not load statuses.</p>`;
          positionMenu();
          menu.querySelector('[data-action="back"]').addEventListener('click', renderMainMenu);
          return;
        }
      }
      const optionsHtml = cachedServiceCallStatusOptions.map((s) => `<button type="button" class="entry-popup-menu-item" data-status-value="${s.value}">${escapeHtml(s.label)}</button>`).join('');
      menu.innerHTML = `<button type="button" class="entry-popup-menu-item" data-action="back">‹ Back</button>${optionsHtml}`;
      positionMenu();
      menu.querySelector('[data-action="back"]').addEventListener('click', renderMainMenu);
      menu.querySelectorAll('[data-status-value]').forEach((btn) => {
        btn.addEventListener('click', () => setServiceCallStatus(entry.id, Number(btn.dataset.statusValue)));
      });
    }

    renderMainMenu();
    setTimeout(() => document.addEventListener('click', onServiceCallMenuOutsideClick, true), 0);
    document.addEventListener('keydown', onServiceCallMenuKeydown);
  }

  // Calls the SAME /api/service-calls/:id/complete route Service Calls'
  // own page (and What's On) use -- a cross-page call, not a duplicated
  // write. Forces a fresh fetch afterward (bypassing this page's own
  // 10-minute cache) so the change is visible immediately.
  async function toggleServiceCallComplete(id, nextIsComplete) {
    closeServiceCallMenu();
    try {
      await fetchJson(`/api/service-calls/${id}/complete`, 'PATCH', { isComplete: nextIsComplete });
      await load(true);
    } catch (err) {
      alert(`Error: ${err.message}`);
    }
  }

  async function setServiceCallStatus(id, status) {
    closeServiceCallMenu();
    try {
      await fetchJson(`/api/service-calls/${id}/status`, 'PATCH', { status });
      await load(true);
    } catch (err) {
      alert(`Error: ${err.message}`);
    }
  }

  // Same .history-modal-* overlay/panel shell and cross-page call to
  // Service Calls' own PATCH .../:id/datetime route as What's On's
  // identical copy of this modal -- not shared code, just the same
  // established shape, since these are separate page packages.
  function openChangeDateTimeModal(entry) {
    closeServiceCallMenu();
    const overlay = document.createElement('div');
    overlay.className = 'history-modal-overlay';
    overlay.innerHTML = `
      <div class="history-modal-panel wsp-qa-modal-panel">
        <div class="history-modal-panel-header">
          <span>Change Date/Time</span>
          <button type="button" class="history-modal-close" aria-label="Close">✕</button>
        </div>
        <div class="history-modal-body">
          <label class="wsp-qa-modal-label wsp-qa-modal-label--top">Start
            <input type="datetime-local" class="wsp-field sc-datetime-start-input" value="${escapeHtml(toDatetimeLocalValue(entry.startDateTime))}" />
          </label>
          <label class="wsp-qa-modal-label wsp-qa-modal-label--top">End
            <input type="datetime-local" class="wsp-field sc-datetime-end-input" value="${escapeHtml(toDatetimeLocalValue(entry.endDateTime))}" />
          </label>
          <p class="status error sc-datetime-modal-error" hidden></p>
          <div class="wsp-form-actions">
            <button type="button" class="button-link sc-datetime-save-button">Save</button>
            <button type="button" class="sc-datetime-cancel-button">Cancel</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKeydown);
    };
    function onKeydown(e) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('keydown', onKeydown);
    overlay.querySelector('.history-modal-close').addEventListener('click', close);
    overlay.querySelector('.sc-datetime-cancel-button').addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    const startInput = overlay.querySelector('.sc-datetime-start-input');
    const endInput = overlay.querySelector('.sc-datetime-end-input');
    const errorEl = overlay.querySelector('.sc-datetime-modal-error');
    const saveButton = overlay.querySelector('.sc-datetime-save-button');

    // Shifting Start also shifts End by the same amount, by request --
    // preserves the call's own duration instead of leaving End behind (or
    // ahead of) a moved Start. Deliberately one-directional -- changing
    // End never touches Start. `change`, not `input` -- fires once a new
    // value is actually committed (picker selection or losing focus), not
    // on every sub-field keystroke a native datetime-local control's own
    // year/month/day/hour/minute segments would otherwise each trigger
    // their own `input` event for. Same duplicated-per-page-package copy
    // as this whole modal already is (see this function's own comment).
    let previousStartValue = startInput.value;
    startInput.addEventListener('change', () => {
      const newStart = fromDatetimeLocalValue(startInput.value);
      const oldStart = fromDatetimeLocalValue(previousStartValue);
      const currentEnd = fromDatetimeLocalValue(endInput.value);
      if (newStart && oldStart && currentEnd) {
        const deltaMs = new Date(newStart).getTime() - new Date(oldStart).getTime();
        if (deltaMs !== 0) {
          endInput.value = toDatetimeLocalValue(new Date(new Date(currentEnd).getTime() + deltaMs).toISOString());
        }
      }
      previousStartValue = startInput.value;
    });

    saveButton.addEventListener('click', async () => {
      errorEl.hidden = true;
      const startDateTime = fromDatetimeLocalValue(startInput.value);
      const endDateTime = fromDatetimeLocalValue(endInput.value);
      if (!startDateTime || !endDateTime) {
        errorEl.hidden = false;
        errorEl.textContent = 'Both a start and end date/time are required.';
        return;
      }
      if (new Date(endDateTime) <= new Date(startDateTime)) {
        errorEl.hidden = false;
        errorEl.textContent = 'End time must be after start time.';
        return;
      }
      saveButton.disabled = true;
      saveButton.textContent = 'Saving...';
      try {
        await fetchJson(`/api/service-calls/${entry.id}/datetime`, 'PATCH', { startDateTime, endDateTime });
        close();
        await load(true);
      } catch (err) {
        errorEl.hidden = false;
        errorEl.textContent = `Error: ${err.message}`;
        saveButton.disabled = false;
        saveButton.textContent = 'Save';
      }
    });
    startInput.focus();
  }

  // <input type="datetime-local"> needs "YYYY-MM-DDTHH:mm" in LOCAL time
  // (no timezone suffix) -- built from the Date object's own local
  // getters, not a slice of its ISO string (always UTC, would silently
  // shift the displayed time). Same helper Service Calls'/What's On's own
  // client.js already carry, duplicated here since these are separate
  // page packages.
  function toDatetimeLocalValue(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  // Reverse of the above -- relies on the browser parsing a bare (no
  // timezone suffix) datetime-local string as LOCAL time. Only actually
  // correct when the browser's own local timezone is AEST, same
  // assumption every other AEST-anchored piece of this dashboard already
  // makes (this is an Australian company's internal tool).
  function fromDatetimeLocalValue(value) {
    if (!value) return null;
    return new Date(value).toISOString();
  }

  function formatTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  // Overdue rows' own date badge -- same "day+month" shape as What's On's
  // own formatShortDate(), duplicated here since these are separate page
  // packages. Built from a bare "T00:00:00" local-time parse, not the
  // dayKey string sliced directly -- avoids a UTC/local off-by-one on the
  // displayed day, same reasoning as that copy.
  function formatShortDate(dateKey) {
    if (!dateKey) return '';
    const d = new Date(`${dateKey}T00:00:00`);
    return `${d.getDate()} ${MONTH_SHORT[d.getMonth()]}`;
  }

  // Tomorrow-on-a-Friday's own weekday label (Sat/Sun/Mon), by request --
  // same bare "T00:00:00" local-time parse as formatShortDate() above,
  // for the same UTC/local off-by-one reason.
  function formatWeekdayShort(dateKey) {
    if (!dateKey) return '';
    const d = new Date(`${dateKey}T00:00:00`);
    return WEEKDAY_SHORT[d.getDay()];
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

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
