const express = require('express');
const axios = require('axios');
const { getClient, listAll } = require('@dashboard/autotask-client');
const {
  getConversation,
  listConversations,
  listMessageLog,
  createConversation,
  markRead,
  updateConversation,
  updateMessageStatus,
  linkClient,
  unlinkClient,
  listMessages,
  recordOutboundMessage,
  recordInboundMessage,
  previousTicketNumber,
  listNotes,
  addNote,
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
} = require('./db.js');

// Access4's SASBOSS SMS Gateway API -- see README.md. Gated by source-IP
// whitelisting on Access4's side only (no API key/token/Basic Auth at
// all); kept exactly as the page's original build proved it out.
const BASE_URL = process.env.ACCESS4_SMS_BASE_URL || 'https://api.sasboss.com.au:10000';
const SERVICE_ID = process.env.ACCESS4_SMS_SERVICE_ID;
const DID_NUMBER_ID = process.env.ACCESS4_SMS_DID_NUMBER_ID;

function hasAccess4Credentials() {
  return !!(SERVICE_ID && DID_NUMBER_ID);
}

function actorFrom(req) {
  return { email: req.session.user.email, name: req.session.user.name };
}

// Same normalization the original build proved out -- accepts "0412 345
// 678" / "+61412345678" / "61412345678", returns the bare 61xxxxxxxxx
// digits Access4's own API examples use, or null if it isn't 11 digits
// once normalized that way.
function normalizeAuMobile(input) {
  const digits = (input || '').replace(/[^\d]/g, '');
  if (digits.startsWith('61') && digits.length === 11) return digits;
  if (digits.startsWith('0') && digits.length === 10) return `61${digits.slice(1)}`;
  return null;
}

function toApiConversation(row) {
  return {
    id: row.id,
    phoneNumber: row.phone_number,
    companyId: row.company_id,
    companyName: row.company_name,
    contactId: row.contact_id,
    contactName: row.contact_name,
    status: row.status,
    hasUnread: !!row.has_unread,
    doNotContact: !!row.do_not_contact,
    assignedToEmail: row.assigned_to_email,
    assignedToName: row.assigned_to_name,
    lastMessageAt: row.last_message_at,
    lastMessagePreview: row.last_message_preview,
    lastMessageFailed: !!row.last_message_failed,
    lastMessageDirection: row.last_message_direction,
    lastMessageError: row.last_message_error,
    createdAt: row.created_at,
  };
}

function toApiMessage(row) {
  return {
    id: row.id,
    direction: row.direction,
    body: row.body,
    createdAt: row.created_at,
    sendStatus: row.send_status,
    error: row.error,
    ticketNumber: row.ticket_number,
    isLoggedManually: !!row.is_logged_manually,
    sentByName: row.sent_by_name,
    status: row.status,
  };
}

function toApiTemplate(row) {
  return { id: row.id, name: row.name, body: row.body, updatedAt: row.updated_at };
}

const router = express.Router();
router.use(express.json());

// --- Conversations -------------------------------------------------------

const DEFAULT_DAYS = 90;

