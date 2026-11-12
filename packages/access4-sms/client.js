export const id = 'access4-sms';
export const label = 'SMS (Access4)';

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDateTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString();
}

// Conservative GSM-7 check -- anything outside plain ASCII plus a handful
// of common GSM-7 extras (£, accented letters the guide's own examples
// don't call out individually) is treated as "forces unicode mode", same
// "emojis reduce your character count to 70" framing the API guide itself
// uses. Not a full GSM-7 charset table -- just enough to warn before
// someone hits Send, not to perfectly predict Access4's own segmentation.
function hasNonGsmChar(text) {
  return /[^\x00-\x7E£¥èéùìòÇØøÅå]/.test(text);
}

function segmentInfo(text) {
  const perSegment = hasNonGsmChar(text) ? 70 : 160;
  const max = perSegment === 70 ? 70 * 4 : 612; // the guide's own 612-char cap is GSM-7 specific
  const segments = text.length === 0 ? 0 : Math.ceil(text.length / perSegment);
  return { length: text.length, perSegment, max, segments };
}

export function mount(container) {
  container.classList.add('access4-sms-page');
  container.innerHTML = `
    <header class="page-header">
      <h1>SMS (Access4)</h1>
    </header>
    <p id="a4s-status" class="status" hidden></p>
    <form id="a4s-send-form">
      <div class="resource-group">
        <label for="a4s-to-input">To (mobile)</label>
        <input type="text" id="a4s-to-input" placeholder="e.g. 0412 345 678" required />
        <label for="a4s-message-input">Message</label>
        <textarea id="a4s-message-input" rows="4" placeholder="Message text" required></textarea>
        <p id="a4s-segment-info" class="inline-subtext"></p>
        <button type="submit" id="a4s-send-button" class="button-link">Send</button>
      </div>
    </form>
    <h2 class="client-summary-section-heading">Recently Sent</h2>
    <div id="a4s-log-results"></div>
  `;

  const statusEl = container.querySelector('#a4s-status');
  const form = container.querySelector('#a4s-send-form');
  const toInput = container.querySelector('#a4s-to-input');
  const messageInput = container.querySelector('#a4s-message-input');
  const segmentInfoEl = container.querySelector('#a4s-segment-info');
  const logResultsEl = container.querySelector('#a4s-log-results');

  function updateSegmentInfo() {
    const { length, perSegment, max, segments } = segmentInfo(messageInput.value);
    segmentInfoEl.textContent = `${length} character${length === 1 ? '' : 's'} -- ${segments} SMS segment${segments === 1 ? '' : 's'} (${perSegment}/segment, ${max} max)`;
    segmentInfoEl.classList.toggle('cell-flag-red', length > max);
  }
  messageInput.addEventListener('input', updateSegmentInfo);
  updateSegmentInfo();

  function renderLog(sent) {
    if (sent.length === 0) {
      logResultsEl.innerHTML = '<p class="status">No messages sent yet.</p>';
      return;
    }
    logResultsEl.innerHTML = `
      <div class="resource-group">
        <table>
          <thead><tr class="shaded-row"><th>Sent</th><th>To</th><th>Message</th><th>Status</th><th>By</th></tr></thead>
          <tbody>
            ${sent
              .map(
                (s) => `
              <tr>
                <td class="ticket-number">${formatDateTime(s.sentAt)}</td>
                <td>${escapeHtml(s.toMobile)}</td>
                <td>${escapeHtml(s.message)}</td>
                <td class="${s.status === 'sent' ? 'cell-flag-green' : 'cell-flag-red'}">${escapeHtml(s.status)}${s.error ? `<span class="cell-subtext">${escapeHtml(s.error)}</span>` : ''}</td>
                <td>${escapeHtml(s.sentByName)}</td>
              </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  async function loadLog() {
    try {
      const res = await fetch('/api/access4-sms');
      const data = await res.json();
      if (!data.configured) {
        statusEl.hidden = false;
        statusEl.className = 'status error';
        statusEl.textContent = 'Access4 SMS is not configured yet -- set ACCESS4_SMS_SERVICE_ID and ACCESS4_SMS_DID_NUMBER_ID in .env.';
      }
      renderLog(data.sent || []);
    } catch (err) {
      logResultsEl.innerHTML = `<p class="status error">Error loading log: ${escapeHtml(err.message)}</p>`;
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    statusEl.hidden = false;
    statusEl.className = 'status loading';
    statusEl.textContent = 'Sending...';
    try {
      const res = await fetch('/api/access4-sms/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toMobile: toInput.value.trim(), message: messageInput.value.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      statusEl.className = 'status';
      statusEl.textContent = `Sent (Access4 id ${data.smsId}).`;
      messageInput.value = '';
      updateSegmentInfo();
      await loadLog();
    } catch (err) {
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    }
  });

  loadLog();
}
