export const id = 'access4-sms';
export const label = 'SMS';

// Same "survive a remount instantly, still refresh in the background"
// module-scope caching convention most pages here use -- whichever
// mount() is CURRENTLY on screen keeps its own render functions live via
// these.
let lastMessageLog = null;
let activeConversationId = null;

const DEFAULT_DAYS = 90;

// What a status means: how an INCOMING text was handled/processed, by
// request -- a small, choosable list shown right on each list row (not
// buried in the conversation panel). "Awaiting Reply" is the one
// exception -- the system sets it automatically (we've sent something and
// are waiting on a reply), so it's never offered as a manual pick
// (SELECTABLE_STATUSES below), just displayed with its own colour when
// it's the current state. "Opted Out" was removed entirely, by request --
// the separate Do Not Contact flag already covers that, so it was a
// redundant second way to say the same thing.
const STATUS_LABELS = {
  new: 'New',
  awaiting_reply: 'Awaiting Reply',
  replied_sms: 'Replied -- SMS',
  replied_email: 'Replied -- Email',
  replied_phone: 'Replied -- Phone',
  ticket_logged: 'Ticket Logged',
  escalated: 'Escalated',
  no_action_needed: 'No Action Needed',
  closed: 'Closed',
};
const SELECTABLE_STATUSES = Object.keys(STATUS_LABELS).filter((s) => s !== 'awaiting_reply');

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
  return new Date(iso).toLocaleString('en-AU');
}

// CSS `width: fit-content` on a styled (appearance: none) <select> still
// sizes to its WIDEST OPTION in every real browser tested (confirmed
// live -- "New"'s pill rendered as wide as "No Action Needed"'s, even
// though only "New" was ever selected), not the currently selected one
// -- a <select>'s native box model reserves that width regardless of
// `appearance`. Measuring the selected option's own text with a canvas
// (same font the select actually renders in, read live off the element
// so this never drifts from its real CSS) and setting an explicit pixel
// width is the one approach that actually sizes to just the selected
// text, by request ("make them fit to text").
let a4sMeasureCanvas = null;
function sizeStatusSelectToText(select) {
  const option = select.options[select.selectedIndex];
  const text = option ? option.textContent : '';
  if (!a4sMeasureCanvas) a4sMeasureCanvas = document.createElement('canvas');
  const ctx = a4sMeasureCanvas.getContext('2d');
  ctx.font = getComputedStyle(select).font;
  const textWidth = ctx.measureText(text).width;
  const style = getComputedStyle(select);
  const horizontalPadding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  select.style.width = `${Math.ceil(textWidth + horizontalPadding) + 2}px`;
}

