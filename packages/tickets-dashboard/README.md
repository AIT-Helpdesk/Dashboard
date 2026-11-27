# @dashboard/tickets-dashboard

Dashboard page: a live, always-current ticket triage board -- six widgets/banners, each a fixed Autotask ticket query (priority or status), with no cache at all by design, since the whole point is a live rotating-display board showing what needs attention right now. Reads only from Autotask (`@dashboard/autotask-client`). Started as a single Critical (P1) widget copied out of the experimental "Ticket Dashboards (Test)" page, then grown into this generally-available page as more widgets were added by request.

- `client.js` - frontend module. Exports `id`, `label`, and `mount(container)`.
- `server.js` - Express router mounted by the shell at `/api/tickets-dashboard`.

## The widgets, and the exact Autotask value each one is keyed on

Every value below was confirmed live against this account's own real Tickets priority/status picklist -- several superficially similar values exist (e.g. "!! TO BE SCHEDULED" vs. "!! SET PRIORITY" vs. "P3 - SCHEDULED" vs. plain "Scheduled"), so none of these are guessed or reused from another page without checking.

| Widget | Autotask field | Value | Notes |
|---|---|---|---|
| Critical (P1) | priority | 4 ("P1 - CRITICAL") | Every ticket here IS critical -- its status column is force-colored red (except the one deliberate yellow exception below). |
| Triage Now | priority | 2 ("!! SET PRIORITY") | Not inherently critical, so its statuses render plain, not forced red. |
| DO TODAY | priority | 10 ("P1 - CANNOT BE MOVED") | Also filtered to due today-or-earlier. Widget + count only, no ticket list. Same priority value this tenant's own Strety automation uses for its "EOD - TODAY Jobs Missed" metric. |
| Schedule Me | priority | 12 ("!! TO BE SCHEDULED") | Widget + count only. Colored yellow/informational, not red/green -- not a bad-news count. |
| Client Updates | status | 19 ("Customer Note Added") | Widget + count only. Also yellow/informational. |
| Overdue tickets (banner) | -- | -- | Count-only red banner, no widget. Open, excludes Monitoring Alerts and the Triage Now/Schedule Me priorities (already called out by their own widgets), due date strictly in the past -- the same definition this tenant's Strety automation uses for its "EOD - Tickets Overdue" metric. |

Every query also excludes status 20 ("Billing - Contract") as already-done -- that status never gets `completedDate` set, so a finished ticket that moved to billing while still carrying a tracked priority would otherwise wrongly reappear. "DO TODAY" is the one widget that deliberately does **not** exclude Monitoring Alert tickets -- "an automated alert that's been escalated to this priority is exactly as urgent as a human-raised one," the same reasoning the Strety automation already applies to the identical metric.

## Clicking a widget

Every widget card is clickable -- Critical (P1) and Triage Now keep their own always-visible inline ticket list *and* also open the same list in a popup; DO TODAY/Schedule Me/Client Updates show only the donut and count inline, with their ticket list available only via the popup.

## No caching, and why queries run sequentially at concurrency 1

This page runs fully live on every page view and every Rotate-cycle swap -- no server-side cache at all, by design, since the whole point is a rotating "what's live right now" display. Confirmed live this mattered twice over:

- Fetching the full open-ticket set and filtering client-side (rather than filtering by priority/status in the query itself) routinely ran past the shell's own Rotate-preload buffer, so the page would briefly show stale data right after switching to it. Every widget's query now filters server-side by the exact priority/status it needs.
- Firing all 6 ticket/count queries concurrently tripped Autotask's rate limit once a third widget row was added -- and, separately, Autotask was confirmed to enforce a hard **3-thread** concurrency ceiling for this integration's Ticket entity specifically (distinct from the ~5 req/s rate limit), which this one page alone could already exhaust on every load. All 6 queries, plus the subsequent company/resource name-resolution passes, now run at `mapWithConcurrency(..., 1, ...)` -- genuinely one at a time -- to leave headroom for every other page's own Ticket queries landing at the same moment.

Client/resource names are still pre-warmed once across all five widgets' tickets combined (not once per widget) so a client or resource appearing on more than one list is only ever looked up once.
