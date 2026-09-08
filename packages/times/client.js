export const id = "times";
export const label = "Time Summaries";

// Module-scope, not inside mount() -- the shell fully tears down and
// re-mounts a page's DOM on every navigation away and back, but the
// dynamically-imported module itself is cached by the browser and stays
// alive for the session, so this survives across re-mounts and lets the
// last result (and the user's own from/to/resource picks) restore
// instantly instead of coming back blank. Same convention as every other
// page here.
let lastParams = null; // { from, to, resourceIds: number[] | null }
let lastData = null;
let allResources = null; // [{id, name}], fetched once, reused across remounts

// Unticked by default, by request -- everyone else starts ticked. Matched
// by exact resolved name (same "First Last" shape /api/times/resources
// returns), not id, since this is a one-off request rather than a stable
// id list someone's expected to maintain.
const DEFAULT_UNCHECKED_NAMES = new Set(['Damon Kirkpatrick', 'Melissa Tannock', 'Amber Worth', 'Matt Jeavons', 'Autotask Administrator']);

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>Time Summaries</h1>
    </header>
    <form id="times-form" class="date-form date-form--stacked">
      <div class="date-form-row">
        <label for="from-input">From</label>
        <input type="date" id="from-input" name="from" required />
        <label for="to-input">To</label>
        <input type="date" id="to-input" name="to" required />
      </div>
      <div class="date-form-row">
        <details id="resource-picker" class="tm-resource-picker">
          <summary id="resource-picker-summary">All resources</summary>
          <div class="tm-resource-picker-panel">
            <div class="tm-resource-picker-actions">
              <button type="button" id="resources-all">All</button>
              <button type="button" id="resources-none">None</button>
            </div>
            <div id="resource-checkboxes" class="tm-resource-checkboxes">Loading resources...</div>
          </div>
        </details>
        <button type="submit">Load</button>
      </div>
    </form>
    <p id="status" class="status">Pick a date range and (optionally) narrow the resources, then click Load.</p>
    <div id="summary" class="summary" hidden></div>
    <div id="results"></div>
  `;

  const form = container.querySelector('#times-form');
  const fromInput = container.querySelector('#from-input');
  const toInput = container.querySelector('#to-input');
  const resourcePicker = container.querySelector('#resource-picker');
  const resourcePickerSummary = container.querySelector('#resource-picker-summary');
  const resourceCheckboxesEl = container.querySelector('#resource-checkboxes');
  const resourcesAllBtn = container.querySelector('#resources-all');
  const resourcesNoneBtn = container.querySelector('#resources-none');
  const statusEl = container.querySelector('#status');
  const summaryEl = container.querySelector('#summary');
  const resultsEl = container.querySelector('#results');

  // AEST (UTC+10, no DST in Queensland) "today", not the browser's own
  // local timezone -- same helper/reasoning as Ticket Times' own todayISO().
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

  if (lastParams) {
    fromInput.value = lastParams.from;
    toInput.value = lastParams.to;
  } else {
    // Last week, Mon-Sun, by request -- not the current in-progress week.
    // This week's Monday minus 7 days is last week's Monday; minus 1 day
    // (i.e. the day before this week's Monday) is last week's Sunday.
    const thisMonday = mondayOfWeek(todayISO());
    fromInput.value = addDays(thisMonday, -7);
    toInput.value = addDays(thisMonday, -1);
  }

  function selectedResourceIds() {
    const boxes = [...resourceCheckboxesEl.querySelectorAll('input[type="checkbox"]')];
    if (boxes.length === 0) return null;
    const checked = boxes.filter((b) => b.checked).map((b) => Number(b.value));
    return checked.length === boxes.length ? null : checked; // every box checked === "all", same as no filter
  }

  function updatePickerSummary() {
    const boxes = [...resourceCheckboxesEl.querySelectorAll('input[type="checkbox"]')];
    const checked = boxes.filter((b) => b.checked);
    if (boxes.length === 0 || checked.length === boxes.length) resourcePickerSummary.textContent = 'All resources';
    else if (checked.length === 0) resourcePickerSummary.textContent = 'No resources selected';
    else resourcePickerSummary.textContent = `${checked.length} resource${checked.length === 1 ? '' : 's'} selected`;
  }

  async function loadResourceList() {
    if (allResources) {
      renderCheckboxes();
      return;
    }
    try {
      const res = await fetch('/api/times/resources');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      allResources = data.resources;
      renderCheckboxes();
    } catch (err) {
      resourceCheckboxesEl.textContent = `Error loading resources: ${err.message}`;
    }
  }

  function renderCheckboxes() {
    // lastParams is only set once a Load has actually happened this
    // session (module-scope, survives remount) -- distinct from
    // lastParams.resourceIds itself being null, which means "every box
    // was checked" on that submit. Only the true first-ever render (no
    // Load yet) uses the unticked-by-default names; a remount after a
    // real "all" submission stays "all", not back to the defaults.
    const preselected = lastParams && lastParams.resourceIds ? new Set(lastParams.resourceIds) : null;
    resourceCheckboxesEl.innerHTML = allResources
      .map((r) => {
        let checked;
        if (lastParams) checked = preselected ? preselected.has(r.id) : true;
        else checked = !DEFAULT_UNCHECKED_NAMES.has(r.name);
        return `<label class="tm-resource-checkbox"><input type="checkbox" value="${r.id}" ${checked ? 'checked' : ''} /> ${escapeHtml(r.name)}</label>`;
      })
      .join('');
    resourceCheckboxesEl.querySelectorAll('input[type="checkbox"]').forEach((b) => {
      b.addEventListener('change', updatePickerSummary);
    });
    updatePickerSummary();
  }

  resourcesAllBtn.addEventListener('click', () => {
    resourceCheckboxesEl.querySelectorAll('input[type="checkbox"]').forEach((b) => (b.checked = true));
    updatePickerSummary();
  });
  resourcesNoneBtn.addEventListener('click', () => {
    resourceCheckboxesEl.querySelectorAll('input[type="checkbox"]').forEach((b) => (b.checked = false));
    updatePickerSummary();
  });
  // Picking a resource shouldn't also submit the form -- <details> inside a
  // <form> is fine, but Enter-to-submit and the "click a label" flow are
  // both left as native browser behaviour; only the panel's own click
  // shouldn't bubble out and close it early, which <details>/<summary>
  // already handles correctly with no extra JS needed.
  void resourcePicker;

  loadResourceList();

  if (lastData) render(lastData);

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
    const resourceIds = selectedResourceIds();
    lastParams = { from, to, resourceIds };

    const submitButton = form.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    statusEl.className = 'status';
    statusEl.textContent = 'Loading...';
    summaryEl.hidden = true;
    resultsEl.innerHTML = '';

    try {
      const qs = new URLSearchParams({ from, to });
      if (resourceIds) qs.set('resourceIds', resourceIds.join(','));
      const res = await fetch(`/api/times?${qs.toString()}`);
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

  function render(data) {
    statusEl.hidden = true;
    if (data.resources.length === 0) {
      summaryEl.hidden = true;
      resultsEl.innerHTML = '<p class="status">No resources selected.</p>';
      return;
    }

    summaryEl.hidden = false;
    summaryEl.innerHTML = `${data.from} to ${data.to} <span class="inline-subtext">(${data.weekdayCount} weekday${data.weekdayCount === 1 ? '' : 's'} in this period, ${data.normalHoursPerDay} normal hours/day)</span>`;

    const sumOf = (key) => data.resources.reduce((s, r) => s + r[key], 0);

    function summaryRow(label, key, opts = {}) {
      const cells = data.resources.map((r) => `<td class="col-center">${formatHours(r[key])}</td>`).join('');
      const total = sumOf(key);
      const totalCell = opts.total !== false ? `<td class="col-center"><strong>${formatHours(total)}</strong></td>` : '<td></td>';
      const hmsCell = opts.total !== false ? `<td class="col-center">${formatHms(total)}</td>` : '<td></td>';
      return `<tr${opts.strong ? ' class="tm-total-row"' : ''}><th>${smallCapsHtml(label)}</th>${cells}${totalCell}${hmsCell}</tr>`;
    }

    // First name only, by request -- full name still available on hover
    // (title attribute) so a shared first name (or "Autotask
    // Administrator", which has no real surname split) is never actually
    // ambiguous, just narrower to read at a glance.
    const headerCells = data.resources
      .map((r) => `<th class="col-center" title="${escapeHtml(r.resourceName)}">${smallCapsHtml(r.resourceName.split(' ')[0])}</th>`)
      .join('');

    // Shared shape for every "one row per named bucket, Total row
    // underneath" table on this page (AITTIME breakdown, client contract
    // breakdown) -- Resource columns across the top exactly like the
    // Hours Summary table, a per-row Total column, and a bottom Total row
    // summed per resource across every named row.
    function totalByResource(rows) {
      const totals = new Map();
      for (const row of rows) {
        for (const r of data.resources) totals.set(r.resourceId, (totals.get(r.resourceId) || 0) + (row.hours[r.resourceId] || 0));
      }
      return totals;
    }
    function rowLabelHtml(label) {
      if (label.startsWith('T&M')) return `<span class="tm-caps-force">T&amp;M</span>${smallCapsHtml(label.slice(3))}`;
      return smallCapsHtml(label);
    }
    function namedRowsHtml(rows, nameKey) {
      return rows
        .map((row) => {
          const rowTotal = data.resources.reduce((s, r) => s + (row.hours[r.resourceId] || 0), 0);
          const cells = data.resources.map((r) => `<td class="col-center">${formatHours(row.hours[r.resourceId] || 0)}</td>`).join('');
          return `<tr><th>${rowLabelHtml(row[nameKey])}</th>${cells}<td class="col-center"><strong>${formatHours(rowTotal)}</strong></td><td class="col-center">${formatHms(rowTotal)}</td></tr>`;
        })
        .join('');
    }
    function totalRowHtml(totals) {
      const grand = [...totals.values()].reduce((s, h) => s + h, 0);
      return `<tr class="tm-total-row"><th>${smallCapsHtml('Total')}</th>${data.resources
        .map((r) => `<td class="col-center">${formatHours(totals.get(r.resourceId) || 0)}</td>`)
        .join('')}<td class="col-center"><strong>${formatHours(grand)}</strong></td><td class="col-center">${formatHms(grand)}</td></tr>`;
    }

    const aittimeTotalByResource = totalByResource(data.aittime);
    const aittimeRowsHtml = namedRowsHtml(data.aittime, 'title');
    const aittimeTotalRow = totalRowHtml(aittimeTotalByResource);

    const clientContractsTotals = totalByResource(data.clientContracts);
    const clientContractsRowsHtml = namedRowsHtml(data.clientContracts, 'contractName');
    const clientContractsTotalRow = totalRowHtml(clientContractsTotals);

    // Work-Type Reconciliation -- NOT fetched as part of the main load, by
    // request ("we can not retrieve it by default so the page is
    // faster"). Built from data.resources (unchanged, already in scope)
    // plus whatever the on-demand /work-type fetch below returns; the
    // same namedRowsHtml/totalByResource/totalRowHtml helpers work
    // unmodified since they only need row.hours + data.resources, not
    // data.workTypeBillable itself.
    function workTypeTableHtml(rows) {
      return { rowsHtml: namedRowsHtml(rows, 'workType'), totalRow: totalRowHtml(totalByResource(rows)) };
    }

    // Total Client Hours Billable -- same rows as Total Client Hours
    // Recorded (same contract grouping, same T&M TC Elite* merge, same
    // Other/Blank catch-all), by request, but each cell holds a pair
    // {worked, toBill} instead of a single number (only entries NOT
    // flagged non-billable count at all -- see server.js's own comment),
    // so this gets its own small set of cell/total helpers rather than
    // reusing namedRowsHtml/totalByResource/totalRowHtml as-is.
    // Per-resource cells show only the worked figure, with toBill as a
    // hover tooltip (on the <td> itself) rather than visible text, by
    // request -- the bracketed pair only shows up VISIBLY, in the Total
    // column, where it's meant to be read at a glance. That column is
    // already the table's own last-child (styles.css widens it and turns
    // off wrapping for exactly this pair), so no extra class is needed
    // here to keep it on one line.
    function billableCellHtml(cell) {
      const c = cell || { worked: 0, toBill: 0 };
      return `<td class="col-center" title="To bill: ${formatHours(c.toBill)}">${formatHours(c.worked)}</td>`;
    }
    function billableTotalCellHtml(cell, strong, mismatch) {
      const c = cell || { worked: 0, toBill: 0 };
      // The bracketed toBill figure stays un-bold and smaller, by request,
      // even when the worked figure next to it is bold (tm-total-bracket
      // explicitly resets font-weight rather than just inheriting <strong>).
      // `mismatch` (Non-Billable's own grand total only, see
      // buildWorkedToBillTable() below) turns the worked figure red, by
      // request, when it disagrees with Recorded-minus-Billable.
      const workedText = formatHours(c.worked);
      const worked = mismatch ? `<span class="tm-mismatch">${workedText}</span>` : workedText;
      const bracket = `<span class="tm-total-bracket">(${formatHours(c.toBill)})</span>`;
      const workedHtml = strong ? `<strong>${worked}</strong>` : worked;
      return `<td class="col-center">${workedHtml} ${bracket}</td>`;
    }
    function billableTotalByResource(rows) {
      const totals = new Map();
      for (const row of rows) {
        for (const r of data.resources) {
          const cell = row.hours[r.resourceId];
          if (!cell) continue;
          const t = totals.get(r.resourceId) || { worked: 0, toBill: 0 };
          t.worked += cell.worked;
          t.toBill += cell.toBill;
          totals.set(r.resourceId, t);
        }
      }
      return totals;
    }
    function sumCells(cells) {
      return cells.reduce((acc, c) => (c ? { worked: acc.worked + c.worked, toBill: acc.toBill + c.toBill } : acc), { worked: 0, toBill: 0 });
    }
    // Shared by Billable and Non-Billable -- same {worked, toBill}-per-cell
    // shape either way (see server.js's own buildClientContractSplitHours()
    // comment), just a different half of the same isNonBillable split.
    // HH:MM (the new right-hand column, by request, on every table) reads
    // the row's own Total figure -- for this table that's the primary
    // (worked) half of the Total column's pair, not the bracketed toBill
    // figure.
    function buildWorkedToBillTable(rows, grandTotalMismatch) {
      const rowsHtml = rows
        .map((row) => {
          const rowTotal = sumCells(data.resources.map((r) => row.hours[r.resourceId]));
          const cells = data.resources.map((r) => billableCellHtml(row.hours[r.resourceId])).join('');
          return `<tr><th>${rowLabelHtml(row.contractName)}</th>${cells}${billableTotalCellHtml(rowTotal, true)}<td class="col-center">${formatHms(rowTotal.worked)}</td></tr>`;
        })
        .join('');
      const totals = billableTotalByResource(rows);
      const grandTotal = sumCells([...totals.values()]);
      const totalRow = `<tr class="tm-total-row"><th>${smallCapsHtml('Total')}</th>${data.resources
        .map((r) => billableCellHtml(totals.get(r.resourceId)))
        .join('')}${billableTotalCellHtml(grandTotal, true, grandTotalMismatch)}<td class="col-center">${formatHms(grandTotal.worked)}</td></tr>`;
      return { rowsHtml, totalRow, totals, grandTotal };
    }

    const clientContractsBillableTable = buildWorkedToBillTable(data.clientContractsBillable);

    // Recorded less Billable -- a normal (non-blue) row under the Billable
    // table's own Total row, by request: each resource's Recorded total
    // minus that same resource's Billable (worked) total -- what the
    // Non-Billable total SHOULD be, derived independently of the actual
    // Non-Billable table. Compared against Non-Billable's own real grand
    // total below; a real mismatch turns that figure red there.
    const recordedGrandTotal = [...clientContractsTotals.values()].reduce((s, h) => s + h, 0);
    const recordedLessBillableCells = data.resources.map((r) => {
      const recorded = clientContractsTotals.get(r.resourceId) || 0;
      const billable = (clientContractsBillableTable.totals.get(r.resourceId) || { worked: 0 }).worked;
      return recorded - billable;
    });
    const recordedLessBillableGrandTotal = recordedGrandTotal - clientContractsBillableTable.grandTotal.worked;
    const recordedLessBillableRow = `<tr class="tm-no-total-shading"><th>${smallCapsHtml('Recorded less Billable')}</th>${data.resources
      .map((r, i) => `<td class="col-center">${formatHours(recordedLessBillableCells[i])}</td>`)
      .join('')}<td class="col-center"><strong>${formatHours(recordedLessBillableGrandTotal)}</strong></td><td class="col-center">${formatHms(recordedLessBillableGrandTotal)}</td></tr>`;

    // Non-Billable's own grand total, compared against Recorded-less-
    // Billable above -- a real disagreement (beyond floating-point residue)
    // turns Non-Billable's Total-column worked figure red, by request.
    const nonBillableGrandTotalWorked = sumCells(
      [...billableTotalByResource(data.clientContractsNonBillable).values()]
    ).worked;
    const nonBillableMismatch = Math.abs(nonBillableGrandTotalWorked - recordedLessBillableGrandTotal) > 0.01;
    const clientContractsNonBillableTable = buildWorkedToBillTable(data.clientContractsNonBillable, nonBillableMismatch);

    // "... less AITTIME" -- Total Hours and Ticket (Recorded) Hours with
    // each resource's own AITTIME total subtracted back out, so AITTIME's
    // internal, non-client time doesn't inflate either figure. Resource
    // names repeated across the top again (same headerCells), by request.
    function lessAittimeRow(label, key) {
      const valueFor = (r) => r[key] - (aittimeTotalByResource.get(r.resourceId) || 0);
      const cells = data.resources.map((r) => `<td class="col-center">${formatHours(valueFor(r))}</td>`).join('');
      const total = data.resources.reduce((s, r) => s + valueFor(r), 0);
      return `<tr><th>${smallCapsHtml(label)}</th>${cells}<td class="col-center"><strong>${formatHours(total)}</strong></td><td class="col-center">${formatHms(total)}</td></tr>`;
    }

    // Overall summary -- one value per row, not per resource, by request.
    // Total Tech Hours: Table 1's own Total Hours row, Total column
    // (sumOf('totalHours'), the same figure that row's own Total cell
    // shows). Tech Hours Available (After AITTime): that figure minus
    // Table 2's own (AITTIME) grand total. The last two rows read as
    // percentages of THAT figure, not of Total Tech Hours itself.
    // Total Tech Hours Worked -- Attendance. This is the baseline every
    // other row's percentage is measured against, so by request it gets
    // NO percentage of its own (it would only ever read a redundant
    // "100%" -- "This is 100% of the hours a resource is at work").
    const totalTechHours = sumOf('totalHours');
    const aittimeGrandTotal = [...aittimeTotalByResource.values()].reduce((s, h) => s + h, 0);
    // Tech Hours Available (After AITTime) = Total Tech Hours Worked minus
    // the Total AITTIME, shown as a percentage OF Total Tech Hours Worked
    // (not of itself) -- by request.
    const techHoursAvailable = totalTechHours - aittimeGrandTotal;
    const totalClientHours = recordedGrandTotal;
    const totalClientHoursBillable = clientContractsBillableTable.grandTotal.worked;

    // `pctBase` is the row's own percentage denominator -- `null` means no
    // percentage column at all for that row (Total Tech Hours (at work),
    // the baseline). Every other row (Available, Client, Billable) is a %
    // of Total Tech Hours (at work), by request -- not of Available, even
    // for the Client/Billable rows.
    function overallSummaryRow(label, hours, pctBase) {
      const pctCell =
        pctBase === null
          ? '<td class="col-center"></td>'
          : `<td class="col-center">${formatPct(pctBase > 0 ? (hours / pctBase) * 100 : 0)}</td>`;
      return `<tr><th>${smallCapsHtml(label)}</th><td class="col-center">${formatHours(hours)}</td><td class="col-center">${formatHms(hours)}</td>${pctCell}</tr>`;
    }
    function formatPct(n) {
      return `${(Math.round((n + Number.EPSILON) * 10) / 10).toFixed(1)}%`;
    }

    resultsEl.innerHTML = `
      <div class="tm-table-group">
      <table class="tm-overall-summary-table">
        <thead>
          <tr><th class="tm-corner-label">${smallCapsHtml('Hours Summary')}</th><th class="col-center">${smallCapsHtml('Hours')}</th><th class="col-center">${smallCapsHtml('HH:MM')}</th><th class="col-center">%**</th></tr>
        </thead>
        <tbody>
          ${overallSummaryRow('Total Tech Hours (at work)', totalTechHours, null)}
          ${overallSummaryRow('Tech Hours Available (After AITTime)', techHoursAvailable, totalTechHours)}
          ${overallSummaryRow('Total Tech Client Hours', totalClientHours, totalTechHours)}
          ${overallSummaryRow('Total Tech Hours Billable', totalClientHoursBillable, totalTechHours)}
        </tbody>
      </table>
      <p class="tm-footnote">** % of Available Hours</p>
      </div>

      <div class="tm-table-group">
      <div class="tm-table-scroll">
        <table class="tm-hours-table">
          <thead>
            <tr><th class="tm-corner-label">${smallCapsHtml('Staff Hours')}</th>${headerCells}<th class="col-center">${smallCapsHtml('Total')}</th><th class="col-center">${smallCapsHtml('HH:MM')}</th></tr>
          </thead>
          <tbody>
            <tr><th>${smallCapsHtml('Normal Hours (per day)')}</th>${data.resources.map(() => `<td class="col-center">${formatHours(data.normalHoursPerDay)}</td>`).join('')}<td></td><td></td></tr>
            ${summaryRow('Leave Hours', 'leaveHours')}
            ${summaryRow('Public Holidays', 'publicHolidayHours')}
            ${summaryRow('Total Hours', 'totalHours', { strong: true })}
            ${summaryRow('Ticket Hours', 'ticketHours')}
          </tbody>
        </table>
      </div>

      ${
        data.aittime.length === 0
          ? '<p class="status">No AITTIME time logged in this period for the selected resources.</p>'
          : `
      <div class="tm-table-scroll">
        <table class="tm-hours-table">
          <thead>
            <tr><th class="tm-corner-label">${smallCapsHtml('AIT Time Tickets')}</th>${headerCells}<th class="col-center">${smallCapsHtml('Total')}</th><th class="col-center">${smallCapsHtml('HH:MM')}</th></tr>
          </thead>
          <tbody>
            ${aittimeRowsHtml}
            ${aittimeTotalRow}
          </tbody>
        </table>
      </div>`
      }

      <div class="tm-table-scroll">
        <table class="tm-hours-table">
          <thead>
            <tr><th></th>${headerCells}<th class="col-center">${smallCapsHtml('Total')}</th><th class="col-center">${smallCapsHtml('HH:MM')}</th></tr>
          </thead>
          <tbody>
            ${lessAittimeRow('Total Hours less AITTIME', 'totalHours')}
            ${lessAittimeRow('Recorded Hours less AITTIME', 'ticketHours')}
          </tbody>
        </table>
      </div>
      </div>

      <div class="tm-table-group">
      ${
        data.clientContracts.length === 0
          ? '<p class="status">No client ticket time in this period for the selected resources.</p>'
          : `
      <div class="tm-table-scroll">
        <table class="tm-hours-table">
          <thead>
            <tr><th class="tm-corner-label">${smallCapsHtml('Total Client Hours Recorded')}</th>${headerCells}<th class="col-center">${smallCapsHtml('Total')}</th><th class="col-center">${smallCapsHtml('HH:MM')}</th></tr>
          </thead>
          <tbody>
            ${clientContractsRowsHtml}
            ${clientContractsTotalRow}
          </tbody>
        </table>
      </div>`
      }

      ${
        data.clientContractsBillable.length === 0
          ? ''
          : `
      <div class="tm-table-scroll">
        <table class="tm-hours-table">
          <thead>
            <tr><th class="tm-corner-label">${smallCapsHtml('Total Client Hours Billable')}</th>${headerCells}<th class="col-center">${smallCapsHtml('Total')}</th><th class="col-center">${smallCapsHtml('HH:MM')}</th></tr>
          </thead>
          <tbody>
            ${clientContractsBillableTable.rowsHtml}
            ${clientContractsBillableTable.totalRow}
            ${recordedLessBillableRow}
          </tbody>
        </table>
      </div>`
      }

      ${
        data.clientContractsNonBillable.length === 0
          ? ''
          : `
      <div class="tm-table-scroll">
        <table class="tm-hours-table">
          <thead>
            <tr><th class="tm-corner-label">${smallCapsHtml('Total Client Hours Non-Billable')}</th>${headerCells}<th class="col-center">${smallCapsHtml('Total')}</th><th class="col-center">${smallCapsHtml('HH:MM')}</th></tr>
          </thead>
          <tbody>
            ${clientContractsNonBillableTable.rowsHtml}
            ${clientContractsNonBillableTable.totalRow}
          </tbody>
        </table>
      </div>`
      }
      </div>

      <div class="tm-heading-with-button">
        <h2 class="section-heading">Data below this point is for Work-Type Reconciliation</h2>
        <div class="date-form"><button type="button" id="work-type-show-button">Show</button></div>
      </div>
      <div id="work-type-container"></div>
    `;

    // Work-Type Reconciliation is fetched on demand only -- by request,
    // not part of the main load above, so a visit that never clicks Show
    // never pays for the extra TimeEntries/BillingCodes fetch at all.
    const workTypeShowButton = resultsEl.querySelector('#work-type-show-button');
    const workTypeContainer = resultsEl.querySelector('#work-type-container');
    workTypeShowButton.addEventListener('click', async () => {
      workTypeShowButton.disabled = true;
      workTypeShowButton.textContent = 'Loading...';
      try {
        const resourceIds = data.resources.map((r) => r.resourceId);
        const qs = new URLSearchParams({ from: data.from, to: data.to, resourceIds: resourceIds.join(',') });
        const res = await fetch(`/api/times/work-type?${qs.toString()}`);
        const wt = await res.json();
        if (!res.ok) throw new Error(wt.error || `Request failed (${res.status})`);

        // Table 1 ("Work Type - Billable"): fixed list, always rendered
        // (even all-zero rows), billable entries only, by request. New
        // Table 1-B ("Billable was Unticked"): same fixed 5 work types'
        // own non-billable entries -- only rows actually found, in the
        // same fixed order. Table 2 ("Work Type - Unbillable", renamed --
        // content unchanged, still every other work type regardless of
        // its own billable flag). Table 3: Accrue--ING by status,
        // unchanged.
        const fixedBillable = workTypeTableHtml(wt.workTypeFixedBillable);
        const fixedUnticked = workTypeTableHtml(wt.workTypeFixedUnticked);
        const other = workTypeTableHtml(wt.workTypeOther);
        const accrueIng = workTypeTableHtml(wt.workTypeAccrueIng);

        // Reconciliation row builder, shared by "Client Ticket Times" and
        // "Total (matches Total Recorded Hours)" below -- one row, no
        // table header, green-shaded with grey top/bottom borders
        // (.tm-reconciliation-row), summing the given rows' own totals
        // per resource and comparing the grand total against a
        // known-good figure; a real disagreement (beyond floating-point
        // residue) turns the Total-column figure red (.tm-mismatch).
        function sumMaps(maps) {
          const result = new Map();
          for (const m of maps) for (const [id, h] of m) result.set(id, (result.get(id) || 0) + h);
          return result;
        }
        function reconciliationRow(label, rowGroups, compareAgainst) {
          const totals = sumMaps(rowGroups.map((rows) => totalByResource(rows)));
          const grandTotal = [...totals.values()].reduce((s, h) => s + h, 0);
          const mismatch = Math.abs(grandTotal - compareAgainst) > 0.01;
          const totalText = formatHours(grandTotal);
          const totalHtml = mismatch ? `<span class="tm-mismatch">${totalText}</span>` : totalText;
          const rowHtml = `<tr class="tm-reconciliation-row"><th>${smallCapsHtml(label)}</th>${data.resources
            .map((r) => `<td class="col-center">${formatHours(totals.get(r.resourceId) || 0)}</td>`)
            .join('')}<td class="col-center"><strong>${totalHtml}</strong></td><td class="col-center">${formatHms(grandTotal)}</td></tr>`;
          return { rowHtml, grandTotal };
        }

        // "Client Ticket Times" -- the four tables above (this section
        // excludes Ambient IT the same way Total Client Hours Recorded
        // does, and between them the four tables cover every real work
        // type once) should sum to Total Client Hours Recorded's own
        // grand total (recordedGrandTotal, already in scope from the
        // main render() above).
        const clientTicketTimes = reconciliationRow(
          'Total (matches Total Client Hours)',
          [wt.workTypeFixedBillable, wt.workTypeFixedUnticked, wt.workTypeOther, wt.workTypeAccrueIng],
          recordedGrandTotal
        );
        const clientTicketTimesRow = clientTicketTimes.rowHtml;

        // "Ambient iT Tickets" -- the last table in this section, by
        // request: every real Ambient iT ticket's own time, split into
        // "AITTime Tickets" (just a total, no per-title breakdown -- that
        // level of detail is the earlier AIT Time Tickets table's job)
        // and "All other Ambient iT tickets". Its own reconciliation row
        // compares against Table 1's own Ticket Hours row (ALL ticket
        // time, client and Ambient iT combined) -- confirmed with the
        // user this is what "Total Recorded Hours" means here. That
        // figure is ALL ticket time, so the row sums THIS table's own
        // rows together with the four client Work-Type tables above
        // (already confirmed to equal Total Client Hours Recorded) --
        // Ambient + Client, together, is what should equal ALL ticket
        // time; the Ambient table alone would never match it.
        const ambientItTickets = workTypeTableHtml(wt.ambientItTickets);
        const totalRecordedHours = sumOf('ticketHours');
        const ambientItTicketsTotal = reconciliationRow(
          'Total (matches Total Recorded Hours)',
          [wt.workTypeFixedBillable, wt.workTypeFixedUnticked, wt.workTypeOther, wt.workTypeAccrueIng, wt.ambientItTickets],
          totalRecordedHours
        );

        workTypeContainer.innerHTML = `
          <div class="tm-table-group">
          <div class="tm-table-scroll">
            <table class="tm-hours-table">
              <thead>
                <tr><th class="tm-corner-label">${smallCapsHtml('Work Type - Billable')}</th>${headerCells}<th class="col-center">${smallCapsHtml('Total')}</th><th class="col-center">${smallCapsHtml('HH:MM')}</th></tr>
              </thead>
              <tbody>
                ${fixedBillable.rowsHtml}
                ${fixedBillable.totalRow}
              </tbody>
            </table>
          </div>

          ${
            wt.workTypeFixedUnticked.length === 0
              ? '<p class="status">No unticked-billable time in this period for these work types.</p>'
              : `
          <div class="tm-table-scroll">
            <table class="tm-hours-table">
              <thead>
                <tr><th class="tm-corner-label">${smallCapsHtml('Billable was Unticked')}</th>${headerCells}<th class="col-center">${smallCapsHtml('Total')}</th><th class="col-center">${smallCapsHtml('HH:MM')}</th></tr>
              </thead>
              <tbody>
                ${fixedUnticked.rowsHtml}
                ${fixedUnticked.totalRow}
              </tbody>
            </table>
          </div>`
          }

          ${
            wt.workTypeOther.length === 0
              ? '<p class="status">No other ticket time in this period for the selected resources.</p>'
              : `
          <div class="tm-table-scroll">
            <table class="tm-hours-table">
              <thead>
                <tr><th class="tm-corner-label">${smallCapsHtml('Work Type - Unbillable')}</th>${headerCells}<th class="col-center">${smallCapsHtml('Total')}</th><th class="col-center">${smallCapsHtml('HH:MM')}</th></tr>
              </thead>
              <tbody>
                ${other.rowsHtml}
                ${other.totalRow}
              </tbody>
            </table>
          </div>`
          }

          <div class="tm-table-scroll">
            <table class="tm-hours-table">
              <thead>
                <tr><th class="tm-corner-label">${smallCapsHtml('Accrue--ING by Status')}</th>${headerCells}<th class="col-center">${smallCapsHtml('Total')}</th><th class="col-center">${smallCapsHtml('HH:MM')}</th></tr>
              </thead>
              <tbody>
                ${accrueIng.rowsHtml}
                ${accrueIng.totalRow}
              </tbody>
            </table>
          </div>

          <div class="tm-table-scroll tm-table-scroll--tight">
            <table class="tm-hours-table">
              <tbody>
                ${clientTicketTimesRow}
              </tbody>
            </table>
          </div>
          <p class="tm-footnote tm-footnote-red">^ These values turn red if they don't match "Total Client Hours Recorded"</p>

          <div class="tm-table-scroll">
            <table class="tm-hours-table">
              <thead>
                <tr><th class="tm-corner-label">${smallCapsHtml('Ambient iT Tickets')}</th>${headerCells}<th class="col-center">${smallCapsHtml('Total')}</th><th class="col-center">${smallCapsHtml('HH:MM')}</th></tr>
              </thead>
              <tbody>
                ${ambientItTickets.rowsHtml}
                ${ambientItTickets.totalRow}
              </tbody>
            </table>
          </div>

          <div class="tm-table-scroll tm-table-scroll--tight">
            <table class="tm-hours-table">
              <tbody>
                ${ambientItTicketsTotal.rowHtml}
              </tbody>
            </table>
          </div>
          <p class="tm-footnote tm-footnote-red">^ These values turn red if they don't match "Total Recorded Hours"</p>
          </div>
        `;
        workTypeShowButton.hidden = true;
      } catch (err) {
        workTypeContainer.innerHTML = `<p class="status error">Error: ${err.message}</p>`;
        workTypeShowButton.disabled = false;
        workTypeShowButton.textContent = 'Show';
      }
    });
  }

  function formatHours(n) {
    const rounded = Math.round((n + Number.EPSILON) * 100) / 100;
    return rounded.toFixed(2);
  }

  // h:mm, same rounding/rollover convention Ticket Times' own formatHours()
  // uses (round to the nearest minute, roll over into the next hour rather
  // than ever showing :60) -- used here only for the HH:MM column, which
  // translates each row's own Total figure into this format.
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

  // Manual small caps, replacing the earlier `font-variant: small-caps`
  // CSS approach -- that relied on the browser/font's own synthesis,
  // which in practice still read as plain ALL CAPS rather than visibly
  // smaller, by report. This builds the effect directly instead: every
  // run of lowercase letters is upper-cased and wrapped in a shrunk
  // <span> (tm-smcp, styles.css); already-uppercase letters (e.g.
  // "AITTIME", "HH:MM", "T&M") and non-letters are left exactly as they
  // are, so the visual size difference is real and guaranteed, not
  // dependent on font support.
  function smallCapsHtml(text) {
    const str = String(text);
    let html = '';
    let i = 0;
    while (i < str.length) {
      const ch = str[i];
      if (ch >= 'a' && ch <= 'z') {
        let j = i + 1;
        while (j < str.length && str[j] >= 'a' && str[j] <= 'z') j++;
        html += `<span class="tm-smcp">${escapeHtml(str.slice(i, j).toUpperCase())}</span>`;
        i = j;
      } else {
        html += escapeHtml(ch);
        i++;
      }
    }
    return html;
  }
}
