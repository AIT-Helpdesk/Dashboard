# @dashboard/my-strety-tasks

Dashboard page: the signed-in user's own **open Strety to-dos**, sorted by due date (soonest first, no-due-date tasks last). Auto-loads on open -- no search/filter input, since this is inherently "my" data, not a search tool.

- `client.js` - frontend module. Exports `id`, `label`, and `mount(container)`, picked up automatically by the shell.
- `server.js` - Express router mounted by the shell at `/api/my-strety-tasks`.

## "Logged in user" -- matched by email, against the signed-in user's OWN Strety connection

This page resolves the **dashboard's own signed-in email** (`req.session.user.email`, the same Microsoft 365 identity every other "my X" feature on this dashboard uses, e.g. Ticket Times' current-user pinning) against Strety's `/people` directory via `filter[email]` (an exact match, confirmed), then fetches THAT person's open todos. Every real Ambient iT person in Strety uses their exact `@ambientit.com.au` address, matching the dashboard's own Entra email one-for-one, confirmed against real data (14 real people, all but a couple with populated emails matching that pattern) -- so no fuzzy/wildcard matching is needed or attempted.

**The `/people` lookup and the `/todos` fetch both go through the signed-in user's OWN personal Strety connection** (`getPersonalClient(email)`, `@dashboard/strety-client`), not the shared connection every other Strety-backed page on this dashboard uses. This was a real, production-confirmed fix, not a design preference from the start: `filter[assignee_id]` on `/todos` is genuinely honored for any person regardless of which account is connected (confirmed -- querying a different person's id while connected as someone else still returns that person's real todos), but a connected account with no Strety team/space membership at all was ALSO confirmed to see **zero** todos company-wide, filtered or not -- the shared `helpdesk@ambientit.com.au` connection is exactly that kind of account. The fix isn't "connect the shared account as someone more privileged" -- that would mean one connection with visibility into every technician's own personal todos, including anything HR/management-sensitive, rejected by request as too high a risk. Instead each dashboard user connects their OWN Strety account, once -- see `@dashboard/strety-client`'s README, "Per-signed-in-user connections", for the full mechanism.

If the signed-in email has no matching Strety person, the page says so plainly (`status: 'person-not-found'`) rather than silently showing nothing or someone else's tasks.

## Open tasks

`filter[completed]=false` on `/todos` -- confirmed against real data as the only working way to scope to open (not-yet-done) tasks; `filter[status]=open` and `filter[completed_at]=null` both 400. Combined with `filter[assignee_id]=<personId>`, walked across every page via `fetchAllPages()` (`@dashboard/strety-client`, capped at 20 rows/page -- confirmed the real ceiling, much lower than Ingram's/IT Glue's).

## Sorting -- done in JS, not via the API's own `sort` param

Confirmed against real data that Strety's `sort=due_date` query param does **not** produce a reliable order when combined with `filter[...]` params (a real request came back in no discernible order -- not ascending, not descending, not creation order either). So `server.js` collects the full result set (via `fetchAllPages()`, which deliberately doesn't expose a `sort` passthrough at all) and sorts it itself: ascending by `due_date`, with **no due date sorting LAST**, not first -- a task with no deadline set isn't more urgent than one that's actually due soon. Verified against real data: 81 real open tasks for the connected account, non-null due dates confirmed correctly ascending, and all 5 null-due-date tasks landed at the very end of the list, not scattered through it.

## "Team" column -- a todo's `space`, not a literal team

Every todo has `relationships.space`, and confirmed against real data it's always one of three types, not just "team":
- `team` -- a real Strety team (Leadership Team, Tech Team, Executive, etc.) -- resolved against `/teams`' own `attributes.name`.
- `person` -- the todo's own assignee's individual space, confirmed against real data the space id is literally the assignee's own person id in this case. Not a team at all -- Strety's equivalent of a personal/individual to-do (an EOS "Individual" concept). Shown as **Personal**, not looked up anywhere since there's no separate entity behind it.
- `project` -- a real Strety project -- resolved against `/projects`' own `attributes.title` (projects use `title`, not `name`, confirmed against real data -- unlike teams and people, which both use `name`).

Both `/teams` (11 real rows) and `/projects` (3 real rows) are small enough to fetch in full every request (`fetchAllPages`, no filtering needed) and resolved into an id->name map alongside the todos fetch -- same no-caching stance as the rest of this page. Verified against real data: all 81 open todos for the connected account resolved to a real name, zero fell through to the "Unknown Team"/"Unknown Project" fallback.

Tasks are grouped by this resolved name, one table per group (`client.js`), not a flat list with a Team column -- by request. Groups are NOT alphabetical: the server already returns `data.tasks` sorted ascending by due date (see below), so `client.js` derives group order from the first (soonest-due) task's team in that already-sorted list -- the team with the most urgent task leads. Within a group, order is inherited for free from the same sort (a `filter()` preserves relative order), so no separate per-group sort is needed.

## Overdue flagging

A task whose due date is before **today (AEST)** is flagged the same "needs attention" red used elsewhere on this dashboard (`.cell-flag-red`) -- computed client-side (`todayAestKey()` in `client.js`), same AEST-anchoring convention every other date-scoped page on this dashboard follows, even though this page has no server-side date logic of its own to anchor to. A task due **today** is deliberately NOT flagged -- there's still time left in the day.

## Not connected / not signed in

Distinct early-exit states, reported separately:
- `status: 'not-connected'` -- the SIGNED-IN USER hasn't connected their own personal Strety account yet (or their token store is missing/corrupt) -- normal and expected the first time any given person uses this page (or What's On's Strety-backed sections), not an error condition to alarm about. The page shows a direct link to `/auth/strety-personal/connect`, which authorizes as whoever's currently signed into the dashboard.
- `status: 'reauth-required'` -- this person's OWN connection was working and has since gone stale (same periodic real-world occurrence as the shared connection -- see `@dashboard/strety-client`'s README). Same fix, same link.
- `status: 'no-session-email'` -- shouldn't normally happen (the dashboard's own `requireAuth` guarantees a signed-in session before any page loads), but handled defensively rather than assumed impossible.

## No caching

Every load is a live fetch (an account-wide `/todos` walk, filtered down to one person) -- this is a personal, low-volume, actionable list a tech would want genuinely current, not a report worth caching. A **Refresh** button re-triggers the same live fetch on demand.

## Sequential, not concurrent, Strety requests

`buildSpaceResolver()` and `fetchOpenTasksFor()` fetch `/teams`/`/projects`/`/todos` one at a time, not via `Promise.all` -- confirmed against real use elsewhere on this same Strety connection (What's On) that firing multiple Strety requests concurrently can come back 200 with a suspiciously empty/short result rather than a clean error. See `@dashboard/strety-client`'s README, "Rate limiting", for the full story.
