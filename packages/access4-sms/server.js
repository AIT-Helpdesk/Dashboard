const express = require('express');
const axios = require('axios');
const { recordSend, listRecent } = require('./db.js');

// Access4's SASBOSS SMS Gateway API -- see
// https://infoboss.sasboss.com/en_AU/sms/sms-gateway-api-guide. Gated by
// source-IP whitelisting on Access4's side only (confirmed with the client
// -- no API key/token/Basic Auth at all), so there's nothing to set here
// beyond these two account-specific ids; the actual security boundary is
// "did Access4 whitelist this server's outbound IP", which lives entirely
// on their side.
const BASE_URL = process.env.ACCESS4_SMS_BASE_URL || 'https://api.sasboss.com.au:10000';
const SERVICE_ID = process.env.ACCESS4_SMS_SERVICE_ID;
const DID_NUMBER_ID = process.env.ACCESS4_SMS_DID_NUMBER_ID;

function hasCredentials() {
  return !!(SERVICE_ID && DID_NUMBER_ID);
}

function actorFrom(req) {
  return { email: req.session.user.email, name: req.session.user.name };
}

// Accepts whatever shape a human types -- "0482 090 090", "+61482090090",
// "61482090090" -- and normalizes to the bare 614xxxxxxxx digits the
// Access4 API's own example requests show for toMobile (no leading +, no
// spaces). Returns null for anything that isn't 11 digits once normalized
// to that 61-prefixed form, which the caller treats as "not a real AU
// mobile" rather than guessing further.
function normalizeAuMobile(input) {
  const digits = (input || '').replace(/[^\d]/g, '');
  if (digits.startsWith('61') && digits.length === 11) return digits;
  if (digits.startsWith('0') && digits.length === 10) return `61${digits.slice(1)}`;
  return null;
}

const router = express.Router();
router.use(express.json());

router.get('/', (req, res) => {
  res.json({
    configured: hasCredentials(),
    sent: listRecent(50).map((row) => ({
      id: row.id,
      toMobile: row.to_mobile,
      message: row.message,
      status: row.status,
      error: row.error,
      sentAt: row.sent_at,
      sentByName: row.sent_by_name,
    })),
  });
});

// Sends a one-off "quick SMS" (not a campaign to a contact list) --
// messageSubType 'quick-sms' + campaignType 'transactional', per the
// guide's own fields: transactional bypasses the global opt-out list and
// is the type meant for quick-sms in the first place (marketing campaign
// type explicitly can't be used for quick-sms per that same guide).
router.post('/send', async (req, res) => {
  if (!hasCredentials()) {
    return res.status(500).json({ error: 'Access4 SMS is not configured -- set ACCESS4_SMS_SERVICE_ID and ACCESS4_SMS_DID_NUMBER_ID in .env.' });
  }
  const rawMobile = (req.body?.toMobile || '').trim();
  const message = (req.body?.message || '').trim();
  const toMobile = normalizeAuMobile(rawMobile);
  if (!toMobile) return res.status(400).json({ error: `"${rawMobile}" doesn't look like a valid Australian mobile number.` });
  if (!message) return res.status(400).json({ error: 'Message text is required.' });
  // 612 chars = 4 concatenated GSM-7 SMS segments -- the guide's own stated
  // maximum. A unicode message (emoji etc.) has a lower real cap (4x70),
  // but this server-side check stays at the guide's own documented ceiling;
  // client.js's own per-character segment counter is what actually warns
  // about the unicode case before someone hits send.
  if (message.length > 612) return res.status(400).json({ error: 'Message is too long -- 612 characters is the maximum (4 concatenated SMS segments).' });

  const actor = actorFrom(req);
  const payload = {
    messageSubType: 'quick-sms',
    campaignType: 'transactional',
    contactListId: '',
    toMobile,
    didNumberId: DID_NUMBER_ID,
    message,
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
    recordSend({ toMobile, message, status: ok ? 'sent' : 'failed', access4SmsId: data.smsId, error: ok ? null : data.message, actor });
    if (!ok) return res.status(502).json({ error: data.message || 'Access4 rejected the request.', raw: data });
    res.json({ ok: true, smsId: data.smsId, message: data.message });
  } catch (err) {
    // Surfaced as-is (not swallowed into a generic "request failed") --
    // while serviceId/didNumberId are still unconfirmed, Access4's own
    // error message here is exactly what tells us which one is wrong.
    const apiError = err.response?.data;
    const errorMessage = apiError?.message || err.message;
    recordSend({ toMobile, message, status: 'failed', access4SmsId: null, error: errorMessage, actor });
    res.status(502).json({ error: errorMessage, raw: apiError || null });
  }
});

module.exports = router;
