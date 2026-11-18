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
const SECTIONS = [
  {
    key: 'missing',
    label: 'Missing',
    emptyMessage: (tab) => `Every "${tab.classificationLabel}" client is present in this filter.`,
    columns: [{ label: 'Client', cell: (r) => (r.companyUrl ? `<a href="${escapeHtml(r.companyUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(r.companyName)}</a>` : escapeHtml(r.companyName)) }],
  },
  {
    key: 'wronglyIncluded',
    label: 'Wrongly Included',
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
  },
  {
    key: 'correctlyPresent',
    label: 'Correct',
    emptyMessage: () => 'No clients are correctly present in this filter.',
    columns: [
      { label: 'Client', cell: (r) => `<a href="${escapeHtml(r.companyUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(r.companyName)}</a>` },
      { label: 'Devices', className: 'ticket-number', cell: (r) => String(r.deviceCount) },
    ],
  },
];

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
        `<button type="button" class="rmmf-tab${i === activeSectionIndex ? ' rmmf-tab--active' : ''}" data-section-index="${i}">${escapeHtml(s.label)} (${tab[s.key].length})</button>`
    ).join('');
    subTabsEl.querySelectorAll('.rmmf-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeSectionIndex = Number(btn.dataset.sectionIndex);
        render(lastData);
      });
    });
    wrap.appendChild(subTabsEl);

    const section = SECTIONS[activeSectionIndex];
    wrap.appendChild(sectionTable(tab[section.key], section.columns, section.emptyMessage(tab)));
    return wrap;
  }

  function sectionTable(rows, columns, emptyMessage) {
    const groupEl = document.createElement('div');
    groupEl.className = 'resource-group';

    if (rows.length === 0) {
      const p = document.createElement('p');
      p.className = 'status';
      p.textContent = emptyMessage;
      groupEl.appendChild(p);
      return groupEl;
    }

    const table = document.createElement('table');
    table.innerHTML = `
      <thead><tr>${columns.map((c) => `<th>${escapeHtml(c.label)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${columns.map((c) => `<td${c.className ? ` class="${c.className}"` : ''}>${c.cell(r)}</td>`).join('')}</tr>`).join('')}</tbody>
    `;
    groupEl.appendChild(table);
    return groupEl;
  }

  if (lastData) render(lastData);
  else load(false);

  function formatDateTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString();
  }
}
