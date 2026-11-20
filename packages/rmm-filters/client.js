export const id = "rmm-filters";
export const label = "RMM Filter Checks";

// Module-scope, not inside mount() -- same "survives a shell re-mount"
// convention every other page's client.js already uses.
let lastData = null;
let activeTabIndex = 0;
let activeSectionIndex = 0;

// The 3 result sections, as a second row of tabs underneath the filter tabs,
// by request ("turn this header into 3 tabs for each of the 3 report
// sections. So two rows of tabs") -- previously these were 3 always-visible
// stacked .resource-group tables. Shared between every filter tab (section
// choice persists across a filter-tab switch, same "stay on the view you
// were on" convention activeTabIndex itself already follows).
// `subTabWire` is the exact wire-format value server.js/db.js use
// ('missing'/'wrongly_included') -- present only on the two sections that
// have an Allowed Exceptions concept at all, by request ("on the Missing &
// Wrongly Included sub pages... Correct has none"); null on Correct skips
// the exception icon/list entirely for that section. `clientNameFor(r)`
// is what gets sent as the exception's own display name when marking a
// row -- Missing rows are always a real company; Wrongly Included rows
// fall back to the raw site name for the rare unresolved case (same
// fallback the Client column itself already shows).
const SECTIONS = [
  {
    key: 'missing',
    label: 'Missing',
    subTabWire: 'missing',
    emptyMessage: (tab) => `Every "${tab.classificationLabel}" client is present in this filter.`,
    columns: [{ label: 'Client', cell: (r) => (r.companyUrl ? `<a href="${escapeHtml(r.companyUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(r.companyName)}</a>` : escapeHtml(r.companyName)) }],
    clientNameFor: (r) => r.companyName,
  },
  {
    key: 'wronglyIncluded',
    label: 'Wrongly Included',
    subTabWire: 'wrongly_included',
    emptyMessage: () => 'Nothing in this filter is wrongly included.',
    columns: [
      {
        label: 'Client',
        cell: (r) =>
          r.companyUrl
            ? `<a href="${escapeHtml(r.companyUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(r.companyName)}</a>`
            : escapeHtml(r.companyName || r.siteName),
      },
      { label: 'Classification', cell: (r) => escapeHtml(r.classificationLabel || (r.companyName ? 'No classification set' : 'No matching Autotask company')) },
      { label: 'Devices', className: 'ticket-number', cell: (r) => String(r.deviceCount) },
    ],
    clientNameFor: (r) => r.companyName || r.siteName,
  },
  {
    key: 'correctlyPresent',
    label: 'Correct',
    subTabWire: null,
    emptyMessage: () => 'No clients are correctly present in this filter.',
    columns: [
      { label: 'Client', cell: (r) => `<a href="${escapeHtml(r.companyUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(r.companyName)}</a>` },
      { label: 'Devices', className: 'ticket-number', cell: (r) => String(r.deviceCount) },
    ],
  },
];

// Server now returns tab.missing/tab.wronglyIncluded as { items, exceptions
// } (an allowed-exception split, see rmm-filters/server.js's own
// splitByExceptions()) instead of a flat array -- tab.correctlyPresent is
// unchanged (still a flat array, no exceptions concept there). These two
// helpers paper over that difference so the rest of this file can treat
// every section the same way regardless of which shape it's reading.
function sectionItems(tab, section) {
  return section.subTabWire ? tab[section.key].items : tab[section.key];
}
function sectionExceptions(tab, section) {
  return section.subTabWire ? tab[section.key].exceptions : [];
}

