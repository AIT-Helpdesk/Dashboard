const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const { getGraphTokenForSession } = require('@dashboard/shell/auth.js');
const { todayAestKey } = require('@dashboard/autotask-client');

// Speech-to-text AND the follow-up-question dialogue both run through the
// same Azure OpenAI resource (two separate deployments on it -- Whisper for
// transcription, a small chat model for slot-filling) rather than a plain
// client-side date parser. Voice input needs to work identically on an
// iPhone (any browser there is really Safari/WebKit under the hood, whose
// SpeechRecognition is unreliable) and on Windows Edge, so recording raw
// audio and transcribing it server-side is the one approach that behaves
// the same everywhere -- see this package's own README for the fuller
// story of why the built-in browser speech APIs weren't good enough here.
const {
  AZURE_OPENAI_ENDPOINT,
  AZURE_OPENAI_KEY,
  AZURE_OPENAI_WHISPER_DEPLOYMENT,
  AZURE_OPENAI_CHAT_DEPLOYMENT,
} = process.env;

function azureOpenAiConfigured() {
  return !!(AZURE_OPENAI_ENDPOINT && AZURE_OPENAI_KEY && AZURE_OPENAI_WHISPER_DEPLOYMENT && AZURE_OPENAI_CHAT_DEPLOYMENT);
}

function baseUrl() {
  return AZURE_OPENAI_ENDPOINT.replace(/\/+$/, '');
}

// Recorded clips are short (a few seconds of speech at a time, one
// conversational turn) -- 15MB is generous headroom, not a real expected size.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// Pinned API versions, not "latest" -- an Azure-side version bump changing
// the response shape underneath this code without anyone touching it here
// is worse than occasionally having to bump these two constants on purpose.
// '2025-03-01-preview' -- confirmed directly against the real resource
// (dashbpoard-voice-resource)'s own sample Target URI for the whisper
// deployment, not guessed; an earlier guess of '2024-06-01' here produced a
// real `DeploymentNotFound` against this resource.
const WHISPER_API_VERSION = '2025-03-01-preview';
const CHAT_API_VERSION = '2025-03-01-preview';

async function transcribe(buffer, filename, mimetype) {
  const form = new FormData();
  form.append('file', buffer, { filename: filename || 'audio.webm', contentType: mimetype || 'audio/webm' });
  const url = `${baseUrl()}/openai/deployments/${AZURE_OPENAI_WHISPER_DEPLOYMENT}/audio/transcriptions?api-version=${WHISPER_API_VERSION}`;
  const res = await axios.post(url, form, {
    headers: { ...form.getHeaders(), 'api-key': AZURE_OPENAI_KEY },
    maxBodyLength: Infinity,
  });
  return res.data.text || '';
}

async function chatJson(messages) {
  const url = `${baseUrl()}/openai/deployments/${AZURE_OPENAI_CHAT_DEPLOYMENT}/chat/completions?api-version=${CHAT_API_VERSION}`;
  const res = await axios.post(
    url,
    { messages, temperature: 0, response_format: { type: 'json_object' } },
    { headers: { 'api-key': AZURE_OPENAI_KEY, 'Content-Type': 'application/json' } }
  );
  const content = res.data.choices?.[0]?.message?.content || '{}';
  return JSON.parse(content);
}

// "Now", in Ambient IT's own fixed AEST (Queensland doesn't observe
// daylight saving -- same fixed +10 assumption every other page on this
// dashboard already makes via @dashboard/autotask-client's aestToUtcIso/
// todayAestKey), for grounding the model's resolution of "today",
// "tomorrow", "next Tuesday", etc. Same "shift the instant, then read its
// UTC fields" trick @dashboard/about-me's own server.js already uses for
// day-key arithmetic -- not a new convention introduced here.
function nowAestContext() {
  const todayKey = todayAestKey();
  const aest = new Date(Date.now() + 10 * 60 * 60 * 1000);
  const hh = String(aest.getUTCHours()).padStart(2, '0');
  const mm = String(aest.getUTCMinutes()).padStart(2, '0');
  const weekday = aest.toLocaleDateString('en-AU', { weekday: 'long', timeZone: 'UTC' });
  return `${weekday}, ${todayKey}, current local time ${hh}:${mm} (Australia/Brisbane, AEST, UTC+10, fixed -- no daylight saving).`;
}

function systemPrompt() {
  return `You are the scheduling assistant behind an internal "Voice Scheduler" dashboard page. Given a conversation transcript (the user's turns were spoken aloud and machine-transcribed -- expect occasional transcription errors, e.g. misheard homophones), extract enough detail to create ONE Microsoft 365 calendar event on the user's own calendar: a subject, a start date/time, and optionally an end date/time and a location.

Context: it is currently ${nowAestContext()} All dates/times you output MUST be this local time zone, formatted exactly "YYYY-MM-DDTHH:mm:ss" (no offset suffix, no "Z").

Rules:
- If the subject or a start date/time is still missing or too ambiguous to resolve confidently, respond with exactly: {"done": false, "question": "<one short, natural, SPOKEN-style question asking for just the one thing that's missing or unclear>"}
- Ask about only ONE missing thing per question -- never a compound question.
- Once you have at least a clear subject and a clear start date/time, respond with exactly: {"done": true, "event": {"subject": "...", "start": "YYYY-MM-DDTHH:mm:ss", "end": "YYYY-MM-DDTHH:mm:ss", "location": "..." or null}, "confirmation": "<one short spoken sentence summarizing it back, e.g. 'Dinner with Kylie, today at 6:30 PM.'>"}
- Default "end" to exactly 1 hour after "start" when no duration or end time was mentioned.
- Never invent a location -- leave it null unless the user actually said one.
- Resolve every relative date/time ("today", "tomorrow", "next Tuesday", "in an hour", "6:30") against the current local time given above.
- Respond with ONLY that JSON object -- no other text, no markdown fencing.`;
}

