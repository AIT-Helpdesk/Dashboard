const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { hasAiPayloadConfig, buildAiPayload, supportedKinds } = require('./ai-payload-config.js');

// AI-drafted commentary for the Make Report page -- by request ("AI-
// Assisted Reporting Brief", Oct 2026). Copies @dashboard/voice-scheduler's
// own Azure OpenAI call shape (server.js:17-66 there -- plain axios REST
// calls, no SDK, since that's the one convention already proven on this
// dashboard). The PLAN here is a DELIBERATELY SEPARATE Azure OpenAI
// resource (own env var prefix) -- this traffic carries real client
// business data (device/patch/backup metrics), so it should get its own
// content-filter policy and its own Modified Abuse Monitoring application,
// not mixed in with Voice Scheduler's own calendar-scheduling resource/
// traffic/logs.
//
// TEMPORARY, by explicit request ("use the voice scheduler Open AI
// connection and we'll fix that later"): until that dedicated resource is
// actually provisioned (Phase A), this falls back to Voice Scheduler's own
// AZURE_OPENAI_* vars so the feature is testable now. The moment real
// AZURE_OPENAI_REPORT_* values are set in .env, they take over automatically
// (no code change needed) -- but until then, report-commentary traffic
// really is going through Voice Scheduler's resource, so it inherits
// WHATEVER content-filter/abuse-monitoring status that resource currently
// has. Remove this fallback once the dedicated resource is live, so a
// future unset of AZURE_OPENAI_REPORT_* fails loudly instead of silently
// sliding back onto the shared one.
const {
  AZURE_OPENAI_REPORT_ENDPOINT,
  AZURE_OPENAI_REPORT_KEY,
  AZURE_OPENAI_REPORT_CHAT_DEPLOYMENT,
  AZURE_OPENAI_ENDPOINT,
  AZURE_OPENAI_KEY,
  AZURE_OPENAI_CHAT_DEPLOYMENT,
} = process.env;

const REPORT_ENDPOINT = AZURE_OPENAI_REPORT_ENDPOINT || AZURE_OPENAI_ENDPOINT;
const REPORT_KEY = AZURE_OPENAI_REPORT_KEY || AZURE_OPENAI_KEY;
const REPORT_CHAT_DEPLOYMENT = AZURE_OPENAI_REPORT_CHAT_DEPLOYMENT || AZURE_OPENAI_CHAT_DEPLOYMENT;

if (!AZURE_OPENAI_REPORT_ENDPOINT && AZURE_OPENAI_ENDPOINT) {
  console.warn(
    'report: AZURE_OPENAI_REPORT_* not set -- TEMPORARILY falling back to Voice Scheduler\'s own Azure OpenAI resource for report-commentary drafting. Provision a dedicated resource (see .env.example) and this fallback goes away automatically.'
  );
}

function azureOpenAiReportConfigured() {
  return !!(REPORT_ENDPOINT && REPORT_KEY && REPORT_CHAT_DEPLOYMENT);
}

function baseUrl() {
  return REPORT_ENDPOINT.replace(/\/+$/, '');
}

// Pinned, not "latest" -- same reasoning as Voice Scheduler's own comment on
// this (server.js there): an Azure-side version bump changing the response
// shape underneath this code without anyone touching it here is worse than
// occasionally having to bump this on purpose. Copied from Voice Scheduler's
// own confirmed-working value as a starting point; re-confirm against this
// NEW resource's own sample Target URI once Phase A hands it over (adjust
// here if it comes back DeploymentNotFound, same as that package's own
// comment documents happening once already).
const CHAT_API_VERSION = '2025-03-01-preview';

async function draftCommentary(messages) {
  const url = `${baseUrl()}/openai/deployments/${REPORT_CHAT_DEPLOYMENT}/chat/completions?api-version=${CHAT_API_VERSION}`;
  const res = await axios.post(
    url,
    // No response_format: 'json_object' here -- unlike Voice Scheduler's own
    // chatJson(), this wants a plain prose paragraph, not a JSON object.
    // temperature 0.5 (not Voice Scheduler's 0) deliberately leaves room for
    // "Regenerate" to produce a genuinely different phrasing, not the exact
    // same sentence back.
    // max_completion_tokens, not the older max_tokens -- confirmed live
    // against the real (currently fallback, see this file's own header
    // comment) resource: it rejected max_tokens outright ("Unsupported
    // parameter... Use 'max_completion_tokens' instead"), the newer unified
    // name every current chat-completions-capable model (including
    // reasoning models) expects.
    { messages, temperature: 0.5, max_completion_tokens: 220 },
    { headers: { 'api-key': REPORT_KEY, 'Content-Type': 'application/json' } }
  );
  return (res.data.choices?.[0]?.message?.content || '').trim();
}