router.get('/conversations', (req, res) => {
  try {
    const days = req.query.days ? Number(req.query.days) : DEFAULT_DAYS;
    const rows = listConversations({ days: Number.isFinite(days) && days > 0 ? days : DEFAULT_DAYS, q: req.query.q });
    res.json({ conversations: rows.map(toApiConversation) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The left-hand list's real source now -- a genuine log, one row per
// message (sent or received), newest first regardless of direction, by
// direct request ("Just a log with the latest message on top regardless
// or sender or receiver"). Each row carries both that one message's own
// fields AND its conversation's current company/contact/status/phone, so
// the list needs no second lookup per row.
router.get('/message-log', (req, res) => {
  try {
    const days = req.query.days ? Number(req.query.days) : DEFAULT_DAYS;
    const rows = listMessageLog({ days: Number.isFinite(days) && days > 0 ? days : DEFAULT_DAYS, q: req.query.q });
    res.json({
      messages: rows.map((r) => ({
        logType: r.log_type,
        itemId: r.item_id,
        conversationId: r.conversation_id,
        direction: r.direction,
        body: r.body,
        createdAt: r.created_at,
        sendStatus: r.send_status,
        error: r.error,
        ticketNumber: r.ticket_number,
        isLoggedManually: !!r.is_logged_manually,
        sentByName: r.sent_by_name,
        status: r.status,
        phoneNumber: r.phone_number,
        companyName: r.company_name,
        contactName: r.contact_name,
        hasUnread: !!r.has_unread,
        doNotContact: !!r.do_not_contact,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/conversations/:id', (req, res) => {
  const id = Number(req.params.id);
  const conversation = getConversation(id);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found.' });
  res.json({
    conversation: toApiConversation(conversation),
    messages: listMessages(id).map(toApiMessage),
    notes: listNotes(id).map((n) => ({ id: n.id, body: n.body, createdAt: n.created_at, createdByName: n.created_by_name })),
  });
});

router.post('/conversations', (req, res) => {
  const rawPhone = (req.body?.phoneNumber || '').trim();
  const phoneNumber = normalizeAuMobile(rawPhone);
  if (!phoneNumber) return res.status(400).json({ error: `"${rawPhone}" doesn't look like a valid Australian mobile number.` });
  const { companyId, companyName, contactId, contactName } = req.body || {};
  const conversation = createConversation({ phoneNumber, companyId, companyName, contactId, contactName });
  res.status(201).json({ conversation: toApiConversation(conversation) });
});

router.post('/conversations/:id/mark-read', (req, res) => {
  const id = Number(req.params.id);
  if (!getConversation(id)) return res.status(404).json({ error: 'Conversation not found.' });
  markRead(id);
  res.json({ ok: true });
});

router.patch('/conversations/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!getConversation(id)) return res.status(404).json({ error: 'Conversation not found.' });
  try {
    const conversation = updateConversation(id, req.body || {});
    res.json({ conversation: toApiConversation(conversation) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Status belongs to the MESSAGE, not the conversation -- editing one
// message's status never touches any other message, even another on the
// same conversation (an earlier version of this page wrongly shared it
// across every message for a number, by request this is now per-message
// only).
router.patch('/messages/:messageId/status', (req, res) => {
  const messageId = Number(req.params.messageId);
  try {
    const message = updateMessageStatus(messageId, req.body?.status);
    if (!message) return res.status(404).json({ error: 'Message not found.' });
    res.json({ message: toApiMessage(message) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// companyId is optional -- the identity fields on screen are free-typed
// (an inline Autotask search, not a pick-only list), so a name with no
// confirmed Autotask match is still saved as plain text rather than
// rejected outright. Only companyName is actually required; call DELETE
// instead to clear the link entirely.
router.post('/conversations/:id/link-client', (req, res) => {
  const id = Number(req.params.id);
  if (!getConversation(id)) return res.status(404).json({ error: 'Conversation not found.' });
  const { companyId, companyName, contactId, contactName } = req.body || {};
  if (!companyName) return res.status(400).json({ error: 'companyName is required.' });
  const conversation = linkClient(id, { companyId: companyId || null, companyName, contactId, contactName });
  res.json({ conversation: toApiConversation(conversation) });
});

router.delete('/conversations/:id/link-client', (req, res) => {
  const id = Number(req.params.id);
  if (!getConversation(id)) return res.status(404).json({ error: 'Conversation not found.' });
  const conversation = unlinkClient(id);
  res.json({ conversation: toApiConversation(conversation) });
});

router.get('/conversations/:id/previous-ticket', (req, res) => {
  const id = Number(req.params.id);
  if (!getConversation(id)) return res.status(404).json({ error: 'Conversation not found.' });
  res.json({ ticketNumber: previousTicketNumber(id) });
});

router.post('/conversations/:id/notes', (req, res) => {
  const id = Number(req.params.id);
  if (!getConversation(id)) return res.status(404).json({ error: 'Conversation not found.' });
  const body = (req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Note text is required.' });
  const notes = addNote(id, { body, actor: actorFrom(req) });
  res.status(201).json({ notes: notes.map((n) => ({ id: n.id, body: n.body, createdAt: n.created_at, createdByName: n.created_by_name })) });
});

// The manual stand-in for a real inbound message -- see README.md's "Why
// this page doesn't receive real texts yet" section. Always
// isLoggedManually: true from this route; a future real capture
// mechanism calls recordInboundMessage() directly from its own code, not
// through this route.
router.post('/conversations/:id/log-inbound', (req, res) => {
  const id = Number(req.params.id);
  if (!getConversation(id)) return res.status(404).json({ error: 'Conversation not found.' });
  const body = (req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Message text is required.' });
  recordInboundMessage(id, { body, ticketNumber: req.body?.ticketNumber || null, isLoggedManually: true });
  res.status(201).json({ messages: listMessages(id).map(toApiMessage) });
});

// Sends a one-off "quick SMS" through the real Access4 API -- same
// payload/endpoint the original build proved out (messageSubType
// 'quick-sms', campaignType 'transactional'). Logged into THIS
// conversation's own message history either way (sent or failed,
// Access4's own error message on failure) -- per direct instruction, a
// not-yet-working Access4 account must never block the rest of this page
// from working; it just logs as a failed send.
router.post('/conversations/:id/send', async (req, res) => {
  const id = Number(req.params.id);
  const conversation = getConversation(id);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found.' });
  if (conversation.do_not_contact) return res.status(400).json({ error: 'This number is marked Do Not Contact.' });
  const body = (req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Message text is required.' });
  if (body.length > 612) return res.status(400).json({ error: 'Message is too long -- 612 characters is the maximum (4 concatenated SMS segments).' });
  const ticketNumber = req.body?.ticketNumber || null;
  const actor = actorFrom(req);

  if (!hasAccess4Credentials()) {
    recordOutboundMessage(id, { body, status: 'failed', error: 'Access4 SMS is not configured (ACCESS4_SMS_SERVICE_ID/ACCESS4_SMS_DID_NUMBER_ID).', ticketNumber, actor });
    return res.status(201).json({ ok: false, messages: listMessages(id).map(toApiMessage) });
  }

  const payload = {
    messageSubType: 'quick-sms',
    campaignType: 'transactional',
    contactListId: '',
    toMobile: conversation.phone_number,
    didNumberId: DID_NUMBER_ID,
    message: body,
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
  };

  try {
    const apiRes = await axios.post(`${BASE_URL}/provisioning/serviceaccount/${SERVICE_ID}/smsgateway/sms`, payload, {
      params: { action: 'sendSms' },
      timeout: 15000,
    });
    const data = apiRes.data || {};
    const ok = String(data.code) === '200';
    // The message bubble only ever shows data.message (by design, see
    // below) -- the FULL raw response is console.error'd here so a real
    // failure's complete detail (any extra field Access4 sends beyond
    // .message) is still recoverable from production's own server logs,
    // not just the one-line summary stored against the message.
    if (!ok) console.error(`Access4 SMS send failed (HTTP ${apiRes.status}, conversation #${id}):`, JSON.stringify(data));
    recordOutboundMessage(id, { body, status: ok ? 'sent' : 'failed', access4SmsId: data.smsId, error: ok ? null : data.message, ticketNumber, actor });
    res.status(201).json({ ok, smsId: data.smsId, messages: listMessages(id).map(toApiMessage) });
  } catch (err) {
    const apiError = err.response?.data;
    const errorMessage = apiError?.message || err.message;
    // Same reasoning as above -- a thrown error (non-2xx HTTP, e.g. the
    // "Unauthorized" case) only ever surfaced apiError?.message to the UI;
    // this logs the full response body/status so there's something to
    // check beyond that one word next time a send fails.
    console.error(`Access4 SMS send failed (HTTP ${err.response?.status ?? 'no response'}, conversation #${id}):`, JSON.stringify(apiError ?? err.message));
    recordOutboundMessage(id, { body, status: 'failed', error: errorMessage, ticketNumber, actor });
    res.status(201).json({ ok: false, error: errorMessage, messages: listMessages(id).map(toApiMessage) });
  }
});

// Simulate Send -- by request, a way to log a message as sent WITHOUT
// actually calling Access4 (useful while the real account isn't working).
// Never touches axios/the real API at all; always treated as a success,
// but recorded with its own distinct send_status ('simulated') so it's
// never mistaken for a real, confirmed delivery.
router.post('/conversations/:id/simulate-send', (req, res) => {
  const id = Number(req.params.id);
  const conversation = getConversation(id);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found.' });
  if (conversation.do_not_contact) return res.status(400).json({ error: 'This number is marked Do Not Contact.' });
  const body = (req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Message text is required.' });
  if (body.length > 612) return res.status(400).json({ error: 'Message is too long -- 612 characters is the maximum (4 concatenated SMS segments).' });
  const ticketNumber = req.body?.ticketNumber || null;
  const actor = actorFrom(req);
  recordOutboundMessage(id, { body, status: 'simulated', ticketNumber, actor });
  res.status(201).json({ ok: true, messages: listMessages(id).map(toApiMessage) });
});

// --- Autotask lookups (ticket validation, company/contact search) --------

router.get('/ticket-lookup', async (req, res) => {
  const trimmed = (req.query.number || '').trim();
  if (!trimmed) return res.status(400).json({ error: 'A ticket number is required.' });
  try {
    const client = await getClient();
    const matches = await listAll(client.tickets, [{ op: 'eq', field: 'ticketNumber', value: trimmed }]);
    if (matches.length === 0) return res.json({ found: false });
    const ticket = matches[0];
    res.json({ found: true, ticketId: ticket.id, ticketNumber: ticket.ticketNumber, title: ticket.title });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Plain substring match on company name, active companies only, capped --
// a picker list for "link this conversation to a client", not a full
// Autotask company browser. Sorted by name so a short/common search term
// (returning many matches) is at least browsable in a sensible order.
const COMPANY_SEARCH_LIMIT = 25;

router.get('/company-search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.status(400).json({ error: 'Type at least 2 characters to search.' });
  try {
    const client = await getClient();
    const matches = await listAll(client.companies, [
      { op: 'contains', field: 'companyName', value: q },
      { op: 'eq', field: 'isActive', value: true },
    ]);
    matches.sort((a, b) => a.companyName.localeCompare(b.companyName));
    res.json({ companies: matches.slice(0, COMPANY_SEARCH_LIMIT).map((c) => ({ id: c.id, companyName: c.companyName })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/companies/:id/contacts', async (req, res) => {
  const companyId = Number(req.params.id);
  try {
    const client = await getClient();
    const contacts = await listAll(client.contacts, [{ op: 'eq', field: 'companyID', value: companyId }]);
    contacts.sort((a, b) => `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`));
    res.json({
      contacts: contacts.map((c) => ({
        id: c.id,
        name: [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || `Contact #${c.id}`,
        phone: c.phone || null,
        mobilePhone: c.mobilePhone || null,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Templates -------------------------------------------------------------

router.get('/templates', (req, res) => {
  res.json({ templates: listTemplates().map(toApiTemplate) });
});

router.post('/templates', (req, res) => {
  const name = (req.body?.name || '').trim();
  const body = (req.body?.body || '').trim();
  if (!name) return res.status(400).json({ error: 'Template name is required.' });
  if (!body) return res.status(400).json({ error: 'Template body is required.' });
  const template = createTemplate({ name, body, actor: actorFrom(req) });
  res.status(201).json({ template: toApiTemplate(template) });
});

router.put('/templates/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!getTemplate(id)) return res.status(404).json({ error: 'Template not found.' });
  const name = (req.body?.name || '').trim();
  const body = (req.body?.body || '').trim();
  if (!name) return res.status(400).json({ error: 'Template name is required.' });
  if (!body) return res.status(400).json({ error: 'Template body is required.' });
  const template = updateTemplate(id, { name, body });
  res.json({ template: toApiTemplate(template) });
});

router.delete('/templates/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!getTemplate(id)) return res.status(404).json({ error: 'Template not found.' });
  deleteTemplate(id);
  res.status(204).end();
});

module.exports = router;
