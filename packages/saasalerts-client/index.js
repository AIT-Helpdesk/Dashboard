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
async function get(path, params) {
  const res = await axios.get(`${BASE_URL}${path}`, {
    headers: { api_key: API_KEY, Accept: 'application/json' },
    params,
  });
  return res.data;
}

module.exports = { get };
