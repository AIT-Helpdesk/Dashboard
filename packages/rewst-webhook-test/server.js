const express = require('express');
const axios = require('axios');

// Every Rewst webhook this page offers is discovered from .env at request
// time -- nothing about which webhooks exist, their labels, or their
// required fields is hardcoded here, by request ("I would like this page
// to do this dynamically from the .ENV data when refreshed rather than
// you hardcoding the info from .env into the code"). The whole thing
// hangs off one naming convention:
//
//   REWST_WEBHOOK_<Name>_URL=https://...                (one per webhook)
//   REWST_WEBHOOK_<Name>_<anything>=jsonKey;Label        (zero or more, one per required field)
//
// `<Name>` is whatever real text sits between `REWST_WEBHOOK_` and the
// trailing `_URL` -- used VERBATIM, case and all, as both this webhook's
// internal key (the `?webhook=` query value) and its dropdown label, by
// request ("show all REWST_WEBHOOK_{Name}_URL items in the Webhook
// dropdown list using the {Name} as the label" / "Don't change case of
// the data read from the .env file"). No transformation at all beyond
// that substring extraction -- an underscore in `<Name>` shows up as a
// literal underscore in the label, nothing gets title-cased or spaced
// out, so whatever's typed in .env is exactly what shows on the page.
//
// A field line's own trailing suffix (the `<anything>` above, e.g.
// `_ORGID`) is never parsed for meaning, only used to tell multiple field
// lines for the same webhook apart -- the real JSON field name Rewst
// receives is whatever's before the `;` in that line's VALUE, which has
// to match the real Rewst trigger's own input variable name; only
// whoever built that trigger in Rewst knows that for sure, so it's
// config, never a guess baked into this file.
//
// Real .env confirmed against while building this (Amber's own real
// values, already renamed to this exact convention):
//
//   REWST_WEBHOOK_Get_CSP_Customers_WEBHOOK_URL=https://...
//   REWST_WEBHOOK_Customer_M365_Licenses_URL=https://...
//   REWST_WEBHOOK_Customer_M365_Licenses_ORGID=org_id;Rewst Org ID
//
// -- which this produces as two dropdown entries labelled literally
// "Get_CSP_Customers_WEBHOOK" and "Customer_M365_Licenses" (the first
// carries a redundant trailing "_WEBHOOK" in its own Name segment --
// left exactly as typed, not "fixed", per the no-transformation rule
// above; rename that .env line if a cleaner label is wanted, and it'll
// show up immediately on the next dev-server restart with zero code
// changes here).
//
// Because the whole set is discovered fresh from process.env on every
// call (not built once into a fixed object at module load), client.js's
// own render() can no longer special-case a dedicated table by webhook
// KEY the way it used to (today's "Get_CSP_Customers_WEBHOOK" could be
// renamed tomorrow) -- it matches on the real response SHAPE instead
// (`{ Customers: [...] }` / `{ subscribed_skus: { data: { value: [...] } } }`),
// which stays correct regardless of what a webhook happens to be named
// in .env today.
const REWST_WEBHOOK_URL_RE = /^REWST_WEBHOOK_(.+)_URL$/;

function discoverWebhooks() {
  const webhooks = [];
  for (const [envKey, envValue] of Object.entries(process.env)) {
    const match = envKey.match(REWST_WEBHOOK_URL_RE);
    if (!match) continue;
    const name = match[1];
    const fieldPrefix = `REWST_WEBHOOK_${name}_`;
    const fields = [];
    for (const [fieldKey, fieldValue] of Object.entries(process.env)) {
      if (fieldKey === envKey || !fieldKey.startsWith(fieldPrefix) || !fieldValue) continue;
      const idx = fieldValue.indexOf(';');
      if (idx === -1) continue;
      const fieldJsonKey = fieldValue.slice(0, idx).trim();
      const fieldLabel = fieldValue.slice(idx + 1).trim();
      if (fieldJsonKey && fieldLabel) fields.push({ key: fieldJsonKey, label: fieldLabel });
    }
    webhooks.push({ key: name, label: name, envVar: envKey, url: envValue || '', fields });
  }
  return webhooks;
}

const router = express.Router();

// Lets the dropdown (and each webhook's own input fields) build itself
// from whatever's really in .env right now instead of a second,
// hand-typed copy living in client.js too. `fields` only ever carries
// {key, label} -- never a value -- this route just describes the SHAPE
// of what a given webhook needs, the real values come from the caller on
// the actual run below.
router.get('/webhooks', (req, res) => {
  res.json({
    webhooks: discoverWebhooks().map(({ key, label, url, fields }) => ({ key, label, configured: Boolean(url), fields })),
  });
});

router.get('/', async (req, res) => {
  const webhooks = discoverWebhooks();
  if (webhooks.length === 0) {
    return res.status(404).json({ error: 'No Rewst webhooks are configured -- add a REWST_WEBHOOK_<Name>_URL line to .env.' });
  }
  const requestedKey = req.query.webhook;
  const webhook = requestedKey ? webhooks.find((w) => w.key === requestedKey) : webhooks[0];
  if (!webhook) return res.status(400).json({ error: `Unknown webhook "${requestedKey}".` });
  if (!webhook.url) return res.status(500).json({ error: `${webhook.envVar} is not configured in .env.` });

  // Each defined field is required -- a Rewst trigger that needs input to
  // run presumably can't do anything useful without it, so a missing one
  // is rejected here with a clear message rather than sent through as an
  // empty string and left to Rewst's own (probably much less clear)
  // validation error.
  const body = {};
  for (const field of webhook.fields) {
    const value = typeof req.query[field.key] === 'string' ? req.query[field.key].trim() : '';
    if (!value) return res.status(400).json({ error: `Missing required field "${field.label}".` });
    body[field.key] = value;
  }

  try {
    const response = await axios.post(webhook.url, body, { headers: { 'Content-Type': 'application/json' } });
    res.json(response.data);
  } catch (err) {
    // Only the message/response body, deliberately -- never the full error
    // object. A raw axios error carries the full outgoing request
    // (including the webhook URL, which functions as a real credential
    // here) on error.config/error.request; @dashboard/autotask-client's
    // own installErrorSanitizer() exists specifically because a plain
    // console.error(err) leaked a real secret that way once already on
    // this dashboard (see that file's own comment) -- simplest safe fix
    // here is to just never pass the full object to the logger at all.
    // Rewst's own error body is real, useful data when present (confirmed
    // live: a disabled trigger returns a real `{ error: "Trigger ... is
    // currently disabled" }` body) -- surfaced over the generic axios
    // "Request failed with status code 400" when it's there.
    const detail = err.response?.data?.error || err.message;
    console.error(`Rewst Webhook Test: call failed (${webhook.key}):`, detail);
    res.status(err.response?.status || 502).json({ error: `Rewst call failed: ${detail}` });
  }
});

module.exports = router;
