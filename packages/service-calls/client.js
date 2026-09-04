export const id = "service-calls";
export const label = "Service Calls";

// Module-scope, not inside mount() -- the shell fully tears down and re-mounts a
// page's DOM on every navigation away and back, but the dynamically-imported
// module itself is cached by the browser and stays alive for the session, so a
// module-level variable survives across re-mounts and lets the last result
// restore instantly instead of coming back blank.
let lastMonth = null; // "YYYY-MM"
let lastData = null;
// The real ServiceCalls.status picklist (see GET /api/service-calls/statuses
// in server.js for the full "why"/live-vs-stale story), fetched ONCE per
// page load (see fetchServiceCallStatusOptions() below) and reused for
// every later "Change Status" submenu open within the same session --
// module-scope, same "survives a remount, never refetched needlessly"
// convention as lastMonth/lastData above, and exactly what "definitely
// don't [fetch] every time a user clicks" requires. null until the first
// fetch resolves; [] would be indistinguishable from "genuinely no
// changeable statuses", which is never actually expected in practice.
let cachedServiceCallStatusOptions = null;
// Filter is purely a display concern (the server always returns everything
// for the month), so it's applied client-side and doesn't trigger a
// refetch -- toggling it re-renders the already-loaded data instantly.
// Module-scope so it survives a same-session re-mount too, same as
// lastMonth/lastData.
let showUnallocatedOnly = false;
// Same client-side-only filtering rationale as showUnallocatedOnly above --
// off by default, so a completed call (nothing left to staff or review)
// doesn't clutter the calendar unless specifically asked for.
let showCompleted = false;

