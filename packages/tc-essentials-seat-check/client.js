export const id = 'tc-essentials-seat-check';
export const label = 'TC Essentials Seat Check';

// Every current Tech Cover Essentials client's 3 real Kaseya 365 contract
// lines, checked against live Workstation (Datto RMM) and Licensed User
// (SaaS Alerts) counts -- see server.js's own header comment for the real
// min/max seat-allocation formula and the SaaS Alerts admin/break-glass
// exclusion this compares against. Deliberately a separate page from Check
// Client's own per-client TC Calc column (different data sources, by
// request), not a replacement for it.

let lastData = null; // module-scope, survives the shell's teardown/re-mount, same convention every other page here uses
let showOnlyMismatches = true; // ticked by default, by request -- the mismatches are the whole point of this page

export function mount(container) {
  container.innerHTML = `
    <div class="tcess-page">
      <header class="page-header">
        <h1>TC Essentials Seat Check</h1>
        <div class="date-form">
          <label class="date-form-row" style="gap: 0.4rem;"><input type="checkbox" id="tcess-mismatch-only" />Show only mismatches</label>
          <button type="button" id="refresh-button">Refresh</button>
        </div>
      </header>
      <p id="status" class="status">Loading...</p>
      <div id="as-of" class="inline-subtext" hidden></div>
      <div id="datto-warning" class="status error" hidden>Datto RMM isn't connected -- Workstation counts can't be checked, so every Bundle/Endpoint/User comparison below shows as "Not available" rather than a guessed number.</div>
      <div id="summary" class="summary" hidden></div>
      <div id="results"></div>
    </div>
  `;

  const refreshButton = container.querySelector('#refresh-button');
  const statusEl = container.querySelector('#status');
  const asOfEl = container.querySelector('#as-of');
  const dattoWarningEl = container.querySelector('#datto-warning');
  const summaryEl = container.querySelector('#summary');
  const resultsEl = container.querySelector('#results');
  const mismatchOnlyCheckbox = container.querySelector('#tcess-mismatch-only');

  mismatchOnlyCheckbox.checked = showOnlyMismatches;
  mismatchOnlyCheckbox.addEventListener('change', () => {
    showOnlyMismatches = mismatchOnlyCheckbox.checked;
    if (lastData) render(lastData);
  });

  refreshButton.addEventListener('click', () => load(true));

  if (lastData) render(lastData);
  else load(false);

  async function load(force) {
    refreshButton.disabled = true;
    resultsEl.innerHTML = '';
    summaryEl.hidden = true;
    dattoWarningEl.hidden = true;
    try {
      const res = await fetch(`/api/tc-essentials-seat-check${force ? '?force=true' : ''}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastData = data;
      render(data);
    } catch (err) {
      statusEl.hidden = false;
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      refreshButton.disabled = false;
    }
  }

  function render(data) {
    statusEl.hidden = true;
    asOfEl.hidden = false;
    asOfEl.textContent = `As of ${new Date(data.asOf).toLocaleString()}`;
    dattoWarningEl.hidden = data.dattoConnected;

    summaryEl.hidden = false;
    summaryEl.innerHTML = `<strong>${data.totalCount}</strong> Tech Cover Essentials client${data.totalCount === 1 ? '' : 's'} <span class="inline-subtext">&middot; ${data.mismatchCount} with a seat-count mismatch</span>`;

    // A reconciled cell (Bundle billed higher, with the excess landing
    // exactly on the matching stand-alone line's own "None" Expected --
    // see server.js's own reconcileBundleExcess()) is a legitimate, just
    // differently-structured billing choice, not a gap -- excluded here
    // the same way it's excluded from data.mismatchCount server-side.
    const isRealMismatch = (c) => c.mismatch && !c.reconciled;
    const rows = showOnlyMismatches ? data.rows.filter((r) => isRealMismatch(r.bundle) || isRealMismatch(r.endpoint) || isRealMismatch(r.user)) : data.rows;

    resultsEl.innerHTML = '';
    if (data.rows.length === 0) {
      resultsEl.innerHTML = '<p class="status">No active Tech Cover Essentials clients found.</p>';
      return;
    }
    if (rows.length === 0) {
      resultsEl.innerHTML = '<p class="status">No clients with a seat-count mismatch.</p>';
      return;
    }
    resultsEl.appendChild(renderTable(rows, data.rows.length));
  }

  function renderTable(rows, totalCount) {
    // Deliberately NOT .resource-group -- that class's own overflow-y:
    // hidden (set for every other page's wide-table horizontal-scroll
    // handling) makes IT the sticky positioning boundary instead of the
    // real page scroll container, so a sticky thead inside it can never
    // actually stick (confirmed against Rollout Tracker's own .rt-table,
    // the one other sticky-header table on this dashboard -- it isn't
    // wrapped in .resource-group either, for this exact reason). Also
    // drops .resource-group's own border/border-radius "card" box, by
    // request -- this table doesn't need one.
    const wrap = document.createElement('div');
    // "(N of M)" next to Client, by request -- how many rows are actually
    // showing (narrowed by "Show only mismatches") out of the real total,
    // right where the rows themselves are, not just in the summary line
    // above. Omitted when nothing's been filtered out (showing = total).
    const countSuffix = rows.length === totalCount ? '' : ` <span class="inline-subtext">(${rows.length} of ${totalCount})</span>`;
    wrap.innerHTML = `
      <table class="tcess-table">
        <thead>
          <tr class="shaded-row">
            <th>Client${countSuffix}</th>
            <th>Licensed Users<br />(SaaS Alerts)</th>
            <th>Workstations<br />(Datto RMM)</th>
            <th>Bundle</th>
            <th>User</th>
            <th>Endpoint</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((r) => renderRow(r)).join('')}
        </tbody>
      </table>
    `;
    return wrap;
  }

  function renderRow(r) {
    // Whole-row red shading, by request, when NONE of the 3 Kaseya 365
    // lines are on the contract at all -- same tr.chk-summary-row-mismatch/
    // --row-warn-bg convention Check Client's own Client Check Summary
    // already uses for "shade the row red" (see styles.css).
    const rowCls = r.hasNoContractAtAll ? ' class="tcess-row-no-contract"' : '';
    return `
      <tr${rowCls}>
        <td>${companyLink(r)}</td>
        <td class="ticket-number tcess-hover-wrap">${countCell(r.licensedUsers, licensedUsersPopupHtml(r), licensedUsersSuffix(r))}</td>
        <td class="ticket-number tcess-hover-wrap">${countCell(r.workstations, workstationsPopupHtml(r))}</td>
        <td class="ticket-number">${lineCell(r.bundle)}</td>
        <td class="ticket-number">${lineCell(r.user)}</td>
        <td class="ticket-number">${lineCell(r.endpoint)}</td>
      </tr>
    `;
  }

  // Links to the client's own Tech Cover Essentials contract, by request --
  // NOT the Company/Account page (r.companyUrl is still returned by
  // server.js, just no longer used here). Bundle/User/Endpoint are normally
  // all 3 lines on that SAME contract, so whichever one actually has a
  // matched line is just as good a link as any other -- falls back through
  // the 3 in order, and renders as plain text (no link) only when NONE of
  // them matched a contract at all.
  function companyLink(r) {
    const label = escapeHtml(r.companyName);
    const contractUrl = r.bundle.contractUrl || r.user.contractUrl || r.endpoint.contractUrl || null;
    if (!contractUrl) return label;
    return `<a href="${escapeHtml(contractUrl)}" target="_blank" rel="noopener noreferrer" onclick="window.open(this.href, '_blank', 'noopener,noreferrer,width=1200,height=900'); return false;">${label}</a>`;
  }

  // "Online now" instead of the raw lastSeen date for a device that's
  // CURRENTLY online, by request's own spirit (not misleading) -- Datto
  // RMM's own lastSeen is confirmed NOT a heartbeat (an online device can
  // carry a lastSeen days old), so showing a stale date next to "online"
  // would read as a contradiction. lastSeen is otherwise the real, useful
  // "when did this go quiet" signal for an offline device.
  function formatLastSeen(device) {
    if (device.online) return 'online now';
    if (!device.lastSeen) return 'last seen unknown';
    return `last seen ${new Date(device.lastSeen).toLocaleDateString()}`;
  }

  // Real hover POPUPS (a positioned div, CSS :hover-revealed -- see
  // .tcess-hover-wrap/.tcess-hover-popup in styles.css), by request --
  // native title= tooltips are plain text only and can't render a table at
  // all, so this replaces that mechanism entirely for these 2 columns.
  // `.tcess-hover-wrap` goes on the whole <td> (see renderRow()), NOT a
  // small inner span -- confirmed by request ("too hard to get to the
  // popup... mouse passes another entry on the way"): a small inline
  // trigger left a real dead zone between it and the popup below, which
  // the cursor had to cross to reach/scroll the popup, and crossing it
  // handed hover to whatever sat underneath (the next row's own trigger).
  // Anchoring on the whole cell instead gives a much bigger, more
  // forgiving hover target, and the popup is positioned flush against it
  // (zero gap -- see styles.css) so there's no dead pixel to cross at all.
  // `trigger` is the visible cell content (the plain count), `bodyHtml` is
  // the popup's own inner HTML (a heading + a real <table>).
  function hoverCell(trigger, bodyHtml) {
    return `<span class="tcess-hover-trigger">${trigger}</span><div class="tcess-hover-popup">${bodyHtml}</div>`;
  }

  // Every matched device's own hostname/last known user/last seen, as a
  // real table -- all 3 fields already came along with the same
  // getAllDevices() call the count itself is built from (server.js's own
  // buildWorkstationCounts()), so this is free, not a second fetch.
  function workstationsPopupHtml(r) {
    if (r.workstations === null) return '<p class="inline-subtext" style="margin: 0;">No matching Datto RMM site found for this client.</p>';
    const heading = `<div class="tcess-hover-heading">Datto RMM: ${escapeHtml(r.workstationSites.join(', '))}</div>`;
    if (r.workstationDevices.length === 0) return `${heading}<p class="inline-subtext" style="margin: 0;">No workstations.</p>`;
    const rows = r.workstationDevices
      .map((d) => `<tr><td>${escapeHtml(d.hostname)}</td><td>${escapeHtml(d.lastUser || 'Unknown')}</td><td>${escapeHtml(formatLastSeen(d))}</td></tr>`)
      .join('');
    return `${heading}<table class="tcess-hover-table"><thead><tr><th>Hostname</th><th>Last User</th><th>Last Seen</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  // The real, actual usernames behind the count, as a real table -- same
  // free reuse of data server.js's own buildLicensedUserCounts() already
  // pulled from SaaS Alerts' per-user endpoint for the count itself.
  // Included and excluded (admin/break-glass) accounts shown together, one
  // list, with a Status column telling them apart -- not two separate
  // tables, so the Excluded ones are seen in context rather than hidden in
  // a second scroll. Excluded accounts sorted to the TOP, by request --
  // they're the ones worth checking at a glance (did this really get
  // excluded correctly?), not buried alphabetically among the much longer
  // Included list.
  function licensedUsersPopupHtml(r) {
    if (r.licensedUsers === null) return '<p class="inline-subtext" style="margin: 0;">No matching SaaS Alerts customer found for this client.</p>';
    const heading = `<div class="tcess-hover-heading">SaaS Alerts: ${escapeHtml(r.saasAlertsCustomerName)}</div>`;
    const all = [
      ...r.includedAccountNames.map((name) => ({ name, excluded: false })),
      ...r.excludedAccountNames.map((name) => ({ name, excluded: true })),
    ].sort((a, b) => (a.excluded === b.excluded ? a.name.localeCompare(b.name) : a.excluded ? -1 : 1));
    if (all.length === 0) return `${heading}<p class="inline-subtext" style="margin: 0;">No licensed users.</p>`;
    const rows = all
      .map((u) => `<tr><td>${escapeHtml(u.name)}</td><td${u.excluded ? ' class="cell-flag-red"' : ''}>${u.excluded ? 'Excluded' : 'Included'}</td></tr>`)
      .join('');
    return `${heading}<table class="tcess-hover-table"><thead><tr><th>User</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  // "(N)" after the Licensed Users count, by request -- how many
  // admin/break-glass accounts were excluded to get there, right where the
  // count itself is shown, not just buried in the hover popup. Omitted
  // when there weren't any, same "don't show it when there's nothing to
  // say" convention the Client column's own "(showing of total)" count
  // already follows.
  function licensedUsersSuffix(r) {
    if (r.licensedUsers === null || r.excludedAccountCount === 0) return '';
    return ` <span class="inline-subtext">(${r.excludedAccountCount})</span>`;
  }

  // A count cell -- "Not available" (muted, not red -- this is a data gap,
  // not a billing mismatch) when there's no match at all for this client,
  // still with its own hover popup explaining why (popupHtml already
  // covers the null case -- see workstationsPopupHtml()/
  // licensedUsersPopupHtml() above), otherwise the plain number plus an
  // optional suffix (the Licensed Users column's own excluded-count, see
  // licensedUsersSuffix() above -- unused by Workstations).
  function countCell(value, popupHtml, suffix) {
    const trigger = value === null ? '<span class="inline-subtext">Not available</span>' : escapeHtml(String(value)) + (suffix || '');
    return hoverCell(trigger, popupHtml);
  }

  // One Bundle/Endpoint/User cell. "Contracted / Expected" (both numbers
  // flagged together, same .cell-flag-* convention Check Client's own TC
  // Calc column uses) ONLY when there's something actually worth comparing
  // side by side -- a real mismatch, or a reconciled one. By request,
  // every OTHER case collapses to a single plain number instead, since
  // pairing it with a second value that's either unknown ("—", Expected
  // couldn't be computed at all -- no Datto and/or no SaaS Alerts match
  // for this client) or identical (a clean match, e.g. "4 / 4") adds
  // nothing.
  //
  // "None" vs "0" when there's no contract line at all for this service:
  // "None" means live usage (Expected) says this line SHOULD carry some
  // units -- a real gap. "0" means Expected agrees nothing's needed here
  // either -- not a problem, shown as a plain 0 rather than reading as
  // "something's missing". When Expected itself is unknown, "None" is
  // used (there's no Expected to say otherwise).
  //
  // Green (.cell-flag-green, same convention as every other green flag on
  // this dashboard), by request, when server.js's own
  // reconcileBundleExcess() marked this cell `reconciled` -- the numbers
  // still don't literally match, but the combined total across the Bundle
  // and the matching stand-alone line IS correct, just billed entirely
  // through one line instead of split across both.
  //
  // A real mismatch is split by DIRECTION, by request ("if the mismatch
  // discrepancy is in our favour use the orangy yellow colour instead of
  // red -- red for when we are losing money"): Contracted > Expected means
  // the client's being billed for MORE than their real usage -- in Ambient
  // iT's own favour, not a revenue loss -- shown orange (.cell-flag-orange,
  // the same established "worth checking, not a loss" amber this dashboard
  // already uses for e.g. SaaS Protection's Backup % column). Contracted <
  // Expected means the client's being billed for LESS than their real
  // usage -- Ambient iT is actually losing money here -- stays red
  // (.cell-flag-red).
  function lineCell(cellData) {
    const contractedText =
      cellData.contracted === null ? (cellData.expected !== null && cellData.expected <= 0 ? '0' : 'None') : String(cellData.contracted);

    if (!cellData.mismatch && !cellData.reconciled) {
      const title = cellData.contractName ? `Contract: ${cellData.contractName}` : 'No active contract line found for this service.';
      return `<span title="${escapeHtml(title)}">${escapeHtml(contractedText)}</span>`;
    }

    const cls = cellData.reconciled ? ' cell-flag-green' : (cellData.contracted ?? 0) > cellData.expected ? ' cell-flag-orange' : ' cell-flag-red';
    const title = cellData.reconciled
      ? 'Billed differently than expected, but the combined total across Bundle and this line is correct -- not a real discrepancy.'
      : cls.includes('orange')
        ? 'Billed higher than expected -- in our favour, not a revenue loss, but still worth checking against real usage.'
        : 'Billed lower than expected -- we are undercharging relative to real usage.';
    return `<span class="${cls.trim()}" title="${escapeHtml(title)}">${escapeHtml(contractedText)}</span> / <span class="${cls.trim()}">${cellData.expected}</span>`;
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
