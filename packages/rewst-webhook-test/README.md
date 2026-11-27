# @dashboard/rewst-webhook-test

A generic testing/debugging tool -- by its own name and design, not a client-facing feature -- for calling any Rewst webhook trigger configured in `.env` and seeing exactly what it returns. It isn't built around one specific business workflow: every webhook it offers, plus any input fields that webhook needs, is discovered live from `.env` rather than hardcoded, so adding, renaming, or removing a webhook is a `.env` change (and a dev-server restart) away, never a code change here. That said, it does genuinely work -- confirmed live against two real configured Rewst workflows (a CSP-customers list and an M365 `/subscribedSkus` lookup) -- so it's a real, useful way to exercise a Rewst integration while building or troubleshooting it, just not a page meant for day-to-day dashboard use.

- `client.js` - frontend module. Exports `id`, `label`, and `mount(container)`; renders the webhook dropdown, that webhook's own input fields, a Load button, a results table, and a results filter box.
- `server.js` - Express router mounted by the shell at `/api/rewst-webhook-test`, with `GET /webhooks` (lists what's configured) and `GET /` (actually calls one).

## How webhooks are discovered from `.env`

Every `REWST_WEBHOOK_<Name>_URL=https://...` line in `.env` becomes one dropdown entry, with `<Name>` used verbatim (case and underscores intact, by request) as both its internal key and its label -- `client.js` only swaps underscores for spaces in the dropdown's own display text, never in the real key. Any further `REWST_WEBHOOK_<Name>_<anything>=jsonKey;Label` lines under the same `<Name>` describe that webhook's own required input fields: the part before `;` is the real JSON field key Rewst's trigger expects, the part after is just the field's on-screen label. None of this is parsed for meaning beyond that -- the webhook's URL and its fields' real JSON keys are config, never guessed at in code, since only whoever built the matching Rewst trigger knows them for sure.

A missing required field is rejected client-side and server-side before any Rewst call is made, to avoid spending a real (rate-limited) call on a request that can't succeed.

## Response rendering

Clicking Load never happens automatically on mount or on switching the dropdown (by request) -- only the Load button fires a real Rewst call; switching back to an already-loaded webhook just re-shows its cached result.

`render()` in `client.js` matches on the **shape** of what came back, not on which webhook was selected (since a webhook's name in `.env` can be renamed at any time):

- `{ Customers: [...] }` gets a dedicated customers table.
- `{ subscribed_skus: { data: { value: [...] } } }` (Rewst's own raw-HTTP-action envelope around a Microsoft Graph call) gets a dedicated subscriptions table.
- Anything else falls back to a generic renderer: it looks for any array-of-objects field (direct or nested one level inside that same raw-HTTP-action envelope) and builds a table from the union of every row's keys, or pretty-prints the raw JSON if no row list is found at all -- including the literal `null` a Rewst workflow sends back when "Wait for results" is on but it has no real output step.

## Error handling

A failed call never logs or returns the full axios error object -- only `err.response?.data?.error` or `err.message`. A raw axios error carries the full outgoing request, including the webhook URL itself (which functions as a real credential), on `error.config`/`error.request`.
