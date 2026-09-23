export const id = "rollout-tracker-builder";
export const label = "Rollout Tracker Builder";

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>Rollout Tracker Builder</h1>
    </header>
    <p class="status">
      Creates a new rollout tracker -- a status grid like TC Elite Rollout, with the list you specify down the left
      and the columns you specify (the required actions) across the top. Every cell starts as Not Done and can be
      set to Started, Done, N/A, Cancelled, Issue, or Note (which requires a comment), each keeping a full audit
      trail. Filed straight into the Trackers category (no restart needed). Anyone signed in can add a row to an
      existing tracker day to day; creating a new tracker, adding a column, and moving one between Trackers and
      Trackers - Complete are all Tracker Manager actions (see TRACKER_MANAGER in .env).
    </p>
    <p id="not-manager-notice" class="status error" hidden>Only a Tracker Manager can create a new rollout tracker -- see whoever manages this dashboard's .env if you think you should be one.</p>
    <div id="builder-form-group" class="resource-group">
      <div class="resource-group-header"><span>New Rollout Tracker</span></div>
      <form id="builder-form" style="display:flex; flex-direction:column; gap:0.75rem; padding:0.75rem 1rem;">
        <label>
          Tracker name
          <input type="text" id="tracker-name-input" placeholder="e.g. AutoElevate Rollout" required style="display:block; width:100%; max-width:28rem; margin-top:0.25rem;" />
        </label>
        <label>
          What do you call each row?
          <input type="text" id="row-noun-input" placeholder="Item" value="Item" style="display:block; width:100%; max-width:16rem; margin-top:0.25rem;" />
        </label>
        <label>
          Rows (one per line -- often clients, but not always)
          <textarea id="rows-input" rows="8" placeholder="Client A&#10;Client B&#10;Client C" style="display:block; width:100%; max-width:28rem; margin-top:0.25rem; font: inherit; padding:0.4rem 0.6rem; border:1px solid var(--border); border-radius:6px; background:var(--bg); color:var(--fg);"></textarea>
        </label>
        <label>
          Columns (one per line -- the required actions)
          <textarea id="columns-input" rows="6" placeholder="Kickoff Call&#10;Config Deployed&#10;Sign-off" style="display:block; width:100%; max-width:28rem; margin-top:0.25rem; font: inherit; padding:0.4rem 0.6rem; border:1px solid var(--border); border-radius:6px; background:var(--bg); color:var(--fg);"></textarea>
        </label>
        <div class="date-form" style="margin:0;">
          <button type="submit" id="publish-button">Publish</button>
        </div>
      </form>
      <p id="publish-result" class="status" style="margin: 0 1rem 1rem;" hidden></p>
    </div>
  `;

  const notManagerNotice = container.querySelector('#not-manager-notice');
  const builderFormGroup = container.querySelector('#builder-form-group');
  fetch('/api/rollout-tracker-builder/can-publish')
    .then((res) => res.json())
    .then((data) => {
      if (!data.isManager) {
        notManagerNotice.hidden = false;
        builderFormGroup.hidden = true;
      }
    })
    .catch(() => {
      // Non-essential -- the form just stays visible if this fails; the
      // real enforcement is POST /publish's own 403 either way.
    });

  const form = container.querySelector('#builder-form');
  const trackerNameInput = container.querySelector('#tracker-name-input');
  const rowNounInput = container.querySelector('#row-noun-input');
  const rowsInput = container.querySelector('#rows-input');
  const columnsInput = container.querySelector('#columns-input');
  const publishButton = container.querySelector('#publish-button');
  const publishResultEl = container.querySelector('#publish-result');

  function linesOf(textarea) {
    return textarea.value
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const trackerLabel = trackerNameInput.value.trim();
    const rowNoun = rowNounInput.value.trim() || 'Item';
    const rowNames = linesOf(rowsInput);
    const columnLabels = linesOf(columnsInput);

    if (!trackerLabel) return; // native `required` already covers this
    if (rowNames.length === 0) {
      alert(`Enter at least one ${rowNoun.toLowerCase()}.`);
      return;
    }
    if (columnLabels.length === 0) {
      alert('Enter at least one column.');
      return;
    }
    if (
      !confirm(
        `Publish "${trackerLabel}" as a new rollout tracker with ${rowNames.length} ${rowNoun.toLowerCase()}${rowNames.length === 1 ? '' : 's'} and ${columnLabels.length} column${columnLabels.length === 1 ? '' : 's'}?\n\nIt'll appear at the top of the sidebar immediately.`
      )
    ) {
      return;
    }

    publishButton.disabled = true;
    publishResultEl.hidden = false;
    publishResultEl.className = 'status';
    publishResultEl.textContent = 'Publishing...';

    try {
      const res = await fetch('/api/rollout-tracker-builder/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: trackerLabel, rowNoun, rowNames, columnLabels }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);

      publishResultEl.className = 'status';
      publishResultEl.innerHTML = `<strong>${escapeHtml(data.label)}</strong> published (id: <code>${escapeHtml(data.id)}</code>) -- now at the top of the sidebar. Refresh the sidebar (or reload the page) to see it, then drag it into place when you're ready.`;

      trackerNameInput.value = '';
      rowNounInput.value = 'Item';
      rowsInput.value = '';
      columnsInput.value = '';
    } catch (err) {
      publishResultEl.className = 'status error';
      publishResultEl.textContent = `Error: ${err.message}`;
    } finally {
      publishButton.disabled = false;
    }
  });

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
