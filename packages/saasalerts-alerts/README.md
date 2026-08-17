# @dashboard/saasalerts-alerts

Dashboard page: pick a **Date** and a **Period**, see every SaaS Alerts security event of **medium or critical** severity in that window, across all customers, optionally filtered by client name (wildcards with `*`). Does not auto-load -- click Load, same convention as Completed Tickets/Ticket Times.

The summary line shows both the report's own count and, in brackets, the total across the chart's whole date range (e.g. "12 alerts on 2026-08-11 ... (312 in the last 28 days)" for a 1-day period, or "1,567 alerts from 2026-08-11 to 2026-08-17 ... (312 in the last 28 days)" for a longer one) -- the bracketed figure is summed client-side from the same `chart` data the chart itself renders (see below), not a separate server field, so it can't drift out of sync with what the chart shows. These two numbers are independent and can genuinely differ once Period is more than a day -- the chart's own window never changes size, only the report does.

- `client.js` - frontend module. Exports `id`, `label`, and `mount(container)`, picked up automatically by the shell.
- `server.js` - Express router mounted by the shell at `/api/saasalerts-alerts`.

## Date and Period

**Date** is the start point; **Period** (`1 day` / `1 week` / `1 month` / `3 months`, default `1 day`) is how far forward from it the report -- the summary line, Alert Summary, and the detail table -- extends. `PERIODS` in `server.js` is the single source of truth for the day ranges and their labels; `PERIOD_OPTIONS` in `client.js` mirrors the same keys so the dropdown renders before any request is made (same manual-sync pattern as `WINDOW_OPTIONS` on Subscriptions Expiring -- keep both in sync when adding an option).

`addPeriod()` computes the period's **exclusive** end date -- `1 month`/`3 months` use plain `Date.UTC` month arithmetic, so its native day-of-month overflow behavior applies (e.g. 31 Jan + 1 month lands on 3 Mar, not clamped to 28/29 Feb) -- this is a reporting window, not a billing date, so there's no need for custom clamping logic. The response's `periodEnd` is that exclusive end date; the client subtracts one day from it (`subtractOneDay()`) to display the actual last included day.

**The chart above the report is intentionally unaffected by Period, by request** -- it always shows its own fixed 28-day window (the selected date's week plus the 3 before it) regardless of which Period is picked, staying general trend context rather than tracking the report's own (potentially much longer) window. Clicking a single day's bar in the chart resets Period back to `1 day` and jumps to that day -- "show me this one day" is what clicking one bar means, not "start a new period of whatever length was previously selected from this day."

Since Period can extend well past the chart's own end date (a 3-month period reaches much further than 28 days), the actual upstream fetch range is the **union** of the chart's window and the report's period, computed once and reused for both -- not two separate fetches. This makes the SaaS Alerts API's per-request `size` handling (see below) matter more, not less, since the effective range can be far larger than 28 days.

## Why medium/critical only, with no toggle for low

Confirmed against the real API: `low` severity is the overwhelming majority of all events -- 92,705 of 92,849 events (99.8%) in a single 24-hour test window, almost entirely routine sign-in activity. This page is meant to be an actual **alerts** feed (things that plausibly need a human to look at them), not a raw activity log, so it's scoped to `medium`+`critical` by design, with no toggle to widen it -- showing the low-severity noise would defeat the point of the page. `critical` alone is rare (0 in a 24h test window, 8 in a 7-day window), so `medium` is what most days' results will actually be.

## Date filtering

SaaS Alerts' `time` field is a real timestamped instant (unlike Ingram's plain-date `expirationDate` on the Subscriptions Expiring page), so this uses **AEST** calendar days, not UTC and not the server's own local clock -- `mondayOf()`/`aestToUtcIso()`/`isoDateAest()` (shared, `@dashboard/autotask-client`), the same helpers Asked for Review uses for its own Monday-Sunday week.

## One fetch covers the chart AND the report, whatever Period is

The server fetches the **union** of two ranges in one shot, for both severities (`alertStatus=critical`, `alertStatus=medium` -- the API's `alertStatus` filter takes exactly one value per request, same constraint Ingram's `status` filter has): the chart's own fixed 28 days (the selected date's Monday-Sunday week, plus the 3 weeks immediately before it -- `CHART_WEEKS = 4` in `server.js`, easy to retune) and the report's own Period range (see above), whichever extends further. Not one fetch per day, per week, or per range. That single fetch covers both the chart (bucketed into daily critical/medium counts across its own fixed 28 days) and the detail table below it (the report period's events, filtered back out of that same fetch).

