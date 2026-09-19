# Voice Scheduler

Speak a calendar entry ("Dinner with Kylie today at 6:30pm") and it lands on
*your own* Microsoft 365 calendar, asking a follow-up question first if
something's missing (title, or a date/time).

## Why this isn't built as a Claude Artifact

The original ask was a Claude Artifact with a microphone. Artifacts run in a
sandboxed iframe that is never granted raw microphone access, on any browser,
regardless of site permission settings -- confirmed against the platform's
own documented capability list (`artifact`, `assets`, `comments`, `db`,
`downloads`, `mcp`, `room`, `sample`, `self`, `user`, `permissions`; no audio
capability exists). That's not fixable from a browser's site-permission
screen -- it needs to be a real top-level page, which is what this is.

## Why speech-to-text is server-side (Azure OpenAI Whisper), not the browser's own API

Needs to work identically on an iPhone and on a Windows PC. On iOS, Apple
requires EVERY browser (Chrome, Edge, Firefox, Safari itself) to use Safari's
own WebKit engine -- so "use Chrome on iPhone instead" doesn't sidestep this;
WebKit's own SpeechRecognition support is unreliable in practice (confirmed
via real-world reports, not just spec support), especially once a page is
saved to the home screen. Recording raw audio with `MediaRecorder` (solid
support everywhere, including iOS Safari since 14.3) and transcribing it
server-side behaves the same on every device.

## Why the follow-up questions are an LLM call, not a regex/date-library parser

"Dinner with Kylie today at 6:30pm", "next Tuesday morning", "in an hour" --
robustly resolving arbitrary spoken phrasing against the current date needs
real language understanding, not a fixed set of patterns. Since an Azure
OpenAI resource already exists for Whisper, one more small chat deployment
on the SAME resource (`AZURE_OPENAI_CHAT_DEPLOYMENT`, e.g. `gpt-4o-mini`)
handles this -- see `server.js`'s own `systemPrompt()` for the exact
contract (strict JSON, one follow-up question at a time, defaults end to
+1 hour, never invents a location).

## Security: why staff can never write to each other's calendars

This writes through Microsoft Graph using the SIGNED-IN user's own delegated
OAuth token (`getGraphTokenForSession()`, `packages/shell/auth.js`), acquired
silently via MSAL from the same Microsoft 365 sign-in every other page on
this dashboard already requires -- NOT an app-only/service-credential token
(the kind `packages/teams-shifts` and `packages/csp-customers` use for their
own tenant-wide reads). A delegated token is bound to that one account by
Microsoft itself: the event is always written to `/me/events`, and there is
no "which mailbox" parameter anywhere in this code a bug could get wrong --
Graph itself is what enforces the isolation, not application logic. Each
staff member signing into the dashboard with their own Microsoft 365 account
gets their own token for their own calendar, automatically.

## One-time setup this feature needs (beyond `.env`)

1. **Entra admin consent**: this adds the `Calendars.ReadWrite` delegated
   Graph permission to the dashboard's existing Entra app registration (see
   root README's "Securing the dashboard"). Unlike `openid`/`profile`/
   `email`/`User.Read`, this one is NOT pre-consented -- an admin needs to
   grant it once: **Entra admin center -> App registrations -> (this app) ->
   API permissions -> Add a permission -> Microsoft Graph -> Delegated ->
   Calendars.ReadWrite -> Add, then "Grant admin consent for <tenant>"**.
   Until that's done, every sign-in still works, but `/api/voice-scheduler/
   create-event` will fail (Graph rejects the token as missing scope).
2. **Two Azure OpenAI deployments**, same resource: `AZURE_OPENAI_WHISPER_DEPLOYMENT`
   (a `whisper` model) and `AZURE_OPENAI_CHAT_DEPLOYMENT` (a small chat model,
   e.g. `gpt-4o-mini`) -- both need to actually support the region your Azure
   OpenAI resource is in; not every region offers every model. See
   `.env.example` for the full variable list.

## Notes

- `POST /api/voice-scheduler/transcribe` -- multipart `audio` field, returns `{ text }`.
- `POST /api/voice-scheduler/converse` -- `{ history: [{role, text}, ...] }`, returns either `{ done: false, question }` or `{ done: true, event, confirmation }`. Stateless server-side, by the same convention as every other page here that re-sends its own full state rather than the server holding per-user in-progress state -- one browser tab mid-conversation never affects another.
- `POST /api/voice-scheduler/create-event` -- `{ subject, start, end, location }` (local `YYYY-MM-DDTHH:mm:ss`, no offset), writes to the caller's own calendar via Graph, returns `{ id, webLink }`.
- Calendar events are created with the fixed `E. Australia Standard Time` Windows zone (Brisbane/Queensland, no daylight saving) -- same fixed-AEST assumption every other page on this dashboard already makes (`aestToUtcIso`/`todayAestKey` in `@dashboard/autotask-client`), NOT `AUS Eastern Standard Time` (that one's Sydney/Melbourne, which does observe daylight saving).
- The confirm step's date/time/title/location are all editable before anything is written -- voice transcription and the model's parse are both imperfect; this is the deliberate check before the actual Graph write, not just a nicety.
