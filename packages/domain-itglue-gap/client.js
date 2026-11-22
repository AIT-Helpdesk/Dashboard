export const id = "domain-itglue-gap";
export const label = "Domain / IT Glue Gaps";

// Module-scope, not inside mount() -- same "survives a shell re-mount"
// convention every other page's client.js already uses.
let lastData = null;
let lastNoPrimaryDomainClients = null;
// By request ("turns out most of them are ok so let's just put a button
// at the bottom to view these on request") -- Email Domain Mismatch is
// still computed every run (ticket/CSV unaffected), just not shown by
// default on this page any more. Module-scope so the choice survives a
// Refresh (a fresh render() call), not reset back to hidden every time.
let emailMismatchExpanded = false;

export function mount(container) {
  // Scopes the narrower-row/smaller-text table style below (styles.css)
  // without touching the shared dashboard-wide table default, same
  // "add a page-scoped class to the container" convention
  // @dashboard/data-matching's own client.js already uses.
  container.classList.add('domain-itglue-gap-page');
  container.innerHTML = `
    <header class="page-header">
      <h1>Domain / IT Glue Gaps</h1>
      <button type="button" id="refresh-button" class="button-link button-link--small">Refresh</button>
    </header>
    <div class="resource-group" id="npd-section">
      <div class="resource-group-header"><span>IT Glue Clients Missing a Primary Domain</span><span class="count" id="npd-count"></span></div>
      <p class="status" id="npd-status">Loading...</p>
      <div id="npd-rows" hidden></div>
    </div>
    <p id="status" class="status">Loading...</p>
    <div id="last-run" class="inline-subtext" hidden></div>
    <div id="summary" class="summary" hidden></div>
    <div id="results" class="results"></div>
  `;

  const refreshButton = container.querySelector('#refresh-button');
  const statusEl = container.querySelector('#status');
  const lastRunEl = container.querySelector('#last-run');
  const summaryEl = container.querySelector('#summary');
  const resultsEl = container.querySelector('#results');
  const npdCountEl = container.querySelector('#npd-count');
  const npdStatusEl = container.querySelector('#npd-status');
  const npdRowsEl = container.querySelector('#npd-rows');

  // Refresh button = a real LIVE pull (force=true -- same query-param
  // convention @dashboard/tc-elite-services's own GET / already uses),
  // which only ever adds a small "what's been fixed" note to an already-
  // open ticket, never a new ticket or a full rewrite -- that's the
  // scheduled/manual job's job alone (see job.js's own refreshLive()
  // comment). The initial page load (no button click) stays a plain, fast
  // read of the last stored state. Also re-runs the "Clients missing a
  // Primary Domain" section's own live pull, by request -- it previously
  // only ever loaded once at mount, never again on a Refresh click.
  refreshButton.addEventListener('click', () => {
    load(true);
    loadNoPrimaryDomain();
  });

  async function load(force) {
    refreshButton.disabled = true;
    statusEl.hidden = false;
    // The live-refresh message gets the dashboard-wide orange "in progress"
    // status treatment (.status.loading, by request) -- a plain load stays
    // the default/neutral status styling.
    statusEl.className = force ? 'status loading' : 'status';
    statusEl.textContent = force ? 'Refreshing live data (TPP, IT Glue, Autotask) -- this can take up to 30 seconds...' : 'Loading...';
    try {
      const res = await fetch(`/api/domain-itglue-gap${force ? '?force=true' : ''}`);
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

  // "Clients missing a Primary Domain" -- loaded independently of the main
  // gap list above, by request structure (its own section, own loading
  // state), same "don't slow down the fast stuff waiting on a slower one"
  // split @dashboard/live-reports' own Email Domain Protection card
  // already uses. Always a real live IT Glue pull (no persisted/cached
  // state server-side, see server.js's own comment) -- this isn't tied to
  // the TPP/ticket job at all, just a live data-quality check.
  async function loadNoPrimaryDomain() {
    npdStatusEl.hidden = false;
    npdStatusEl.className = 'status';
    npdStatusEl.textContent = 'Loading...';
    npdRowsEl.hidden = true;
    try {
      const res = await fetch('/api/domain-itglue-gap/no-primary-domain');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastNoPrimaryDomainClients = data.clients;
      renderNoPrimaryDomain(data.clients);
    } catch (err) {
      npdStatusEl.hidden = false;
      npdStatusEl.className = 'status error';
      npdStatusEl.textContent = `Error: ${err.message}`;
    }
  }

  function renderNoPrimaryDomain(clients) {
    npdCountEl.textContent = clients.length;
    if (clients.length === 0) {
      npdStatusEl.hidden = false;
      npdStatusEl.className = 'status';
      npdStatusEl.textContent = 'Every IT Glue client with a domain on file has a Primary Domain tagged.';
      npdRowsEl.hidden = true;
      return;
    }
    npdStatusEl.hidden = true;
    npdRowsEl.hidden = false;
    // One shared width across every row's dropdown, sized to the single
    // longest domain name in the WHOLE list ("fit the worst case"), by
    // request -- not each row's own browser-default sizing, which would
    // otherwise stretch to fill the grid column's full width (see
    // .npd-domain-select's own comment in styles.css).
    const placeholderLabel = '-- choose a domain --';
    const widestChars = Math.max(placeholderLabel.length, ...clients.flatMap((c) => c.domains.map((d) => d.name.length)));
    const selectWidth = `${widestChars + 3}ch`;
    npdRowsEl.innerHTML = clients
      .map((c) => {
        // Only one domain on file -- nothing to actually pick, by request
        // ("show the one domain in a box with no dropdown"). A plain
        // readonly box (same [readonly] look @dashboard/access4-sms's own
        // phone input already established) instead of a <select>, and the
        // button starts enabled since there's no selection to wait on.
        const singleDomain = c.domains.length === 1 ? c.domains[0] : null;
        const domainFieldHtml = singleDomain
          ? `<input type="text" class="npd-domain-single" style="width: ${selectWidth}" value="${escapeHtml(singleDomain.name)}" data-domain-id="${escapeHtml(singleDomain.id)}" readonly />`
          : `<select class="npd-domain-select" style="width: ${selectWidth}">
               <option value="">${escapeHtml(placeholderLabel)}</option>
               ${c.domains.map((d) => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)}</option>`).join('')}
             </select>`;
        return `
      <div class="npd-row" data-org-id="${escapeHtml(c.organizationId)}">
        <span class="npd-client-name">${c.organizationUrl ? `<a href="${escapeHtml(c.organizationUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(c.organizationName)}</a>` : escapeHtml(c.organizationName || '')}</span>
        ${domainFieldHtml}
        <button type="button" class="npd-set-primary-btn button-link button-link--small" ${singleDomain ? '' : 'disabled'}>Set as Primary</button>
        <p class="dm-match-status" hidden></p>
      </div>`;
      })
      .join('');
    npdRowsEl.querySelectorAll('.npd-row').forEach((rowEl) => wireNoPrimaryDomainRow(rowEl));
  }

  // On-page confirm (OK before Cancel, same convention @dashboard/data-
  // matching's own showInlineConfirm() already established), by request
  // ("present a warning next to the button stating domain.xxx.xx will be
  // set as Primary for client XXX, OK, Cancel") -- reuses that same shared
  // .dm-match-status/.dm-inline-confirm styling rather than a new one-off.
  function wireNoPrimaryDomainRow(rowEl) {
    const orgId = rowEl.dataset.orgId;
    const clientName = rowEl.querySelector('.npd-client-name').textContent;
    const select = rowEl.querySelector('.npd-domain-select');
    const singleInput = rowEl.querySelector('.npd-domain-single');
    const button = rowEl.querySelector('.npd-set-primary-btn');
    const statusEl2 = rowEl.querySelector('.dm-match-status');

    // The single-domain case has nothing to select at all -- its id/name
    // come straight off the readonly box, button already enabled from the
    // start (see renderNoPrimaryDomain above).
    function currentSelection() {
      if (singleInput) return { id: singleInput.dataset.domainId, name: singleInput.value };
      return { id: select.value, name: select.options[select.selectedIndex]?.textContent };
    }

    if (select) {
      select.addEventListener('change', () => {
        button.disabled = !select.value;
      });
    }

    function showInlineConfirm(message) {
      return new Promise((resolve) => {
        statusEl2.hidden = false;
        statusEl2.className = 'dm-match-status dm-inline-confirm';
        statusEl2.innerHTML = `
          <span class="dm-inline-confirm-message">${escapeHtml(message)}</span>
          <button type="button" class="button-link button-link--small dm-inline-confirm-ok-btn">OK</button>
          <button type="button" class="button-link button-link--small dm-inline-confirm-cancel-btn">Cancel</button>
        `;
        statusEl2.querySelector('.dm-inline-confirm-ok-btn').addEventListener('click', () => resolve(true), { once: true });
        statusEl2.querySelector('.dm-inline-confirm-cancel-btn').addEventListener('click', () => resolve(false), { once: true });
      });
    }

    button.addEventListener('click', async () => {
      const { id: domainId, name: domainName } = currentSelection();
      if (!domainId) return;
      const proceed = await showInlineConfirm(`${domainName} will be set as Primary for client ${clientName}.`);
      statusEl2.hidden = true;
      statusEl2.className = 'dm-match-status';
      if (!proceed) return;
      button.disabled = true;
      if (select) select.disabled = true;
      if (singleInput) singleInput.disabled = true;
      button.textContent = 'Setting...';
      try {
        const res = await fetch('/api/domain-itglue-gap/set-primary-domain', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ organizationId: orgId, domainId }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        // Done -- this client's no longer missing a Primary Domain, so its
        // row just disappears (update in place, same convention
        // toggleTick() below already uses, rather than a full re-fetch).
        lastNoPrimaryDomainClients = (lastNoPrimaryDomainClients || []).filter((c) => c.organizationId !== orgId);
        renderNoPrimaryDomain(lastNoPrimaryDomainClients);
      } catch (err) {
        statusEl2.hidden = false;
        statusEl2.className = 'status error dm-match-status'; // same combined-class convention @dashboard/data-matching's own validation errors use, so it still sizes/sits correctly inline in this row
        statusEl2.textContent = `Error: ${err.message}`;
        button.disabled = false;
        if (select) select.disabled = false;
        if (singleInput) singleInput.disabled = false;
        button.textContent = 'Set as Primary';
      }
    });
  }

  function renderLastRun(lastRun) {
    if (!lastRun) {
      lastRunEl.hidden = true;
      return;
    }
    lastRunEl.hidden = false;
    const when = formatDateTime(lastRun.timestamp);
    if (!lastRun.ok) {
      lastRunEl.className = 'cell-flag-red';
      lastRunEl.textContent = `Last run FAILED ${when}: ${lastRun.error}`;
      return;
    }
    lastRunEl.className = 'inline-subtext';
    const dryRunNote = lastRun.dryRun ? ' (dry run -- not written to Autotask)' : '';
    const ticketPart = lastRun.ticketNumber ? `, ticket ${lastRun.ticketNumber}` : '';
    lastRunEl.textContent = `Last run ${when}${dryRunNote} -- ${lastRun.gapCount} gap(s), ${lastRun.unmatchedCount} unmatched${ticketPart}.`;
  }

  // Small text next to the "Missing from IT Glue" heading, by request --
  // the open ticket's own number (linked) first, then the Refresh
  // reminder. ticket is null when the live lookup failed or no open
  // ticket exists (findOpenTicketInfo() in job.js) -- the reminder still
  // shows either way, just without a ticket number in front of it.
  function missingHeaderExtraHtml(ticket) {
    const ticketPart =
      ticket && ticket.ticketUrl
        ? `<a href="${escapeHtml(ticket.ticketUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(ticket.ticketNumber || `Ticket #${ticket.ticketId}`)}</a> -- `
        : '';
    return `<span class="dig-missing-header-note">${ticketPart}Press Refresh to update the Autotask Ticket with your updates.</span>`;
  }

  // One emphasis per summary line, by request (same convention every other
  // page's own summary line follows) -- the total open gap count is
  // bolded; the per-category/ticked breakdown sits alongside it unbolded.
  function renderSummary(summary) {
    summaryEl.hidden = false;
    const total = summary.gapCount + summary.unmatchedCount + summary.wrongClientCount + summary.emailDomainMismatchCount;
    summaryEl.innerHTML = `<strong>${total}</strong> currently open item${total === 1 ? '' : 's'} -- ${summary.gapCount} missing from IT Glue (${summary.gapTickedCount} ticked), ${summary.unmatchedCount} with no matching Autotask Client (${summary.unmatchedTickedCount} ticked), ${summary.wrongClientCount} under the wrong Client in IT Glue (${summary.wrongClientTickedCount} ticked), ${summary.emailDomainMismatchCount} different from their Primary Contact's email domain (${summary.emailDomainMismatchTickedCount} ticked)`;
  }

  function render(data) {
    statusEl.hidden = true;
    renderLastRun(data.lastRun);
    renderSummary(data.summary);
    resultsEl.innerHTML = '';

    const gapRows = data.rows.filter((r) => r.category === 'missing_from_itglue');
    const unmatchedRows = data.rows.filter((r) => r.category === 'unmatched_client');
    const wrongClientRows = data.rows.filter((r) => r.category === 'wrong_client');
    const emailDomainMismatchRows = data.rows.filter((r) => r.category === 'email_domain_mismatch');

    resultsEl.appendChild(
      sectionTable(
        'Missing from IT Glue',
        gapRows,
        [
          { key: 'domain', label: 'Domain', cell: (r) => escapeHtml(r.domainName), sort: (r) => r.domainName || '' },
          { key: 'expiry', label: 'Expiry Date', className: 'ticket-number', cell: (r) => formatDate(r.expiryDate), sort: (r) => r.expiryDate || '' },
          { key: 'tppAcc', label: 'TPP Acc', cell: (r) => escapeHtml(r.tppAccountReference || ''), sort: (r) => r.tppAccountReference || '' },
          {
            key: 'client',
            label: 'IT Glue Client Name',
            cell: (r) =>
              r.autotaskClientName && r.itglueOrgUrl
                ? `<a href="${escapeHtml(r.itglueOrgUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(r.autotaskClientName)}</a>`
                : escapeHtml(r.autotaskClientName || ''),
            sort: (r) => r.autotaskClientName || '',
          },
        ],
        'client',
        missingHeaderExtraHtml(data.ticket)
      )
    );
    resultsEl.appendChild(
      sectionTable(
        'No matching Autotask Client',
        unmatchedRows,
        [
          { key: 'domain', label: 'Domain', cell: (r) => escapeHtml(r.domainName), sort: (r) => r.domainName || '' },
          { key: 'expiry', label: 'Expiry Date', className: 'ticket-number', cell: (r) => formatDate(r.expiryDate), sort: (r) => r.expiryDate || '' },
          { key: 'tppAcc', label: 'TPP Account Reference', cell: (r) => escapeHtml(r.tppAccountReference || ''), sort: (r) => r.tppAccountReference || '' },
        ],
        'expiry',
        // By request -- these rows mean the TPP domain's accountReference
        // has no Name:TPP UDF match on any Autotask Company (see job.js's
        // own comment); that's exactly what Data Matching's own "TPP
        // Domains" view is for fixing, not something to resolve here.
        `<span class="dig-missing-header-note">Fix these on the <a href="#data-matching">Data Matching</a> page (TPP Domains).</span>`
      )
    );
    resultsEl.appendChild(
      sectionTable(
        'Wrong Client in IT Glue',
        wrongClientRows,
        [
          { key: 'domain', label: 'Domain', cell: (r) => escapeHtml(r.domainName), sort: (r) => r.domainName || '' },
          { key: 'expiry', label: 'Expiry Date', className: 'ticket-number', cell: (r) => formatDate(r.expiryDate), sort: (r) => r.expiryDate || '' },
          { key: 'tppAcc', label: 'TPP Acc', cell: (r) => escapeHtml(r.tppAccountReference || ''), sort: (r) => r.tppAccountReference || '' },
          {
            key: 'shouldBe',
            label: 'Autotask Client UDF',
            // Links to the real Autotask Company record, by request ("The
            // links in the 'Autotask Client UDF' column should go to
            // Autotask, not IT Glue") -- the Domain Tracker column right
            // after this one is the IT Glue link.
            cell: (r) =>
              r.autotaskClientName && r.autotaskClientUrl
                ? `<a href="${escapeHtml(r.autotaskClientUrl)}" target="_blank" rel="noopener noreferrer" onclick="window.open(this.href, '_blank', 'noopener,noreferrer,width=1200,height=900'); return false;">${escapeHtml(r.autotaskClientName)}</a>`
                : escapeHtml(r.autotaskClientName || ''),
            sort: (r) => r.autotaskClientName || '',
          },
          {
            key: 'currentlyUnder',
            label: 'Domain Tracker (IT Glue)',
            cell: (r) =>
              r.wrongItglueOrgName && r.wrongItglueOrgUrl
                ? `<a href="${escapeHtml(r.wrongItglueOrgUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(r.wrongItglueOrgName)}</a>`
                : escapeHtml(r.wrongItglueOrgName || ''),
            sort: (r) => r.wrongItglueOrgName || '',
          },
        ],
        'domain',
        // By request ("If a domain appears on an IT Glue Client but that
        // Client is not the same client as the Autotask Client on which
        // the TPP Account appears in the UDF") -- the domain IS in IT
        // Glue (so it's not a "Missing" gap), just under the wrong
        // organisation. Exact (case-insensitive) name match only, same
        // convention this whole job already follows -- a genuine naming
        // difference between an Autotask Client and its own IT Glue
        // organisation (not an actual misfiling) can also show up here.
        `<span class="dig-missing-header-note">Move the domain to the correct organisation in IT Glue.</span>`
      )
    );
    // Hidden behind a button by default, by request ("turns out most of
    // them are ok so let's just put a button at the bottom to view these
    // on request") -- still fully computed every run (ticket/CSV/summary
    // counts unaffected), just not shown automatically on this page.
    if (emailMismatchExpanded) {
      resultsEl.appendChild(
        sectionTable(
          'Email Domain Mismatch',
          emailDomainMismatchRows,
          [
            { key: 'domain', label: 'Domain', cell: (r) => escapeHtml(r.domainName), sort: (r) => r.domainName || '' },
            { key: 'expiry', label: 'Expiry Date', className: 'ticket-number', cell: (r) => formatDate(r.expiryDate), sort: (r) => r.expiryDate || '' },
            { key: 'tppAcc', label: 'TPP Acc', cell: (r) => escapeHtml(r.tppAccountReference || ''), sort: (r) => r.tppAccountReference || '' },
            {
              key: 'client',
              label: 'Autotask Client',
              cell: (r) =>
                r.autotaskClientName && r.itglueOrgUrl
                  ? `<a href="${escapeHtml(r.itglueOrgUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(r.autotaskClientName)}</a>`
                  : escapeHtml(r.autotaskClientName || ''),
              sort: (r) => r.autotaskClientName || '',
            },
            { key: 'contactEmailDomain', label: 'Primary Contact Email Domain', cell: (r) => escapeHtml(r.contactEmailDomain || ''), sort: (r) => r.contactEmailDomain || '' },
          ],
          'domain',
          // By request ("List where Domain is different from the domain of
          // the Primary Contact's email address in Autotask ... only do
          // this match for nominated primary domains in IT Glue") -- scoped
          // to just the ONE domain IT Glue itself says is primary for that
          // Client's organisation, not every domain the Client happens to
          // own (confirmed live this was the right call -- checking every
          // matched domain produced 319 mostly-noise rows; the primary-
          // domain-only version is a much tighter, more trustworthy list).
          `<span class="dig-missing-header-note">Only checks each Client's own nominated Primary Domain in IT Glue.</span>`
        )
      );
      const hideButton = document.createElement('button');
      hideButton.type = 'button';
      hideButton.className = 'button-link button-link--small';
      hideButton.textContent = 'Hide Email Domain Mismatches';
      hideButton.addEventListener('click', () => {
        emailMismatchExpanded = false;
        render(lastData);
      });
      resultsEl.appendChild(hideButton);
    } else {
      const showButton = document.createElement('button');
      showButton.type = 'button';
      showButton.className = 'button-link button-link--small';
      showButton.textContent = `View Email Domain Mismatches (${emailDomainMismatchRows.length})`;
      showButton.addEventListener('click', () => {
        emailMismatchExpanded = true;
        render(lastData);
      });
      resultsEl.appendChild(showButton);
    }
  }

  // Click-to-sort on every column (by request), plus the Done checkbox --
  // same "header built once, only tbody replaced on sort" convention
  // @dashboard/contact-search's own results table already established, so
  // a sort click never disturbs any other row's checkbox mid-interaction.
  function sectionTable(heading, rows, columns, defaultSortKey, headerExtraHtml) {
    const groupEl = document.createElement('div');
    groupEl.className = 'resource-group';
    const headerEl = document.createElement('div');
    headerEl.className = 'resource-group-header';
    // The count sits in brackets right after the heading TEXT, at the same
    // size as the heading (by request) -- not the dashboard's usual
    // smaller/muted .count badge, which is why this builds a plain string
    // here instead of using that class. headerExtraHtml sits in the same
    // flex item too, so it renders right next to the heading+count rather
    // than floating to the middle of the bar (this header has only ONE
    // top-level flex child now, not two).
    headerEl.innerHTML = `<span>${escapeHtml(heading)} (${rows.length})${headerExtraHtml || ''}</span>`;
    groupEl.appendChild(headerEl);

    if (rows.length === 0) {
      const p = document.createElement('p');
      p.className = 'status';
      p.textContent = 'Nothing currently open.';
      groupEl.appendChild(p);
      return groupEl;
    }

    let sortState = { key: defaultSortKey || columns[0].key, direction: 'asc' };

    const table = document.createElement('table');
    table.innerHTML = `
      <thead>
        <tr>
          ${columns.map((c) => `<th><button type="button" class="dig-sort-btn" data-key="${c.key}">${escapeHtml(c.label)}</button></th>`).join('')}
          <th><button type="button" class="dig-sort-btn" data-key="ticked">Done</button></th>
        </tr>
      </thead>
      <tbody></tbody>
    `;
    groupEl.appendChild(table);

    const tbody = table.querySelector('tbody');
    const sortButtons = [...table.querySelectorAll('.dig-sort-btn')];

    function updateSortButtonStyles() {
      for (const btn of sortButtons) {
        const isActive = sortState.key === btn.dataset.key;
        const label = btn.dataset.key === 'ticked' ? 'Done' : columns.find((c) => c.key === btn.dataset.key).label;
        btn.textContent = `${label}${isActive ? (sortState.direction === 'asc' ? ' ▲' : ' ▼') : ''}`;
        btn.classList.toggle('dig-sort-btn--active', isActive);
      }
    }

    function renderRows() {
      const sortValue = sortState.key === 'ticked' ? (r) => (r.ticked ? 1 : 0) : columns.find((c) => c.key === sortState.key).sort;
      const sorted = [...rows].sort((a, b) => {
        const av = sortValue(a);
        const bv = sortValue(b);
        const cmp = typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
        return sortState.direction === 'asc' ? cmp : -cmp;
      });
      tbody.innerHTML = sorted
        .map((r) => {
          // Ticked but STILL present means it didn't actually get fixed --
          // flagged rather than hidden, by request ("keep it ticked, but
          // flag it").
          const stillMissingFlag = r.ticked ? '<span class="cell-flag-red"> still showing as missing</span>' : '';
          return `
        <tr>
          ${columns.map((c) => `<td${c.className ? ` class="${c.className}"` : ''}>${c.cell(r)}</td>`).join('')}
          <td><label class="inline-checkbox-label" title="${r.ticked ? `Marked done${r.tickedByName ? ` by ${escapeHtml(r.tickedByName)}` : ''}${r.tickedAt ? ` on ${formatDateTime(r.tickedAt)}` : ''}` : 'Mark as handled'}">
            <input type="checkbox" class="gap-tick-input" data-domain="${escapeHtml(r.domainName)}" ${r.ticked ? 'checked' : ''} />
          </label>${stillMissingFlag}</td>
        </tr>`;
        })
        .join('');
      tbody.querySelectorAll('.gap-tick-input').forEach((input) => {
        input.addEventListener('change', () => toggleTick(input.dataset.domain, input.checked, input, renderRows));
      });
    }

    for (const btn of sortButtons) {
      btn.addEventListener('click', () => {
        const key = btn.dataset.key;
        sortState = { key, direction: sortState.key === key && sortState.direction === 'asc' ? 'desc' : 'asc' };
        updateSortButtonStyles();
        renderRows();
      });
    }

    updateSortButtonStyles();
    renderRows();
    return groupEl;
  }

  async function toggleTick(domainName, ticked, input, onSuccess) {
    input.disabled = true;
    try {
      const res = await fetch(`/api/domain-itglue-gap/${encodeURIComponent(domainName)}/tick`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticked }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      // Update in place rather than a full reload -- keeps scroll position
      // and every other row's own just-clicked state intact.
      const row = lastData.rows.find((r) => r.domainName === domainName);
      if (row) Object.assign(row, data);
      onSuccess(); // re-renders this table's own tbody so the "still showing as missing" flag/tooltip reflect the new state immediately
    } catch (err) {
      input.checked = !ticked; // revert the checkbox on failure
      statusEl.hidden = false;
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      input.disabled = false;
    }
  }

  if (lastData) render(lastData);
  else load(false);

  if (lastNoPrimaryDomainClients) renderNoPrimaryDomain(lastNoPrimaryDomainClients);
  else loadNoPrimaryDomain();

  function formatDate(isoDateOnly) {
    if (!isoDateOnly) return '';
    return new Date(`${isoDateOnly}T00:00:00.000Z`).toLocaleDateString(undefined, { timeZone: 'Australia/Brisbane' });
  }

  function formatDateTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString();
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