const router = express.Router();

router.post('/transcribe', upload.single('audio'), async (req, res) => {
  if (!azureOpenAiConfigured()) return res.status(500).json({ error: 'Azure OpenAI is not configured -- see .env.example (AZURE_OPENAI_*).' });
  if (!req.file) return res.status(400).json({ error: 'No audio file uploaded (expected multipart field "audio").' });
  try {
    const text = await transcribe(req.file.buffer, req.file.originalname, req.file.mimetype);
    res.json({ text });
  } catch (err) {
    console.error('Transcription failed:', err.response?.data || err.message);
    res.status(502).json({ error: 'Transcription failed. Check server logs.' });
  }
});

// `history`: [{ role: 'assistant' | 'user', text: '...' }, ...] -- the
// WHOLE conversation so far, built up client-side turn by turn (see
// client.js). Kept stateless server-side deliberately, same reasoning as
// every other page on this dashboard that re-sends its own full state
// rather than the server holding a per-user in-progress-event object: one
// browser tab left mid-conversation never leaks into or blocks another.
router.post('/converse', express.json(), async (req, res) => {
  if (!azureOpenAiConfigured()) return res.status(500).json({ error: 'Azure OpenAI is not configured -- see .env.example (AZURE_OPENAI_*).' });
  const history = Array.isArray(req.body?.history) ? req.body.history : null;
  if (!history || history.length === 0) return res.status(400).json({ error: 'Body must be { history: [{role, text}, ...] } with at least one turn.' });

  const messages = [
    { role: 'system', content: systemPrompt() },
    ...history.map((turn) => ({ role: turn.role === 'assistant' ? 'assistant' : 'user', content: String(turn.text || '') })),
  ];

  try {
    const result = await chatJson(messages);
    if (result.done) {
      res.json({ done: true, event: result.event, confirmation: result.confirmation || '' });
    } else {
      res.json({ done: false, question: result.question || 'Sorry, could you say that again?' });
    }
  } catch (err) {
    console.error('Conversation turn failed:', err.response?.data || err.message);
    res.status(502).json({ error: 'Failed to process that. Check server logs.' });
  }
});

// Windows time zone name for Brisbane -- "E. Australia Standard Time", NOT
// "AUS Eastern Standard Time" (that one's Sydney/Melbourne, which DOES
// observe daylight saving). Matches the same fixed-AEST, no-DST assumption
// nowAestContext() above and the rest of this dashboard already make.
const GRAPH_EVENT_TIMEZONE = 'E. Australia Standard Time';

// Writes to the SIGNED-IN user's OWN calendar only -- resourceEmail/id is
// never accepted from the request body, only the Graph token itself
// (getGraphTokenForSession(req), see packages/shell/auth.js), which
// Microsoft has already bound to this one session's own account. There is
// no code path here that can target anyone else's mailbox, by construction
// -- not something this handler has to get right on its own.
router.post('/create-event', express.json(), async (req, res) => {
  const { subject, start, end, location } = req.body || {};
  if (!subject || !start || !end) return res.status(400).json({ error: 'Body must include subject, start, and end.' });

  const token = await getGraphTokenForSession(req);
  if (!token) return res.status(401).json({ error: 'Your Microsoft 365 sign-in has expired for calendar access. Please sign out and back in, then try again.' });

  try {
    const graphRes = await axios.post(
      'https://graph.microsoft.com/v1.0/me/events',
      {
        subject,
        start: { dateTime: start, timeZone: GRAPH_EVENT_TIMEZONE },
        end: { dateTime: end, timeZone: GRAPH_EVENT_TIMEZONE },
        ...(location ? { location: { displayName: location } } : {}),
      },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    res.json({ id: graphRes.data.id, webLink: graphRes.data.webLink });
  } catch (err) {
    // Graph's own error message for this one is frustratingly generic
    // ("At least one property failed validation", no field name) -- the
    // payload is logged alongside it so a real failure can actually be
    // diagnosed from the next attempt's server log, not guessed at.
    console.error('Graph event creation failed:', err.response?.data || err.message, '-- payload was:', {
      subject,
      start: { dateTime: start, timeZone: GRAPH_EVENT_TIMEZONE },
      end: { dateTime: end, timeZone: GRAPH_EVENT_TIMEZONE },
      location,
    });
    res.status(502).json({ error: err.response?.data?.error?.message || 'Failed to create the calendar event.' });
  }
});

module.exports = router;
