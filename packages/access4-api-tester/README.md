# @dashboard/access4-api-tester

A raw HTTP request console, scoped by default at Access4's own SASBOSS SMS
Gateway API -- built specifically to debug the real SMS-sending issue on
`@dashboard/access4-sms`. **Amber-only** (`restrictedTo` in `package.json`),
since it sends real outbound requests with no further confirmation.

- `client.js` - frontend module. A form (method, base URL, path, query
  string, headers, JSON body) plus a response panel and a this-session
  history of past attempts.
- `server.js` - Express router mounted at `/api/access4-api-tester`.
  `GET /config` returns the current `.env` defaults (`ACCESS4_SMS_BASE_URL`/
  `ACCESS4_SMS_SERVICE_ID`/`ACCESS4_SMS_DID_NUMBER_ID` -- not secrets, Access4
  has no API key/token of its own at all). `POST /request` actually makes
  the call, server-side, and returns the real response (or a network-level
  error) verbatim.

## Why this exists

Access4's API is gated **purely by source IP**, no API key/token/Basic Auth
at all (see `@dashboard/access4-sms`'s own README). That means a request
sent from a laptop or dev machine proves nothing about whether Access4 has
actually whitelisted this dashboard's real outbound IP -- the request has
to originate from THIS production server to mean anything. Rather than
round-tripping every payload/endpoint tweak through a code change and a
full redeploy, this page lets that experimentation happen live, from here.

## Why a request here can come back two different ways

- **A real HTTP response** (`ok: true`, any status 200-599) -- Access4 (or
  whatever Base URL was targeted) actually answered. `validateStatus: () =>
  true` in `server.js` means even a 401/403/500 comes back as a normal
  result with its full body shown, not swallowed into a generic error --
  seeing Access4's own rejection message is the whole point.
- **A network-level error** (`ok: false`) -- the request never reached a
  server at all (DNS failure, connection refused, timeout). This is a
  materially different signal from a real rejection: it means the problem
  is the network path itself (a firewall/outbound rule), not anything
  Access4 said back.

## Base URL is editable on purpose

It defaults to the real `ACCESS4_SMS_BASE_URL`, but can be pointed anywhere
-- e.g. a plain `https://httpbin.org` connectivity check -- specifically so
"Access4 is rejecting us" can be told apart from "this server can't reach
anything on that port at all." Path is kept strictly relative (must start
with `/`, rejected if it contains `://`) and is always appended to Base URL
by plain string concatenation, never resolved via `new URL(path, base)` --
that would let an absolute URL typed into Path silently replace Base URL
instead of appending to it.

## The "Send SMS (quick-sms)" preset

Fills in the exact endpoint/payload shape `@dashboard/access4-sms`'s own
real send call uses (`messageSubType: 'quick-sms'`, `campaignType:
'transactional'`) -- a known-good starting point to tweak from, not a
guess. `toMobile` is left as an obvious placeholder (`61412345678`) since
the preset is reused for every test, not tied to one real number.

## Explicitly out of scope

- No history is kept server-side -- the history list is this browser tab's
  session only (module-scope JS, lost on refresh), since this is a
  throwaway debugging tool, not a feature to maintain long-term.
- Not wired into the sidebar (`nav-layout.json`) -- reach it directly at
  `#access4-api-tester`, or right-click anywhere on the loaded page to add
  it to My Favourites, same as any other page.