const MONTH_LABELS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAY_HEADERS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// The left-border accent, by request, is ONLY for the two "Onsite"
// statuses -- gold for Onsite Arranged, red for Onsite TBA.
const ONSITE_ACCENT_CLASSES = {
  'Onsite Arranged': 'calendar-entry--onsite-arranged',
  'Onsite TBA': 'calendar-entry--onsite-tba',
};
// Background SHADING, not a border accent, for the rest of the real
// ServiceCalls.status picklist, by request ("I wanted background
// shading please. The sidebar colours are only for the Onsite jobs") --
// TAM/vCIO light grey (was white, changed by request -- true white was
// barely visible against a light-mode page background), Complete/
// Canceled/Canceled by Client green, Phone Call yellow. Takes priority
// over the completion/allocation-based fill below when a call's status
// matches one of these (see colorClass below) -- entries with a status
// not in this map (currently just "New"/"To Do") fall back to that
// completion/allocation shading as before.
const STATUS_BACKGROUND_CLASSES = {
  'TAM/vCIO': 'calendar-entry--status-bg-grey',
  Complete: 'calendar-entry--status-bg-green',
  Canceled: 'calendar-entry--status-bg-green',
  'Canceled by Client': 'calendar-entry--status-bg-green',
  'Phone Call': 'calendar-entry--status-bg-yellow',
};

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>Service Calls</h1>
      <div class="date-form calendar-nav">
        <button type="button" id="prev-button" aria-label="Previous month">&lsaquo;</button>
        <span id="month-label" class="calendar-month-label"></span>
        <button type="button" id="next-button" aria-label="Next month">&rsaquo;</button>
        <button type="button" id="today-button">Today</button>
        <button type="button" id="refresh-button">Refresh</button>
        <button type="button" id="allocation-toggle" class="link-button"></button>
        <label for="show-completed-input" class="inline-checkbox-label">
          <input type="checkbox" id="show-completed-input" /> Show Completed
        </label>
      </div>
    </header>
    <p id="status" class="status">Every Autotask Service Call, with the resource(s) assigned to it (if any) -- "To Do" items aren't included (Autotask's REST API doesn't expose them; see the README).</p>
    <div id="summary" class="summary" hidden></div>
    <div id="calendar" class="results"></div>
  `;

  const prevButton = container.querySelector('#prev-button');
  const nextButton = container.querySelector('#next-button');
  const todayButton = container.querySelector('#today-button');
  const refreshButton = container.querySelector('#refresh-button');
  const allocationToggle = container.querySelector('#allocation-toggle');
  const showCompletedInput = container.querySelector('#show-completed-input');
  const monthLabelEl = container.querySelector('#month-label');
  const statusEl = container.querySelector('#status');
  const summaryEl = container.querySelector('#summary');
  const calendarEl = container.querySelector('#calendar');

  function renderToggleLabel() {
    // The label names the ACTION a click performs, not the current state --
    // default (showing all) reads "Show Unallocated Only" (what clicking
    // does), and once filtered it flips to "Show All" (what clicking does
    // from there), by request.
    allocationToggle.textContent = showUnallocatedOnly ? 'Show All' : 'Show Unallocated Only';
  }
  renderToggleLabel();

  allocationToggle.addEventListener('click', () => {
    showUnallocatedOnly = !showUnallocatedOnly;
    renderToggleLabel();
    if (lastData) render(lastData);
  });

  showCompletedInput.checked = showCompleted;
  showCompletedInput.addEventListener('change', () => {
    showCompleted = showCompletedInput.checked;
    if (lastData) render(lastData);
  });

  // Browser-local "today" for the initial guess, before the server's own
  // AEST todayKey comes back on first load -- close enough purely to decide
  // which month to open on (our users are all in Queensland, so this is
  // AEST in practice anyway); every actual "today" highlight and the Today
  // button both switch to using the server's todayKey once a response
  // arrives, same reasoning Ingram Orders' defaultSinceISO() uses.
  function defaultMonthKey() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  function addMonths(monthKey, delta) {
    const [y, m] = monthKey.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  prevButton.addEventListener('click', () => load(addMonths(lastMonth || defaultMonthKey(), -1)));
  nextButton.addEventListener('click', () => load(addMonths(lastMonth || defaultMonthKey(), 1)));
  todayButton.addEventListener('click', () => load(lastData ? lastData.todayKey.slice(0, 7) : defaultMonthKey()));
  // Refresh always bypasses the 10-min cache for whichever month is
  // currently shown -- everything else (prev/next/today) is happy to serve
  // a recent cached view, this is the explicit "no, check again right now"
  // button for when a staffing gap might have just been fixed.
  refreshButton.addEventListener('click', () => load(lastMonth || defaultMonthKey(), true));

  async function load(monthKey, force) {
    prevButton.disabled = true;
    nextButton.disabled = true;
    todayButton.disabled = true;
    refreshButton.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = `Loading ${monthLabelFor(monthKey)}...`;
    summaryEl.hidden = true;
    calendarEl.innerHTML = '';
    monthLabelEl.textContent = monthLabelFor(monthKey);

    try {
      const params = new URLSearchParams({ month: monthKey });
      if (force) params.set('force', 'true');
      const res = await fetch(`/api/service-calls?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastMonth = monthKey;
      lastData = data;
      render(data);
    } catch (err) {
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      prevButton.disabled = false;
      nextButton.disabled = false;
      todayButton.disabled = false;
      refreshButton.disabled = false;
    }
  }

  function monthLabelFor(monthKey) {
    const [y, m] = monthKey.split('-').map(Number);
    return `${MONTH_LABELS[m - 1]} ${y}`;
  }

  // Both toggles are pure client-side filters over the same already-loaded
  // month, combined with AND (e.g. "Show Unallocated Only" + completed
  // hidden shows only still-unallocated, not-yet-complete calls). Used both
  // per-day (for what actually renders in each cell) and across the whole
  // month (so the summary line's counts always match what's on screen,
  // rather than the server's raw totals which may include calls the current
  // filters are hiding).
  function visibleEntries(entries) {
    let result = entries;
    if (showUnallocatedOnly) result = result.filter((e) => !e.allocated);
    if (!showCompleted) result = result.filter((e) => !e.isComplete);
    return result;
  }

  function render(data) {
    statusEl.hidden = true;
    monthLabelEl.textContent = monthLabelFor(data.month);

    const allEntries = Object.values(data.byDay).flat();
    const visible = visibleEntries(allEntries);
    const visibleUnallocatedCount = visible.filter((e) => !e.allocated).length;
    // Looked up by the click handler wired below -- entryHtml() itself
    // only embeds the id (data-sc-id), not the whole entry object, since
    // it's just building an HTML string.
    const entryById = new Map(allEntries.map((e) => [String(e.id), e]));

    summaryEl.hidden = false;
    summaryEl.innerHTML = showUnallocatedOnly
      ? `<strong>${visibleUnallocatedCount}</strong> unallocated service call${visibleUnallocatedCount === 1 ? '' : 's'} in ${escapeHtml(monthLabelFor(data.month))} <span class="inline-subtext">(${data.totalCount} total, ${data.unallocatedCount} unallocated${showCompleted ? '' : ' -- completed hidden'})</span>`
      : `<strong>${visible.length}</strong> service call${visible.length === 1 ? '' : 's'} in ${escapeHtml(monthLabelFor(data.month))} <span class="inline-subtext">(${visibleUnallocatedCount} unallocated${showCompleted ? '' : `, ${data.totalCount} total -- completed hidden`})</span>`;

    calendarEl.innerHTML = '';
    const table = document.createElement('table');
    table.className = 'calendar-table';

    const thead = document.createElement('thead');
    thead.innerHTML = `<tr>${WEEKDAY_HEADERS.map((w) => `<th>${w}</th>`).join('')}</tr>`;
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    const [y, m] = data.month.split('-').map(Number);
    for (let i = 0; i < data.gridDates.length; i += 7) {
      const week = data.gridDates.slice(i, i + 7);
      const tr = document.createElement('tr');
      for (const dayKey of week) {
        const [dy, dm, dd] = dayKey.split('-').map(Number);
        const inMonth = dm === m && dy === y;
        const isToday = dayKey === data.todayKey;
        const td = document.createElement('td');
        td.className = 'calendar-cell' + (inMonth ? '' : ' calendar-cell--outside') + (isToday ? ' calendar-cell--today' : '');
        const entries = visibleEntries(data.byDay[dayKey] || []);
        td.innerHTML = `
          <button type="button" class="calendar-cell-daynum" ${entries.length === 0 ? 'disabled' : ''}>${dd}</button>
          <div class="calendar-cell-entries">${entries.map((e) => entryHtml(e)).join('')}</div>
        `;
        if (entries.length > 0) {
          td.querySelector('.calendar-cell-daynum').addEventListener('click', () => openDayPopup(dayKey, entries));
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    calendarEl.appendChild(table);
    wireServiceCallEntries(calendarEl, entryById);
  }

  // A plain left-click on any entry (ticket-linked or not) now opens the
  // Open ticket/Mark Complete popup instead of navigating straight there,
  // by request -- see openServiceCallMenu() below. preventDefault() on the
  // click is what stops the ticket-linked <a>'s own default navigation;
  // it deliberately does NOT touch the anchor's real href/target, so a
  // middle-click or right-click -> "open in new tab" still goes straight
  // to the ticket as normal (those don't fire a 'click' event at all,
  // just this page's own left-click interception).
  function wireServiceCallEntries(container, entryById) {
    container.querySelectorAll('[data-sc-id]').forEach((el) => {
      el.addEventListener('click', (ev) => {
        ev.preventDefault();
        const entry = entryById.get(el.dataset.scId);
        if (entry) openServiceCallMenu(el, entry);
      });
    });
  }

  function entryHtml(e) {
    // Three lines per entry, by request -- time/company, the allocation
    // state (resource name(s), wrapped in angle brackets, in blue -- not
    // bold -- when allocated, matching What's On's own Service Calls
    // section; "Unallocated" stays the default muted colour), and the
    // first line of the call's own description, so all three are visible
    // on the calendar itself without needing to hover for the tooltip.
    // Line 3 always renders (an em dash when there's no description) so
    // every entry keeps the same 3-line shape, rather than shorter
    // entries looking inconsistent next to ones that have a description.
    const line1 = `${formatTime(e.startDateTime)} ${escapeHtml(e.companyName)}`;
    // .text-highlight-blue (shared, styles.css) -- not a new class -- is
    // already exactly right (var(--accent) blue, font-weight: 400) without
    // needing to touch .text-highlight-green itself, which m365-environment's
    // own client.js also uses for something unrelated. &lt;/&gt;, not raw
    // </> characters, so they render as literal visible brackets rather
    // than risk being read as the start of a real tag.
    const line2 = e.allocated
      ? `<span class="text-highlight-blue">&lt;${e.resourceNames.map(escapeHtml).join(', ')}&gt;</span>`
      : 'Unallocated';
    // Descriptions are often multi-paragraph free text -- split on real
    // newlines and take the first non-blank one, rather than just letting
    // line3's own CSS ellipsis cut off wherever the box runs out of
    // width regardless of the text's own line breaks.
    const descriptionFirstLine = e.description
      ? e.description
          .split('\n')
          .map((s) => s.trim())
          .find(Boolean)
      : null;
    const line3 = escapeHtml(descriptionFirstLine || '—');
    const inner = `<span class="calendar-entry-line1">${line1}</span><span class="calendar-entry-line2">${line2}</span><span class="calendar-entry-line3">${line3}</span>`;
    const ticket = e.tickets[0]; // linked ticket is the first one -- see README for the rare multi-ticket case
    // Ticket line(s) and the call's own description are shown together, not
    // one-or-the-other -- a call can have both (a description explaining
    // the work, plus a real linked ticket for it), and hiding the
    // description just because a ticket happened to be linked was losing
    // real information.
    const titleLines = e.tickets.flatMap((t) => [`${t.ticketNumber}: ${t.title}`, `  Ticket Status: ${t.status}`]);
    if (e.description) titleLines.push(e.description);
    titleLines.push(e.allocated ? `Allocated: ${e.resourceNames.join(', ')}` : 'Unallocated');
    if (e.isComplete) titleLines.push('Complete');
    titleLines.push(`Service call status: ${e.serviceCallStatus}`);
    if (e.isMine) titleLines.push('You are an allocated resource on this call');
    const title = escapeHtml(titleLines.join('\n'));
    // Priority order: a real ServiceCalls.status match (TAM/vCIO grey,
    // Complete/Canceled/Canceled by Client green, Phone Call yellow, see
    // STATUS_BACKGROUND_CLASSES above) wins outright over the completion/
    // allocation-based shading below, by request. Otherwise: complete
    // wins regardless of allocation (green -- nothing left to staff or
    // review), then allocated-but-not-complete (blue -- staffed, still
    // upcoming/in progress), then unallocated (red -- the staffing gap
    // this page originally existed to surface).
    const colorClass =
      ' ' + (STATUS_BACKGROUND_CLASSES[e.serviceCallStatus] || (e.isComplete ? 'calendar-entry--completed' : e.allocated ? 'calendar-entry--allocated' : 'calendar-entry--unallocated'));
    // A left-border accent, independent of the background fill above,
    // ONLY for the two "Onsite" statuses (see ONSITE_ACCENT_CLASSES
    // above) -- everything else gets background shading instead, not a
    // border accent, by request.
    const accentClass = ONSITE_ACCENT_CLASSES[e.serviceCallStatus] ? ' ' + ONSITE_ACCENT_CLASSES[e.serviceCallStatus] : '';
    // A full green outline, independent of both the fill and the left-
    // border accent above, when the signed-in user is one of the call's
    // allocated resources -- by request, so "mine" stands out regardless of
    // whatever other state the entry is already showing.
    const mineClass = e.isMine ? ' calendar-entry--mine' : '';
    if (ticket) {
      // href/target/rel stay real (not just decorative) -- by request, a
      // plain left-click is intercepted client-side to open the Open
      // ticket/Mark Complete popup instead (see wireServiceCallEntries()
      // above), but a middle-click or right-click -> "open in new tab"
      // never fires that JS at all, so those still go straight to the
      // ticket natively, same as any other real link.
      return `<a class="calendar-entry${colorClass}${accentClass}${mineClass}" data-sc-id="${e.id}" href="${escapeHtml(ticket.ticketUrl)}" target="_blank" rel="noopener noreferrer" title="${title}">${inner}</a>`;
    }
    // No ticket doesn't mean nothing to click, by request -- Mark Complete
    // is still available even with no linked ticket, just via the same
    // popup with only that one option (see openServiceCallMenu() below).
    return `<div class="calendar-entry calendar-entry--no-ticket${colorClass}${accentClass}${mineClass}" data-sc-id="${e.id}" title="${title}">${inner}</div>`;
  }

  // ---- Open ticket / Mark Complete popup -- by request, replaces the old
  // "click an entry -> straight to the ticket" behaviour. A small floating
  // menu (shared .entry-popup-menu-* classes -- What's On's own Service
  // Calls section uses the exact same ones) anchored under whichever
  // entry was clicked. Only one open at a time. ----
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
  // real attempt when the eager mount-time prefetch itself failed.
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
    const ticket = entry.tickets[0];
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
        ${ticket ? `<button type="button" class="entry-popup-menu-item" data-action="open-ticket">Open ticket</button>` : ''}
        <button type="button" class="entry-popup-menu-item" data-action="change-datetime">Change Date/Time</button>
        ${entry.isComplete ? '' : `<button type="button" class="entry-popup-menu-item" data-action="mark-complete">Mark As Complete</button>`}
        <button type="button" class="entry-popup-menu-item" data-action="change-status">Change Status</button>
      `;
      positionMenu();
      if (ticket) {
        menu.querySelector('[data-action="open-ticket"]').addEventListener('click', () => {
          window.open(ticket.ticketUrl, '_blank', 'noopener,noreferrer,width=1200,height=900');
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
    // Deferred, not added synchronously -- otherwise the very click that
    // opened this menu would immediately bubble up to document and close
    // it again in the same tick.
    setTimeout(() => document.addEventListener('click', onServiceCallMenuOutsideClick, true), 0);
    document.addEventListener('keydown', onServiceCallMenuKeydown);
  }

  // Shared by the popup menu above AND the day popup's own button (see
  // dayPopupEntryHtml()/openDayPopup() below, reached via window.opener
  // since that's a genuinely separate document/window). Forces a fresh
  // fetch afterward (bypassing the 10-min report cache) so the change is
  // visible immediately rather than waiting out the cache -- same
  // reasoning the Refresh button's own force=true already uses.
  async function toggleServiceCallComplete(id, nextIsComplete) {
    closeServiceCallMenu();
    try {
      await fetchJson(`/api/service-calls/${id}/complete`, 'PATCH', { isComplete: nextIsComplete });
      await load(lastMonth || defaultMonthKey(), true);
    } catch (err) {
      alert(`Error: ${err.message}`);
    }
  }
  // Same shape as toggleServiceCallComplete() above, for the "Mark as
  // Onsite TBA"/"Mark as Onsite Arranged" menu items -- a different
  // field (status, not isComplete) but the same PATCH .../:id/status
  // route, cache-bypass-refresh, and error handling.
  async function setServiceCallStatus(id, status) {
    closeServiceCallMenu();
    try {
      await fetchJson(`/api/service-calls/${id}/status`, 'PATCH', { status });
      await load(lastMonth || defaultMonthKey(), true);
    } catch (err) {
      alert(`Error: ${err.message}`);
    }
  }
  // ---- Change Date/Time modal -- opened from the popup menu above, by
  // request. Same .history-modal-* overlay/panel shell (and the same
  // .wsp-field/.wsp-form-actions field/button styling) Contract Checks'
  // own small single-purpose edit modals use (e.g. its Ticket Number
  // editor) -- not shared code, just the same established shape, since
  // this is a separate page package. ----
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
    // their own `input` event for.
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
        await load(lastMonth || defaultMonthKey(), true);
      } catch (err) {
        errorEl.hidden = false;
        errorEl.textContent = `Error: ${err.message}`;
        saveButton.disabled = false;
        saveButton.textContent = 'Save';
      }
    });
    startInput.focus();
  }

  // <input type="datetime-local"> needs "YYYY-MM-DDTHH:mm" in LOCAL time (no
  // timezone suffix) -- built from the Date object's own local getters, not
  // a slice of its ISO string (which is always UTC and would silently shift
  // the displayed time). Same helper packages-received/client.js already
  // uses for its own Date & Time field, duplicated here since these are
  // separate page packages.
  function toDatetimeLocalValue(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  // Reverse of the above -- relies on the browser parsing a bare (no
  // timezone suffix) datetime-local string as LOCAL time, which is exactly
  // what toISOString() then converts correctly from. Only actually correct
  // when the browser's own local timezone is AEST, same assumption every
  // other AEST-anchored piece of this dashboard already makes (this is an
  // Australian company's internal tool).
  function fromDatetimeLocalValue(value) {
    if (!value) return null;
    return new Date(value).toISOString();
  }

  // Exposed for the day popup's own separate window to call back into via
  // window.opener -- see dayPopupEntryHtml() below.
  window.toggleServiceCallComplete = toggleServiceCallComplete;
  window.setServiceCallStatus = setServiceCallStatus;

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

  // Opens a real popup window (same "not just a new tab" convention as the
  // ticket links, via explicit window features) showing every entry
  // currently visible in that day's cell -- respects whichever filters
  // (Show Unallocated Only / Show Completed) are active, so it's the same
  // set the user is already looking at, not the unfiltered full day. Every
  // detail otherwise only available via hovering an entry (ticket status,
  // description, full allocation/completion/service-call-status state) is
  // shown directly here instead, since there's no hover in a list this
  // detailed. Built and written client-side (`document.write`) rather than
  // a server round trip -- the data's already loaded in `lastData`.
  function openDayPopup(dayKey, entries) {
    // Deliberately NO noopener/noreferrer here, unlike the ticket-link
    // popups -- those open an external Autotask URL and never need a JS
    // handle back to the new window, so severing it is the safe default.
    // This window opens blank and only gets its content from THIS script
    // writing into it via `popup.document.write()` below, so a null
    // reference (which is exactly what `noopener` forces) meant the window
    // Chrome still opened had nothing ever written into it -- a real bug
    // that shipped once, worth flagging so it doesn't come back.
    const popup = window.open('', '_blank', 'width=720,height=800,scrollbars=yes');
    if (!popup) return; // genuinely blocked by the browser's popup blocker -- nothing more to do

    const dateLabel = new Date(`${dayKey}T00:00:00`).toLocaleDateString(undefined, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    // Same light/dark token values as packages/shell/public/styles.css's
    // :root -- this window is a standalone document, not part of the shell
    // page, so it can't inherit those CSS custom properties; picking the
    // matching literal values keeps it visually consistent with whichever
    // mode the dashboard itself is currently in rather than defaulting to
    // one fixed look regardless of the user's actual theme.
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark' ||
      (document.documentElement.getAttribute('data-theme') !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const colors = isDark
      ? { bg: '#14161a', fg: '#eef0f3', muted: '#9aa3af', border: '#2a2e35', card: '#1b1e24', accent: '#5b8def' }
      : { bg: '#ffffff', fg: '#1a1a1a', muted: '#6b7280', border: '#e5e7eb', card: '#f9fafb', accent: '#2563eb' };

    const cardsHtml = entries.map((e) => dayPopupEntryHtml(e, colors)).join('');

    popup.document.open();
    popup.document.write(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Service Calls -- ${escapeHtml(dateLabel)}</title>
<style>
  body { font-family: system-ui, sans-serif; background: ${colors.bg}; color: ${colors.fg}; margin: 0; padding: 1rem 1.25rem; }
  h1 { font-size: 1.15rem; margin: 0 0 1rem; }
  .card { border: 1px solid ${colors.border}; border-radius: 8px; background: ${colors.card}; padding: 0.75rem 1rem; margin-bottom: 0.75rem; }
  .card h2 { font-size: 1rem; margin: 0 0 0.4rem; }
  .card dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 0.15rem 0.75rem; }
  .card dt { color: ${colors.muted}; }
  .card dd { margin: 0; }
  a { color: ${colors.accent}; }
  .empty { color: ${colors.muted}; }
  .mark-complete-btn { font: inherit; font-size: 0.72rem; padding: 0.1rem 0.4rem; margin-left: 0.4rem; border: 1px solid ${colors.border}; border-radius: 4px; background: ${colors.bg}; color: ${colors.fg}; cursor: pointer; }
  .mark-complete-btn:hover { border-color: ${colors.accent}; color: ${colors.accent}; }
</style>
</head>
<body>
<h1>Service Calls -- ${escapeHtml(dateLabel)}</h1>
${cardsHtml || '<p class="empty">No entries.</p>'}
</body>
</html>`);
    popup.document.close();
  }

  // The Mark As Complete button below reaches back into the OPENER window
  // via `window.opener.toggleServiceCallComplete(...)` (exposed on
  // `window` above) rather than duplicating the fetch/cache-bypass/reload
  // logic inside this separate document.write()'d window -- this window's
  // own `location` is about:blank, so a plain relative fetch() from here
  // has no reliable base URL to resolve against. Closes the day popup
  // right after, by request-adjacent simplicity: this list is a static
  // snapshot (not live-updating in place), so closing and letting the
  // calendar behind it refresh is simpler than trying to rebuild just the
  // one card in here. Only shown when NOT already complete, and always
  // "Mark As Complete" -- no "Mark Incomplete" any more, by request
  // ("the user must choose a status, not just mark as new"); undoing a
  // completed call is Change Status' own job (the main popup's, not
  // duplicated here).
  function dayPopupEntryHtml(e, colors) {
    const time = `${formatTime(e.startDateTime)}${e.endDateTime ? ` - ${formatTime(e.endDateTime)}` : ''}`;
    const allocation = e.allocated ? escapeHtml(e.resourceNames.join(', ')) : 'Unallocated';
    const ticketsHtml = e.tickets.length
      ? e.tickets
          .map(
            (t) =>
              // Same real-popup-window treatment as this page's own calendar-entry
              // ticket links above -- this ticket link lives inside the day-popup's
              // OWN separate window, but should still open the ticket as its own
              // real window rather than navigating the day-popup away from itself.
              `<dt>Ticket</dt><dd><a href="${escapeHtml(t.ticketUrl)}" target="_blank" rel="noopener noreferrer" onclick="window.open(this.href, '_blank', 'noopener,noreferrer,width=1200,height=900'); return false;">${escapeHtml(t.ticketNumber)}</a>: ${escapeHtml(t.title)} (${escapeHtml(t.status)})</dd>`
          )
          .join('')
      : '';
    return `
      <div class="card">
        <h2>${escapeHtml(time)} -- ${escapeHtml(e.companyName)}</h2>
        <dl>
          <dt>Allocated to</dt><dd style="${e.isMine ? `color: ${colors.accent}; font-weight: 600;` : ''}">${allocation}${e.isMine ? ' (you)' : ''}</dd>
          <dt>Completed</dt><dd>${e.isComplete ? 'Yes' : 'No'}
            ${e.isComplete ? '' : `<button type="button" class="mark-complete-btn" onclick="if (window.opener) { window.opener.toggleServiceCallComplete(${e.id}, true); window.close(); }">Mark As Complete</button>`}
          </dd>
          <dt>Service call status</dt><dd>${escapeHtml(e.serviceCallStatus)}
            <button type="button" class="mark-complete-btn" onclick="if (window.opener) { window.opener.setServiceCallStatus(${e.id}, 104); window.close(); }">Mark as Onsite TBA</button>
            <button type="button" class="mark-complete-btn" onclick="if (window.opener) { window.opener.setServiceCallStatus(${e.id}, 103); window.close(); }">Mark as Onsite Arranged</button>
          </dd>
          ${e.description ? `<dt>Description</dt><dd>${escapeHtml(e.description)}</dd>` : ''}
          ${ticketsHtml}
        </dl>
      </div>`;
  }

  if (lastData) {
    render(lastData);
  } else {
    load(defaultMonthKey());
  }
  // Fire-and-forget, not awaited -- primes cachedServiceCallStatusOptions
  // (see its own module-scope comment) well before anyone actually opens
  // the "Change Status" submenu, without blocking this page's own main
  // load. A no-op once already cached from an earlier mount this session.
  fetchServiceCallStatusOptions();

  function formatTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
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