function formatPhone(phoneNumber) {
  // Display-only: "61412345678" -> "0412 345 678" -- the same canonical
  // 61xxxxxxxxx form the backend stores/normalizes everything to.
  const m = /^61(\d{9})$/.exec(phoneNumber || '');
  if (!m) return phoneNumber || '';
  const d = m[1];
  return `0${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
}

// Same conservative GSM-7 check/segment math the original single-send page
// already proved out -- kept unchanged.
function hasNonGsmChar(text) {
  return /[^\x00-\x7E£¥èéùìòÇØøÅå]/.test(text);
}
function segmentInfo(text) {
  const perSegment = hasNonGsmChar(text) ? 70 : 160;
  const max = perSegment === 70 ? 70 * 4 : 612;
  const segments = text.length === 0 ? 0 : Math.ceil(text.length / perSegment);
  return { length: text.length, perSegment, max, segments };
}

async function fetchJson(url, method, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  if (res.status !== 204) data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

export function mount(container) {
  container.classList.add('access4-sms-page');
  container.innerHTML = `
    <header class="page-header">
      <h1>SMS</h1>
      <div class="date-form">
        <button type="button" id="sms-new-button" class="button-link button-link--small">New Message</button>
        <button type="button" id="sms-templates-button" class="button-link button-link--small">Manage Templates</button>
        <button type="button" id="sms-refresh-button" class="button-link button-link--small refresh-button--emphasis">Refresh</button>
      </div>
    </header>
    <div class="a4s-layout">
      <div class="a4s-list-pane">
        <input type="text" id="sms-search-input" class="wsp-field a4s-search-input" placeholder="Search Client, Person, Ticket, or Phone..." />
        <div id="sms-list-wrap"><p class="status">Loading...</p></div>
      </div>
      <div class="a4s-detail-pane" id="sms-detail-wrap"></div>
    </div>
  `;

  const listWrapEl = container.querySelector('#sms-list-wrap');
  const detailWrapEl = container.querySelector('#sms-detail-wrap');
  const searchInput = container.querySelector('#sms-search-input');
  const refreshButton = container.querySelector('#sms-refresh-button');
  const newButton = container.querySelector('#sms-new-button');
  const templatesButton = container.querySelector('#sms-templates-button');

  // A genuine LOG, by direct request ("It's a log of messages... Just a
  // log with the latest message on top regardless or sender or
  // receiver") -- one row per real message (sent or received), not one
  // row per phone number summarizing it down to its single latest
  // message. GET /message-log already does the join, so each row here
  // carries both that one message's own fields and its conversation's
  // current company/contact/status.
  async function loadMessageLog() {
    try {
      const params = new URLSearchParams({ days: String(DEFAULT_DAYS) });
      if (searchInput.value.trim()) params.set('q', searchInput.value.trim());
      const data = await fetchJson(`/api/access4-sms/message-log?${params.toString()}`, 'GET');
      lastMessageLog = data.messages;
      renderList(lastMessageLog);
    } catch (err) {
      listWrapEl.innerHTML = `<p class="status error">Error: ${escapeHtml(err.message)}</p>`;
    }
  }

  // Status select per row -- a real PER-MESSAGE value (editing one
  // message's status never touches any other message, even another on
  // the same conversation -- by direct correction, this was wrongly
  // shared across a whole conversation for a while). "awaiting_reply"
  // included only to display correctly when it's the CURRENT status
  // (system-set, never manually chosen -- disabled so it can't be picked
  // back once changed away from it, same "current value can still show
  // even though it's not an offered choice" behaviour every browser
  // already gives a disabled <option>).
  function statusSelectHtml(messageId, currentStatus) {
    const options = SELECTABLE_STATUSES.includes(currentStatus) ? SELECTABLE_STATUSES : [currentStatus, ...SELECTABLE_STATUSES];
    return `
      <select class="a4s-conv-status-select a4s-conv-status-select--${escapeHtml(currentStatus)}" data-id="${messageId}">
        ${options
          .map((s) => `<option value="${s}"${s === currentStatus ? ' selected' : ''}${s === 'awaiting_reply' ? ' disabled' : ''}>${escapeHtml(STATUS_LABELS[s] || s)}</option>`)
          .join('')}
      </select>
    `;
  }

  // A real table, by request ("needs to be like table format") -- same
  // .resource-group/shaded-row conventions every other table on this
  // dashboard uses, rows as <tr> (with a nested <select> in its own <td>,
  // same click-vs-select-click distinction the earlier div-row version
  // already needed). `data-id` on each ROW is the CONVERSATION id (for
  // opening that whole conversation's history) -- the status <select>
  // nested inside carries its own, separate `data-id` (the MESSAGE id),
  // since status is per-message, not per-conversation.
  function renderList(messages) {
    if (!messages || messages.length === 0) {
      listWrapEl.innerHTML = '<p class="status">No messages in this period.</p>';
      return;
    }
    listWrapEl.innerHTML = `
      <div class="resource-group a4s-conv-table-wrap">
        <table class="a4s-conv-table">
          <thead>
            <tr class="shaded-row">
              <th>Type</th>
              <th>Client</th>
              <th>Phone</th>
              <th>Message</th>
              <th>Ticket #</th>
              <th>Status</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            ${messages
              .map((m) => {
                const isNote = m.logType === 'note';
                // Blank rather than "Unlinked", by request -- less noisy
                // for the common case of a number with no client match
                // yet. Person name on its own line under the Client name,
                // in grey, by request -- was inline on one line before.
                const who = m.companyName
                  ? `${escapeHtml(m.companyName)}${m.contactName ? `<br><span class="a4s-conv-who-person">${escapeHtml(m.contactName)}</span>` : ''}`
                  : '';
                // Blue "Sent" / orange "Received" / green "Note" -- same
                // colours as the message bubbles themselves
                // (.a4s-msg-bubble--out/--in), by request -- THIS row's
                // own real type, not a conversation-level summary.
                const dirLabel = isNote ? 'Note' : m.direction === 'out' ? 'Sent' : 'Received';
                const dirClass = isNote ? ' a4s-conv-who--note' : ` a4s-conv-who--${m.direction}`;
                // Status is "how an incoming text was handled" -- a note
                // has none at all (blank); an OUTBOUND message row shows
                // that message's own real send outcome (plain text, not a
                // pill -- "Sent"/"Send Failed", the real Access4 error on
                // hover for a failure) rather than a pick-list, since
                // there's nothing incoming on THIS row to have handled. An
                // INBOUND row shows THIS message's own editable status --
                // per-message, not shared with any other row.
                let statusCellHtml;
                if (isNote) {
                  statusCellHtml = '';
                } else if (m.direction === 'out' && m.sendStatus === 'failed') {
                  statusCellHtml = `<span class="a4s-conv-status-text a4s-conv-status-text--failed" title="${escapeHtml(m.error || '')}">Send Failed</span>`;
                } else if (m.direction === 'out' && m.sendStatus === 'simulated') {
                  statusCellHtml = '<span class="a4s-conv-status-text a4s-conv-status-text--simulated">Simulated Send</span>';
                } else if (m.direction === 'out') {
                  statusCellHtml = '<span class="a4s-conv-status-text a4s-conv-status-text--sent">Sent</span>';
                } else {
                  statusCellHtml = statusSelectHtml(m.itemId, m.status);
                }
                // Unread only ever applies to an inbound message -- a
                // note or an outbound message is never itself "unread".
                const isUnread = !isNote && m.direction === 'in' && m.hasUnread;
                return `
                <tr class="a4s-conv-row${isUnread ? ' a4s-conv-row--unread' : ''}${m.conversationId === activeConversationId ? ' a4s-conv-row--active' : ''}" data-id="${m.conversationId}" tabindex="0">
                  <td class="a4s-conv-direction${dirClass}">${dirLabel}</td>
                  <td class="a4s-conv-who">${who}</td>
                  <td class="a4s-conv-phone">${escapeHtml(formatPhone(m.phoneNumber))}</td>
                  <td class="a4s-conv-preview">${escapeHtml(m.body || '')}</td>
                  <td class="a4s-conv-ticket">${escapeHtml(m.ticketNumber || '')}</td>
                  <td>${statusCellHtml}</td>
                  <td class="a4s-conv-time">${formatDateTime(m.createdAt)}</td>
                </tr>`;
              })
              .join('')}
          </tbody>
        </table>
      </div>
    `;
    listWrapEl.querySelectorAll('.a4s-conv-row').forEach((row) => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('select')) return;
        loadDetail(Number(row.dataset.id));
      });
      row.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('select')) {
          e.preventDefault();
          loadDetail(Number(row.dataset.id));
        }
      });
    });
    listWrapEl.querySelectorAll('.a4s-conv-status-select').forEach((select) => {
      sizeStatusSelectToText(select);
      select.addEventListener('click', (e) => e.stopPropagation());
      select.addEventListener('change', async (e) => {
        e.stopPropagation();
        const messageId = Number(select.dataset.id);
        const newStatus = select.value;
        try {
          await fetchJson(`/api/access4-sms/messages/${messageId}/status`, 'PATCH', { status: newStatus });
          // Per-message -- only THIS row's own cached status changes.
          const row = lastMessageLog?.find((m) => m.itemId === messageId);
          if (row) row.status = newStatus;
          select.className = `a4s-conv-status-select a4s-conv-status-select--${newStatus}`;
          sizeStatusSelectToText(select);
        } catch (err) {
          alert(`Error updating status: ${err.message}`);
          loadMessageLog();
        }
      });
    });
  }

  let searchDebounce = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(loadMessageLog, 250);
  });
  refreshButton.addEventListener('click', loadMessageLog);
  newButton.addEventListener('click', () => {
    activeConversationId = null;
    if (lastMessageLog) renderList(lastMessageLog);
    showNewMessagePanel();
  });
  templatesButton.addEventListener('click', () => openTemplatesModal());

  // --- Detail pane ---------------------------------------------------

  async function loadDetail(conversationId) {
    activeConversationId = conversationId;
    if (lastMessageLog) renderList(lastMessageLog); // re-render to highlight the active rows
    detailWrapEl.innerHTML = '<p class="status">Loading...</p>';
    try {
      const data = await fetchJson(`/api/access4-sms/conversations/${conversationId}`, 'GET');
      await fetchJson(`/api/access4-sms/conversations/${conversationId}/mark-read`, 'POST', {});
      renderPanel(data);
      // Reflect the now-cleared unread flag in the list without a full
      // reload -- cheaper than re-fetching the whole log. Every row for
      // this conversation shares the one flag.
      if (lastMessageLog) {
        lastMessageLog.forEach((m) => {
          if (m.conversationId === conversationId) m.hasUnread = false;
        });
        renderList(lastMessageLog);
      }
    } catch (err) {
      detailWrapEl.innerHTML = `<p class="status error">Error: ${escapeHtml(err.message)}</p>`;
    }
  }

  function messageBubbleHtml(m) {
    const statusNote =
      m.direction === 'out' && m.sendStatus === 'failed'
        ? `<div class="a4s-msg-error">Failed to send${m.error ? `: ${escapeHtml(m.error)}` : ''}</div>`
        : m.direction === 'out' && m.sendStatus === 'simulated'
          ? '<div class="a4s-msg-simulated">Simulated Send -- not actually sent through Access4</div>'
          : '';
    const manualNote = m.direction === 'in' && m.isLoggedManually ? '<span class="a4s-msg-manual-tag">Manually logged</span>' : '';
    const ticketTag = m.ticketNumber ? `<span class="a4s-msg-ticket-tag">Ticket: ${escapeHtml(m.ticketNumber)}</span>` : '';
    const byline = m.direction === 'out' && m.sentByName ? escapeHtml(m.sentByName) : '';
    return `
      <div class="a4s-msg-row a4s-msg-row--${m.direction}">
        <div class="a4s-msg-bubble a4s-msg-bubble--${m.direction}">
          <div class="a4s-msg-body">${escapeHtml(m.body)}</div>
          <div class="a4s-msg-meta">
            ${byline ? `<span>${byline}</span>` : ''}
            <span>${formatDateTime(m.createdAt)}</span>
            ${manualNote}
          </div>
          ${ticketTag ? `<div class="a4s-msg-tags">${ticketTag}</div>` : ''}
          ${statusNote}
        </div>
      </div>
    `;
  }

  // The whole right-hand panel -- identity fields (Number/Client/Contact),
  // message thread, compose box, Simulate Reply, and notes -- ONE shared
  // renderer for both an existing conversation and a not-yet-created one
  // (conversation: null), by request ("always ready to fill... should
  // look like it's an app embedded in the page"). Client/contact linking
  // is inline now (type-ahead against real Autotask companies/contacts
  // via <datalist>, resolveCompany()/resolveContact() below), not a
  // separate "Link to Client" modal -- resolved values are applied when
  // Send/Simulate Reply is actually clicked, not on every keystroke.
  function renderPanel({ conversation: c, messages, notes }) {
    const isNew = !c;
    detailWrapEl.innerHTML = `
      <div class="a4s-app">
        <div class="a4s-app-header">
          <span class="a4s-app-title">${isNew ? 'New Message' : 'Conversation'}</span>
          ${
            isNew
              ? ''
              : `<div class="a4s-app-header-actions">
                   <label class="inline-checkbox-label a4s-dnc-label"><input type="checkbox" id="sms-dnc-checkbox" ${c.doNotContact ? 'checked' : ''} /> DNC</label>
                 </div>`
          }
        </div>

        <div class="a4s-app-identity">
          <div class="pm-form-field">
            <label for="sms-phone-input">Mobile Number</label>
            <input type="text" id="sms-phone-input" class="wsp-field" placeholder="e.g. 0412 345 678" value="${escapeHtml(isNew ? '' : formatPhone(c.phoneNumber))}" ${isNew ? '' : 'readonly'} />
          </div>
          <div class="pm-form-field">
            <label for="sms-company-input">Client (Company) Name</label>
            <input type="text" id="sms-company-input" class="wsp-field" list="sms-company-datalist" placeholder="Start typing a company name..." value="${escapeHtml(isNew ? '' : c.companyName || '')}" />
            <datalist id="sms-company-datalist"></datalist>
          </div>
          <div class="pm-form-field">
            <label for="sms-contact-input">Contact Name</label>
            <input type="text" id="sms-contact-input" class="wsp-field" list="sms-contact-datalist" placeholder="Optional" value="${escapeHtml(isNew ? '' : c.contactName || '')}" />
            <datalist id="sms-contact-datalist"></datalist>
          </div>
        </div>

        ${
          isNew
            ? ''
            : `<div class="a4s-thread" id="sms-thread">
                 ${messages.length === 0 ? '<p class="status">No messages yet.</p>' : messages.map(messageBubbleHtml).join('')}
               </div>`
        }

        <div class="a4s-compose">
          <div class="pm-form-field">
            <label for="sms-template-select">Template</label>
            <select id="sms-template-select" class="wsp-field">
              <option value="">Choose a template...</option>
            </select>
          </div>
          <div class="pm-form-field">
            <label for="sms-ticket-input">Ticket Number</label>
            <input type="text" id="sms-ticket-input" class="wsp-field" placeholder="Optional" />
          </div>
          <div id="sms-tags-wrap" class="a4s-tags-wrap"></div>
          <div class="pm-form-field">
            <label for="sms-compose-input">Message</label>
            <textarea id="sms-compose-input" class="wsp-field a4s-compose-input" rows="3" placeholder="Type a message..."></textarea>
            <p id="sms-segment-info" class="inline-subtext"></p>
          </div>
          ${!isNew && c.doNotContact ? '<p class="status error">This number is marked Do Not Contact -- sending is disabled.</p>' : ''}
          <div class="a4s-compose-actions">
            <button type="button" id="sms-simulate-send-button" class="button-link button-link--small" title="Logs this as sent without actually calling Access4 -- useful while the real account isn't working">Simulate Send</button>
            <button type="button" id="sms-send-button" class="button-link"${!isNew && c.doNotContact ? ' disabled' : ''}>Send</button>
          </div>
          <p id="sms-compose-status" class="status" hidden></p>
        </div>

        <div class="a4s-simulate-box">
          <label for="sms-simulate-input">Simulate Reply <span class="inline-subtext">(stand-in until real inbound receiving is built)</span></label>
          <textarea id="sms-simulate-input" class="wsp-field" rows="2" placeholder="Type what the client said..."></textarea>
          <div class="a4s-simulate-actions">
            <button type="button" id="sms-simulate-button" class="button-link button-link--small">Simulate Reply</button>
          </div>
          <p id="sms-simulate-status" class="status" hidden></p>
        </div>

        ${
          isNew
            ? ''
            : `<div class="a4s-notes-section">
                 <p class="a4s-notes-heading">Notes</p>
                 <div id="sms-notes-list">
                   ${
                     notes.length === 0
                       ? '<p class="inline-subtext">No notes yet.</p>'
                       : notes.map((n) => `<div class="a4s-note"><span>${escapeHtml(n.body)}</span><span class="a4s-note-meta">${escapeHtml(n.createdByName || '')} -- ${formatDateTime(n.createdAt)}</span></div>`).join('')
                   }
                 </div>
                 <div class="a4s-note-form">
                   <input type="text" id="sms-note-input" class="wsp-field" placeholder="Add an internal note..." />
                   <button type="button" id="sms-note-add-button" class="button-link button-link--small">Add Note</button>
                 </div>
               </div>`
        }
      </div>
    `;

    const threadEl = detailWrapEl.querySelector('#sms-thread');
    if (threadEl) threadEl.scrollTop = threadEl.scrollHeight;

    if (!isNew) {
      detailWrapEl.querySelector('#sms-dnc-checkbox').addEventListener('change', async (e) => {
        try {
          await fetchJson(`/api/access4-sms/conversations/${c.id}`, 'PATCH', { doNotContact: e.target.checked });
          await loadDetail(c.id);
        } catch (err) {
          alert(`Error: ${err.message}`);
        }
      });

      const noteInput = detailWrapEl.querySelector('#sms-note-input');
      detailWrapEl.querySelector('#sms-note-add-button').addEventListener('click', async () => {
        const body = noteInput.value.trim();
        if (!body) return;
        try {
          await fetchJson(`/api/access4-sms/conversations/${c.id}/notes`, 'POST', { body });
          await loadDetail(c.id);
        } catch (err) {
          alert(`Error adding note: ${err.message}`);
        }
      });
    }

    // --- Identity fields: inline Autotask company/contact search -------
    const phoneInput = detailWrapEl.querySelector('#sms-phone-input');
    const companyInput = detailWrapEl.querySelector('#sms-company-input');
    const companyDatalist = detailWrapEl.querySelector('#sms-company-datalist');
    const contactInput = detailWrapEl.querySelector('#sms-contact-input');
    const contactDatalist = detailWrapEl.querySelector('#sms-contact-datalist');
    let companyNameToId = new Map();
    let contactNameToId = new Map();

    let companySearchDebounce = null;
    companyInput.addEventListener('input', () => {
      clearTimeout(companySearchDebounce);
      const q = companyInput.value.trim();
      if (q.length < 2) {
        companyDatalist.innerHTML = '';
        return;
      }
      companySearchDebounce = setTimeout(async () => {
        try {
          const data = await fetchJson(`/api/access4-sms/company-search?q=${encodeURIComponent(q)}`, 'GET');
          companyNameToId = new Map(data.companies.map((comp) => [comp.companyName, comp.id]));
          companyDatalist.innerHTML = data.companies.map((comp) => `<option value="${escapeHtml(comp.companyName)}"></option>`).join('');
        } catch (err) {
          // Non-fatal -- the field still works as free text.
        }
      }, 250);
    });
    companyInput.addEventListener('change', async () => {
      const name = companyInput.value.trim();
      const id = companyNameToId.get(name);
      contactInput.value = '';
      contactDatalist.innerHTML = '';
      contactNameToId = new Map();
      if (id) {
        try {
          const data = await fetchJson(`/api/access4-sms/companies/${id}/contacts`, 'GET');
          contactNameToId = new Map(data.contacts.map((ct) => [ct.name, ct.id]));
          contactDatalist.innerHTML = data.contacts.map((ct) => `<option value="${escapeHtml(ct.name)}"></option>`).join('');
        } catch (err) {
          // Non-fatal.
        }
      }
    });

    // Resolved at ACT time (Send/Simulate Reply), not on every keystroke --
    // an exact match against the live search results wins; otherwise, if
    // the field still reads exactly as it did when this conversation
    // loaded, the original linked id carries over unchanged; anything
    // else is free text with no real Autotask id (same "manual, not
    // required" linking this page already allows).
    function resolveCompany() {
      const name = companyInput.value.trim();
      if (!name) return { companyId: null, companyName: null };
      if (companyNameToId.has(name)) return { companyId: companyNameToId.get(name), companyName: name };
      if (c && name === (c.companyName || '')) return { companyId: c.companyId, companyName: c.companyName };
      return { companyId: null, companyName: name };
    }
    function resolveContact() {
      const name = contactInput.value.trim();
      if (!name) return { contactId: null, contactName: null };
      if (contactNameToId.has(name)) return { contactId: contactNameToId.get(name), contactName: name };
      if (c && name === (c.contactName || '')) return { contactId: c.contactId, contactName: c.contactName };
      return { contactId: null, contactName: name };
    }

    // Applies the identity fields' current state to an EXISTING
    // conversation, only if something actually changed -- called right
    // before Send/Simulate Reply so a field edited without saving isn't
    // silently lost the next time this panel re-renders.
    async function applyLinkIfChanged() {
      if (isNew) return;
      const company = resolveCompany();
      const contact = resolveContact();
      const changed =
        company.companyId !== c.companyId || company.companyName !== c.companyName || contact.contactId !== c.contactId || contact.contactName !== c.contactName;
      if (!changed) return;
      if (company.companyName) {
        await fetchJson(`/api/access4-sms/conversations/${c.id}/link-client`, 'POST', {
          companyId: company.companyId,
          companyName: company.companyName,
          contactId: contact.contactId,
          contactName: contact.contactName,
        });
      } else {
        await fetchJson(`/api/access4-sms/conversations/${c.id}/link-client`, 'DELETE');
      }
    }

    async function ensureConversationId() {
      if (!isNew) return c.id;
      const phoneNumber = phoneInput.value.trim();
      if (!phoneNumber) {
        phoneInput.focus();
        throw new Error('Enter a mobile number first.');
      }
      const company = resolveCompany();
      const contact = resolveContact();
      const data = await fetchJson('/api/access4-sms/conversations', 'POST', {
        phoneNumber,
        companyId: company.companyId,
        companyName: company.companyName,
        contactId: contact.contactId,
        contactName: contact.contactName,
      });
      return data.conversation.id;
    }

    // --- Compose: templates + tag fill-in + Send ------------------------
    const composeInput = detailWrapEl.querySelector('#sms-compose-input');
    const segmentInfoEl = detailWrapEl.querySelector('#sms-segment-info');
    const tagsWrapEl = detailWrapEl.querySelector('#sms-tags-wrap');
    const sendButton = detailWrapEl.querySelector('#sms-send-button');
    const simulateSendButton = detailWrapEl.querySelector('#sms-simulate-send-button');
    const ticketInput = detailWrapEl.querySelector('#sms-ticket-input');
    const composeStatusEl = detailWrapEl.querySelector('#sms-compose-status');
    const doNotContact = !isNew && c.doNotContact;

    // Known tag values -- still shown as a clickable chip for review (per
    // request, "tags... clicked and completed/replaced before sending",
    // nothing silently assumed), just pre-populated with a suggested
    // value where one's available, read live off the identity fields so
    // a name typed but not yet saved still suggests correctly.
    function knownTagValue(tagName) {
      const name = tagName.trim().toLowerCase();
      if (name === 'ticketnumber' && ticketInput.value.trim()) return ticketInput.value.trim();
      if (name === 'contactname' && contactInput.value.trim()) return contactInput.value.trim();
      if (name === 'companyname' && companyInput.value.trim()) return companyInput.value.trim();
      return null;
    }

    function renderTagChips() {
      const text = composeInput.value;
      const found = [...new Set([...text.matchAll(/\{\{([^}]+)\}\}/g)].map((m) => m[1]))];
      if (found.length === 0) {
        tagsWrapEl.innerHTML = '';
        sendButton.disabled = !!doNotContact;
        simulateSendButton.disabled = !!doNotContact;
        return;
      }
      sendButton.disabled = true;
      simulateSendButton.disabled = true;
      tagsWrapEl.innerHTML = found
        .map((tag) => {
          const suggestion = knownTagValue(tag);
          return `<button type="button" class="a4s-tag-chip" data-tag="${escapeHtml(tag)}" data-suggestion="${escapeHtml(suggestion || '')}">{{${escapeHtml(tag)}}}${suggestion ? ` &rarr; ${escapeHtml(suggestion)}` : ''}</button>`;
        })
        .join('');
      tagsWrapEl.querySelectorAll('.a4s-tag-chip').forEach((chip) => {
        chip.addEventListener('click', () => {
          const tag = chip.dataset.tag;
          const suggestion = chip.dataset.suggestion;
          const value = suggestion || window.prompt(`Fill in {{${tag}}}:`, '') || '';
          if (!value) return;
          composeInput.value = composeInput.value.split(`{{${tag}}}`).join(value);
          updateCompose();
          composeInput.focus();
        });
      });
    }

    function updateCompose() {
      const { length, perSegment, max, segments } = segmentInfo(composeInput.value);
      segmentInfoEl.textContent = `${length} character${length === 1 ? '' : 's'} -- ${segments} SMS segment${segments === 1 ? '' : 's'} (${perSegment}/segment, ${max} max)`;
      segmentInfoEl.classList.toggle('cell-flag-red', length > max);
      renderTagChips();
    }
    composeInput.addEventListener('input', updateCompose);
    updateCompose();
    (isNew ? phoneInput : composeInput).focus();

    detailWrapEl.querySelector('#sms-template-select').addEventListener('change', (e) => {
      const tpl = (window.__sms_templates_cache || []).find((t) => String(t.id) === e.target.value);
      if (tpl) composeInput.value = tpl.body;
      updateCompose();
    });
    loadTemplatesIntoSelect(detailWrapEl.querySelector('#sms-template-select'));

    // Simulate Send -- logs the message as sent WITHOUT calling the real
    // Access4 API at all, by request ("Don't try to do the actual send on
    // these and treat as a Success"). Useful for testing the send flow
    // while the real account isn't working.
    simulateSendButton.addEventListener('click', async () => {
      const body = composeInput.value.trim();
      if (!body) return;
      composeStatusEl.hidden = false;
      composeStatusEl.className = 'status loading';
      composeStatusEl.textContent = 'Simulating send...';
      simulateSendButton.disabled = true;
      sendButton.disabled = true;
      try {
        const ticketNumber = ticketInput.value.trim() || null;
        const convId = await ensureConversationId();
        await applyLinkIfChanged();
        await fetchJson(`/api/access4-sms/conversations/${convId}/simulate-send`, 'POST', { body, ticketNumber });
        await loadMessageLog();
        await loadDetail(convId);
      } catch (err) {
        composeStatusEl.hidden = false;
        composeStatusEl.className = 'status error';
        composeStatusEl.textContent = `Error: ${err.message}`;
      } finally {
        simulateSendButton.disabled = false;
        sendButton.disabled = false;
      }
    });

    sendButton.addEventListener('click', async () => {
      const body = composeInput.value.trim();
      if (!body) return;
      composeStatusEl.hidden = false;
      composeStatusEl.className = 'status loading';
      composeStatusEl.textContent = 'Sending...';
      sendButton.disabled = true;
      simulateSendButton.disabled = true;
      try {
        const ticketNumber = ticketInput.value.trim() || null;
        const convId = await ensureConversationId();
        await applyLinkIfChanged();
        const result = await fetchJson(`/api/access4-sms/conversations/${convId}/send`, 'POST', { body, ticketNumber });
        await loadMessageLog();
        await loadDetail(convId);
        if (result.ok === false) {
          const statusEl = detailWrapEl.querySelector('#sms-compose-status');
          if (statusEl) {
            statusEl.hidden = false;
            statusEl.className = 'status error';
            statusEl.textContent = `Logged, but the send itself failed: ${result.error || 'Access4 did not confirm delivery.'}`;
          }
        }
      } catch (err) {
        composeStatusEl.hidden = false;
        composeStatusEl.className = 'status error';
        composeStatusEl.textContent = `Error: ${err.message}`;
        sendButton.disabled = false;
        simulateSendButton.disabled = false;
      }
    });

    // --- Simulate Reply (manual stand-in for real inbound receiving) ---
    const simulateInput = detailWrapEl.querySelector('#sms-simulate-input');
    const simulateButton = detailWrapEl.querySelector('#sms-simulate-button');
    const simulateStatusEl = detailWrapEl.querySelector('#sms-simulate-status');
    simulateButton.addEventListener('click', async () => {
      const body = simulateInput.value.trim();
      if (!body) return;
      simulateButton.disabled = true;
      try {
        const ticketNumber = ticketInput.value.trim() || null;
        const convId = await ensureConversationId();
        await applyLinkIfChanged();
        await fetchJson(`/api/access4-sms/conversations/${convId}/log-inbound`, 'POST', { body, ticketNumber });
        await loadMessageLog();
        await loadDetail(convId);
      } catch (err) {
        simulateStatusEl.hidden = false;
        simulateStatusEl.className = 'status error';
        simulateStatusEl.textContent = `Error: ${err.message}`;
        simulateButton.disabled = false;
      }
    });
  }

  function showNewMessagePanel() {
    renderPanel({ conversation: null, messages: [], notes: [] });
  }

  // --- Templates (shared cache + dropdown + management modal) --------

  async function loadTemplatesIntoSelect(selectEl) {
    try {
      const data = await fetchJson('/api/access4-sms/templates', 'GET');
      window.__sms_templates_cache = data.templates;
      selectEl.innerHTML =
        '<option value="">Choose a template...</option>' + data.templates.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
    } catch (err) {
      // Non-fatal -- compose still works with no templates loaded.
    }
  }

  function openModal(innerHtml) {
    const overlay = document.createElement('div');
    overlay.className = 'history-modal-overlay';
    overlay.innerHTML = `<div class="history-modal-panel a4s-modal-panel">${innerHtml}</div>`;
    document.body.appendChild(overlay);
    const close = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKeydown);
    };
    function onKeydown(e) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('keydown', onKeydown);
    overlay.querySelector('.history-modal-close')?.addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
    return { overlay, close };
  }

  function openTemplatesModal() {
    const { overlay, close } = openModal(`
      <div class="history-modal-panel-header">
        <span>Manage Templates</span>
        <button type="button" class="history-modal-close" aria-label="Close">&#10005;</button>
      </div>
      <div class="history-modal-body">
        <p class="inline-subtext">Use <code>{{TagName}}</code> for anything that needs filling in before sending (e.g. <code>{{ContactName}}</code>, <code>{{TicketNumber}}</code>, <code>{{AppointmentTime}}</code>).</p>
        <div id="sms-templates-list"></div>
        <h3 class="a4s-template-form-heading">Add Template</h3>
        <div class="pm-form-field">
          <label for="sms-template-name">Name</label>
          <input type="text" id="sms-template-name" class="wsp-field" />
        </div>
        <div class="pm-form-field">
          <label for="sms-template-body">Message body</label>
          <textarea id="sms-template-body" class="wsp-field" rows="3"></textarea>
        </div>
        <p class="status error a4s-template-error" hidden></p>
        <div class="wsp-form-actions">
          <button type="button" class="button-link a4s-template-add">Add Template</button>
        </div>
      </div>
    `);
    const listEl = overlay.querySelector('#sms-templates-list');
    const errorEl = overlay.querySelector('.a4s-template-error');

    async function refreshList() {
      const data = await fetchJson('/api/access4-sms/templates', 'GET');
      window.__sms_templates_cache = data.templates;
      listEl.innerHTML =
        data.templates.length === 0
          ? '<p class="inline-subtext">No templates yet.</p>'
          : `<table class="ann-table"><thead><tr class="shaded-row"><th>Name</th><th>Body</th><th></th></tr></thead><tbody>${data.templates
              .map(
                (t) => `
            <tr>
              <td>${escapeHtml(t.name)}</td>
              <td>${escapeHtml(t.body)}</td>
              <td><button type="button" class="button-link button-link--small a4s-template-delete" data-id="${t.id}">Delete</button></td>
            </tr>`
              )
              .join('')}</tbody></table>`;
      listEl.querySelectorAll('.a4s-template-delete').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (!confirm('Delete this template?')) return;
          await fetchJson(`/api/access4-sms/templates/${btn.dataset.id}`, 'DELETE');
          await refreshList();
        });
      });
    }
    refreshList();

    overlay.querySelector('.a4s-template-add').addEventListener('click', async () => {
      const name = overlay.querySelector('#sms-template-name').value.trim();
      const body = overlay.querySelector('#sms-template-body').value.trim();
      try {
        await fetchJson('/api/access4-sms/templates', 'POST', { name, body });
        overlay.querySelector('#sms-template-name').value = '';
        overlay.querySelector('#sms-template-body').value = '';
        await refreshList();
      } catch (err) {
        errorEl.hidden = false;
        errorEl.textContent = err.message;
      }
    });
  }

  loadMessageLog();
  showNewMessagePanel();
}
