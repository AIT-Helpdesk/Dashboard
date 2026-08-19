const axios = require('axios');

// IT Glue's documentation/asset-management API -- a wholly separate system
// from Autotask, mirroring @dashboard/ingram-client/@dashboard/saasalerts-client's
// shape (thin get() wrapper, auth + base URL baked in once here).
//
// Region matters: IT Glue has separate regional API hosts (api.itglue.com,
// api.eu.itglue.com, api.au.itglue.com) -- confirmed against the real
// account this dashboard is for, which is api.au.itglue.com. Configurable
// via env rather than hardcoded, in case that ever needs to change.
const { ITGLUE_API_KEY: API_KEY, ITGLUE_API_BASE: BASE_URL } = process.env;

// Auth is a plain `x-api-key` header, not Bearer/Basic -- confirmed against
// the real API.
async function get(path, params) {
  const res = await axios.get(`${BASE_URL}${path}`, {
    headers: { 'x-api-key': API_KEY },
    params,
  });
  return res.data;
}

module.exports = { get };