// Small inline SVGs for the two Allowed Exceptions actions, by request.
// Plain Material-style checkmark/close glyphs (fill="currentColor", same
// "follows the button's own text colour" convention PERSON_ICON_SVG etc.
// use elsewhere on this dashboard), not a new icon system.
const MARK_EXCEPTION_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1.99 15l-5-5L6.42 10.58l3.59 3.59 7.59-7.59L19 8l-8.99 9z"/></svg>';
const REMOVE_EXCEPTION_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function mount(container) {
  // Same "narrower, tighter rows" page-scoped table style as Data
  // Matching/Domain IT Glue Gaps, by request.
  container.classList.add('rmm-filters-page');
  container.innerHTML = `
    <header class="page-header">
      <h1>RMM Filter Checks</h1>
      <button type="button" id="refresh-button" class="button-link button-link--small">Refresh</button>
    </header>
    <p class="inline-subtext">Filter content checks for any Datto RMM filter starting with "TC Elite *" or "TC ESS *" and compares them to Autotask clients with Classification "Tech Cover E*". Clients with an incorrect Classification will report as false negatives.</p>
    <p id="status" class="status">Loading...</p>
    <div id="as-of" class="inline-subtext" hidden></div>
    <div id="tabs" class="rmmf-tabs rmmf-tabs--primary" hidden></div>
    <div id="tab-panels"></div>
  `;

  const refreshButton = container.querySelector('#refresh-button');
  const statusEl = container.querySelector('#status');
  const asOfEl = container.querySelector('#as-of');
  const tabsEl = container.querySelector('#tabs');
  const panelsEl = container.querySelector('#tab-panels');

  refreshButton.addEventListener('click', () => load(true));

  async function load(force) {
    refreshButton.disabled = true;
    statusEl.hidden = false;
    statusEl.className = force ? 'status loading' : 'status';
    statusEl.textContent = force ? 'Refreshing live data (Datto RMM, Autotask)...' : 'Loading...';
    try {
      const res = await fetch(`/api/rmm-filters${force ? '?force=true' : ''}`);
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
    if (data.status === 'not-connected') {
      statusEl.hidden = false;
      statusEl.className = 'status error';
      statusEl.textContent = 'Datto RMM is not configured -- set DATTO_API_URL/DATTO_API_KEY (and DATTO_API_SECRET, if your key needs one) in .env.';
      asOfEl.hidden = true;
      tabsEl.hidden = true;
      panelsEl.innerHTML = '';
      return;
    }

    if (data.tabs.length === 0) {
      statusEl.hidden = false;
      statusEl.className = 'status error';
      statusEl.textContent = 'None of the expected filters ("TC Elite Servers Filter", "TC Elite Workstations Filter", "TC ESS Workstations Filter") were found on the real Datto RMM account.';
      asOfEl.hidden = true;
      tabsEl.hidden = true;
      panelsEl.innerHTML = '';
      return;
    }

    statusEl.hidden = true;
    asOfEl.hidden = false;
    asOfEl.textContent = `As of ${formatDateTime(data.asOf)}`;

    if (activeTabIndex >= data.tabs.length) activeTabIndex = 0;

    tabsEl.hidden = false;
    tabsEl.innerHTML = data.tabs
      .map((t, i) => `<button type="button" class="rmmf-tab${i === activeTabIndex ? ' rmmf-tab--active' : ''}" data-tab-index="${i}">${escapeHtml(t.name)}</button>`)
      .join('');
    tabsEl.querySelectorAll('.rmmf-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeTabIndex = Number(btn.dataset.tabIndex);
        render(lastData);
      });
    });

    panelsEl.innerHTML = '';
    panelsEl.appendChild(buildTabPanel(data.tabs[activeTabIndex]));
  }

  // Second row of tabs, by request ("make the Filters tabs look like tabs
  // over the ... header and turn this header into 3 tabs for each of the 3
  // report sections. So two rows of tabs") -- same .rmmf-tab* look as the
  // filter tabs above, just one row down. Section choice is shared
  // module-scope state (activeSectionIndex), so switching filter tabs stays
  // on whichever section (Missing/Wrongly Included/Correctly Present) was
  // already selected, same "stay on the view you were on" convention
  // activeTabIndex itself already follows.
  function buildTabPanel(tab) {
    if (activeSectionIndex >= SECTIONS.length) activeSectionIndex = 0;
    const wrap = document.createElement('div');

    const subTabsEl = document.createElement('div');
    subTabsEl.className = 'rmmf-tabs rmmf-subtabs';
    subTabsEl.innerHTML = SECTIONS.map(
      (s, i) =>
        `<button type="button" class="rmmf-tab${i === activeSectionIndex ? ' rmmf-tab--active' : ''}" data-section-index="${i}">${escapeHtml(s.label)} (${sectionItems(tab, s).length})</button>`
    ).join('');
    subTabsEl.querySelectorAll('.rmmf-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeSectionIndex = Number(btn.dataset.sectionIndex);
        render(lastData);
      });
    });
    wrap.appendChild(subTabsEl);

    const section = SECTIONS[activeSectionIndex];
    wrap.appendChild(sectionTable(sectionItems(tab, section), section, tab, section.emptyMessage(tab)));
    if (section.subTabWire) wrap.appendChild(exceptionsListEl(sectionExceptions(tab, section), section));
    return wrap;
  }

  // `section`/`tab` (not just columns) are now passed in -- the Action
  // column (Mark as Allowed Exception icon) only renders when
  // section.subTabWire is set (Missing/Wrongly Included, never Correct),
  // and its own data-* attributes need the real filter name (tab.name) and
  // each row's own subjectKey/display name (section.clientNameFor(r)).
  function sectionTable(rows, section, tab, emptyMessage) {
    const groupEl = document.createElement('div');
    groupEl.className = 'resource-group';

    if (rows.length === 0) {
      const p = document.createElement('p');
      p.className = 'status';
      p.textContent = emptyMessage;
      groupEl.appendChild(p);
      return groupEl;
    }

    const columns = section.columns;
    const table = document.createElement('table');
    table.innerHTML = `
      <thead><tr>${columns.map((c) => `<th>${escapeHtml(c.label)}</th>`).join('')}${section.subTabWire ? '<th></th>' : ''}</tr></thead>
      <tbody>${rows
        .map(
          (r) =>
            `<tr>${columns.map((c) => `<td${c.className ? ` class="${c.className}"` : ''}>${c.cell(r)}</td>`).join('')}${
              section.subTabWire
                ? `<td class="rmmf-action-cell"><button type="button" class="rmmf-exception-btn" title="Mark as Allowed Exception" data-filter-name="${escapeHtml(tab.name)}" data-sub-tab="${section.subTabWire}" data-subject-key="${escapeHtml(r.subjectKey)}" data-client-name="${escapeHtml(section.clientNameFor(r))}">${MARK_EXCEPTION_ICON_SVG}</button></td>`
                : ''
            }</tr>`
        )
        .join('')}</tbody>
    `;
    groupEl.appendChild(table);
    return groupEl;
  }

  // Allowed Exceptions list, below the main table -- by request. Each
  // exception row is the SAME shape as a main-list row (splitByExceptions()
  // in server.js just spreads the original row plus exceptionId), so
  // section.clientNameFor(r) works unchanged here too.
  function exceptionsListEl(exceptions, section) {
    const wrap = document.createElement('div');
    wrap.className = 'rmmf-exceptions';
    const heading = document.createElement('div');
    heading.className = 'section-heading section-heading--nav';
    heading.textContent = `Allowed Exceptions (${exceptions.length})`;
    wrap.appendChild(heading);

    if (exceptions.length === 0) {
      const p = document.createElement('p');
      p.className = 'status';
      p.textContent = 'No allowed exceptions for this list.';
      wrap.appendChild(p);
      return wrap;
    }

    const ul = document.createElement('ul');
    ul.className = 'rmmf-exceptions-list';
    ul.innerHTML = exceptions
      .map(
        (e) =>
          `<li><button type="button" class="rmmf-exception-remove-btn" title="Remove from Allowed Exceptions" data-exception-id="${e.exceptionId}">${REMOVE_EXCEPTION_ICON_SVG}</button><span>${escapeHtml(section.clientNameFor(e))}</span></li>`
      )
      .join('');
    wrap.appendChild(ul);
    return wrap;
  }

  // Delegated once on the stable #tab-panels container, not re-wired per
  // render -- buildTabPanel() rebuilds this element's content on every
  // render, same "listener on the ancestor keeps working regardless"
  // convention used throughout this dashboard. Both Allowed Exceptions
  // actions just reload (load(false)) on success rather than patching the
  // DOM in place -- getRmmFilters(false) re-applies the live exceptions
  // split against the still-cached raw data (server.js), so this is a
  // cheap local-only round trip, not a fresh Datto RMM/Autotask pull.
  panelsEl.addEventListener('click', async (e) => {
    const markBtn = e.target.closest('.rmmf-exception-btn');
    if (markBtn) {
      const { filterName, subTab, subjectKey, clientName } = markBtn.dataset;
      markBtn.disabled = true;
      try {
        const res = await fetch('/api/rmm-filters/exceptions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filterName, subTab, subjectKey, clientName }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        await load(false);
      } catch (err) {
        alert(`Error marking exception: ${err.message}`);
        markBtn.disabled = false;
      }
      return;
    }
    const removeBtn = e.target.closest('.rmmf-exception-remove-btn');
    if (removeBtn) {
      removeBtn.disabled = true;
      try {
        const res = await fetch(`/api/rmm-filters/exceptions/${removeBtn.dataset.exceptionId}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
        await load(false);
      } catch (err) {
        alert(`Error removing exception: ${err.message}`);
        removeBtn.disabled = false;
      }
    }
  });

  if (lastData) render(lastData);
  else load(false);

  function formatDateTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString();
  }
}
