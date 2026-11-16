const axios = require('axios');

// SaaS Alerts REST API (Kaseya's SaaS Alerts -- M365/Google Workspace
// security monitoring for MSPs), a wholly separate system from Autotask.
// Shared here (mirroring @dashboard/ingram-client) from the start, since two
// pages (SaaS Alerts Customers, Security Alerts) need it.
//
// Base URL is NOT api.saasalerts.com, despite that being the domain the
// product's own marketing/docs pages live on -- confirmed by fetching the
// real OpenAPI spec (https://api.swaggerhub.com/apis/SaaS_Alerts/functions/0.20.0/swagger.json)
// after api.saasalerts.com turned out not to resolve at all. The production
// server really is a Google Cloud Functions URL tied to the vendor's own GCP
// project ("the-byway-248217") -- an implementation detail of theirs, not
// something to assume is stable indefinitely, but it's what the vendor's own
// spec documents as production today.
const BASE_URL = 'https://us-central1-the-byway-248217.cloudfunctions.net/reportApi/api/v1';

const { SAASALERTS_API_KEY: API_KEY } = process.env;

// Auth is a header literally named `api_key`, value = the key as-is -- NOT
// an `Authorization: Basic`/`Bearer` header, despite the key itself decoding
// (it's base64) to what looks like a `<uuid>:<partnerId>` Basic-auth pair.
// Confirmed against the real API: the api_key header alone is sufficient,
// SAASALERTS_PARTNER_ID isn't needed on any request.
// A real client (Queensland Greyhound Racing Club) confirmed live this
// session that this endpoint can take 60-70+ seconds to respond before the
// vendor's own server eventually gives up with a 408 -- axios has NO
// default timeout (waits indefinitely), so Live Reports' own Create PDF
// button stayed stuck on "Loading" that whole time waiting on this one
// call (every OTHER vendor call for the same client succeeded in well
// under a second). 20s is generous for a REST call that's normally fast,
// but short enough that a client-side timeout here now fails well before
// the vendor's own 408 would, letting live-reports/server.js's own
// catchVendorError() move on quickly instead of blocking the whole page.
async function get(path, params) {
  const res = await axios.get(`${BASE_URL}${path}`, {
    headers: { api_key: API_KEY, Accept: 'application/json' },
    params,
    timeout: 20000,
  });
  return res.data;
}

module.exports = { get };
