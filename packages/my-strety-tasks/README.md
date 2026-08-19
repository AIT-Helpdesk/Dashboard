# @dashboard/my-strety-tasks

Dashboard page: the signed-in user's own **open Strety to-dos**, sorted by due date (soonest first, no-due-date tasks last). Auto-loads on open -- no search/filter input, since this is inherently "my" data, not a search tool.

- `client.js` - frontend module. Exports `id`, `label`, and `mount(container)`, picked up automatically by the shell.
- `server.js` - Express router mounted by the shell at `/api/my-strety-tasks`.

## "Logged in user" -- matched by email, not the connection owner

Strety's OAuth connection is tied to whichever ONE person originally approved it (see `@dashboard/strety-client`'s README) -- but `/todos` turned out to be account-wide, not scoped to that person specifically, confirmed against real data (multiple distinct real assignees showed up through the one shared connection). So this page doesn't just show the connector's own tasks -- it resolves the **dashboard's own signed-in email** (`req.session.user.email`, the same Microsoft 365 identity every other "my X" feature on this dashboard uses, e.g. Ticket Times' current-user pinning) against Strety's `/people` directory via `filter[email]` (an exact match, confirmed), then fetches THAT person's open todos. Every real Ambient iT person in Strety uses their exact `@ambientit.com.au` address, matching the dashboard's own Entra email one-for-one, confirmed against real data (14 real people, all but a couple with populated emails matching that pattern) -- so no fuzzy/wildcard matching is needed or attempted.

If the signed-in email has no matching Strety person, the page says so plainly (`status: 'person-not-found'`) rather than silently showing nothing or someone else's tasks.

## Open tasks

`filter[completed]=false` on `/todos` -- confirmed against real data as the only working way to scope to open (not-yet-done) tasks; `filter[status]=open` and `filter[completed_at]=null` both 400. Combined with `filter[assignee_id]=<personId>`, walked across every page via `fetchAllPages()` (`@dashboard/strety-client`, capped at 20 rows/page -- confirmed the real ceiling, much lower than Ingram's/IT Glue's).

## Sorting -- done in JS, not via the API's own `sort` param

Confirmed against real data that Strety's `sort=due_date` query param does **not** produce a reliable order when combined with `filter[...]` params (a real request came back in no discernible order -- not ascending, not descending, not creation order either). So `server.js` collects the full result set (via `fetchAllPages()`, which deliberately doesn't expose a `sort` passthrough at all) and sorts it itself: ascending by `due_date`, with **no due date sorting LAST**, not first -- a task with no deadline set isn't more urgent than one that's actually due soon. Verified against real data: 81 real open tasks for the connected account, non-null due dates confirmed correctly ascending, and all 5 null-due-date tasks landed at the very end of the list, not scattered through it.

## Overdue flagging

A task whose due date is before **today (AEST)** is flagged the same "needs attention" red used elsewhere on this dashboard (`.cell-flag-red`) -- computed client-side (`todayAestKey()` in `client.js`), same AEST-anchoring convention every other date-scoped page on this dashboard follows, even though this page has no server-side date logic of its own to anchor to. A task due **today** is deliberately NOT flagged -- there's still time left in the day.

## Not connected / not signed in

Two distinct early-exit states, reported separately:
- `status: 'not-connected'` -- nobody has been through the Strety authorization flow yet (or the token store is missing/corrupt). The page shows a direct link to `/auth/strety/connect`.
- `status: 'no-session-email'` -- shouldn't normally happen (the dashboard's own `requireAuth` guarantees a signed-in session before any page loads), but handled defensively rather than assumed impossible.

## No caching

Every load is a live fetch (an account-wide `/todos` walk, filtered down to one person) -- this is a personal, low-volume, actionable list a tech would want genuinely current, not a report worth caching. A **Refresh** button re-triggers the same live fetch on demand.