function systemPrompt() {
  // The brief's own example prompt, verbatim -- by request.
  return 'You are writing a concise paragraph of commentary for an MSP client report based only on the metrics provided below. Highlight anything notably good or concerning. Do not infer causes not shown in the data. Keep it to two or three sentences.';
}

function userPrompt(kindLabel, site, metrics) {
  return `Report section: ${kindLabel}\nClient: ${site || 'this client'}\nMetrics:\n${JSON.stringify(metrics, null, 2)}`;
}

// Append-only audit trail -- by request ("Log what data was sent to the
// model and what was returned, for audit purposes"), separate from Azure
// OpenAI's own abuse-monitoring retention (which Phase A's Modified Abuse
// Monitoring application disables). One line per call: who, when, which
// component, the exact (already-minimized) metrics sent, and the text that
// came back. Plain JSONL, not a new DB dependency -- this package has no
// existing audit-log convention of its own to extend, and nothing yet needs
// to browse this interactively (see this feature's own plan for why
// contract-checks' SQLite audit_log table, the closest analog on this
// dashboard, would be overkill here). Never committed -- see .gitignore.
const AUDIT_LOG_PATH = path.join(__dirname, 'report-ai-audit.jsonl');

function appendAudit(entry) {
  try {
    fs.appendFileSync(AUDIT_LOG_PATH, `${JSON.stringify(entry)}\n`);
  } catch (err) {
    // A logging failure should never block handing the drafted text back to
    // the TAM who's waiting on it -- surfaced in the server console only.
    console.error('report: failed to write AI audit log:', err.message);
  }
}

const router = express.Router();
router.use(express.json());

// client.js's one source of truth for which kinds get a "Draft Commentary"
// button -- fetched once per mount, same "fetch once, reuse" convention
// other pages' own rarely-changing option lists already use. Not gated on
// azureOpenAiReportConfigured() -- the list of SUPPORTED kinds is config
// shape, independent of whether the Azure resource is actually wired up
// yet; a misconfigured resource still fails informatively at the actual
// /draft-commentary call instead.
router.get('/ai-kinds', (req, res) => {
  res.json({ kinds: supportedKinds() });
});

router.post('/draft-commentary', async (req, res) => {
  if (!azureOpenAiReportConfigured()) {
    return res.status(500).json({ error: 'Azure OpenAI (report) is not configured -- see .env.example (AZURE_OPENAI_REPORT_*).' });
  }
  const component = req.body?.component;
  if (!component || !component.id || !component.kind) {
    return res.status(400).json({ error: 'component (with id and kind) is required.' });
  }
  if (!hasAiPayloadConfig(component.kind)) {
    return res.status(400).json({ error: `No AI commentary config for report kind "${component.kind}".` });
  }
  try {
    // Re-derives the small payload itself from whatever the client posted --
    // deliberately NOT trusting the client to have already minimized it
    // (the brief's own "don't send raw API dumps to the model"). Every
    // field buildAiPayload() doesn't explicitly read (images, sourceUrl, a
    // full raw devices/drives array, etc.) never reaches the model
    // regardless of what else the client's component object happens to
    // carry.
    const { kindLabel, metrics } = buildAiPayload(component);
    const messages = [
      { role: 'system', content: systemPrompt() },
      { role: 'user', content: userPrompt(kindLabel, component.site, metrics) },
    ];
    const text = await draftCommentary(messages);
    appendAudit({
      at: new Date().toISOString(),
      userName: req.session.user?.name || null,
      userEmail: req.session.user?.email || null,
      componentId: component.id,
      kind: component.kind,
      site: component.site || null,
      metricsSent: metrics,
      textReturned: text,
    });
    res.json({ text });
  } catch (err) {
    console.error('report: AI draft-commentary failed:', err.response?.data || err.message);
    res.status(502).json({ error: 'AI drafting failed. Check server logs.' });
  }
});

module.exports = router;
