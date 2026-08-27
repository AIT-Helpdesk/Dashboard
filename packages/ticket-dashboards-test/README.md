# Ticket Dashboards (Test)

An experimental first cut at pulling Autotask "dashboard"-style metrics into
this app. **Restricted to one account (`amber@ambientit.com.au`) while it's
being tried out** -- see "Access restriction" below.

## Why this exists, and what it isn't

Autotask has no public API for the actual visual Dashboard widgets shown in
its own web UI -- those aren't exposed over the REST API at all, so there is
no way to literally embed Autotask's own dashboard screen here. This instead
reconstructs the closest useful equivalent from the same live Tickets data
every other page on this dashboard already reads, and renders it as our own
charts.

## What it shows

- **Open tickets right now**, broken down by Status / Queue / Priority (three
  horizontal bar-chart sections, reusing the same `.bar-chart` markup
  Classification Summary already uses, just without a drilldown).
- **Created vs. Closed, last 30 days** -- one stacked vertical bar per day
  (same shape as Security Alerts' own weekly chart), plus the 30-day totals.

All labels (status/queue/priority) are resolved live from each field's own
Autotask picklist metadata (`getPicklistLabels()` in
`@dashboard/autotask-client`), not a hardcoded map -- these are genuine
Autotask picklists specific to this account's configuration (queues in
particular are custom: Helpdesk, Workshop, Billing Issues, etc.), not fixed
values this app owns.

### "Open" is defined loosely, on purpose

Open = `completedDate` is not set. That's *simpler* than Completed
Tickets' own definition (which also treats status 20, "Billing - Contract",
as done via `resolvedDateTime`, since those tickets never get a
`completedDate` at all). Kept simple for this first test cut -- a status-20
ticket sitting in billing still counts as "open" here, which slightly
overstates the open count relative to Completed Tickets' stricter one. Worth
tightening (reuse Completed Tickets' exact closed-set definition, inverted)
if this page graduates past "test".

`completedDate IS NULL` is queried via Autotask's real `notExist` filter
operator -- confirmed working via a live round-trip (not previously used
anywhere else on this dashboard; every other page's `exist`/`notExist` usage
was `exist` only, e.g. Ticket Times).

### Rate limiting -- confirmed the hard way

The route's queries are deliberately **phased**, not all fired via one
`Promise.all`: open tickets, then the 3 picklist-label lookups together
(matching Ticket Times' own already-proven-safe 3-concurrent pattern), then
the trend fetch. An earlier version fired all 5 at once and got a real `429`
from Autotask (~5 req/s limit) during testing -- Autotask's own rate limit
doesn't distinguish "5 independent queries this one page needs" from a burst,
so anything beyond a few concurrent top-level requests risks the same thing
on a heavier page.

## Access restriction

`package.json`'s `dashboardPage.restrictedTo: ["amber@ambientit.com.au"]` is a
new, generic mechanism (see `packages/shell/server.js`'s `pageVisibleTo()`)
for hiding a page from everyone except a specific email allowlist, layered on
top of the dashboard-wide Microsoft 365 sign-in every page already requires.
Checked in three places, so there's no gap between them:

1. `/pages-registry.js` -- an unauthorized browser's copy of the page list
   never includes this page's id at all, which also means the shell's own
   `reconcileTree()` can never auto-append it into that browser's sidebar (no
   `nav-layout.json` change was needed for that reason -- it's just not in
   the list to begin with, same as every newly-added page normally auto-
   appends itself, except restricted-to accounts never see it happen).
2. `/pages/:id/client.js` -- the page's own JS module can't be fetched
   directly by URL either.
3. The `/api/<id>` router mount -- the underlying data can't be reached by a
   direct API call even by someone who somehow guessed the page id.

All three answer a plain `404`, not `403` -- the point is that the page
doesn't appear to exist at all for anyone not on the list, not merely that
it's visibly locked.

To open this page up to more people later (or to everyone), delete the
`restrictedTo` line from `package.json` entirely, or add more lowercase
emails to the array.