**`size` is derived from a real count, not a guessed fixed number** (`SIZE_CAP = 10000`, `fetchAlertsInRange()`) -- confirmed the hard way against the real API: the `size` query param has an undocumented hard ceiling somewhere between 10,000 and 12,000, and exceeding it doesn't error or clamp, it silently returns **zero** results. A real 28-day range once carried 7,400 medium events on its own (one single outlier day alone had 2,571), well past what a "generous-looking" fixed guess like 5,000 or even 15,000 safely covers -- 15,000 is *past* the undocumented ceiling and was caught returning an empty chart during testing despite genuine data existing. So each severity's request is preceded by a cheap, uncapped call to `/reports/events/count` for the same range, and `size` is set to `min(that real count, SIZE_CAP)` -- correct by construction rather than by a number that happened to look big enough in testing. If a real count ever exceeds `SIZE_CAP`, that's logged rather than silently truncated. This makes a full report 2-4 requests total (a count + a list per severity that actually has events that day range, fewer if a severity has zero) rather than a fixed 2.

## Week chart

A **vertical** stacked bar per day, 28 days total across 4 consecutive Monday-Sunday weeks (the selected date's own week plus the 3 before it), sitting above the detail table -- critical (red) stacked on medium (blue) within each column, every column scaled against the busiest day across all 4 weeks (a fixed 140px track height) so all 28 are comparable on one shared scale. A thin rule (`.vbar-col--week-start`) marks every week boundary; the boundary of the SELECTED week specifically is accented instead (`.vbar-col--current-week-start`, a thicker accent-colored rule) so it stands out among the others -- otherwise 4 unbroken runs of 7 columns read as one ambiguous block rather than 4 distinct weeks. `.vbar-chart`/`.vbar-col`/`.vbar-track` (`styles.css`) is its own component, not a reuse of the horizontal `.bar-chart` Clients by Classification uses -- the stacking direction (`flex-direction: column-reverse`, medium at the base, critical above it) is genuinely different layout, not just a rotated version of the same CSS. Renders even when the selected day itself has zero alerts -- a quiet day is still meaningful context, not something to hide. The column for the currently-selected date is highlighted (`.vbar-col.active`); clicking any other day's column jumps straight to that day (updates the date picker and reloads), rather than requiring the date picker to be used for every day you want to check within any of the 4 weeks. Segment colors match the Severity column's flag colors in the table below, not new ones. The client-name filter, when set, narrows the chart's counts the same way it narrows the table -- both always agree with each other.

## Alert Summary

Sits between the week chart and the detail table -- a breakdown of the **selected Period's** alerts (same scope as the detail table, not the chart's own fixed 28-day window), grouped by alert name (`event`, i.e. `jointDesc`). Each group shows how many times that alert fired within the period, then lists every client+user combination that triggered it and how many times, sorted busiest-first. Groups themselves are also sorted busiest-first (most-frequent alert type at the top), so it reads as "what happened most, and to whom" at a glance, rather than needing to scan every row of the detail table underneath.

Built entirely client-side (`renderAlertSummary()`) from `data.rows` -- the exact same data the detail table renders, not a separate request -- so it's always consistent with whatever's in the table and respects the client-name filter automatically. A client+user combination that recurs for the same alert within the period is counted once with `count > 1`, not listed as repeated rows. Verified against real data: group totals summed exactly back to the report's total count.

## All Alerts (collapsible)

The full detail table sits behind an **"All Alerts"** heading, collapsed by default every time a new date/search loads (`.resource-group-header--toggle`, `styles.css`) -- click it (▸/▾) to show or hide the table. Starts minimized because the Alert Summary above it already gives the at-a-glance view; this is the "show me every individual row" detail underneath, not something that needs to be open by default. State isn't persisted between loads -- picking a new date or search always starts collapsed again, same as the state before the click.

## Table columns

**Time** (browser-local time-of-day, same convention as Tickets Created's `formatTime()` -- this is a same-day view, so only the time-of-day matters), **Client** (linked to the matching Autotask company when SaaS Alerts has that mapping -- see below), **Severity** (critical shown red, medium shown blue), **Event** (`jointDesc`, the human-readable event description, e.g. "IAM Event - Multi-Factor Authentication Disabled" -- with `jointDescAdditional`, when present, shown as smaller subtext underneath for the specific detail, e.g. "jharries@... deleted Authenticator App as an MFA Method"), **User** (`user.fullName`, falling back to `user.name`), **Ticket** (linked to the Autotask ticket SaaS Alerts auto-created for this alert, when one exists -- see below).

## Autotask company link

Same `mappedToPSA` mechanism as the SaaS Alerts Customers page, but resolved independently here (its own 20-min cache, `getAutotaskUrlByCustomerId()`) rather than shared between the two pages -- this page only needs the id -> URL lookup, not the full customer record set that page displays.

## Autotask ticket link

Some rule-triggered alerts carry a `psaTicket` array on the raw event -- SaaS Alerts' own Autotask integration auto-created a ticket for that specific alert. Where a `psaTicket` entry of type `autotaskpsa` exists, its ticket number links directly to that ticket. Not every alert has one (only certain configured Response rules create tickets automatically) -- most rows show a blank Ticket column.

## Client name filter

Applied server-side after fetching (small-to-moderate dataset even at the longest Period, no performance concern), matched against each event's own `customer.name` using the dashboard-wide wildcard convention (`matchesWildcard()`, `@dashboard/autotask-client`).
