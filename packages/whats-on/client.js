export const id = "whats-on";
export const label = "What's On";

// Module-scope, not inside mount() -- the shell tears down and re-mounts a
// page's DOM on every navigation, but the imported module itself stays
// alive for the browser tab's session, so this survives across re-mounts.
// Unlike My Strety Tasks (which uses the same module-scope pattern just to
// avoid a blank flash before an always-live re-fetch), this page actually
// SKIPS re-fetching entirely when lastData is already set, by request --
// see mount() below.
let lastData = null;

// Team Shifts excerpt's own state, deliberately separate from lastData
// above -- it's a wholly separate fetch (see server.js's dedicated /shifts
// route) so paging a week forward/back never touches the Strety scorecard
// data or re-triggers its own rate-limited fetch.
let lastShiftsWeekStart = null; // "YYYY-MM-DD" Monday key, or null before the first load (server defaults to the current week)
let lastShiftsData = null;

// "Today & Tomorrow" section's own state, same wholly-separate-fetch
// reasoning as the shifts excerpt above -- its own /today-tomorrow route,
// so its own Refresh never touches the Strety scorecard fetch or the
// shifts excerpt.
let lastTodayTomorrowData = null;

// Service Calls column's own All/Just Mine/Unallocated filter, by request
// -- a pure client-side view filter over the already-fetched rows (no
// re-fetch needed, same "purely a re-layout of data already in memory"
// reasoning Workshop Board's own 2-column toggle uses), so it lives here
// as its own module-scope variable rather than round-tripping through the
// server. Module scope (not declared inside mount()) so it survives a
// remount the same way lastTodayTomorrowData above does. Resets to 'all'
// every time loadTodayTomorrow() runs (see mount() below) -- covers both
// the section's own Refresh button and the very first load of a session,
// by request ("Refresh should always return to ALL"); navigating away and
// back WITHOUT refreshing (the lastTodayTomorrowData cache-restore path)
// deliberately leaves whatever filter was last selected alone.
let serviceCallFilter = 'all';
const SERVICE_CALL_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'mine', label: 'Just Mine' },
  { value: 'unallocated', label: 'Unallocated' },
];

const FREQUENCIES = ['daily', 'weekly', 'monthly'];
const FREQUENCY_LABELS = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };

// Used by formatShortDate() (below, inside mount()) -- a fixed 3-letter
// table, not toLocaleDateString's own month: 'short' (that option's actual
// output length isn't guaranteed 3 characters across every locale/browser).
// Deliberately at true MODULE scope, not declared inside mount() itself --
// confirmed the hard way: a `const` declared inside mount() sat AFTER the
// synchronous "restore from cache on revisit" call
// (`if (lastTodayTomorrowData) renderTodayTomorrow(...)` below), which
// itself calls into formatShortDate() -- a real `ReferenceError: Cannot
// access 'MONTH_SHORT' before initialization` on every SECOND-OR-LATER
// visit to this page within the same browser session (not the first visit,
// since lastTodayTomorrowData is still null then and that early-return
// line does nothing) -- a `const`'s temporal dead zone applies to its
// whole enclosing scope, not just "before this line textually", and
// mount() re-runs top-to-bottom on every navigation back to this page,
// hitting that early call before ever reaching the `const` line again each
// time. Module scope sidesteps this entirely -- it's fully initialized
// once, before mount() is ever called the first time.
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Same bug class as MONTH_SHORT above, confirmed for real on production:
// "Cannot access 'TEAM_ICON_HTML' before initialization" on every
// second-or-later visit to this page in one browser session. These two were
// added later (for the scorecard row icons) without following that same
// module-scope fix -- they sat inside mount(), after the early
// `if (lastData) { render(lastData); }` cache-restore call, but are read by
// titleHtml() for EVERY scorecard row, so a revisit hit the same temporal
// dead zone every single time. Moved to true module scope for the same
// reason MONTH_SHORT was.
//
// A plain inline SVG (fill="currentColor", so it follows the link's own
// text colour rather than a fixed one) marking a Personal-space metric --
// Material "person" glyph. The Helpdesk (team) equivalent is a real image
// (strety-logo-icon.png, Strety's own logo, transparent background) since
// that one's a specific brand mark, not a generic glyph a font/icon-set
// path can stand in for.
const PERSON_ICON_SVG =
  '<svg class="wo-metric-icon" viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>';
const TEAM_ICON_HTML = '<img src="/strety-logo-icon.png" class="wo-metric-icon wo-metric-icon--logo" alt="" aria-hidden="true">';

// Also moved to module scope alongside PERSON_ICON_SVG/TEAM_ICON_HTML above:
// metricRowHtml() (called from the same early render(lastData) path) reads
// UPDATE_ICON_SVG whenever a row's most-recent period has no check-in yet,
// which is a common, real case -- same latent risk, same fix.
//
// Reuses Contract Checks' own pencil path (its cc-po-edit-btn icon) --
// same dashboard-wide "editable/update" convention, not a one-off design
// here.
const UPDATE_ICON_SVG =
  '<svg class="wo-update-icon" viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a.9959.9959 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>';

// The remaining constants below (the update-modal toolbar/image/text
// settings) are only ever read inside openMetricUpdateModal() and its
// nested helpers, which run solely in response to a user's click on the
// Update icon -- never reachable from the synchronous early-render path
// above, so they were never actually TDZ-vulnerable. Moved to module scope
// anyway, alongside the others, so nothing in this constant group can ever
// regress into that bug class if the code around them changes later.
//
// Rich-text toolbar for the Update editor -- same command set as the Help
// tab's own toolbar (@dashboard/shell/public/tab-page-client.js) --
// duplicated here, not imported, since this is a separate page package and
// the two editors don't otherwise share anything.
const UPDATE_MODAL_TOOLBAR_COMMANDS = [
  { label: 'B', title: 'Bold', command: 'bold', style: 'font-weight:700;' },
  { label: 'U', title: 'Underline', command: 'underline', style: 'text-decoration:underline;' },
  { label: '• List', title: 'Bulleted list', command: 'insertUnorderedList' },
  { label: '🔗 Link', title: 'Link', command: 'createLink', promptForUrl: true },
];

// Downscales/recompresses a pasted screenshot before it's inserted, by
// request -- a clipboard image (especially a full-screen capture on a
// high-DPI display) can easily run several MB as a raw PNG data: URL,
// which is unnecessary weight for what's meant to be a readable inline
// reference, not a pixel-perfect copy. Capped to MAX_IMAGE_DIMENSION on
// its longest side (only ever shrinks -- an already-small image is left
// at its own real size, never upscaled) and re-encoded as JPEG at
// IMAGE_JPEG_QUALITY, which alone is typically a much bigger size win
// than the resize for a UI screenshot (large flat colour areas).
const MAX_IMAGE_DIMENSION = 1400;
const IMAGE_JPEG_QUALITY = 0.82;

// Shrinks the context HTML down before sending, by request -- applied to a
// detached copy right before the request (in the Confirm button), never to
// the editor itself, which still shows everything at its normal readable
// size while composing.
//
// Images: forced down to a real thumbnail width. Confirmed (both against
// this codebase's own Strety write logic and an independent third-party
// API reference) that Strety's real check-in "attachment" feature (the
// thumbnail + View full size/Download links seen when a photo is added
// through Strety's OWN UI) has no documented public API at all -- an
// embedded <img> in context is the only option this integration actually
// has, and Strety just renders it as plain HTML at whatever size it's
// given.
//
// Text: wrapped in one explicit font-size, by request -- Strety renders
// context as real HTML with no size of its own asserted, so it was
// inheriting whatever base font size Strety's own check-in view uses, same
// "just renders the raw HTML" situation as the image.
const STRETY_IMAGE_DISPLAY_WIDTH = 400; // px -- 200px tried first, doubled by request
const STRETY_TEXT_FONT_SIZE = '10px'; // 12px tried first, shrunk further by request

// Fixed legend, by request -- matched against each entry's own `displayName`
// (case-insensitive), which for a regular shift is the shift's own label and
// for a time-off entry is its RESOLVED timeOffReason name (see
// @dashboard/teams-shifts/lib.js's getResolvedShifts() -- both kinds share
// this one field in the resolved row shape, so one match function covers
// both without the caller needing to know which `kind` it's looking at).
//
// Order here is the order the legend renders in. Confirmed against real
// data: "On Call" and "Helpdesk Handler" are exact real /shifts labels; the
// holiday patterns cover 7 real label variants seen across 2026's real
// shifts ("Public Holiday", "Pub Hol", "Sri Lanka - Pub Hol", "Australia
// Day", "Good Friday", "Easter Monday", "Labour Day" -- Graph's own `theme`
// field was NOT consistent across these, so matching is on the label text,
// never the theme). Vacation/Unpaid/Sick-Other-Leave/RDO-Time-in-Lieu are
// real timeOffReason names, NOT shift labels -- confirmed against real data
// this account has 11 real reasons configured, several spelling their own
// intended legend color directly in the name (e.g. "Vacation (green)",
// "Sick/Other Leave (purple)", "RDO / Time in Lieu (grey)"), a strong
// confirmation this category list matches real intent, not a guessed
// taxonomy. This was found (and fixed) after a real report that a real
// booked Vacation wasn't showing -- root cause was /shifts and /timesOff
// being two entirely separate Graph resources, and this page originally
// only ever queried /shifts; not a matching-logic bug at all.
const SHIFT_CATEGORIES = [
  { key: 'onCall', label: 'On Call', color: '#eab308', match: (dn) => /^on\s*call/i.test(dn) },
  { key: 'helpdesk', label: 'Helpdesk Handler', color: '#3b82f6', match: (dn) => /helpdesk\s*handler/i.test(dn) },
  { key: 'vacation', label: 'Vacation', color: '#22c55e', match: (dn) => /vacation/i.test(dn) },
  // "leave" is NOT required in the match -- confirmed against real data the
  // actual timeOffReason is spelled literally "Unpaid" (see
  // @dashboard/teams-shifts/lib.js's fetchTimeOffReasonNames() -- these
  // reason names are the real source of Vacation/Unpaid/Sick-Other/RDO-TIL
  // categories, not a shift's own displayName; matching stays on
  // displayName either way since both shifts and time-off entries share
  // that field name in the resolved row shape).
  { key: 'unpaidLeave', label: 'Unpaid leave', color: '#dc2626', match: (dn) => /unpaid/i.test(dn) },
  { key: 'sickOther', label: 'Sick/Other Leave', color: '#8b5cf6', match: (dn) => /\bsick\b|other\s*leave/i.test(dn) },
  { key: 'rdoTil', label: 'RDO/Time in Lieu', color: '#9ca3af', match: (dn) => /\brdo\b|time\s*in\s*lieu/i.test(dn) },
  {
    key: 'publicHoliday',
    label: 'Public Holiday',
    color: '#ffffff',
    match: (dn) => /pub(lic)?\s*hol|australia\s*day|good\s*friday|easter\s*monday|labour\s*day|christmas|boxing\s*day|anzac\s*day|new\s*year/i.test(dn),
  },
];

