export const id = "accrued-time";
export const label = "Accrued Time";

// Module-scope, not inside mount() -- the shell fully tears down and
// re-mounts a page's DOM on every navigation away and back, but the
// dynamically-imported module itself is cached by the browser and stays
// alive for the session, so this survives across re-mounts and lets the
// last result restore instantly instead of coming back blank. Same
// convention as every other page here (see @dashboard/times' own client.js
// for the fullest write-up of this pattern).
let lastParams = null; // { from, to, resourceId, ticketNumber }
let lastData = null; // { completeRows } from the main load -- the Not Complete list is separate, see below
let lastIncompleteData = null; // { otherRows } from GET /api/accrued-time/incomplete, or null if never fetched for the current lastParams
let incompleteVisible = false; // whether the Not Complete table is currently shown (independent of whether it's been fetched)
let allResources = null; // [{id, name}], fetched once, reused across remounts
// id of the quick-date button that currently matches From/To exactly, or
// null once either field's been hand-edited -- see setActiveQuickButton()
// in mount(), same convention @dashboard/times' own client.js uses.
let lastActiveQuickButtonId = 'quick-today-button';

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>Accrued Time Checker</h1>
    </header>
    <form id="accrued-time-form" class="date-form date-form--stacked">
      <div class="date-form-row">
        <label for="from-input">From</label>
        <input type="date" id="from-input" name="from" required />
        <label for="to-input">To</label>
        <input type="date" id="to-input" name="to" required />
        <div class="tm-quick-date-groups">
          <div class="tm-quick-date-group">
            <button type="button" class="button-link button-link--small" id="quick-today-button">Today</button>
            <button type="button" class="button-link button-link--small" id="quick-yesterday-button">Yesterday</button>
          </div>
          <div class="tm-quick-date-group">
            <button type="button" class="button-link button-link--small" id="quick-this-week-button">This Week</button>
            <button type="button" class="button-link button-link--small" id="quick-last-week-button">Last Week</button>
          </div>
          <div class="tm-quick-date-group">
            <button type="button" class="button-link button-link--small" id="quick-this-month-button">This Month</button>
            <button type="button" class="button-link button-link--small" id="quick-last-month-button">Last Month</button>
          </div>
        </div>
      </div>
      <div class="date-form-row">
        <label for="resource-input">Resource</label>
        <select id="resource-input"><option value="">All Resources</option></select>
        <label for="ticket-input">Ticket #</label>
        <input type="text" id="ticket-input" placeholder="e.g. T20260101.0001" />
        <button type="submit">Load</button>
        <label><input type="checkbox" id="issues-only-input" /> Show Issues Only</label>
      </div>
    </form>
    <p id="status" class="status">Pick a date range (and, optionally, a resource or ticket number), then click Load.</p>
    <div id="results"></div>
  `;

  const form = container.querySelector('#accrued-time-form');
  const issuesOnlyInput = container.querySelector('#issues-only-input');
  const fromInput = container.querySelector('#from-input');
  const toInput = container.querySelector('#to-input');
  const resourceInput = container.querySelector('#resource-input');
  const ticketInput = container.querySelector('#ticket-input');
  const statusEl = container.querySelector('#status');
  const resultsEl = container.querySelector('#results');

  // Pure display filter, by request -- no new fetch needed, just re-render
  // the data already in hand with non-mismatch rows left out.
  issuesOnlyInput.addEventListener('change', () => {
    if (lastData) render(lastData);
  });

  // Real popup window, not a plain new-tab link -- same window.open
  // features string every ticket link on this dashboard already uses
  // (Service Calls, What's On, Today Things, Ticket Times, Time
  // Summaries' own drill-down). Also handles the Show/Hide Incomplete
  // Tickets button -- delegated the same way since resultsEl's own
  // innerHTML (both the button and every ticket link) is fully replaced
  // on every render(), so a listener attached to any element inside it
  // wouldn't survive past the first render.
  resultsEl.addEventListener('click', (e) => {
    const link = e.target.closest('a.ticket-link');
    if (link) {
      e.preventDefault();
      window.open(link.href, '_blank', 'noopener,noreferrer,width=1200,height=900');
      return;
    }
    if (e.target.closest('#show-incomplete-button')) toggleIncomplete();
  });

  // AEST (UTC+10, no DST in Queensland) "today" -- same helper every
  // date-range page on this dashboard uses.
  function todayISO() {
    return new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }
  function mondayOfWeek(iso) {
    const d = new Date(`${iso}T00:00:00Z`);
    const day = d.getUTCDay();
    const diff = day === 0 ? -6 : 1 - day;
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

  // Same paired, stacked quick-date buttons as @dashboard/times, by
  // request ("change the buttons on the Accrued Time page to be like the
  // Time Summaries buttons") -- "This Week"/"This Month" run only up to
  // TODAY, not the rest of the still-in-progress period; "Last Week"/
  // "Last Month" are unchanged, full past periods.
  const QUICK_DATE_BUTTON_IDS = [
    'quick-today-button',
    'quick-yesterday-button',
    'quick-this-week-button',
    'quick-last-week-button',
    'quick-this-month-button',
    'quick-last-month-button',
  ];
  // Highlights whichever quick-date button produced the CURRENT From/To
  // values, by request ("highlight the chosen button until the dates are
  // manually editted (both pages)") -- same convention @dashboard/times'
  // own client.js uses, see its comment for the fuller write-up.
  function setActiveQuickButton(id) {
    lastActiveQuickButtonId = id;
    for (const btnId of QUICK_DATE_BUTTON_IDS) {
      container.querySelector(`#${btnId}`).classList.toggle('active', btnId === id);
    }
  }
  fromInput.addEventListener('input', () => setActiveQuickButton(null));
  toInput.addEventListener('input', () => setActiveQuickButton(null));

  container.querySelector('#quick-today-button').addEventListener('click', () => {
    const today = todayISO();
    fromInput.value = today;
    toInput.value = today;
    setActiveQuickButton('quick-today-button');
  });
  container.querySelector('#quick-yesterday-button').addEventListener('click', () => {
    const yesterday = addDays(todayISO(), -1);
    fromInput.value = yesterday;
    toInput.value = yesterday;
    setActiveQuickButton('quick-yesterday-button');
  });
  container.querySelector('#quick-this-week-button').addEventListener('click', () => {
    fromInput.value = mondayOfWeek(todayISO());
    toInput.value = todayISO();
    setActiveQuickButton('quick-this-week-button');
  });
  container.querySelector('#quick-last-week-button').addEventListener('click', () => {
    const thisMonday = mondayOfWeek(todayISO());
    fromInput.value = addDays(thisMonday, -7);
    toInput.value = addDays(thisMonday, -1);
    setActiveQuickButton('quick-last-week-button');
  });
  container.querySelector('#quick-this-month-button').addEventListener('click', () => {
    fromInput.value = startOfMonth(todayISO(), 0);
    toInput.value = todayISO();
    setActiveQuickButton('quick-this-month-button');
  });
  container.querySelector('#quick-last-month-button').addEventListener('click', () => {
    const today = todayISO();
    fromInput.value = startOfMonth(today, -1);
    toInput.value = endOfMonth(today, -1);
    setActiveQuickButton('quick-last-month-button');
  });

  if (lastParams) {
    fromInput.value = lastParams.from;
    toInput.value = lastParams.to;
    ticketInput.value = lastParams.ticketNumber || '';
    setActiveQuickButton(lastActiveQuickButtonId);
  } else {
    // Today, by request -- was "last week, Mon-Sun"; changed to match
    // Times' own new default.
    const today = todayISO();
    fromInput.value = today;
    toInput.value = today;
    setActiveQuickButton('quick-today-button');
  }

  async function loadResourceList() {
    if (allResources) {
      renderResourceOptions();
      return;
    }
    try {
      const res = await fetch('/api/accrued-time/resources');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      allResources = data.resources;
      renderResourceOptions();
    } catch (err) {
      resourceInput.innerHTML = `<option value="">All Resources</option>`;
      console.error('Failed to load resource list:', err.message);
    }
  }
  function renderResourceOptions() {
    const selected = lastParams ? lastParams.resourceId : '';
    resourceInput.innerHTML =
      `<option value="">All Resources</option>` +
      allResources.map((r) => `<option value="${r.id}"${String(r.id) === String(selected) ? ' selected' : ''}>${escapeHtml(r.name)}</option>`).join('');
  }
  loadResourceList();

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    load();
  });

  async function load() {
    const from = fromInput.value;
    const to = toInput.value;
    if (!from || !to) return;
    if (to < from) {
      statusEl.className = 'status error';
      statusEl.textContent = 'Error: "To" must not be before "From".';
      return;
    }
    const resourceId = resourceInput.value;
    const ticketNumber = ticketInput.value.trim();
    lastParams = { from, to, resourceId, ticketNumber };
    // New params -> any previously-fetched Not Complete list is for a
    // stale request; drop it so the button starts fresh at "Show
    // Incomplete Tickets" and a real re-fetch happens next time it's
    // clicked, not stale data from the old params.
    lastIncompleteData = null;
    incompleteVisible = false;

    const submitButton = form.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = 'Loading...';
    resultsEl.innerHTML = '';

    try {
      const qs = new URLSearchParams({ from, to });
      if (resourceId) qs.set('resourceId', resourceId);
      if (ticketNumber) qs.set('ticketNumber', ticketNumber);
      const res = await fetch(`/api/accrued-time?${qs.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastData = data;
      render(data);
    } catch (err) {
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      submitButton.disabled = false;
    }
  }

  // Red/Yellow shading, by request -- "our rules for shading rows red ...
  // If the sum of --END times is less than --ING time - RED; If greater -
  // Yellow." Originally exact comparison (no buffer); a 5-minute allowed
  // variance added by request just after -- END within 5 minutes of ING
  // either side now stays uncoloured, same idea as the earlier (since
  // replaced) 15-minute mismatch tolerance, just a tighter window this
  // time. Replaces the earlier "END with no ING" yellow case entirely --
  // END > ING (by more than the variance) now covers that case too, since
  // any real END > 0 with ING = 0 trivially satisfies it once ING is 0.
  const VARIANCE_HOURS = 5 / 60;
  function endTotal(r) {
    return r.accrueEnd + r.accrueEndNoBill;
  }
  function isRed(r) {
    return endTotal(r) < r.accrueIng - VARIANCE_HOURS;
  }
  function isYellow(r) {
    return endTotal(r) > r.accrueIng + VARIANCE_HOURS;
  }
  // Shared by rowHtml()'s own shading AND the "Issues Only" checkbox below
  // (same definition of "an issue" either way), rather than separate
  // copies of the same logic. A row is red XOR yellow XOR neither --
  // never both, since endTotal(r) can't be both less than AND greater
  // than accrueIng at once.
  function hasIssue(r) {
    return isRed(r) || isYellow(r);
  }

  // Moved here from right after loadResourceList() above -- a real bug,
  // by request ("I get an error on VARIANCE_HOURS when the page
  // refreshes"): render() (via rowHtml()/listHtml()/mismatchCountHtml())
  // calls isRed()/isYellow(), which close over the `const VARIANCE_HOURS`
  // above. Calling it from up there ran BEFORE that const's own
  // declaration had executed in THIS invocation of mount() (mount() runs
  // fresh, and each of its own local `const`s re-enters its own temporal
  // dead zone, every time the shell re-mounts this page -- e.g.
  // navigating away and back with lastData already populated from an
  // earlier Load) -- a real "Cannot access 'VARIANCE_HOURS' before
  // initialization" ReferenceError, not just a hypothetical one.
  if (lastData) render(lastData);

  function render(data) {
    if (data.ticketNumberNotFound) {
      statusEl.hidden = false;
      statusEl.className = 'status error';
      statusEl.textContent = `No ticket found with number "${lastParams.ticketNumber}".`;
      resultsEl.innerHTML = '';
      return;
    }
    statusEl.hidden = true;

    // "Issues Only" -- a pure display filter, by request, applied on top
    // of whichever real rows are currently in hand (Complete always; Not
    // Complete only once it's actually been fetched, see below) rather
    // than a separate fetch of its own.
    const issuesOnly = issuesOnlyInput.checked;
    const applyIssuesOnly = (rows) => (issuesOnly ? rows.filter(hasIssue) : rows);

    // Complete (including Billing - Contract) tickets, by request --
    // fetched as part of the main load, always shown. showMismatchCount:
    // by request, only this heading gets the "- N Mismatches" reading.
    // showDiffSum: by request ("add at the top next to complete and
    // mismatch the actual sum of time of the difference between --ING
    // and (--END*)"), same "Complete heading only" scope.
    const completeHtml = listHtml('Complete', applyIssuesOnly(data.completeRows), { showMismatchCount: true, showDiffSum: true });

    // Not Complete -- by request ("for the second table, don't retrieve
    // the data initially ... add a button for Show Incomplete Tickets"),
    // NOT fetched as part of the main load at all; clicking the button
    // (toggleIncomplete() below) fires its own request to
    // GET /api/accrued-time/incomplete the first time, same "don't
    // retrieve it by default so the page is faster" reasoning
    // @dashboard/times' own Work-Type Reconciliation Show button uses.
    // Toggling again after that first fetch just shows/hides the already-
    // fetched table -- no re-fetch -- which is what "Hide Them" (rather
    // than, say, "Reload") signals.
    const showIncompleteLabel = incompleteVisible ? 'Hide Them' : 'Show Incomplete Tickets';
    const incompleteTableHtml = incompleteVisible && lastIncompleteData ? listHtml('Not Complete', applyIssuesOnly(lastIncompleteData.otherRows)) : '';

    // No separate "Not Complete" heading here, by request -- once shown,
    // listHtml()'s own generated heading (with its row count) already
    // reads as this section's title; a second static one next to the
    // button just duplicated it.
    resultsEl.innerHTML = `
      ${completeHtml}
      <div class="accrued-time-heading-with-button">
        <button type="button" id="show-incomplete-button">${escapeHtml(showIncompleteLabel)}</button>
      </div>
      <div id="incomplete-container">${incompleteTableHtml}</div>
    `;
  }

  async function toggleIncomplete() {
    // Already fetched -- just toggle visibility, no re-fetch, matching
    // the "Hide Them" label (not "Reload").
    if (lastIncompleteData) {
      incompleteVisible = !incompleteVisible;
      render(lastData);
      return;
    }
    // First time for these params -- real fetch.
    const btn = resultsEl.querySelector('#show-incomplete-button');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Loading...';
    }
    try {
      const qs = new URLSearchParams({ from: lastParams.from, to: lastParams.to });
      if (lastParams.resourceId) qs.set('resourceId', lastParams.resourceId);
      if (lastParams.ticketNumber) qs.set('ticketNumber', lastParams.ticketNumber);
      const res = await fetch(`/api/accrued-time/incomplete?${qs.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastIncompleteData = data;
      incompleteVisible = true;
      render(lastData);
    } catch (err) {
      const container = resultsEl.querySelector('#incomplete-container');
      if (container) container.innerHTML = `<p class="status error">Error: ${escapeHtml(err.message)}</p>`;
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Show Incomplete Tickets';
      }
    }
  }

  // "- N Mismatch(es)" next to the Complete heading, by request -- RED
  // rows only, not yellow, and only shown at all when there's at least
  // one (a real "0 Mismatches" reading next to "Complete (N)" would just
  // be noise). Text itself shaded red (.accrued-time-mismatch-count),
  // same #dc2626 red every other mismatch/warning reading on this page
  // already uses.
  function mismatchCountHtml(rows) {
    const count = rows.filter(isRed).length;
    if (count === 0) return '';
    return ` <span class="accrued-time-mismatch-count">- ${count} Mismatch${count === 1 ? '' : 'es'}</span>`;
  }

  // "The actual sum of time of the difference between --ING and (--END*)",
  // by request. Originally a net total across every row; narrowed by a
  // follow-up request to only the END* > ING (yellow) rows; corrected by
  // a further follow-up ("I only want the difference of the sums of the
  // mismatch lines where the ENDs are smaller than the --INGs") to the
  // OPPOSITE rows instead -- exactly isRed(r), the same variance-aware
  // definition both the row shading AND the "- N Mismatches" count above
  // already use, reused here rather than a second, possibly-inconsistent
  // check. "The mismatch lines" confirms this -- isRed(r) is also
  // literally what mismatchCountHtml() above counts, so this figure now
  // scopes to the SAME rows that count reports on, just summed instead of
  // counted. Rows where END* is bigger (yellow) or within the variance
  // (uncoloured) don't contribute to this sum at all -- not summed as a
  // negative, not summed as zero, excluded outright. Every qualifying
  // row's own accrueIng - endTotal(r) is positive by construction (END*
  // smaller than ING), so the total is always >= 0.
  // No descriptive label, by request ("remove all the descriptive text
  // for that calculation and just show the hours as HH:MM after
  // MISMATCHES") -- just the figure itself, HH:MM (formatHms(), same
  // rounding/rollover convention @dashboard/times' own formatHms() uses),
  // right after the mismatch count's own span.
  function diffSumHtml(rows) {
    const total = rows.filter(isRed).reduce((sum, r) => sum + (r.accrueIng - endTotal(r)), 0);
    // "- " prefix kept (not itself descriptive text) -- same separator
    // convention the mismatch count's own span already uses right before
    // this one in the heading.
    return ` <span class="accrued-time-diff-sum">- ${formatHms(total)}</span>`;
  }

  function listHtml(title, rows, opts = {}) {
    if (rows.length === 0) return `<h2 class="section-heading">${escapeHtml(title)}</h2><p class="status">None.</p>`;
    const mismatchHtml = opts.showMismatchCount ? mismatchCountHtml(rows) : '';
    const diffSumHtmlStr = opts.showDiffSum ? diffSumHtml(rows) : '';
    return `
      <h2 class="section-heading">${escapeHtml(title)} (${rows.length})${mismatchHtml}${diffSumHtmlStr}</h2>
      <table class="accrued-time-table">
        <thead>
          <tr>
            <th>Ticket #</th>
            <th>Ticket Title</th>
            <th>Ticket Status</th>
            <th class="col-center">Accrue--ING</th>
            <th class="col-center accrued-time-end-col">END</th>
            <th class="col-center accrued-time-end-col">NO Bill</th>
            <th class="col-center">.STD</th>
            <th class="col-center">Other</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(rowHtml).join('')}
        </tbody>
      </table>
    `;
  }

  function rowHtml(r) {
    const otherTitle = r.otherWorkTypes.length > 0 ? ` title="${escapeHtml(r.otherWorkTypes.join(', '))}"` : '';
    const rowClass = isRed(r) ? ' class="accrued-time-red-row"' : isYellow(r) ? ' class="accrued-time-yellow-row"' : '';
    return `
      <tr${rowClass}>
        <td>${ticketLink(r)}</td>
        <td>${escapeHtml(r.ticketTitle)}</td>
        <td>${escapeHtml(r.status)}</td>
        <td class="col-center">${formatHours(r.accrueIng)}</td>
        <td class="col-center accrued-time-end-col">${formatHours(r.accrueEnd)}</td>
        <td class="col-center accrued-time-end-col">${formatHours(r.accrueEndNoBill)}</td>
        <td class="col-center">${formatHours(r.standardSupport)}</td>
        <td class="col-center"${otherTitle}>${formatHours(r.other)}</td>
      </tr>
    `;
  }

  function ticketLink(r) {
    const label = escapeHtml(r.ticketNumber);
    if (!r.ticketUrl) return label;
    return `<a href="${escapeHtml(r.ticketUrl)}" class="ticket-link" target="_blank" rel="noopener noreferrer">${label}</a>`;
  }

  function formatHours(n) {
    return (n || 0).toFixed(2);
  }

  // h:mm, for the "Diff" figure next to Mismatches -- same rounding/
  // rollover convention @dashboard/times' own formatHms() uses (round to
  // the nearest minute, roll over into the next hour rather than ever
  // showing :60).
  function formatHms(hours) {
    const totalMinutes = Math.round((hours || 0) * 60);
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
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
