export const id = "tc-elite";
export const label = "TC Elite Summary";

// First pass, by request ("let's start with that and see what we get") --
// every client currently on a "Tech Cover Elite" contract, with a seat
// count summed from that contract's own real TC Elite service lines
// (current period only, positive $ value only). See server.js's own
// comment for the full methodology and the honest "units isn't always a
// literal person-seat count" caveat.

let lastData = null; // module-scope, survives the shell's teardown/re-mount, same convention every other page here uses

// Month selector, by request ("add a selection for Month and use the
// contracts in that month for the list. Default to Next Month.") --
// 'selectedMonth' ("YYYY-MM") is sent to the server, which picks the 1st
// of that month as the day whose billing period counts as "current"
// (see server.js's own comment). Offered range: next month at the top,
// then back 13 months from there, by request -- newest/most-useful
// first, not an unbounded dropdown. Plain local-date math (not
// AEST-anchored) -- a month-level UI default doesn't need AEST precision,
// unlike a same-day financial cutoff elsewhere on this dashboard.
function monthKeyOffset(offset) {
  const d = new Date();
  d.setDate(1); // avoid a short-month rollover (e.g. Jan 31 + 1 month skipping to Mar)
  d.setMonth(d.getMonth() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function monthLabelFor(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}
let selectedMonth = monthKeyOffset(1); // defaults to next month, by request

// Column sort, by request ("allow sort by any column") -- client-side
// only, re-sorting the already-fetched rows in place, no re-fetch needed.
// 'seats' descending (biggest clients first, the order the server
// already returns) is the starting point so a fresh page load looks
// unchanged until a header is actually clicked.
let sortColumn = 'seats';
let sortDirection = 'desc';

const SORT_KEYS = {
  client: (r) => (r.companyName || '').toLowerCase(),
  seats: (r) => r.seats,
  price: (r) => r.totalPrice,
  lines: (r) => r.lines.length,
};
const SORT_LABELS = { client: 'Client', seats: 'Seats', price: '$ (current period)', lines: 'Lines' };

function sortRows(rows) {
  const keyFor = SORT_KEYS[sortColumn] || SORT_KEYS.seats;
  const dir = sortDirection === 'desc' ? -1 : 1;
  return [...rows].sort((a, b) => {
    const ka = keyFor(a);
    const kb = keyFor(b);
    const cmp = typeof ka === 'number' ? ka - kb : ka.localeCompare(kb);
    if (cmp !== 0) return cmp * dir;
    return (a.companyName || '').localeCompare(b.companyName || '');
  });
}

export function mount(container) {
  container.innerHTML = `
    <div class="tc-elite-page">
      <header class="page-header">
        <h1>TC Elite Summary</h1>
        <div class="date-form">
          <label for="month-select">Month</label>
          <select id="month-select">
            ${Array.from({ length: 14 }, (_, i) => monthKeyOffset(1 - i))
              .map((key) => `<option value="${key}"${key === selectedMonth ? ' selected' : ''}>${monthLabelFor(key)}</option>`)
              .join('')}
          </select>
          <button type="button" id="refresh-button">Refresh</button>
        </div>
      </header>
      <p id="status" class="status">Every client on a "Tech Cover Elite" contract (any variant name, e.g. "Tech Cover Elite [3 Years]") whose billing period covers the selected month -- seats summed from that period's own positive-value TC Elite lines, $ summed from every line, credits/discounts included. Clients with a parent company are listed separately below. Hover a row's Lines count for the breakdown.</p>
      <div id="summary" class="summary" hidden></div>
      <div id="results"></div>
    </div>
  `;

  const refreshButton = container.querySelector('#refresh-button');
  const monthSelect = container.querySelector('#month-select');
  const statusEl = container.querySelector('#status');
  const summaryEl = container.querySelector('#summary');
  const resultsEl = container.querySelector('#results');

  refreshButton.addEventListener('click', () => load(true));
  // Changing the month was never actually wired to a reload -- the
  // dropdown updated but every request still asked for whatever month
  // the page happened to load with, so the list never changed. Fixed:
  // picking a month updates selectedMonth and reloads for real.
  monthSelect.addEventListener('change', () => {
    selectedMonth = monthSelect.value;
    load(false);
  });

  if (lastData && lastData.month === selectedMonth) render(lastData);
  else load(false);

  async function load(force) {
    refreshButton.disabled = true;
    resultsEl.innerHTML = '';
    summaryEl.hidden = true;
    try {
      const res = await fetch(`/api/tc-elite?month=${selectedMonth}${force ? '&force=true' : ''}`);
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

  // Clients/Seats/$ all render in the same plain text weight on one
  // line, by request ("don't use different sized text on the one line")
  // -- no bolded number for any of them.
  function summaryLineHtml(rows) {
    const totalSeats = rows.reduce((sum, r) => sum + r.seats, 0);
    const totalPrice = rows.reduce((sum, r) => sum + r.totalPrice, 0);
    return `${rows.length} client${rows.length === 1 ? '' : 's'} with TC Elite &middot; ${totalSeats} seat${totalSeats === 1 ? '' : 's'} &middot; $${totalPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} total`;
  }

  function render(data) {
    if (data.rows.length === 0) {
      summaryEl.hidden = true;
      resultsEl.innerHTML = '<p class="status">No clients found with a current, positive-value TC Elite line.</p>';
      return;
    }

    // Clients with a parent company get their own separate list at the
    // bottom, by request -- same real hasParent/parentCompanyName fields
    // TC Services' own identical grouping already uses (server.js's own
    // comment). A client with a parent is usually billed/managed through
    // that parent, so it's worth seeing those as their own group rather
    // than mixed in alphabetically with every standalone client above.
    // Each group gets its OWN totals line, by request ("Is this the
    // totals for both groups? Have this for each table separately") --
    // the top-level #summary is no longer a combined-everyone total.
    const standaloneRows = data.rows.filter((r) => !r.hasParent);
    const parentRows = data.rows.filter((r) => r.hasParent);

    summaryEl.hidden = false;
    summaryEl.innerHTML = `${summaryLineHtml(standaloneRows)} <span class="inline-subtext">(as of ${new Date(data.asOf).toLocaleString()})</span>`;

    resultsEl.innerHTML = '';
    resultsEl.appendChild(renderTable(standaloneRows, { showParentColumn: false }));

    if (parentRows.length > 0) {
      const section = document.createElement('div');
      section.innerHTML = `
        <h2 class="client-summary-section-heading">Clients with a Parent Company <span class="inline-subtext">(${parentRows.length})</span></h2>
        <p class="summary">${summaryLineHtml(parentRows)}</p>
      `;
      section.appendChild(renderTable(parentRows, { showParentColumn: true }));
      resultsEl.appendChild(section);
    }
  }

  function renderTable(rows, { showParentColumn }) {
    const wrap = document.createElement('div');
    if (rows.length === 0) {
      wrap.innerHTML = '<p class="status">No clients.</p>';
      return wrap;
    }
    const sortedRows = sortRows(rows);
    const rowsHtml = sortedRows
      .map((r) => {
        const lineCount = r.lines.length;
        const tooltip = r.lines.map((l) => `${l.description || '(no description)'} -- ${l.units} unit${l.units === 1 ? '' : 's'}, $${l.price.toFixed(2)} (${formatDate(l.periodStart)} - ${formatDate(l.periodEnd)})`).join('\n');
        return `
          <tr>
            <td>${r.companyUrl ? `<a href="${escapeHtml(r.companyUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(r.companyName)}</a>` : escapeHtml(r.companyName)}</td>
            ${showParentColumn ? `<td>${escapeHtml(r.parentCompanyName)}</td>` : ''}
            <td class="col-center">${r.seats}</td>
            <td>$${r.totalPrice.toFixed(2)}</td>
            <td class="col-center" title="${escapeHtml(tooltip)}">${lineCount}</td>
          </tr>`;
      })
      .join('');

    wrap.innerHTML = `
      <table>
        <thead>
          <tr>
            ${sortableHeaderHtml('client', '')}
            ${showParentColumn ? '<th>Parent</th>' : ''}
            ${sortableHeaderHtml('seats', 'col-center')}
            ${sortableHeaderHtml('price', '')}
            ${sortableHeaderHtml('lines', 'col-center')}
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    `;
    wrap.querySelectorAll('.sortable-th').forEach((th) => {
      th.addEventListener('click', () => {
        const key = th.dataset.sortKey;
        if (sortColumn === key) sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
        else {
          sortColumn = key;
          sortDirection = key === 'client' ? 'asc' : 'desc';
        }
        render(lastData);
      });
    });
    return wrap;
  }

  // Every header is click-to-sort, by request ("allow sort by any
  // column"). A small ▲/▼ marks the active column/direction; clicking
  // the same header again flips direction, clicking a different one
  // switches to it (descending for the numeric columns, ascending for
  // Client -- whichever reads naturally first for that column).
  function sortableHeaderHtml(key, extraClass) {
    const active = sortColumn === key;
    const arrow = active ? (sortDirection === 'desc' ? ' ▼' : ' ▲') : '';
    const cls = ['sortable-th', extraClass].filter(Boolean).join(' ');
    return `<th class="${cls}" data-sort-key="${key}">${escapeHtml(SORT_LABELS[key])}${arrow}</th>`;
  }

  function formatDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString();
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
