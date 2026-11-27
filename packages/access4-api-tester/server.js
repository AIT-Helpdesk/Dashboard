const express = require('express');
const axios = require('axios');

// Raw HTTP request console, scoped (by default) at Access4's own SASBOSS
// SMS Gateway API -- see @dashboard/access4-sms's README.md for the proven
// "quick-sms" send call this was built to help debug. Access4 has NO API
// key/token/Basic Auth at all; it's gated purely by the SOURCE IP of
// whoever calls it. That means a request has to actually originate from
// THIS production server to prove anything -- a laptop/dev-machine request
// to the same URL tells you nothing about whether Access4 has the right IP
// whitelisted. This page exists so that proving/debugging can happen from
// here, live, without round-tripping every payload tweak through a code
// change + redeploy.
const DEFAULT_BASE_URL = process.env.ACCESS4_SMS_BASE_URL || 'https://api.sasboss.com.au:10000';
const SERVICE_ID = process.env.ACCESS4_SMS_SERVICE_ID || '';
const DID_NUMBER_ID = process.env.ACCESS4_SMS_DID_NUMBER_ID || '';

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

const router = express.Router();
router.use(express.json());

// Not secrets -- Access4 has no key/token of its own, so SERVICE_ID/
// DID_NUMBER_ID are just account identifiers, not credentials. Shown so
// the path/payload can be built here without digging through .env by hand.
router.get('/config', (req, res) => {
  res.json({
    baseUrl: DEFAULT_BASE_URL,
    serviceId: SERVICE_ID,
    didNumberId: DID_NUMBER_ID,
    hasCredentials: !!(SERVICE_ID && DID_NUMBER_ID),
  });
});

router.post('/request', async (req, res) => {
  const { method, baseUrl, path, query, headers, body } = req.body || {};

  const upperMethod = String(method || 'POST').toUpperCase();
  if (!ALLOWED_METHODS.has(upperMethod)) {
    return res.status(400).json({ error: `Unsupported method "${method}". Use one of: ${[...ALLOWED_METHODS].join(', ')}.` });
  }

  const resolvedBaseUrl = (baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(resolvedBaseUrl)) {
    return res.status(400).json({ error: 'Base URL must start with http:// or https://.' });
  }

  const trimmedPath = (path || '').trim();
  // Kept deliberately relative, never resolved via `new URL(path, base)` --
  // that would let an absolute URL typed into Path silently override and
  // replace Base URL instead of appending to it. Plain string concatenation
  // below means Base URL is always genuinely where the request goes.
  if (!trimmedPath.startsWith('/') || trimmedPath.includes('://')) {
    return res.status(400).json({ error: 'Path must be a relative path starting with "/" (e.g. /provisioning/serviceaccount/...), not a full URL.' });
  }

  const trimmedQuery = (query || '').trim().replace(/^\?/, '');
  const fullUrl = trimmedQuery ? `${resolvedBaseUrl}${trimmedPath}?${trimmedQuery}` : `${resolvedBaseUrl}${trimmedPath}`;

  let parsedHeaders = { 'Content-Type': 'application/json' };
  if (headers && String(headers).trim()) {
    try {
      parsedHeaders = { ...parsedHeaders, ...JSON.parse(headers) };
    } catch (err) {
      return res.status(400).json({ error: `Headers is not valid JSON: ${err.message}` });
    }
  }

  let parsedBody;
  if (body && String(body).trim()) {
    try {
      parsedBody = JSON.parse(body);
    } catch (err) {
      return res.status(400).json({ error: `Body is not valid JSON: ${err.message}` });
    }
  }

  const startedAt = Date.now();
  try {
    const apiRes = await axios({
      method: upperMethod,
      url: fullUrl,
      headers: parsedHeaders,
      data: parsedBody,
      timeout: 20000,
      // Any real HTTP response (2xx-5xx alike) comes back here as a normal
      // result, not a thrown error -- a debug tool like this needs to show
      // EXACTLY what Access4 sent back, including a 4xx/5xx body, rather
      // than collapsing it into a generic axios error.
      validateStatus: () => true,
    });
    const tookMs = Date.now() - startedAt;
    console.log(`[access4-api-tester] ${upperMethod} ${fullUrl} -> ${apiRes.status} (${tookMs}ms)`);
    res.json({
      ok: true,
      requestUrl: fullUrl,
      tookMs,
      status: apiRes.status,
      statusText: apiRes.statusText,
      responseHeaders: apiRes.headers,
      data: apiRes.data,
    });
  } catch (err) {
    // Reaching here means the request never got a response at all (DNS
    // failure, connection refused, timeout) -- distinct from, and a much
    // more useful signal than, a real 401/403 FROM Access4: this is "the
    // network path itself is the problem," not "Access4 rejected us."
    const tookMs = Date.now() - startedAt;
    console.error(`[access4-api-tester] ${upperMethod} ${fullUrl} -> network error (${tookMs}ms):`, err.message);
    res.json({ ok: false, requestUrl: fullUrl, tookMs, error: err.message, code: err.code || null });
  }
});

module.exports = router;