function categorizeShift(entry) {
  const dn = (entry.displayName || '').trim();
  if (!dn) return null;
  return SHIFT_CATEGORIES.find((cat) => cat.match(dn)) || null;
}

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>What's On</h1>
    </header>
    <p id="status" class="status">Helpdesk Task Tracker's scorecards, followed by your own personal scorecards -- up to the last 8 real check-in periods, most recent first. Hover a value for its check-in note.</p>
    <div id="summary" class="section-heading section-heading--nav section-heading-row" hidden>
      <span id="summary-text"></span>
      <div class="date-form">
        <button type="button" id="refresh-button">Refresh Scorecards</button>
      </div>
    </div>
    <div id="results" class="results"></div>

    <div class="tt-section">
      <div class="section-heading section-heading--nav section-heading-row">
        <span>Today &amp; Tomorrow</span>
        <div class="date-form">
          <button type="button" id="tt-refresh-button">Refresh</button>
        </div>
      </div>
      <p id="tt-status" class="status">Loading...</p>
      <div id="tt-columns" class="tt-columns"></div>
    </div>

    <div class="wo-shifts-section">
      <div class="section-heading section-heading--nav section-heading-row">
        <span>Team Shifts -- General</span>
        <div class="date-form calendar-nav">
          <button type="button" id="shifts-prev-button" aria-label="Previous week">&lsaquo;</button>
          <span id="shifts-week-label" class="calendar-month-label"></span>
          <button type="button" id="shifts-next-button" aria-label="Next week">&rsaquo;</button>
          <button type="button" id="shifts-today-button">This Week</button>
          <button type="button" id="shifts-refresh-button">Refresh</button>
        </div>
      </div>
      <p id="shifts-status" class="status">Loading...</p>
      <div id="shifts-calendar" class="results"></div>
      <div id="shifts-legend" class="shifts-legend"></div>
    </div>
  `;

  const refreshButton = container.querySelector('#refresh-button');
  const statusEl = container.querySelector('#status');
  const summaryEl = container.querySelector('#summary');
  const summaryTextEl = container.querySelector('#summary-text');
  const resultsEl = container.querySelector('#results');

  const ttRefreshButton = container.querySelector('#tt-refresh-button');
  const ttStatusEl = container.querySelector('#tt-status');
  const ttColumnsEl = container.querySelector('#tt-columns');

  const shiftsPrevButton = container.querySelector('#shifts-prev-button');
  const shiftsNextButton = container.querySelector('#shifts-next-button');
  const shiftsTodayButton = container.querySelector('#shifts-today-button');
  const shiftsRefreshButton = container.querySelector('#shifts-refresh-button');
  const shiftsWeekLabelEl = container.querySelector('#shifts-week-label');
  const shiftsStatusEl = container.querySelector('#shifts-status');
  const shiftsCalendarEl = container.querySelector('#shifts-calendar');
  const shiftsLegendEl = container.querySelector('#shifts-legend');

  refreshButton.addEventListener('click', load);

  // Delegated once on the stable #results container, not re-wired per
  // render -- scorecardTable() rebuilds this element's content on every
  // load, same "listener on the ancestor keeps working regardless"
  // convention #tt-columns' own delegated listener below already uses.
  resultsEl.addEventListener('click', (e) => {
    const updateCell = e.target.closest('.wo-update-cell');
    if (!updateCell) return;
    openMetricUpdateModal(updateCell.dataset.metricId, updateCell.dataset.metricTitle || 'Metric', updateCell.dataset.scorecardType || '', updateCell.dataset.frequency || '');
  });

  // Set by shell/server.js's Strety personal-connect callback page's own
  // "Return to Dashboard" link (?strety_connected=1) right after a real
  // (re)connect succeeds -- Today & Tomorrow's own response is cached
  // server-side for 10 minutes per email, so a plain force:false bootstrap
  // here would otherwise still serve the STALE personalNotConnected result
  // fetched before this connect happened, even on a genuinely fresh page
  // load. Removed from the URL immediately via replaceState so it doesn't
  // linger and force a bypass on every later plain reload too.
  const urlParams = new URLSearchParams(window.location.search);
  const justConnectedStrety = urlParams.has('strety_connected');
  if (justConnectedStrety) {
    urlParams.delete('strety_connected');
    const newSearch = urlParams.toString();
    history.replaceState(null, '', `${window.location.pathname}${newSearch ? `?${newSearch}` : ''}${window.location.hash}`);
  }

  ttRefreshButton.addEventListener('click', () => loadTodayTomorrow(true));
  // Delegated once on the stable #tt-columns container, not re-wired per
  // render -- renderTodayTomorrow() below replaces its innerHTML on every
  // load, but a listener on the ancestor itself keeps working regardless
  // (event delegation), same convention as elsewhere on this dashboard
  // where content re-renders more often than its container does.
  ttColumnsEl.addEventListener('click', (e) => {
    // The Service Calls filter buttons (All/Just Mine/Unallocated), by
    // request -- checked first, before the [data-sc-id] row-click handling
    // below, since a filter button also lives inside the same delegated
    // container. Purely a re-render from already-fetched data (no
    // re-fetch) -- see serviceCallFilter's own comment at the top of this
    // file.
    const filterBtn = e.target.closest('[data-sc-filter]');
    if (filterBtn) {
      serviceCallFilter = filterBtn.dataset.scFilter;
      if (lastTodayTomorrowData) renderTodayTomorrow(lastTodayTomorrowData);
      return;
    }
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
  if (lastTodayTomorrowData) renderTodayTomorrow(lastTodayTomorrowData);
  else loadTodayTomorrow(justConnectedStrety);

  async function loadTodayTomorrow(force) {
    // "Refresh should always return to ALL", by request -- see
    // serviceCallFilter's own comment at the top of this file.
    serviceCallFilter = 'all';
    ttRefreshButton.disabled = true;
    ttStatusEl.hidden = false;
    ttStatusEl.className = 'status';
    ttStatusEl.textContent = 'Loading...';
    ttColumnsEl.innerHTML = '';

    try {
      const res = await fetch(`/api/whats-on/today-tomorrow${force ? '?force=true' : ''}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastTodayTomorrowData = data;
      renderTodayTomorrow(data);
    } catch (err) {
      ttStatusEl.hidden = false;
      ttStatusEl.className = 'status error';
      ttStatusEl.textContent = `Error: ${err.message}`;
    } finally {
      ttRefreshButton.disabled = false;
    }
  }

  function renderTodayTomorrow(data) {
    if (data.status === 'no-session-email') {
      ttStatusEl.hidden = false;
      ttStatusEl.className = 'status error';
      ttStatusEl.textContent = 'Could not determine your signed-in email.';
      ttColumnsEl.innerHTML = '';
      return;
    }

    ttStatusEl.hidden = true;
    ttColumnsEl.innerHTML = '';

    // All/Just Mine/Unallocated, by request -- a pure client-side filter
    // over the already-fetched rows (see serviceCallFilter's own comment
    // at the top of this file). scColumn keeps its original `rows` (the
    // unfiltered full list, needed below for the "(showing/all)" count and
    // to tell "genuinely nothing today/tomorrow" apart from "filter hid
    // everything"); scVisibleRows is what actually renders.
    const scColumn = data.serviceCalls;
    const scVisibleRows =
      scColumn.ok && serviceCallFilter !== 'all'
        ? scColumn.rows.filter((r) => (serviceCallFilter === 'mine' ? r.isMine : !r.allocated))
        : scColumn.rows;
    // Distinguishes "no calls today/tomorrow at all" (ttColumn()'s own
    // default empty message already covers that) from "there ARE calls,
    // the current filter just hides all of them" -- the generic message
    // would otherwise misleadingly imply nothing's scheduled at all.
    const scEmptyMessage =
      scColumn.ok && scColumn.rows.length > 0 && scVisibleRows.length === 0
        ? `No service calls match "${SERVICE_CALL_FILTERS.find((f) => f.value === serviceCallFilter)?.label}".`
        : null;

    ttColumnsEl.appendChild(
      ttColumn(
        'Service Calls',
        scColumn.ok ? { ...scColumn, rows: scVisibleRows } : scColumn,
        (row) => serviceCallRowHtml(row, data.today, data.tomorrow),
        scEmptyMessage,
        null,
        { href: '#service-calls', label: 'Show All Service Calls' },
        { totalCount: scColumn.ok ? scColumn.rows.length : undefined, headingExtraHtml: scColumn.ok ? serviceCallFilterButtonsHtml() : '' }
      )
    );
    ttColumnsEl.appendChild(
      ttColumn(
        'Subscriptions Expiring',
        data.subscriptionsExpiring,
        (row) => subscriptionRowHtml(row, data.today, data.tomorrow),
        null,
        null,
        { href: '#subscriptions-expiring', label: 'Show All Expiring Subscriptions' }
      )
    );
    // My Strety Tasks' own connection states -- distinct from the shared
    // Strety connection's page-level banner elsewhere on this page (this
    // column depends on the SIGNED-IN USER'S OWN personal connection, see
    // @dashboard/strety-client's getPersonalClient(); the shared one can be
    // perfectly healthy while this signed-in user just hasn't connected
    // their own yet). Checked before the generic personFound-false message
    // below, since "not connected at all" and "connected, but no matching
    // person" are different situations worth telling apart.
    let stretyOverrideHtml = null;
    if (data.stretyTasks.personalNotConnected) {
      stretyOverrideHtml = `Your Strety account isn't connected yet. <a class="button-link" href="/auth/strety-personal/connect">Connect Strety</a>`;
    } else if (data.stretyTasks.personalReauthRequired) {
      const who = data.stretyTasks.personalConnectedAs ? ` (currently connected as ${escapeHtml(data.stretyTasks.personalConnectedAs)})` : '';
      stretyOverrideHtml = `Your Strety connection${who} has stopped working and needs to be reconnected. <a class="button-link" href="/auth/strety-personal/connect">Reconnect Strety</a>`;
    }
    ttColumnsEl.appendChild(
      ttColumn(
        'My Strety Tasks',
        data.stretyTasks,
        (row) => stretyTaskRowHtml(row, data.today, data.tomorrow),
        data.stretyTasks.personFound === false ? `No Strety account found for you.` : null,
        stretyOverrideHtml,
        { href: '#my-strety-tasks', label: 'Show All of My Strety Tasks' }
      )
    );
  }

  // One column's card -- shared shell for all three (heading, then either
  // an error, a "nothing" notice, or the real rows) so the three sources'
  // very different real failure/empty states all read consistently rather
  // than each column inventing its own look. `overrideEmptyHtml`, when
  // given, takes priority over the escaped-text `overrideEmptyMessage` --
  // only ever passed a trusted, hardcoded connect/reconnect link, never
  // anything from the API response itself. `footerLink` ({ href, label }),
  // when given, adds a "Show All <X>" link to that column's own full page
  // below the list -- shown regardless of the column's state (error/empty/
  // populated), since jumping to the full page is useful in every case,
  // not just when there's today/tomorrow data to show. `extra` ({
  // totalCount, headingExtraHtml }), when given (Service Calls only, by
  // request), adds real (unescaped -- a trusted, hardcoded button row, same
  // caveat as overrideEmptyHtml above) markup next to the heading, and
  // switches the count to "(showing/total)" whenever totalCount differs
  // from this column's own (possibly filtered) row count.
  function ttColumn(title, column, rowHtmlFn, overrideEmptyMessage, overrideEmptyHtml, footerLink, extra = {}) {
    const { totalCount, headingExtraHtml } = extra;
    const div = document.createElement('div');
    div.className = 'resource-group tt-column';
    let body;
    if (!column.ok) {
      body = `<p class="status error">${escapeHtml(column.error)}</p>`;
    } else if (overrideEmptyHtml) {
      body = `<p class="status error">${overrideEmptyHtml}</p>`;
    } else if (overrideEmptyMessage) {
      body = `<p class="status">${escapeHtml(overrideEmptyMessage)}</p>`;
    } else if (column.rows.length === 0) {
      body = `<p class="status">Nothing today or tomorrow.</p>`;
    } else {
      body = `<ul class="tt-list">${column.rows.map(rowHtmlFn).join('')}</ul>`;
    }
    // Count in brackets next to the heading -- only when the column loaded
    // successfully (an error state has no real row count to show).
    // "(showing/total)" instead of a plain count whenever a filter
    // (Service Calls' own All/Just Mine/Unallocated) is actually hiding
    // some rows -- totalCount === column.rows.length (the "All" case, or
    // any column that never passes totalCount at all) falls through to
    // the plain count exactly as before.
    const countText = column.ok ? (totalCount !== undefined && totalCount !== column.rows.length ? `(${column.rows.length}/${totalCount})` : `(${column.rows.length})`) : '';
    const heading = column.ok ? `${title} ${countText}` : title;
    const footer = footerLink
      ? `<div class="tt-column-footer"><a class="button-link button-link--small" href="${escapeHtml(footerLink.href)}">${escapeHtml(footerLink.label)}</a></div>`
      : '';
    // body wrapped in its own flex-grow div (.tt-column-body), by request --
    // the three columns already stretch to match the tallest one (grid's
    // own default align-items: stretch), but without this the footer just
    // sat right after each column's own (varying-length) content, landing
    // at a different height in every column. Growing this wrapper instead
    // pushes the footer down to the same fixed spot at the bottom of every
    // column, regardless of how much content is above it.
    div.innerHTML = `<div class="section-heading tt-column-heading"><span>${escapeHtml(heading)}</span>${headingExtraHtml || ''}</div><div class="tt-column-body">${body}</div>${footer}`;
    return div;
  }

  // The Service Calls column's own All/Just Mine/Unallocated buttons, by
  // request -- the currently-showing one highlighted green
  // (.tt-filter-btn--active). Delegated click handling lives on
  // #tt-columns itself (see mount()'s own listener above), not wired here
  // per-render -- these buttons get torn down and rebuilt on every
  // renderTodayTomorrow() call same as everything else in this column.
  function serviceCallFilterButtonsHtml() {
    return `<span class="tt-filter-buttons">${SERVICE_CALL_FILTERS.map(
      (f) =>
        `<button type="button" class="button-link button-link--small tt-filter-btn${f.value === serviceCallFilter ? ' tt-filter-btn--active' : ''}" data-sc-filter="${f.value}">${escapeHtml(f.label)}</button>`
    ).join('')}</span>`;
  }

  // "Today"/"Tomorrow"/"Overdue" tag shared by all three row renderers --
  // green for today (most immediate), amber for tomorrow, same status-color
  // convention (not a new one) used elsewhere on this dashboard. Anything
  // that's neither today nor tomorrow (Strety's own overdue to-dos, and
  // Service Calls' past-scheduled-and-still-incomplete rows) is the overdue
  // case -- shown red with just its actual date (no "Overdue" text label,
  // by request -- the red already says that on its own). `href`, when given,
  // renders the tag itself as a link (service call -> its ticket) instead of
  // a plain span -- opened as a real popup window, same explicit
  // window.open(..., 'width=1200,height=900') convention every other ticket
  // link on this dashboard uses (see e.g. service-calls/client.js), not just
  // target="_blank" (which only opens a new tab). `tooltip`, when given, is
  // a plain native title="" tooltip -- by request, Service Calls' own tags
  // show their linked ticket's number/title on hover this way (the other
  // two columns don't pass one -- neither subscriptions nor Strety tasks
  // have a "ticket" for this to mean anything).
  function ttDayTag(dateKey, today, tomorrow, href, tooltip) {
    let cls;
    let label;
    if (dateKey === today) {
      cls = 'tt-tag--today';
      label = 'Today';
    } else if (dateKey === tomorrow) {
      cls = 'tt-tag--tomorrow';
      label = 'Tomorrow';
    } else {
      cls = 'tt-tag--overdue';
      // By request: just the date, no "Overdue" prefix -- the red
      // .tt-tag--overdue color already says that on its own.
      label = formatShortDate(dateKey);
    }
    const titleAttr = tooltip ? ` title="${escapeHtml(tooltip)}"` : '';
    if (href) {
      // href/target/rel stay real (not just decorative) -- by request, a
      // plain left-click anywhere on the Service Calls ROW (not just this
      // tag -- see the <li data-sc-id> wrapper in serviceCallRowHtml()
      // below) is intercepted client-side to open the Open ticket/Mark
      // Complete popup instead (wireServiceCallMenu(), delegated on
      // #tt-columns). A middle-click or right-click -> "open in new tab"
      // on the tag itself never fires that JS at all, so those still go
      // straight to the ticket natively.
      return `<a class="tt-tag ${cls}"${titleAttr} href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    }
    return `<span class="tt-tag ${cls}"${titleAttr}>${label}</span>`;
  }

  // MONTH_SHORT itself lives at module scope (top of file) -- see its own
  // comment there for why (a real TDZ crash on page revisit, confirmed the
  // hard way, when it was declared here instead).
  function formatShortDate(dateKey) {
    if (!dateKey) return '';
    const d = new Date(`${dateKey}T00:00:00`);
    return `${d.getDate()} ${MONTH_SHORT[d.getMonth()]}`;
  }

  function serviceCallRowHtml(row, today, tomorrow) {
    const allocation = row.allocated
      ? `<span class="text-highlight-green">${escapeHtml(row.resourceNames.join(', '))}</span>`
      : '<span class="text-highlight-red">Unallocated</span>';
    // Ticket number/title/status on hover, by request -- the Ticket Status
    // line is only included alongside the ticket number/title (null when
    // there's no linked ticket at all, same case ticketUrl is also null
    // for); Service call status is always shown underneath, regardless of
    // whether a ticket is linked, since every service call has its own
    // status either way. Same multi-line native title="" tooltip
    // convention Service Calls' own client.js uses for this identical info
    // (see entryHtml() there).
    const tooltipLines = [];
    if (row.ticketNumber) {
      tooltipLines.push(`${row.ticketNumber}: ${row.ticketTitle || ''}`.trim());
      tooltipLines.push(`Ticket Status: ${row.ticketStatus}`);
    }
    tooltipLines.push(`Service call status: ${row.serviceCallStatus}`);
    const tooltip = tooltipLines.join('\n');
    // The WHOLE row is the click target for the Open ticket/Mark Complete
    // popup, by request -- not just the day tag, since a call with no
    // linked ticket at all still needs to be clickable for Mark Complete
    // (see the delegated click listener on ttColumnsEl above).
    return `
      <li class="tt-service-call-row" data-sc-id="${row.id}" data-sc-complete="${row.isComplete ? 'true' : 'false'}" data-sc-ticket-url="${escapeHtml(row.ticketUrl || '')}" data-sc-start="${escapeHtml(row.startDateTime || '')}" data-sc-end="${escapeHtml(row.endDateTime || '')}">
        ${ttDayTag(row.dayKey, today, tomorrow, row.ticketUrl, tooltip)}
        <span class="tt-time">${formatTime(row.startDateTime)}</span>
        <strong>${escapeHtml(row.companyName)}</strong>
        <span class="cell-subtext">${allocation}${row.description ? ` -- ${escapeHtml(row.description)}` : ''}</span>
      </li>`;
  }

  // ---- Open ticket / Mark Complete popup -- by request, replaces the old
  // "click a Service Calls row -> straight to the ticket" behaviour. Same
  // shared .entry-popup-menu-* classes Service Calls' own client.js uses
  // for the identical component. Only one open at a time. ----
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
  function openServiceCallMenu(anchorEl, entry) {
    closeServiceCallMenu();
    const menu = document.createElement('div');
    menu.className = 'entry-popup-menu';
    menu.innerHTML = `
      ${entry.ticketUrl ? `<button type="button" class="entry-popup-menu-item" data-action="open-ticket">Open ticket</button>` : ''}
      <button type="button" class="entry-popup-menu-item" data-action="change-datetime">Change Date/Time</button>
      <button type="button" class="entry-popup-menu-item" data-action="toggle-complete">${entry.isComplete ? 'Mark Incomplete' : 'Mark Complete'}</button>
      <button type="button" class="entry-popup-menu-item" data-action="onsite-tba">Mark as Onsite TBA</button>
      <button type="button" class="entry-popup-menu-item" data-action="onsite-arranged">Mark as Onsite Arranged</button>
    `;
    document.body.appendChild(menu);
    const rect = anchorEl.getBoundingClientRect();
    menu.style.top = `${rect.bottom + window.scrollY + 4}px`;
    menu.style.left = `${rect.left + window.scrollX}px`;
    const menuRect = menu.getBoundingClientRect();
    if (menuRect.right > window.innerWidth) {
      menu.style.left = `${Math.max(4, window.innerWidth - menuRect.width - 4)}px`;
    }
    openEntryMenuEl = menu;
    if (entry.ticketUrl) {
      menu.querySelector('[data-action="open-ticket"]').addEventListener('click', () => {
        window.open(entry.ticketUrl, '_blank', 'noopener,noreferrer,width=1200,height=900');
        closeServiceCallMenu();
      });
    }
    menu.querySelector('[data-action="change-datetime"]').addEventListener('click', () => openChangeDateTimeModal(entry));
    menu.querySelector('[data-action="toggle-complete"]').addEventListener('click', () => toggleServiceCallComplete(entry.id, !entry.isComplete));
    // 104/103 -- Autotask's own real ServiceCalls.status values for these
    // two, confirmed against the live picklist -- see Service Calls' own
    // README/server.js comment for why NOT to trust
    // autotask_get_field_info's own (stale/cached) picklist for this field.
    menu.querySelector('[data-action="onsite-tba"]').addEventListener('click', () => setServiceCallStatus(entry.id, 104));
    menu.querySelector('[data-action="onsite-arranged"]').addEventListener('click', () => setServiceCallStatus(entry.id, 103));
    // Deferred, not added synchronously -- otherwise the very click that
    // opened this menu would immediately bubble up to document and close
    // it again in the same tick.
    setTimeout(() => document.addEventListener('click', onServiceCallMenuOutsideClick, true), 0);
    document.addEventListener('keydown', onServiceCallMenuKeydown);
  }

  // Calls the SAME /api/service-calls/:id/complete route Service Calls'
  // own page uses -- a cross-page call, not a duplicated write, since
  // that's the one place ServiceCalls.isComplete actually gets patched in
  // Autotask. Forces a fresh fetch afterward (bypassing the 10-min
  // Today & Tomorrow cache) so the change is visible immediately, same
  // reasoning the Refresh button's own force=true already uses.
  async function toggleServiceCallComplete(id, nextIsComplete) {
    closeServiceCallMenu();
    try {
      await fetchJson(`/api/service-calls/${id}/complete`, 'PATCH', { isComplete: nextIsComplete });
      await loadTodayTomorrow(true);
    } catch (err) {
      alert(`Error: ${err.message}`);
    }
  }

  // Same shape as toggleServiceCallComplete() above, calling Service
  // Calls' own PATCH .../:id/status route instead.
  async function setServiceCallStatus(id, status) {
    closeServiceCallMenu();
    try {
      await fetchJson(`/api/service-calls/${id}/status`, 'PATCH', { status });
      await loadTodayTomorrow(true);
    } catch (err) {
      alert(`Error: ${err.message}`);
    }
  }

  // ---- Change Date/Time modal -- opened from the popup menu above, by
  // request. Same .history-modal-* overlay/panel shell (and the same
  // .wsp-field/.wsp-form-actions field/button styling) Contract Checks' own
  // small single-purpose edit modals use -- not shared code, just the same
  // established shape, and a near-duplicate of Service Calls' own copy of
  // this same modal (that page's own client.js), since these are separate
  // page packages. Calls the SAME /api/service-calls/:id/datetime route
  // that page's own copy does -- a cross-page call, not a duplicated write.
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
        await loadTodayTomorrow(true);
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
  // the displayed time). Same helper packages-received/client.js and
  // Service Calls' own client.js already use, duplicated here since these
  // are separate page packages.
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

  function subscriptionRowHtml(row, today, tomorrow) {
    const renew = row.autoRenews
      ? '<span class="text-highlight-green">auto-renews</span>'
      : '<span class="text-highlight-red">NOT renewing</span>';
    return `
      <li>
        ${ttDayTag(row.expirationDate, today, tomorrow)}
        <strong>${escapeHtml(row.clientName)}</strong>
        <span class="cell-subtext">${escapeHtml(row.name)} -- ${renew}</span>
      </li>`;
  }

  // Opens the to-do directly in Strety's own web app, by request -- on the
  // day tag itself (Today/Tomorrow/date), NOT the title text (tried that
  // first, looked bad by request -- reverted). Same href-on-ttDayTag
  // convention Service Calls' own rows already use for their ticket link.
  // row.todoUrl is null when getTodoUrl() (server.js/
  // @dashboard/strety-client) has nothing to build from -- ttDayTag()
  // renders a plain non-link tag in that case, same as any other row with
  // no href.
  function stretyTaskRowHtml(row, today, tomorrow) {
    return `
      <li>
        ${ttDayTag(row.dueDate, today, tomorrow, row.todoUrl)}
        <span class="tt-strety-title">${escapeHtml(row.title)}</span>
      </li>`;
  }

  renderShiftsLegend();

  function addDaysKey(dateKey, delta) {
    const [y, m, d] = dateKey.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
  }

  // The Monday of the ISO week containing dateKey -- used to find "this
  // week"'s own real Monday from data.todayKey, then compare each rendered
  // week-row's own first day against it (see renderShifts()'s "This Week"/
  // "Last Week" label). getUTCDay() is Sun=0..Sat=6; days-since-Monday is
  // (day + 6) % 7 (Monday itself -> 0) -- same math as server.js's own
  // weeklyLabelForDate().
  function mondayOfKey(dateKey) {
    const [y, m, d] = dateKey.split('-').map(Number);
    const daysSinceMonday = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
    return addDaysKey(dateKey, -daysSinceMonday);
  }

  shiftsPrevButton.addEventListener('click', () => loadShifts(addDaysKey(lastShiftsWeekStart, -7)));
  shiftsNextButton.addEventListener('click', () => loadShifts(addDaysKey(lastShiftsWeekStart, 7)));
  shiftsTodayButton.addEventListener('click', () => loadShifts(null)); // null -- let the server default to the current AEST week, same as the very first load
  shiftsRefreshButton.addEventListener('click', () => loadShifts(lastShiftsWeekStart, true));

  if (lastShiftsData) renderShifts(lastShiftsData);
  else loadShifts(null);

  async function loadShifts(weekKey, force) {
    shiftsPrevButton.disabled = true;
    shiftsNextButton.disabled = true;
    shiftsTodayButton.disabled = true;
    shiftsRefreshButton.disabled = true;
    shiftsStatusEl.hidden = false;
    shiftsStatusEl.className = 'status';
    shiftsStatusEl.textContent = 'Loading...';
    shiftsCalendarEl.innerHTML = '';

    try {
      const params = new URLSearchParams();
      if (weekKey) params.set('week', weekKey);
      if (force) params.set('force', 'true');
      const qs = params.toString();
      const res = await fetch(`/api/whats-on/shifts${qs ? `?${qs}` : ''}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastShiftsWeekStart = data.weekStart;
      lastShiftsData = data;
      renderShifts(data);
    } catch (err) {
      shiftsStatusEl.hidden = false;
      shiftsStatusEl.className = 'status error';
      shiftsStatusEl.textContent = `Error: ${err.message}`;
    } finally {
      shiftsPrevButton.disabled = false;
      shiftsNextButton.disabled = false;
      shiftsTodayButton.disabled = false;
      shiftsRefreshButton.disabled = false;
    }
  }

  function renderShifts(data) {
    shiftsWeekLabelEl.textContent = shiftsRangeLabel(data.days[0], data.days[data.days.length - 1]);

    if (data.notFound) {
      shiftsStatusEl.hidden = false;
      shiftsStatusEl.className = 'status error';
      shiftsStatusEl.textContent = `"${data.teamName}" wasn't found in Teams -- it may have been renamed or removed.`;
      shiftsCalendarEl.innerHTML = '';
      return;
    }

    shiftsStatusEl.hidden = true;
    shiftsCalendarEl.innerHTML = '';

    // Real current/previous/next AEST week's own Monday -- NOT necessarily
    // either of the two rows below, which are whatever window the prev/
    // next arrows have navigated to. Compared against each row's own first
    // day (its Monday) so the sideways "This Week"/"Last Week"/"Next Week"
    // label below only ever shows on the row it's actually true for, and
    // is blank (vanishes) the moment navigation moves a row away from
    // being any of the three -- computed fresh every render, not cached,
    // since "this week" changes out from under a long-open tab as real
    // time passes.
    const thisWeekMonday = mondayOfKey(data.todayKey);
    const lastWeekMonday = addDaysKey(thisWeekMonday, -7);
    const nextWeekMonday = addDaysKey(thisWeekMonday, 7);

    const table = document.createElement('table');
    table.className = 'calendar-table';
    const tbody = document.createElement('tbody');
    for (let i = 0; i < data.days.length; i += 7) {
      const week = data.days.slice(i, i + 7);
      const tr = document.createElement('tr');
      // Thin sideways label column, by request -- one per week-row, not
      // per page, since only ONE of the two rows can ever actually BE
      // "This Week" (or "Last"/"Next Week") at a time. The rotated text
      // lives on an INNER <span>, not the <td> itself -- transform/
      // writing-mode applied directly to a table cell doesn't interact
      // cleanly with table layout in real browsers (confirmed: the text
      // visually escaped onto the border between cells rather than
      // staying inside its own cell). The <td> stays a plain, normally-
      // laid-out cell and just centers the inner span (see
      // .shifts-week-label-cell's flex centering in styles.css).
      const weekLabelTd = document.createElement('td');
      weekLabelTd.className = 'shifts-week-label-cell';
      let weekLabel = '';
      if (week[0] === thisWeekMonday) weekLabel = 'This Week';
      else if (week[0] === lastWeekMonday) weekLabel = 'Last Week';
      else if (week[0] === nextWeekMonday) weekLabel = 'Next Week';
      if (weekLabel) weekLabelTd.innerHTML = `<span class="shifts-week-label-text">${weekLabel}</span>`;
      tr.appendChild(weekLabelTd);
      for (const dayKey of week) {
        const isToday = dayKey === data.todayKey;
        const td = document.createElement('td');
        td.className = 'calendar-cell' + (isToday ? ' calendar-cell--today' : '');
        const entries = data.byDay[dayKey] || [];
        // Day+month, not a bare day number -- unlike a single-month
        // calendar, this 14-day window routinely spans two different
        // months (sometimes two different years), so the month has to be
        // shown on every cell, not just implied by a shared header.
        const dayLabel = shiftsDayNumLabel(dayKey);
        td.innerHTML = `
          <span class="calendar-cell-daynum" style="cursor: default;">${dayLabel}</span>
          <div class="calendar-cell-entries">${entries.map((e) => shiftEntryHtml(e)).join('')}</div>
        `;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    shiftsCalendarEl.appendChild(table);
  }

  function shiftEntryHtml(e) {
    const cat = categorizeShift(e);
    const line1 = `${formatTime(e.startDateTime)}-${formatTime(e.endDateTime)}`;
    const line2 = e.userName || '(Open shift)';
    // Type -- the matched legend category's own clean label when there is
    // one (e.g. "Vacation", not the raw underlying reason text "Vacation
    // (green)"), otherwise the raw displayName so an uncategorized entry
    // still shows something rather than nothing. By request -- previously
    // this was tooltip-only ("Type: ..."); now shown directly on the entry
    // itself, one line taller.
    const line3 = cat ? cat.label : e.displayName || '(unlabeled)';
    // .calendar-entry-line2's shared CSS rule reads color: var(--muted) --
    // fine normally, but once a matched-category entry's own background is
    // pinned to its light-mode look (below), that class rule would still
    // follow the page's real theme and go light-gray-on-pastel in dark
    // mode. Pinned inline here too, same literal light --muted value, only
    // when there's a real category to color -- an unmatched-label entry
    // isn't one of these colored entries and keeps following the class
    // rule (and the page's real theme) normally.
    const line2Style = cat ? ' style="color: #6b7280;"' : '';
    const inner = `<span class="calendar-entry-line1">${escapeHtml(line1)}</span><span class="calendar-entry-line2"${line2Style}>${escapeHtml(line2)}</span><span class="calendar-entry-line2"${line2Style}>${escapeHtml(line3)}</span>`;
    const titleLines = [
      `${formatDateTime(e.startDateTime)} - ${formatDateTime(e.endDateTime)}`,
      `Assigned: ${e.userName || 'Open shift (unassigned)'}`,
      `Type: ${e.displayName || '(unlabeled)'}${cat ? ` -- ${cat.label}` : ''}`,
    ];
    if (e.notes) titleLines.push(`Notes: ${e.notes}`);
    if (!e.published) titleLines.push('Not yet published (draft)');
    const title = escapeHtml(titleLines.join('\n'));

    // Public Holiday's box is white -- a translucent color-mix tint (the
    // convention every other category uses) would be indistinguishable
    // from an empty cell on a light background, so it gets a solid fill
    // plus a visible border instead, same special-case as the legend swatch
    // below.
    //
    // Every matched-category entry is pinned to its light-mode look always,
    // by request -- narrower than the whole section (cell backgrounds, the
    // legend, headers all still follow the page's real theme normally).
    // Mixing toward opaque `white` here (not `transparent`, the previous
    // value) is what actually makes this theme-independent: `transparent`
    // composites against whatever's really painted behind the entry (the
    // cell's own background, which follows the page theme), so the same
    // tint looked muddy/dark once the cell itself went dark; mixing toward
    // a fixed white keeps the pastel tint identical regardless of the
    // cell's real color. `color`/`border` are likewise literals here, not
    // `var(--fg)`/`var(--border)`, for the same reason -- an unmatched
    // label (no cat at all) is the one case NOT touched, since it isn't
    // one of these colored entries and should just read like normal page
    // text.
    const style = !cat
      ? '' // unmatched label (e.g. real data's "Working ", or an unlabeled shift) -- plain default look, not falsely colored
      : cat.key === 'publicHoliday'
        ? `background: #ffffff; color: #1a1a1a; border: 1px solid #e5e7eb; border-left: 4.5px solid #9ca3af;`
        : `background: color-mix(in srgb, ${cat.color} 22%, white); color: #1a1a1a; border-left-color: ${cat.color};`;
    return `<div class="calendar-entry calendar-entry--allocated" style="${style}" title="${title}">${inner}</div>`;
  }

  function renderShiftsLegend() {
    shiftsLegendEl.innerHTML = SHIFT_CATEGORIES.map((cat) => {
      const swatchStyle =
        cat.key === 'publicHoliday'
          ? `background: #ffffff; border: 1px solid var(--border);`
          : `background: ${cat.color}; border: 1px solid color-mix(in srgb, ${cat.color} 60%, black);`;
      return `<span class="shifts-legend-item"><span class="shifts-legend-swatch" style="${swatchStyle}"></span>${escapeHtml(cat.label)}</span>`;
    }).join('');
  }

  function shiftsDayNumLabel(dayKey) {
    const [, m, d] = dayKey.split('-').map(Number);
    const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${d} ${MONTH_ABBR[m - 1]}`;
  }

  function shiftsRangeLabel(startKey, endKey) {
    const [sy] = startKey.split('-').map(Number);
    const [ey] = endKey.split('-').map(Number);
    const start = shiftsDayNumLabel(startKey);
    const end = shiftsDayNumLabel(endKey);
    // Only shows a year at all when the window's end year differs from the
    // browser's current year -- keeps the common case ("17 Aug - 30 Aug")
    // short, without hiding the year in the rarer case a window straddles a
    // real year boundary (sy !== ey) or is being viewed well into another year.
    const showYear = sy !== ey || sy !== new Date().getFullYear();
    return showYear ? `${start} ${sy} - ${end} ${ey}` : `${start} - ${end}`;
  }

  // Auto-loads on mount only when there's nothing to show yet -- by
  // request. Unlike My Strety Tasks/SaaS Alerts Customers (which re-fetch
  // live every time the page is opened), navigating back to a page that
  // already has real scorecard data just restores it instantly with no
  // new request at all; only a genuinely first visit this tab session, or
  // an explicit click of Refresh, hits the API.
  if (lastData) {
    render(lastData);
  } else {
    load();
  }

  async function load() {
    refreshButton.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = 'Loading...';
    summaryEl.hidden = true;
    resultsEl.innerHTML = '';

    try {
      const res = await fetch('/api/whats-on');
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
    if (data.status === 'not-connected') {
      // The SIGNED-IN USER'S OWN Strety connection now (both the Helpdesk
      // team group and Personal group use it, by request -- see
      // server.js), not the old shared one -- points at
      // /auth/strety-personal/connect, which authorizes as whoever's
      // currently signed into the dashboard.
      statusEl.hidden = false;
      statusEl.className = 'status error';
      statusEl.innerHTML = `Your Strety account isn't connected yet.<br><a class="button-link" href="/auth/strety-personal/connect">Connect Strety</a>`;
      resultsEl.innerHTML = '';
      return;
    }
    if (data.status === 'reauth-required') {
      // Distinct message from 'not-connected' -- this was working and its
      // stored refresh token has gone stale/revoked (confirmed this
      // happens periodically, see @dashboard/strety-client's README). Same
      // fix (redo the browser login), but says so plainly rather than
      // surfacing as a raw error someone has to go dig into. Names WHICH
      // Strety account needs reconnecting, when known (see server.js --
      // recorded at connect time, since a broken connection can no longer
      // ask Strety who it belongs to).
      const who = data.connectedAs ? ` (currently connected as ${escapeHtml(data.connectedAs)})` : '';
      statusEl.hidden = false;
      statusEl.className = 'status error';
      statusEl.innerHTML = `Your Strety connection${who} has stopped working and needs to be reconnected.<br><a class="button-link" href="/auth/strety-personal/connect">Reconnect Strety</a>`;
      resultsEl.innerHTML = '';
      return;
    }
    if (data.status === 'person-not-found') {
      statusEl.hidden = false;
      statusEl.className = 'status error';
      statusEl.textContent = `No Strety account found matching "${data.email}".`;
      resultsEl.innerHTML = '';
      return;
    }
    if (data.status === 'no-session-email') {
      statusEl.hidden = false;
      statusEl.className = 'status error';
      statusEl.textContent = 'Could not determine your signed-in email.';
      resultsEl.innerHTML = '';
      return;
    }

    statusEl.hidden = true;
    summaryEl.hidden = false;
    // Only the text span is replaced here, not summaryEl's whole innerHTML
    // -- the Refresh Scorecards button lives as a static sibling inside
    // #summary (set up once in mount()'s own skeleton, not rebuilt on every
    // render()), so overwriting the outer element's innerHTML on every
    // render would silently detach its click listener (a fresh <button>
    // node each time, not the one addEventListener() was ever called on).
    // Very small "last synced" line under the heading, by request -- only
    // when automationStatus actually has a ranAt to show (null on
    // localhost, since the automation is production-only; also absent if
    // it's genuinely never run at all). Shown regardless of whether the
    // automation is currently healthy -- the banner below already covers
    // the unhealthy case in more detail, this is just a quick timestamp.
    // connectedAs rides along on the same line, also regardless of health
    // -- a run completing successfully says nothing about whether it ran
    // as the RIGHT account, which has actually gone wrong silently before
    // (see packages/shell/server.js's own comment on the real incident).
    // A "Manage" link rides along too, EVEN when healthy -- without it,
    // spotting a wrong "(as ...)" name here had no click-through at all
    // unless you already knew the raw /auth/strety-automation/connect URL
    // (the banner below only renders when the run itself failed/went
    // stale, which "running fine as the wrong account" never trips).
    // data.automationStatus is only ever non-null for Amber (see
    // canSeeAutomationStatus in server.js), so this link is safe to always
    // show whenever automationStatus itself is present at all.
    const connectedAsSuffix = data.automationStatus?.connectedAs ? ` (as ${escapeHtml(data.automationStatus.connectedAs)})` : '';
    const manageLink = data.automationStatus ? ` · <a href="/auth/strety-automation/connect">Manage</a>` : '';
    const syncedLine = data.automationStatus?.ranAt
      ? `<span class="inline-subtext-tiny">Autotask -&gt; Strety sync last ran: ${formatDateTime(data.automationStatus.ranAt)}${connectedAsSuffix}${manageLink}</span>`
      : '';
    summaryTextEl.innerHTML = `Helpdesk Scorecards<span class="inline-subtext"> -- as at ${formatDateTime(data.asOf)}</span>${syncedLine}`;

    resultsEl.innerHTML = '';

    // The Autotask -> Strety automation's own health, distinct from THIS
    // page's own (main) Strety connection above -- reported purely from a
    // status file the automation writes after each run (see
    // @dashboard/strety-autotask-sync's status.js), no extra live API call
    // needed to check it. Only shown when something's actually wrong --
    // a healthy/current automation is silent, same as the main connection's
    // own not-connected/reauth-required messages only showing on a real
    // problem.
    if (data.automationStatus && !data.automationStatus.ok) {
      const banner = document.createElement('p');
      banner.className = 'status error';
      const identityLine = data.automationStatus.connectedAs
        ? `<br><span class="inline-subtext-tiny">Currently connected as: ${escapeHtml(data.automationStatus.connectedAs)}</span>`
        : '';
      // Label spelled out deliberately -- this reconnects the SHARED
      // Helpdesk automation account, not the viewer's own Strety login (see
      // packages/shell/server.js's matching gate on the route itself for
      // why that distinction matters here).
      banner.innerHTML = `${escapeHtml(data.automationStatus.message)}${identityLine}<br><a class="button-link" href="/auth/strety-automation/connect">Reconnect Helpdesk Automation</a>`;
      resultsEl.appendChild(banner);
    }

    // Shown only for someone whose OWN connection genuinely can't write
    // yet (server.js's own hasWriteScope() check), by request -- the
    // Update icon further down would otherwise fail with a real 403 the
    // first time they tried to use it. Naturally stops appearing the
    // moment their connection actually becomes write-capable (reconnect,
    // or their existing token's next natural refresh if it was already
    // write-scoped) -- no per-browser dismiss state, this just reflects
    // real server-side fact on every load.
    if (data.canWriteCheckIns === false) {
      const banner = document.createElement('p');
      banner.className = 'status error';
      banner.innerHTML = `Your Strety connection needs reconnecting to allow writing scorecard check-ins (used by the Update button below). Reading scorecards is unaffected.<br><a class="button-link" href="/auth/strety-personal/connect">Reconnect Strety</a>`;
      resultsEl.appendChild(banner);
    }

    data.groups.forEach((group) => {
      // The Personal group is always second (see server.js -- Helpdesk is
      // pushed first, unconditionally). No separating heading here, by
      // request -- Personal Scorecards sits directly below Helpdesk's own,
      // rather than getting its own "Your Personal Scorecards -- as at..."
      // heading first.
      if (group.notFound) {
        resultsEl.appendChild(notice(`"${group.label}" wasn't found in Strety -- it may have been renamed or removed.`));
        return;
      }
      // The connected-but-no-matching-Strety-person case -- unlike a
      // not-yet-connected/broken connection (both handled at the page
      // level above, since both groups share one connection now), this can
      // only be known once fetchPersonByEmail() actually runs.
      if (group.personNotFound) {
        resultsEl.appendChild(notice(`No Strety account found matching your signed-in email.`));
        return;
      }
      // group.byFrequency[f] is { columns, rows } (see server.js), NOT an
      // array -- checking .rows.length here, not .length on the object
      // itself, which was always undefined regardless of real data and
      // made every group show "No scorecards" even when it had some.
      const frequenciesPresent = FREQUENCIES.filter((f) => group.byFrequency[f]?.rows?.length);
      if (frequenciesPresent.length === 0) {
        resultsEl.appendChild(notice(`No scorecards for ${group.label}.`));
        return;
      }
      for (const freq of frequenciesPresent) {
        const { columns, rows } = group.byFrequency[freq];
        resultsEl.appendChild(scorecardTable(group.label, FREQUENCY_LABELS[freq], columns, rows, freq));
      }
    });
  }

  // Only ever used for the three scorecard-group messages above ("wasn't
  // found in Strety" / "No Strety account found" / "No scorecards for
  // ...") -- indented under whichever group heading it's replacing the
  // table for, by request.
  function notice(text) {
    const p = document.createElement('p');
    p.className = 'status scorecard-notice';
    p.textContent = text;
    return p;
  }

  function scorecardTable(prefix, suffix, columns, rows, freq) {
    const groupEl = document.createElement('div');
    groupEl.className = 'resource-group';

    // Only the part after "--" (the cadence: Daily/Weekly/Monthly) is
    // bold+green, by request -- the rest of the heading (the team/person
    // name) stays plain .section-heading styling. Built from the prefix/
    // suffix passed in separately, not by splitting the combined text on
    // "--" after the fact -- Personal's own group.label already contains
    // its own "--" (e.g. "Personal -- Amber Worth"), so string-splitting
    // would be ambiguous about which "--" is meant.
    const headingEl = document.createElement('div');
    headingEl.className = 'section-heading section-heading--scorecard';
    headingEl.innerHTML = `${escapeHtml(prefix)} -- <span class="text-highlight-green">${escapeHtml(suffix)}</span>`;
    groupEl.appendChild(headingEl);

    if (columns.length === 0) {
      // Metrics exist for this cadence, but none has ever been checked in --
      // still list them (so they're not silently invisible), just without
      // any period columns to hang values on.
      const table = document.createElement('table');
      table.className = 'scorecard-table';
      table.innerHTML = `
        <thead>
          <tr class="shaded-row"><th>Metric</th><th>Target</th><th>Check-ins</th></tr>
        </thead>
        <tbody>
          ${rows.map((m) => `<tr><td>${titleHtml(m.title, Boolean(m.cells[0]), m.isAutoManaged, m.url, m.spaceType)}</td><td class="ticket-number">${escapeHtml(m.target)}</td><td>No check-ins yet</td></tr>`).join('')}
        </tbody>
      `;
      groupEl.appendChild(table);
      return groupEl;
    }

    // Columns are real shared periods (the most recent ones ANY metric in
    // this cadence actually has a check-in for, see server.js) -- every row
    // lines up against the exact same dates, not its own independent
    // "last 8" -- so the header can show a real date per column instead of
    // a generic "last 8" label.
    const table = document.createElement('table');
    table.className = 'scorecard-table';
    table.innerHTML = `
      <thead>
        <tr class="shaded-row">
          <th>Metric</th>
          <th>Target</th>
          ${columns.map((label) => `<th class="checkin-cell">${escapeHtml(label)}</th>`).join('')}
        </tr>
      </thead>
      <tbody>
        ${rows.map((m) => metricRowHtml(m, columns.length, `${prefix} -- ${suffix}`, freq)).join('')}
      </tbody>
    `;
    groupEl.appendChild(table);
    return groupEl;
  }

  function metricRowHtml(m, columnCount, scorecardType, freq) {
    const cells = [];
    for (let i = 0; i < columnCount; i++) {
      const c = m.cells[i];
      if (c) {
        cells.push(checkinCellHtml(c));
      } else if (i === 0) {
        // No value yet for the most recent period -- an Update icon, by
        // request, but ONLY in this first/latest column, never any
        // earlier empty column (a metric that's simply never had a
        // check-in for an OLDER period stays a plain blank cell, same as
        // before). Opens openMetricUpdateModal() below (see its own
        // comment), which actually writes a real Strety check-in.
        // data-scorecard-type ("Helpdesk Task Tracker -- Daily" etc.) and
        // data-metric-title feed that modal's own confirmation step
        // (Scorecard type + Scorecard name), by request. data-frequency
        // ('daily'/'weekly'/'monthly') tells server.js which period
        // attributes this metric's check-in actually needs -- confirmed
        // the hard way these genuinely differ by cadence (see server.js's
        // own comment on its new POST route).
        cells.push(
          `<td class="checkin-cell wo-update-cell" data-metric-id="${escapeHtml(m.id)}" data-metric-title="${escapeHtml(m.title)}" data-scorecard-type="${escapeHtml(scorecardType)}" data-frequency="${escapeHtml(freq)}" title="No check-in yet for this period -- click to update">${UPDATE_ICON_SVG}</td>`
        );
      } else {
        cells.push('<td></td>');
      }
    }
    return `
      <tr>
        <td>${titleHtml(m.title, Boolean(m.cells[0]), m.isAutoManaged, m.url, m.spaceType)}</td>
        <td class="ticket-number">${escapeHtml(m.target)}</td>
        ${cells.join('')}
      </tr>`;
  }

  // A canvas round-trip, not a library -- no new dependency for what the
  // browser already does natively.
  function resizeImageDataUrl(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
          const scale = MAX_IMAGE_DIMENSION / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', IMAGE_JPEG_QUALITY));
      };
      img.onerror = reject;
      img.src = dataUrl;
    });
  }

  // Exact decoded byte length of a data: URL's own base64 payload --
  // used only to show the before/after size below the editor (see the
  // paste handler), by request, after "that resize didn't seem to do
  // anything" turned out to be the compression working correctly but
  // being visually invisible: this image's pixel dimensions were already
  // under MAX_IMAGE_DIMENSION, so only the underlying bytes shrank
  // (PNG -> JPEG), which looks identical on screen at the same display
  // size. atob() is exact (not an estimate off the base64 string's own
  // length, which overcounts for padding).
  function dataUrlByteLength(dataUrl) {
    const base64 = dataUrl.split(',')[1] || '';
    try {
      return atob(base64).length;
    } catch {
      return Math.round((base64.length * 3) / 4);
    }
  }
  function formatKb(bytes) {
    return `${Math.round(bytes / 1024)} KB`;
  }

  // One wrapping <div>, not per-element styling for the outer shell -- it
  // has to survive execCommand's own mix of <b>/<u>/<ul>/<a> tags without
  // touching each one individually.
  function prepareContextForStrety(html) {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = html;
    wrapper.querySelectorAll('img').forEach((img) => {
      img.removeAttribute('width');
      img.removeAttribute('height');
      img.style.width = `${STRETY_IMAGE_DISPLAY_WIDTH}px`;
      img.style.height = 'auto';
    });
    // font-size on every element individually, not just the outer
    // wrapper -- confirmed a single wrapping div's font-size (relying on
    // plain inheritance) didn't actually shrink the text once this was
    // tried against real Strety. Inheritance has the LOWEST priority in
    // the CSS cascade -- if Strety's own site CSS sets an explicit
    // font-size on specific elements it renders inside a check-in's
    // context (a <p>/<li>/etc., which execCommand's own output uses),
    // that beats simple inheritance from one outer div regardless of
    // what it says. !important on every element (not just the wrapper)
    // is what actually survives that.
    wrapper.style.setProperty('font-size', STRETY_TEXT_FONT_SIZE, 'important');
    wrapper.querySelectorAll('*').forEach((el) => {
      el.style.setProperty('font-size', STRETY_TEXT_FONT_SIZE, 'important');
    });
    return wrapper.outerHTML;
  }

  // Writes a real Strety check-in, by request -- reuses the exact
  // create-or-update-on-409 contract @dashboard/strety-autotask-sync's
  // own sync.js already has confirmed working against the real API
  // (value/context/date attributes; see server.js's own new route for
  // the actual POST/PATCH). Two things NOT resolved yet, tried anyway by
  // request rather than blocked on:
  //  - Strety's check-in "context" is plain text everywhere else it's
  //    used in this codebase -- sent here as real HTML regardless (this
  //    editor's own innerHTML), to actually see what Strety does with
  //    it rather than pre-emptively stripping formatting.
  //  - A pasted screenshot has no confirmed place to go in Strety's
  //    check-in API at all (no known attachment/image field) -- sent
  //    anyway, as an inline <img src="data:..."> inside that same HTML,
  //    same "try it and see" reasoning.
  // The confirmation step (Scorecard type + Scorecard name + Value,
  // Confirm/Back) is the actual safety net, by request -- nothing goes
  // to Strety without it.
  function openMetricUpdateModal(metricId, title, scorecardType, frequency) {
    const overlay = document.createElement('div');
    overlay.className = 'history-modal-overlay';
    overlay.innerHTML = `
      <div class="history-modal-panel wo-update-modal-panel">
        <div class="history-modal-panel-header">
          <span>${escapeHtml(title)} -- Update</span>
          <button type="button" class="history-modal-close" aria-label="Close">✕</button>
        </div>
        <div class="history-modal-body wo-update-modal-body"></div>
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
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    const bodyEl = overlay.querySelector('.wo-update-modal-body');
    // Carried across a Confirm -> Back round trip, so backing out of the
    // confirmation step doesn't lose what was typed/pasted.
    let savedValue = '';
    let savedContext = '';

    function renderComposeView() {
      const toolbarHtml = UPDATE_MODAL_TOOLBAR_COMMANDS.map(
        (c) =>
          `<button type="button" class="button-link button-link--small" data-wo-command="${c.command}" data-wo-prompt="${!!c.promptForUrl}" title="${escapeHtml(c.title)}" style="${c.style || ''}">${c.label}</button>`
      ).join(' ');
      bodyEl.innerHTML = `
        <label class="wsp-qa-modal-label">
          <span class="wsp-qa-modal-field-label">Value</span>
          <input type="text" class="wsp-field wo-update-value-input" placeholder="e.g. 12" value="${escapeHtml(savedValue)}" />
        </label>
        <div style="margin-bottom:0.4rem;">${toolbarHtml}</div>
        <div id="wo-update-editor" class="wo-update-editor" contenteditable="true">${savedContext}</div>
        <p class="inline-subtext wo-update-image-status" style="margin-top:0.3rem;" hidden></p>
        <p class="inline-subtext" style="margin-top:0.4rem;">Strety's own check-in notes are plain text elsewhere on this dashboard -- formatting may not carry over exactly, and a pasted screenshot may not display there at all (no confirmed image support in Strety's check-in API).</p>
        <p class="status error wo-update-error" hidden></p>
        <div class="wsp-form-actions" style="margin-top:0.75rem;">
          <button type="button" class="button-link wo-update-send-button">Send to Strety</button>
          <button type="button" class="wo-update-close-button">Cancel</button>
        </div>
      `;
      const editorEl = bodyEl.querySelector('#wo-update-editor');
      const valueInput = bodyEl.querySelector('.wo-update-value-input');
      const errorEl = bodyEl.querySelector('.wo-update-error');

      bodyEl.querySelector('.wo-update-close-button').addEventListener('click', close);

      // preventDefault on mousedown (not click) is what actually keeps
      // the contenteditable's current text selection alive -- a button
      // click alone would blur the editable div FIRST (losing the
      // selection execCommand needs to act on) before the click handler
      // even runs.
      bodyEl.querySelectorAll('[data-wo-command]').forEach((btn) => {
        btn.addEventListener('mousedown', (e) => e.preventDefault());
        btn.addEventListener('click', () => {
          const command = btn.dataset.woCommand;
          if (btn.dataset.woPrompt === 'true') {
            const url = prompt('Link URL:', 'https://');
            if (!url) return;
            document.execCommand(command, false, url);
          } else {
            document.execCommand(command, false, null);
          }
          editorEl.focus();
        });
      });

      // Screenshot/image paste -- inserted as a data: URL <img> at the
      // current cursor position (falling back to just appending it if
      // there's no live selection inside the editor, e.g. right after
      // it's first focused). Only intercepts an actual image on the
      // clipboard; a plain-text or rich-text paste (e.g. copied from a
      // webpage) is left alone to go through the browser's own default
      // paste.
      editorEl.addEventListener('paste', (e) => {
        const items = e.clipboardData?.items || [];
        const imageItem = [...items].find((item) => item.type.startsWith('image/'));
        if (!imageItem) return;
        e.preventDefault();
        const file = imageItem.getAsFile();
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async () => {
          // Falls back to the original, un-shrunk data: URL if the resize
          // itself fails for any reason (a malformed/unusual image type,
          // say), OR if it somehow comes back BIGGER than the original
          // (JPEG re-encoding a very simple/already-small image can lose
          // to PNG occasionally) -- whichever is actually smaller wins,
          // never a blind "always use the JPEG" swap.
          let src = reader.result;
          try {
            const resized = await resizeImageDataUrl(reader.result);
            if (dataUrlByteLength(resized) < file.size) src = resized;
          } catch {
            // Best-effort -- fall through with the original.
          }
          // Shown below the editor, by request -- the compression itself
          // is otherwise invisible on screen whenever the image's pixel
          // dimensions were already under MAX_IMAGE_DIMENSION (only the
          // underlying bytes shrink in that case, which looks identical
          // at the same on-screen display size). file.size is the exact
          // original; dataUrlByteLength() decodes the exact result size,
          // not an estimate.
          const statusEl = bodyEl.querySelector('.wo-update-image-status');
          if (statusEl) {
            const afterBytes = dataUrlByteLength(src);
            statusEl.hidden = false;
            statusEl.textContent =
              afterBytes < file.size
                ? `Pasted image: ${formatKb(file.size)} → ${formatKb(afterBytes)} (compressed before sending)`
                : `Pasted image: ${formatKb(file.size)} (already small -- sent as-is)`;
          }
          const img = document.createElement('img');
          img.src = src;
          const selection = window.getSelection();
          if (selection && selection.rangeCount > 0 && editorEl.contains(selection.anchorNode)) {
            const range = selection.getRangeAt(0);
            range.deleteContents();
            range.insertNode(img);
            range.setStartAfter(img);
            range.setEndAfter(img);
            selection.removeAllRanges();
            selection.addRange(range);
          } else {
            editorEl.appendChild(img);
          }
        };
        reader.readAsDataURL(file);
      });

      bodyEl.querySelector('.wo-update-send-button').addEventListener('click', () => {
        const value = valueInput.value.trim();
        if (!value) {
          errorEl.hidden = false;
          errorEl.textContent = 'Error: enter a value first.';
          valueInput.focus();
          return;
        }
        savedValue = value;
        savedContext = editorEl.innerHTML;
        renderConfirmView();
      });

      editorEl.focus();
    }

    // The actual safety net, by request -- Scorecard type + Scorecard
    // name + Value, shown plainly before anything is sent, with a Back
    // step that returns to the compose view without losing what was
    // typed (savedValue/savedContext above).
    function renderConfirmView() {
      const sendPreviewHtml = prepareContextForStrety(savedContext);
      // Shown whenever there's real content (text or an image) -- an
      // exact preview of what Strety will receive (shrunk text/image
      // both applied, per prepareContextForStrety()'s own comment), not
      // the larger/normal-size version still shown back on the compose
      // view -- so what's confirmed here matches what's actually sent.
      // Skipped only for a genuinely blank editor (a naive tag-strip is
      // enough here, just to avoid showing an empty box).
      const hasContent = sendPreviewHtml.replace(/<[^>]*>/g, '').trim() !== '' || sendPreviewHtml.includes('<img');
      const hasEmbeddedImage = sendPreviewHtml.includes('<img');
      const previewHtml = hasContent
        ? `<p class="inline-subtext" style="margin-top:0.5rem;">Context as it will be sent (text shrunk to ${STRETY_TEXT_FONT_SIZE}${hasEmbeddedImage ? `, image shrunk to a ${STRETY_IMAGE_DISPLAY_WIDTH}px-wide thumbnail` : ''}):</p>
           <div class="wo-update-editor" style="cursor:default;">${sendPreviewHtml}</div>`
        : '';
      bodyEl.innerHTML = `
        <p>You're about to send this check-in to Strety:</p>
        <table class="wo-update-confirm-table">
          <tbody>
            <tr><th>Scorecard type</th><td>${escapeHtml(scorecardType)}</td></tr>
            <tr><th>Scorecard name</th><td>${escapeHtml(title)}</td></tr>
            <tr><th>Value</th><td>${escapeHtml(savedValue)}</td></tr>
          </tbody>
        </table>
        ${previewHtml}
        <p class="status error wo-update-confirm-error" hidden></p>
        <div class="wsp-form-actions" style="margin-top:0.75rem;">
          <button type="button" class="button-link wo-update-confirm-button">Confirm &amp; Send</button>
          <button type="button" class="wo-update-back-button">Back</button>
        </div>
      `;
      bodyEl.querySelector('.wo-update-back-button').addEventListener('click', renderComposeView);

      const confirmBtn = bodyEl.querySelector('.wo-update-confirm-button');
      const confirmErrorEl = bodyEl.querySelector('.wo-update-confirm-error');
      confirmBtn.addEventListener('click', async () => {
        confirmBtn.disabled = true;
        confirmErrorEl.hidden = true;
        try {
          const res = await fetch(`/api/whats-on/metrics/${encodeURIComponent(metricId)}/check-in`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ value: savedValue, context: sendPreviewHtml, frequency }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            const err = new Error(data.message || data.error || `Request failed (${res.status})`);
            if (data.error === 'strety-not-connected' || data.error === 'strety-reauth-required') err.needsConnect = true;
            throw err;
          }
          close();
          // Refreshes the whole scorecards section from real data -- the
          // Update icon on this row disappears once the real check-in
          // this just wrote comes back from Strety.
          load();
        } catch (err) {
          confirmErrorEl.hidden = false;
          confirmErrorEl.innerHTML = err.needsConnect
            ? `${escapeHtml(err.message)} <a href="/auth/strety-personal/connect">Connect Strety</a>`
            : `Error: ${escapeHtml(err.message)}`;
          confirmBtn.disabled = false;
        }
      });
    }

    renderComposeView();
  }

  // Bold+green/red for a title's own leading "PREFIX:" convention (e.g.
  // "THURSDAY: Check for Errors..."), up to and including the first colon.
  // By request: green if the metric's most recent column (cells[0] --
  // columns are always most-recent-first, see server.js) has a real value,
  // red if that most recent column is empty -- a quick "is this metric
  // current" signal at a glance, not just decoration. A title with no
  // colon at all still renders unstyled either way, as before.
  //
  // isAutoManaged (set server-side, from @dashboard/strety-autotask-sync's
  // own METRICS list -- see server.js) prepends a bold blue "AUTO: " label
  // ahead of all that, by request -- these specific metrics are filled in
  // automatically by the Autotask -> Strety sync, not a human, so it's
  // worth flagging at a glance which ones those are.
  // `url` (server.js -- @dashboard/strety-client's getMetricUrl) opens this
  // metric's own scorecard in Strety directly, by request. Wraps the whole
  // title (including the AUTO/colour-coded prefix, plus the leading
  // team/person icon) in one link rather than just the plain-text part, so
  // the entire cell is clickable, not just a sliver of it. .wo-scorecard-link
  // keeps it looking like normal text -- no browser default blue/purple, and
  // no underline (by request -- the icon is the "this is a link" signal now,
  // not underlining) -- a dedicated class rather than reusing Workshop's
  // .wsp-ticket-link, so that page's own underline-free-but-otherwise-
  // unrelated styling doesn't quietly change too.
  function titleHtml(title, hasRecentData, isAutoManaged, url, spaceType) {
    const autoPrefix = isAutoManaged ? '<span class="text-highlight-blue">AUTO: </span>' : '';
    const icon = spaceType === 'team' ? TEAM_ICON_HTML : spaceType === 'person' ? PERSON_ICON_SVG : '';
    const colonIndex = title.indexOf(':');
    const inner =
      colonIndex === -1
        ? autoPrefix + escapeHtml(title)
        : `${autoPrefix}<span class="${hasRecentData ? 'text-highlight-green' : 'text-highlight-red'}">${escapeHtml(title.slice(0, colonIndex + 1))}</span>${escapeHtml(title.slice(colonIndex + 1))}`;
    if (!url) return icon + inner;
    return `<a class="wo-scorecard-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${icon}${inner}</a>`;
  }

  function checkinCellHtml(c) {
    // Pass/fail flagged the same "needs attention" red / on-track green used
    // elsewhere on this dashboard (e.g. Subscriptions Expiring's
    // Auto-Renews column) -- no flag at all when there's no target to judge
    // against (pass === null).
    const flagClass = c.pass === true ? ' cell-flag-green' : c.pass === false ? ' cell-flag-red' : '';
    const titleAttr = c.context ? ` title="${escapeHtml(c.context)}"` : '';
    return `<td class="checkin-cell${flagClass}"${titleAttr}>${escapeHtml(c.displayValue)}</td>`;
  }

  function formatDateTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString();
  }

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
