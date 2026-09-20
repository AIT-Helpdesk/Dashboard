export const id = "rewst-webhook-test";
export const label = "Rewst Webhook Test";

// Module-scope, not inside mount() -- same "survives across remounts,
// re-fetching a remote workflow's own data on every navigation would be
// wasteful" reasoning every other page on this dashboard already uses.
// Keyed per webhook so switching the dropdown back to an already-loaded
// one doesn't need a re-fetch either.
let lastDataByWebhook = {};
let lastWebhookKey = null;
// Field VALUES typed in, kept per webhook key so switching the dropdown
// away and back doesn't lose what was already typed (webhook key ->
// {jsonFieldKey: value}). Never sent anywhere until Load is clicked.
let lastFieldValuesByWebhook = {};

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>Rewst Webhook Test</h1>
    </header>
    <p class="status">Calls a real Rewst workflow (via its webhook trigger) and shows whatever data it returns.</p>
    <div class="date-form date-form-row">
      <label for="webhook-select">Webhook</label>
      <select id="webhook-select"></select>
      <div id="webhook-fields" class="date-form date-form-row"></div>
      <button type="button" id="load-button">Load</button>
      <input type="text" id="search-input" placeholder="Filter..." />
    </div>
    <p id="status" class="status" hidden></p>
    <div id="results"></div>
  `;

  const webhookSelect = container.querySelector('#webhook-select');
  const webhookFieldsEl = container.querySelector('#webhook-fields');
  const loadButton = container.querySelector('#load-button');
  const searchInput = container.querySelector('#search-input');
  const statusEl = container.querySelector('#status');
  const resultsEl = container.querySelector('#results');

  let webhooksByKey = {};

  loadButton.addEventListener('click', () => load(webhookSelect.value));
  webhookSelect.addEventListener('change', () => {
    renderFieldInputs(webhookSelect.value);
    // By request ("make a change to not auto-load the page") -- switching
    // the dropdown never fires a real Rewst call on its own anymore, only
    // Load does. Re-showing an already-loaded webhook's own cached result
    // isn't a new call (nothing goes over the network here), so that part
    // still happens automatically -- otherwise flipping between two
    // webhooks you'd already loaded would blank the page for no reason.
    if (lastDataByWebhook[webhookSelect.value]) render(lastDataByWebhook[webhookSelect.value], webhookSelect.value);
    else {
      statusEl.hidden = false;
      statusEl.className = 'status';
      statusEl.textContent = 'Click Load to call this webhook.';
      resultsEl.innerHTML = '';
    }
  });
  searchInput.addEventListener('input', () => {
    const cached = lastDataByWebhook[webhookSelect.value];
    if (cached) render(cached, webhookSelect.value);
  });

  init();

  // The dropdown's own options -- and now each webhook's own required
  // input fields -- come from the server's real WEBHOOKS map (`GET
  // /api/rewst-webhook-test/webhooks`) rather than a second, hand-typed
  // copy of the same keys/labels here -- by request ("add a dropdown to
  // choose between the 2 available webhooks"), one real list, not two
  // that could drift apart. Each field's own {key, label} comes straight
  // from .env server-side (see server.js's own discoverFieldsFromEnv())
  // -- by request ("have fields labeled with the label provided in the
  // .env file").
  async function init() {
    try {
      const res = await fetch('/api/rewst-webhook-test/webhooks');
      const data = await res.json();
      const webhooks = data.webhooks || [];
      webhooksByKey = Object.fromEntries(webhooks.map((w) => [w.key, w]));
      webhookSelect.innerHTML = webhooks
        .map((w) => `<option value="${escapeHtml(w.key)}"${w.configured ? '' : ' disabled'}>${escapeHtml(webhookDisplayLabel(w.label))}${w.configured ? '' : ' (not configured)'}</option>`)
        .join('');
      const initialKey = lastWebhookKey && webhooks.some((w) => w.key === lastWebhookKey) ? lastWebhookKey : webhooks.find((w) => w.configured)?.key || webhooks[0]?.key;
      if (initialKey) webhookSelect.value = initialKey;
      renderFieldInputs(webhookSelect.value);
      // By request ("make a change to not auto-load the page") -- mounting
      // the page no longer fires a real Rewst call on its own; only Load
      // does. An already-loaded webhook's own cached result still shows
      // right away (no new network call), same as switching the dropdown.
      if (lastDataByWebhook[webhookSelect.value]) render(lastDataByWebhook[webhookSelect.value], webhookSelect.value);
      else {
        statusEl.hidden = false;
        statusEl.className = 'status';
        statusEl.textContent = 'Click Load to call this webhook.';
      }
    } catch (err) {
      statusEl.hidden = false;
      statusEl.className = 'status error';
      statusEl.textContent = `Error loading webhook list: ${err.message}`;
    }
  }

  // One labeled text input per {key, label} the selected webhook's own
  // .env discoverWebhooks() finds -- empty for a webhook that needs no
  // input at all (no `REWST_WEBHOOK_<Name>_<...>` field lines beyond its
  // own `_URL`). `data-field-key` carries the real JSON key load() sends
  // this value under -- the label is just for display, never sent itself.
  function renderFieldInputs(webhookKey) {
    const webhook = webhooksByKey[webhookKey];
    const fields = webhook ? webhook.fields : [];
    const savedValues = lastFieldValuesByWebhook[webhookKey] || {};
    webhookFieldsEl.innerHTML = fields
      .map((f) => {
        const inputId = `webhook-field-${escapeHtml(f.key)}`;
        const savedValue = savedValues[f.key] || '';
        return `<label for="${inputId}">${escapeHtml(f.label)}</label><input type="text" id="${inputId}" data-field-key="${escapeHtml(f.key)}" value="${escapeHtml(savedValue)}" />`;
      })
      .join('');
  }

  async function load(webhookKey) {
    if (!webhookKey) return;
    const webhook = webhooksByKey[webhookKey];
    const fieldInputs = [...webhookFieldsEl.querySelectorAll('[data-field-key]')];
    const values = {};
    for (const input of fieldInputs) values[input.dataset.fieldKey] = input.value.trim();
    lastFieldValuesByWebhook[webhookKey] = values;

    // Checked client-side too, not just left to the server's own 400 --
    // catches an empty field before spending a real (rate-limited) Rewst
    // call on a request that can't succeed anyway.
    if (webhook) {
      const missing = webhook.fields.find((f) => !values[f.key]);
      if (missing) {
        statusEl.hidden = false;
        statusEl.className = 'status error';
        statusEl.textContent = `Error: "${missing.label}" is required.`;
        return;
      }
    }

    loadButton.disabled = true;
    webhookSelect.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = 'Calling Rewst...';
    resultsEl.innerHTML = '';

    try {
      const qs = new URLSearchParams({ webhook: webhookKey, ...values });
      const res = await fetch(`/api/rewst-webhook-test?${qs.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastDataByWebhook[webhookKey] = data;
      lastWebhookKey = webhookKey;
      render(data, webhookKey);
    } catch (err) {
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      loadButton.disabled = false;
      webhookSelect.disabled = false;
    }
  }

  // Matched on the real response SHAPE, not on which webhook was picked --
  // by request, the dropdown's own set of webhooks is now fully dynamic
  // (discovered from .env, see server.js's own comment), so a webhook's
  // name/key in .env can be renamed at any time; keying a dedicated table
  // off today's name would silently stop matching the moment someone
  // renamed it. Shape detection has no such dependency.
  function render(data, webhookKey) {
    // `{ Customers: [...] }` -- confirmed real shape, 370 real customer
    // records with company_name/csp_tenant_id/has_consent/id/
    // linked_organizations/tenant_id fields.
    if (Array.isArray(data?.Customers)) {
      renderCustomers(data.Customers);
      return;
    }
    // `{ subscribed_skus: { data: { value: [...] } } }` -- confirmed real
    // shape, one row per real Microsoft Graph `/subscribedSkus` entry (an
    // M365 license SKU) for the given org. The rest of that envelope
    // (`status_code`/`response`/`request`) is Rewst's own raw HTTP-action
    // wrapper around the real Graph call, not part of the actual
    // subscription data -- only `.data.value` is shown.
    if (Array.isArray(data?.subscribed_skus?.data?.value)) {
      renderSubscriptions(data.subscribed_skus.data.value);
      return;
    }
    // Any other shape (including a still-null/echoed response from a
    // webhook that hasn't been fully wired up in Rewst yet) falls back to
    // the generic renderer below rather than guessing at a table.
    renderGeneric(data);
  }

  function renderCustomers(customers) {
    if (customers.length === 0) {
      statusEl.hidden = false;
      statusEl.className = 'status';
      statusEl.textContent = 'No customers returned.';
      resultsEl.innerHTML = '';
      return;
    }

    const search = searchInput.value.trim().toLowerCase();
    const filtered = search ? customers.filter((c) => (c.company_name || '').toLowerCase().includes(search)) : customers;

    const withConsent = customers.filter((c) => c.has_consent).length;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = `${customers.length} real customers (${withConsent} with consent, ${customers.length - withConsent} without)${search ? ` -- ${filtered.length} matching "${search}"` : ''}`;

    resultsEl.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Company Name</th>
            <th class="col-center">Consent</th>
            <th>Tenant ID</th>
            <th>Organisation ID</th>
            <th>Linked Organizations</th>
            <th>Rewst Customer ID</th>
          </tr>
        </thead>
        <tbody>
          ${filtered.map(customerRowHtml).join('')}
        </tbody>
      </table>
    `;
  }

  function customerRowHtml(c) {
    const linkedOrgs = Array.isArray(c.linked_organizations) ? c.linked_organizations.map((o) => o.name).join(', ') : '';
    // The real "Organisation ID" (what @dashboard/rewst-webhook-test's own
    // "Customer_M365_Licenses" webhook needs as its org_id input) is NOT
    // c.id (Rewst's own internal customer-record id) or c.csp_tenant_id
    // (a Microsoft CSP tenant id, confirmed the same across every real
    // customer -- not useful to show, by request) -- it's nested inside
    // linked_organizations[].id, confirmed live against real data (G & H
    // Civil: linked_organizations[0].id === the real Organisation ID).
    // Joined the same way linkedOrgs (names) already is, in case a real
    // customer is ever linked to more than one organisation.
    const linkedOrgIds = Array.isArray(c.linked_organizations) ? c.linked_organizations.map((o) => o.id).join(', ') : '';
    return `
      <tr>
        <td>${escapeHtml(c.company_name)}</td>
        <td class="col-center">${c.has_consent ? 'Yes' : 'No'}</td>
        <td>${escapeHtml(c.tenant_id)}</td>
        <td>${escapeHtml(linkedOrgIds)}</td>
        <td>${escapeHtml(linkedOrgs)}</td>
        <td>${escapeHtml(c.id)}</td>
      </tr>
    `;
  }

  // One real row per M365 license SKU, per its own confirmed real shape
  // (see render() above).
  function renderSubscriptions(skus) {
    if (skus.length === 0) {
      statusEl.hidden = false;
      statusEl.className = 'status';
      statusEl.textContent = 'No subscriptions returned.';
      resultsEl.innerHTML = '';
      return;
    }

    const search = searchInput.value.trim().toLowerCase();
    const filtered = search ? skus.filter((s) => (s.skuPartNumber || '').toLowerCase().includes(search)) : skus;

    const enabledCount = skus.filter((s) => s.capabilityStatus === 'Enabled').length;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = `${skus.length} real subscriptions (${enabledCount} enabled, ${skus.length - enabledCount} not)${search ? ` -- ${filtered.length} matching "${search}"` : ''}`;

    resultsEl.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>SKU</th>
            <th>Applies To</th>
            <th class="col-center">Status</th>
            <th class="col-center">Consumed</th>
            <th class="col-center">Enabled</th>
            <th class="col-center">Suspended</th>
            <th>Service Plans</th>
          </tr>
        </thead>
        <tbody>
          ${filtered.map(subscriptionRowHtml).join('')}
        </tbody>
      </table>
    `;
  }

  function subscriptionRowHtml(s) {
    const plans = Array.isArray(s.servicePlans) ? s.servicePlans.map((p) => p.servicePlanName).join(', ') : '';
    return `
      <tr>
        <td>${escapeHtml(s.skuPartNumber)}</td>
        <td>${escapeHtml(s.appliesTo)}</td>
        <td class="col-center">${escapeHtml(s.capabilityStatus)}</td>
        <td class="col-center">${escapeHtml(s.consumedUnits)}</td>
        <td class="col-center">${escapeHtml(s.prepaidUnits?.enabled)}</td>
        <td class="col-center">${escapeHtml(s.prepaidUnits?.suspended)}</td>
        <td>${escapeHtml(plans)}</td>
      </tr>
    `;
  }

  // Shape-agnostic fallback for any webhook whose real response hasn't
  // been confirmed/built a dedicated table for yet -- this page's whole
  // point is testing a webhook, so "show something readable" beats
  // "crash because the field names don't match a table built for a
  // different workflow." Finds the first top-level array-of-objects field
  // (whatever it's called -- Rewst's own convention so far, per
  // "Customers" above, is one capitalized key holding the real rows) and
  // builds a generic table from the UNION of keys across all its rows (not
  // just the first row's own keys, in case row shapes vary); anything that
  // isn't an array of objects at all just gets pretty-printed as raw JSON.
  function renderGeneric(data) {
    // A real, confirmed case, not a hypothetical -- a Rewst workflow with
    // "Wait for results" now enabled but no real `return`/output step of
    // its own sends back a literal JSON `null` body once it finishes,
    // which crashed here (`Object.entries(null)` throws "Cannot convert
    // undefined or null to object") before this guard existed. `data` can
    // also legitimately be any other non-object JSON value (a bare
    // string/number/array), not just an object with a row list -- all of
    // those get the same plain "show what actually came back" treatment
    // as the "no obvious row list" case below, never a crash.
    if (data === null || typeof data !== 'object') {
      statusEl.hidden = false;
      statusEl.className = 'status';
      statusEl.textContent = data === null || data === undefined ? 'Webhook returned no data (empty/null response).' : 'Raw response:';
      resultsEl.innerHTML = `<pre class="rewst-raw-json">${escapeHtml(JSON.stringify(data, null, 2))}</pre>`;
      return;
    }

    // A top-level array (the whole response IS the row list, not nested
    // under a field like "Customers") is treated the same as finding that
    // field directly, rather than searching its own numeric indices for
    // ANOTHER nested array (which would never match and always fall
    // through to the raw-JSON case below for this shape).
    const arrayEntry = Array.isArray(data)
      ? data.length > 0 && typeof data[0] === 'object' && data[0] !== null
        ? ['(response)', data]
        : null
      : Object.entries(data).find(([, v]) => Array.isArray(v) && v.length > 0 && typeof v[0] === 'object' && v[0] !== null);

    if (!arrayEntry) {
      statusEl.hidden = false;
      statusEl.className = 'status';
      statusEl.textContent = 'Raw response (no obvious row list found):';
      resultsEl.innerHTML = `<pre class="rewst-raw-json">${escapeHtml(JSON.stringify(data, null, 2))}</pre>`;
      return;
    }

    const [fieldName, rows] = arrayEntry;
    const search = searchInput.value.trim().toLowerCase();
    const filtered = search ? rows.filter((r) => JSON.stringify(r).toLowerCase().includes(search)) : rows;

    const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];

    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = `${rows.length} real "${fieldName}" rows${search ? ` -- ${filtered.length} matching "${search}"` : ''}`;

    resultsEl.innerHTML = `
      <table>
        <thead>
          <tr>${columns.map((col) => `<th>${escapeHtml(col)}</th>`).join('')}</tr>
        </thead>
        <tbody>
          ${filtered.map((row) => genericRowHtml(row, columns)).join('')}
        </tbody>
      </table>
    `;
  }

  function genericRowHtml(row, columns) {
    return `<tr>${columns.map((col) => `<td>${escapeHtml(genericCellText(row[col]))}</td>`).join('')}</tr>`;
  }

  function genericCellText(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Dropdown display only, by request ("replace them with spaces") -- the
  // real `w.label`/`w.key` (used for matching and field-input lookups)
  // stay exactly as server.js discovered them from .env, untouched; only
  // what's actually shown in the <option> text has underscores swapped
  // for spaces. Case is still never touched, same standing rule as before.
  function webhookDisplayLabel(label) {
    return label.replace(/_/g, ' ');
  }
}
