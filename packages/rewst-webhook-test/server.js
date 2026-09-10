const express = require('express');
const axios = require('axios');

// Real Rewst webhook trigger, found and confirmed working live this
// session (packages/csp-customers' own real data, "Every CSP customer and
// their Microsoft tenant ID" -- this Rewst workflow is apparently that
// same data's own source/sync). URL lives in .env (REWST_CSP_CUSTOMERS_
// WEBHOOK_URL), not hardcoded -- Rewst's own webhook URLs are effectively
// bearer credentials (no separate auth header confirmed required for this
// one), same "real secret, keep it out of source control" treatment every
// other external API credential on this dashboard already gets.
//
// Confirmed against the real endpoint before writing this route: POST
// only (a plain GET 405s), no request body required (an empty JSON object
// is enough -- the workflow doesn't appear to read anything from it), and
// "Wait for results" is enabled on this trigger, so the response IS the
// real workflow output (a real `{ Customers: [...] }` shape, confirmed
// against 370 real customer records with company_name/csp_tenant_id/
// has_consent/id/linked_organizations/tenant_id fields, not the generic
// request-echo a trigger without "Wait for results" returns instead).
const WEBHOOK_URL = process.env.REWST_CSP_CUSTOMERS_WEBHOOK_URL;

const router = express.Router();

router.get('/', async (req, res) => {
  if (!WEBHOOK_URL) {
    return res.status(500).json({ error: 'REWST_CSP_CUSTOMERS_WEBHOOK_URL is not configured in .env.' });
  }
  try {
    const response = await axios.post(WEBHOOK_URL, {}, { headers: { 'Content-Type': 'application/json' } });
    res.json(response.data);
  } catch (err) {
    // Only the message, deliberately -- never the full error object. A raw
    // axios error carries the full outgoing request (including the
    // webhook URL, which functions as a real credential here) on
    // error.config/error.request; @dashboard/autotask-client's own
    // installErrorSanitizer() exists specifically because a plain
    // console.error(err) leaked a real secret that way once already on
    // this dashboard (see that file's own comment) -- simplest safe fix
    // here is to just never pass the full object to the logger at all.
    console.error('Rewst Webhook Test: call failed:', err.message);
    res.status(502).json({ error: `Rewst call failed: ${err.message}` });
  }
});

module.exports = router;
