export const id = 'access4-api-tester';
export const label = 'Access4 API Tester';

// Survives a remount the same way every other page here does -- only the
// in-flight request history, since re-sending a real request on every tab
// switch would be pointless (and, for Access4, actively unhelpful: real
// SMS sends cost money and go to real numbers).
let history = []; // newest first, capped at HISTORY_LIMIT
const HISTORY_LIMIT = 25;

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const MONO_STYLE = 'font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.82rem;';

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>Access4 API Tester</h1>
    </header>
    <p class="status">
      Sends a REAL HTTP request to Access4 from this production server -- the one thing a laptop/dev-machine request
      can't prove, since Access4 whitelists by source IP only. Visible to Amber only. Use "Simulate Send" on the
      real SMS page for anything that shouldn't actually attempt to send a text.
    </p>

    <div id="a4t-config" class="resource-group" style="padding: 0.75rem 1rem; margin-bottom: 1rem;"><p class="status">Loading config...</p></div>

    <div class="date-form date-form-row" style="margin-bottom: 0.5rem;">
      <button type="button" id="a4t-preset-send-sms" class="button-link button-link--small">Load: Send SMS (quick-sms)</button>
      <button type="button" id="a4t-clear" class="button-link button-link--small">Clear Form</button>
    </div>

    <div class="pm-form-field">
      <label for="a4t-method">Method</label>
      <select id="a4t-method" class="wsp-field" style="max-width: 10rem;">
        <option value="POST">POST</option>
        <option value="GET">GET</option>
        <option value="PUT">PUT</option>
        <option value="PATCH">PATCH</option>
        <option value="DELETE">DELETE</option>
      </select>
    </div>
    <div class="pm-form-field">
      <label for="a4t-base-url">Base URL</label>
      <input type="text" id="a4t-base-url" class="wsp-field" style="${MONO_STYLE}" placeholder="https://api.sasboss.com.au:10000" />
      <p class="inline-subtext">Editable so you can point this at a plain connectivity-test URL too (e.g. https://httpbin.org) to tell "Access4 rejected us" apart from "this server's outbound network can't reach anything."</p>
    </div>
    <div class="pm-form-field">
      <label for="a4t-path">Path</label>
      <input type="text" id="a4t-path" class="wsp-field" style="${MONO_STYLE}" placeholder="/provisioning/serviceaccount/.../smsgateway/sms" />
    </div>
    <div class="pm-form-field">
      <label for="a4t-query">Query string (optional)</label>
      <input type="text" id="a4t-query" class="wsp-field" style="${MONO_STYLE}" placeholder="action=sendSms" />
    </div>
    <div class="pm-form-field">
      <label for="a4t-headers">Extra headers (optional, JSON object -- Content-Type: application/json is always sent unless overridden here)</label>
      <textarea id="a4t-headers" class="wsp-field" style="${MONO_STYLE}" rows="2" placeholder='{ "X-Example": "value" }'></textarea>
    </div>
    <div class="pm-form-field">
      <label for="a4t-body">Body (JSON, optional)</label>
      <textarea id="a4t-body" class="wsp-field" style="${MONO_STYLE}" rows="14"></textarea>
    </div>

    <div class="wsp-form-actions">
      <button type="button" id="a4t-send" class="button-link">Send Request</button>
    </div>
    <p id="a4t-status" class="status" hidden></p>

    <div id="a4t-response"></div>

    <h3 style="margin-top: 2rem;">History (this session)</h3>
    <div id="a4t-history"><p class="inline-subtext">Nothing sent yet.</p></div>
  `;

  const methodSelect = container.querySelector('#a4t-method');
  const baseUrlInput = container.querySelector('#a4t-base-url');
  const pathInput = container.querySelector('#a4t-path');
  const queryInput = container.querySelector('#a4t-query');
  const headersInput = container.querySelector('#a4t-headers');
  const bodyInput = container.querySelector('#a4t-body');
  const sendButton = container.querySelector('#a4t-send');
  const statusEl = container.querySelector('#a4t-status');
  const responseEl = container.querySelector('#a4t-response');
  const historyEl = container.querySelector('#a4t-history');
  const configEl = container.querySelector('#a4t-config');

  let config = null;

  async function loadConfig() {
    try {
      const res = await fetch('/api/access4-api-tester/config');
      config = await res.json();
      configEl.innerHTML = `
        <p><strong>Base URL:</strong> ${escapeHtml(config.baseUrl)}</p>
        <p><strong>Service ID:</strong> ${escapeHtml(config.serviceId) || '<span class="status error">not set</span>'}</p>
        <p><strong>DID Number ID:</strong> ${escapeHtml(config.didNumberId) || '<span class="status error">not set</span>'}</p>
        <p>${config.hasCredentials ? '<span class="status">Both ids are configured in .env.</span>' : '<span class="status error">ACCESS4_SMS_SERVICE_ID/ACCESS4_SMS_DID_NUMBER_ID are missing from .env -- the preset below will leave gaps for you to fill in.</span>'}</p>
      `;
      if (!baseUrlInput.value) baseUrlInput.value = config.baseUrl;
    } catch (err) {
      configEl.innerHTML = `<p class="status error">Error loading config: ${escapeHtml(err.message)}</p>`;
    }
  }

  // The exact payload/endpoint @dashboard/access4-sms's own real "quick
  // SMS" send call uses (server.js there) -- a known-good starting point
  // to tweak from, not a guess. toMobile is left as an obvious placeholder
  // since this preset is reused for every test, not just one number.
  function loadSendSmsPreset() {
    const serviceId = config?.serviceId || '<SERVICE_ID>';
    const didNumberId = config?.didNumberId || '<DID_NUMBER_ID>';
    methodSelect.value = 'POST';
    pathInput.value = `/provisioning/serviceaccount/${serviceId}/smsgateway/sms`;
    queryInput.value = 'action=sendSms';
    headersInput.value = '';
    bodyInput.value = JSON.stringify(
      {
        messageSubType: 'quick-sms',
        campaignType: 'transactional',
        contactListId: '',
        toMobile: '61412345678',
        didNumberId,
        message: 'Access4 API Tester -- test message',
        trackLink: '',
        schedule: 'no',
        scheduleTimeZone: '',
        smsScheduleAt: '',
        pendingMessageExpiry: 'no',
        pendingMessageExpiryTime: '',
        forwardToEmail: 'no',
        forwardToEmailValue: '',
        forwardToMobile: 'no',
        forwardToMobileValue: '',
        forwardToUrl: 'no',
        forwardToUrlValue: '',
        autoReply: 'no',
        autoReplyFirstMessage: '',
        autoReplySecondMessage: '',
      },
      null,
      2
    );
  }

  container.querySelector('#a4t-preset-send-sms').addEventListener('click', loadSendSmsPreset);
  container.querySelector('#a4t-clear').addEventListener('click', () => {
    methodSelect.value = 'POST';
    pathInput.value = '';
    queryInput.value = '';
    headersInput.value = '';
    bodyInput.value = '';
  });

  function renderResponse(entry) {
    if (!entry.result.ok) {
      responseEl.innerHTML = `
        <p class="status error">Network error -- the request never reached a server (${escapeHtml(entry.result.tookMs)}ms): ${escapeHtml(entry.result.error)}${entry.result.code ? ` (${escapeHtml(entry.result.code)})` : ''}</p>
        <p class="inline-subtext">Requested URL: ${escapeHtml(entry.result.requestUrl)}</p>
      `;
      return;
    }
    const r = entry.result;
    const okClass = r.status >= 200 && r.status < 300 ? '' : ' error';
    let bodyText;
    try {
      bodyText = typeof r.data === 'string' ? r.data : JSON.stringify(r.data, null, 2);
    } catch {
      bodyText = String(r.data);
    }
    responseEl.innerHTML = `
      <p class="status${okClass}"><strong>${escapeHtml(r.status)} ${escapeHtml(r.statusText || '')}</strong> &middot; ${escapeHtml(r.tookMs)}ms</p>
      <p class="inline-subtext">Requested URL: ${escapeHtml(r.requestUrl)}</p>
      <p class="inline-subtext">Response headers:</p>
      <pre class="rewst-raw-json">${escapeHtml(JSON.stringify(r.responseHeaders || {}, null, 2))}</pre>
      <p class="inline-subtext">Response body:</p>
      <pre class="rewst-raw-json">${escapeHtml(bodyText)}</pre>
    `;
  }

  function renderHistory() {
    if (history.length === 0) {
      historyEl.innerHTML = '<p class="inline-subtext">Nothing sent yet.</p>';
      return;
    }
    historyEl.innerHTML = `
      <table>
        <thead>
          <tr><th>Time</th><th>Method</th><th>URL</th><th>Result</th><th></th></tr>
        </thead>
        <tbody>
          ${history
            .map((entry, i) => {
              const r = entry.result;
              const resultText = r.ok ? `${r.status} ${r.statusText || ''}`.trim() : `Network error: ${r.error}`;
              const resultClass = r.ok && r.status >= 200 && r.status < 300 ? '' : ' error';
              return `
                <tr>
                  <td>${escapeHtml(new Date(entry.at).toLocaleTimeString('en-AU'))}</td>
                  <td>${escapeHtml(entry.request.method)}</td>
                  <td style="${MONO_STYLE}">${escapeHtml(r.requestUrl)}</td>
                  <td class="status${resultClass}" style="margin:0;">${escapeHtml(resultText)}</td>
                  <td><button type="button" class="button-link button-link--small a4t-history-load" data-index="${i}">Load</button></td>
                </tr>
              `;
            })
            .join('')}
        </tbody>
      </table>
    `;
    historyEl.querySelectorAll('.a4t-history-load').forEach((btn) => {
      btn.addEventListener('click', () => {
        const entry = history[Number(btn.dataset.index)];
        if (!entry) return;
        methodSelect.value = entry.request.method;
        baseUrlInput.value = entry.request.baseUrl;
        pathInput.value = entry.request.path;
        queryInput.value = entry.request.query;
        headersInput.value = entry.request.headers;
        bodyInput.value = entry.request.body;
        renderResponse(entry);
      });
    });
  }

  sendButton.addEventListener('click', async () => {
    const request = {
      method: methodSelect.value,
      baseUrl: baseUrlInput.value.trim(),
      path: pathInput.value.trim(),
      query: queryInput.value.trim(),
      headers: headersInput.value.trim(),
      body: bodyInput.value.trim(),
    };
    sendButton.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = 'Sending...';
    responseEl.innerHTML = '';
    try {
      const res = await fetch('/api/access4-api-tester/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || `Request failed (${res.status})`);
      statusEl.hidden = true;
      const entry = { at: Date.now(), request, result };
      history = [entry, ...history].slice(0, HISTORY_LIMIT);
      renderResponse(entry);
      renderHistory();
    } catch (err) {
      statusEl.hidden = false;
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      sendButton.disabled = false;
    }
  });

  renderHistory();
  loadConfig();
}
