export const id = "tc-elite";
export const label = "TC Elite";

// First pass, by request ("let's start with that and see what we get") --
// every client currently on a "Tech Cover Elite" contract, with a seat
// count summed from that contract's own real TC Elite service lines
// (current period only, positive $ value only). See server.js's own
// comment for the full methodology and the honest "units isn't always a
// literal person-seat count" caveat.

let lastData = null; // module-scope, survives the shell's teardown/re-mount, same convention every other page here uses

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>TC Elite</h1>
      <div class="date-form">
        <button type="button" id="refresh-button">Refresh</button>
      </div>
    </header>
    <p id="status" class="status">Every client currently on a "Tech Cover Elite" contract, with a seat count summed from that contract's own TC Elite service lines -- current billing period only, and only lines with a positive $ value. Hover a row's Lines count for the breakdown.</p>
    <div id="summary" class="summary" hidden></div>
    <div id="results"></div>
  `;

  const refreshButton = container.querySelector('#refresh-button');
  const statusEl = container.querySelector('#status');
  const summaryEl = container.querySelector('#summary');
  const resultsEl = container.querySelector('#results');

  refreshButton.addEventListener('click', () => load(true));

  if (lastData) render(lastData);
  else load(false);

  async function load(force) {
    refreshButton.disabled = true;
    resultsEl.innerHTML = '';
    summaryEl.hidden = true;
    try {
      const res = await fetch(`/api/tc-elite${force ? '?force=true' : ''}`);
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
    const totalSeats = data.rows.reduce((sum, r) => sum + r.seats, 0);
    summaryEl.hidden = false;
    summaryEl.innerHTML = `<strong>${data.rows.length}</strong> client${data.rows.length === 1 ? '' : 's'} with TC Elite, <strong>${totalSeats}</strong> seat${totalSeats === 1 ? '' : 's'} total <span class="inline-subtext">(as of ${new Date(data.asOf).toLocaleString()})</span>`;

    if (data.rows.length === 0) {
      resultsEl.innerHTML = '<p class="status">No clients found with a current, positive-value TC Elite line.</p>';
      return;
    }

    const rowsHtml = data.rows
      .map((r) => {
        const lineCount = r.lines.length;
        const tooltip = r.lines.map((l) => `${l.description || '(no description)'} -- ${l.units} unit${l.units === 1 ? '' : 's'}, $${l.price.toFixed(2)} (${formatDate(l.periodStart)} - ${formatDate(l.periodEnd)})`).join('\n');
        return `
          <tr>
            <td>${r.companyUrl ? `<a href="${escapeHtml(r.companyUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(r.companyName)}</a>` : escapeHtml(r.companyName)}</td>
            <td class="col-center"><strong>${r.seats}</strong></td>
            <td>$${r.totalPrice.toFixed(2)}</td>
            <td class="col-center" title="${escapeHtml(tooltip)}">${lineCount}</td>
          </tr>`;
      })
      .join('');

    resultsEl.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Client</th>
            <th class="col-center">Seats</th>
            <th>$ (current period)</th>
            <th class="col-center">Lines</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    `;
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
