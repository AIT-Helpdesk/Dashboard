# @dashboard/live-reports

Dashboard page: "Present to Client" -- search for one Autotask client, get a live-pulled equivalent of Datto RMM's own canned "Executive Summary Report" on screen, then optionally export it as a branded PDF with AI-written narrative sections. Built by request as a live-data replacement for the scheduled-email PDF a TAM previously had to download by hand. Reads from Datto RMM (devices, alerts, per-device audits), Autotask (company resolution, M365 contract seat counts), IT Glue (primary domain), SaaS Alerts, Datto SaaS Protection, Datto EDR, AutoElevate, Huntress, and INKY (each via its own already-established client module elsewhere on this dashboard), plus the company intranet's own SharePoint pages (live reference tables) and the Anthropic API (optional AI narrative).

- `client.js` - frontend module (~2,000 lines). Exports `id`, `label`, and `mount(container)`.
- `server.js` - Express router mounted by the shell at `/api/live-reports`.
- `pdf-template.js` - draws the branded PDF directly with `pdfkit`, in-process -- deliberately **not** a Puppeteer/headless-Chrome HTML-to-PDF render, confirmed live that launching a real browser from the dashboard's Windows Service (Local System, Session 0) fails every time, a well-documented and effectively unfixable limitation of that execution context.
- `ai-commentary.js` - calls the Anthropic API to draft the PDF's narrative sections (Executive Summary, On Track/Watch/Action Needed, Recommendations).
- `sharepoint-client.js` - reads two live tables off the company intranet (Cybersecurity Services descriptions, Proactive Maintenance Jobs) via Microsoft Graph, app-only client-credentials auth.
- `email-domain-protection.js` - live DMARC/SPF/DKIM DNS checks for the client's primary domain, resolved via IT Glue.

## What this page is NOT (by design, so far)

First version, by explicit request ("we will add more parts to this page as we go if I like what you create"): Device Health (Patch/Antivirus/Software), Asset Management, Monitoring, and Open Alerts only, built on top of real live Datto RMM data via `@dashboard/datto-rmm`'s `getAllDevices()`/`getOpenAlerts()`/`getDeviceAudit()`/`getSiteAlertsBreakdown()` -- the same functions Datto RMM's own account-wide page and Check Client's per-client section already use, not a new integration.

## Overall Health Score formula

Reconstructed from Datto RMM's own canned "Executive Summary Report," confirmed against real screenshots of it, not an approximation invented from scratch:

- **Device Health** (60% of Overall): each of Workstations/Servers gets its own Group Health Score = `Patch*0.40 + Antivirus*0.40 + Software*0.20`, where each component is the group's own *average point value* across devices (e.g. a group half "Reboot Required"/half "Fully Patched" scores ~95 on Patch, not a binary 50%). Servers are scored Antivirus-only for this component (weight 1.0) -- Patch/Software aren't Datto-managed for servers on this account at all, so scoring them there would just penalize servers for data that doesn't exist. When both groups have devices, Device Health = `Server*0.6 + Workstation*0.4` (servers carry more business risk per device, so they aren't averaged in equally regardless of how many workstations exist).
- **Asset Management** (20% of Overall): Datto's real 4-factor formula -- OS still supported by Microsoft, ≥15% free System Drive space, ≥7.8 GB memory, device within warranty -- each check scored as "% of devices *with data for that check* that pass it." A device with no data at all for one check (e.g. `warrantyDate` never populated) drops out of that check's average entirely rather than counting as a failure. Disk-free%/memory need one `/v2/audit/device/{deviceUid}` call **per device** (no bulk endpoint exists), fetched with bounded concurrency and cached 6 hours per device.
- **Monitoring** (20% of Overall): Datto's real resolution-ratio-per-priority-tier formula -- `Score = (Raised - Unresolved) / Raised * 100` per tier (Critical/High/Moderate/Low/Information, 100% when nothing was raised), averaged across all 5 tiers. Sourced from the site-scoped `/v2/site/{siteUid}/alerts/open|resolved` endpoints.
- Servers' own Health Score additionally blends in Asset Management/Monitoring alongside Antivirus (by request, Antivirus alone was judged too narrow a signal for servers), each only when actually available.
- Any component with no data drops out of its blend and the remaining weights re-normalize -- a missing score is never silently treated as a 0.

This exact formula (`computeOverallHealth()`, `computeAssetManagementDetail()`/`computeMonitoringDetail()` via `computeAssetManagementAndMonitoringScores()`) is exported and reused verbatim by `@dashboard/live-health-scores`, so the two pages can never disagree.

## Matching a client to a Datto RMM site

Unlike every other page on this dashboard, the primary client lookup here is **by Autotask Company name first** (`GET /resolve-client`, reading the "Name:Datto RMM" UDF -- the one thing that tells this page which real Datto site a company corresponds to). There's no fallback-to-company-name guess if that UDF is blank; `client.js` reports that honestly rather than inventing a Datto site name that might not exist. Everything downstream of the initial match (Datto devices, the 5 vendor cards, M365 Licenses) is then keyed off the real matched Datto **site name**, not the Autotask company, except where noted below.

## "Other Systems" vendor cards

A separate route (`GET /vendors`), fetched by the client *after* the fast Datto RMM report has already rendered -- folding these into the main route made a cold page take 60-70+ seconds (several vendors, SaaS Protection's per-customer detail especially, have no account-wide warm cache path the way Datto RMM's own device list does). Every vendor match here is a cross-vendor **name** match against the matched Datto site name (this page has no Autotask company to resolve from in most cases) -- SaaS Alerts, Datto SaaS Protection, Datto EDR, AutoElevate, and Huntress, each via that vendor's own already-confirmed-live module elsewhere on this dashboard. INKY (email security) is also included. Each of the 6 vendor calls is caught individually (`catchVendorError()`) -- confirmed a real bug: one vendor's transient failure used to take down the whole response, including unrelated vendors and M365 Licenses.

- **SaaS Alerts** -- literal 30-day window (not Client Summary's calendar-month "1 month"). Confirmed live this session that `/reports/events(/count)` genuinely respects a `customerId` param server-side, so once the customer is matched by name, every call is scoped directly to that one customer rather than account-wide-fetch-then-filter. Top Events tracks each severity's own real critical/medium count *separately per event name* -- a prior version merged them into one combined count colored red on any critical occurrence, which could (and did, on a real client) make the on-screen red numbers sum to more than the actual Critical tile.
- **SaaS Protection (Datto backup)** -- reuses `@dashboard/saas-protection`'s own cached functions, no new Datto calls. A UDF match ("Name:SaaS Backups") is tried before the fuzzy name match, when the Autotask company is known. Per-app-type (Email/OneDrive/SharePoint/Teams) seat counts are derived from Datto's own seat-type-to-app-type mapping, duplicated here as a small literal rather than imported (one module is a browser ES module, the other Node CJS).
- **Datto EDR** -- summed across every matched Location (a client can have several). The 30-day alert count is computed by filtering one fixed, cached, 1000-row account-wide alert batch client-side (Datto EDR's `/api/Alerts` has no working server-side filter or pagination, confirmed live) -- not a true sliding window, but confirmed reliable in practice at this tenant's real alert volume.
- **AutoElevate** -- elevation requests/events, 30-day window. "Approved (Manual)" is deliberately *not* labelled "by a technician" -- confirmed live there's an apparent third, undocumented auto-allow path that doesn't cleanly map to "a rule matched" vs. "a human decided."
- **Huntress** -- `incidentReportsCount` is a lifetime total (no date-range param on that endpoint), labelled as such rather than implied to be windowed.
- **INKY (email security)** -- last-30-days message/caution/danger totals plus top threat reasons, with specific reason codes relabeled to clearer client-facing wording (e.g. `internal_name_match` → "Impersonation Attempt"). Unlike every other vendor card, a failed INKY call still shows its own card, with a generic reassuring note rather than vanishing like a "not installed" vendor.

## Microsoft License Counts

The one section on this page that resolves a real Autotask Company (by name, or by a passed-through `companyId` when already known) rather than purely matching on Datto site name. Confirmed live: Autotask has no separate "Product" entity on this account's contracts -- real per-seat counts live on `ContractServiceUnits.units`, one row per billing period per `ContractService`, accumulating a new row every time a line's billing changes. So this fetches only the `ContractServiceUnits` whose date range covers *today*, groups by a normalized product name (stripping Autotask's own `(Monthly)`/`- Prorate from X to Y`/`- Recurring` suffixes), and sums units within each group -- confirmed to match what a human would read off the real contract as "how many of this are we billing right now." All active contracts whose name starts with "M365" are combined (a client can have more than one active simultaneously); billing term (Monthly/Annual) is kept as its own column, detected from the real invoice description text.

## Email Domain Protection (live DNS) vs. Mail Domain Protection Monitoring (manual)

Two separate, deliberately different cards:

- **Email Domain Protection DNS Check** -- fully automated: resolves the client's primary domain via IT Glue (an explicit "Primary Domain" Flexible Asset tag first, falling back to "exactly one domain on file" if unambiguous), then runs real DMARC/SPF/DKIM DNS lookups and tags each with the detected provider (Microsoft/Google/EasyDMARC). IT Glue's native Domains resource is confirmed read-only via their public API (every write shape tried 404s), so there's no way to save a resolved domain back there directly -- instead, an admin can pick/type a domain for just this report, with a "Set this Domain as Primary" checkbox that writes to the separate, writable Flexible Asset instead.
- **Mail Domain Protection Monitoring** -- a fully manual-entry card (score out of 10, 3-dot DMARC/SPF/DKIM levels, SPF/DKIM pass rates) for data looked up by hand in EasyDMARC, since there's no EasyDMARC API connected to this dashboard yet. The score and dot levels are picked by hand and are **not** derived from the pass-rate numbers shown alongside them. Starts locked (every field `disabled`); clicking a cog icon unlocks editing. Defaults to 10/10 "best case" on a fresh search rather than a lower score that would read as a real finding before anyone's looked anything up.

## Scorecard, Asset Management/Monitoring tables, and per-item "include in PDF" toggles

The on-screen Scorecard (Area/Result/Status rows, 90/70 On Track/Watch/In Progress thresholds) and the PDF use the exact same `scorecardStatus()` logic, so they always read as the same scorecard. Nearly every section, Cybersecurity Systems card, and Device Health sub-item carries its own "include in PDF" checkbox (ticked by default, tracked via one delegated change listener on the page container so re-renders don't need rewiring) -- an unticked box is the only thing that ever hides a section from the exported PDF; a missing/undefined toggle always means "shown."

## Generate Summary (AI narrative) -- gated

`ai-commentary.js` calls Claude (model `claude-opus-5`) with a trimmed JSON snapshot of the client's live data (never the raw device list) and a prompt that explicitly forbids naming the underlying vendor/product to the client (e.g. `dattoEdr` → "endpoint detection and response"), asking for a strict JSON shape (`executiveSummary`, `onTrack`/`watch`/`actionNeeded` bullets, `recommendations`). The resulting narrative is shown in an editable form before the PDF is created -- whatever's in the form at Create PDF time is sent as-is and used without a second AI call.

This feature is gated server-side to a named allow-list (`ALLOW_REPORT_AI_GENERATION` env var, comma-separated names, checked against the logged-in session user on the real `/commentary` route -- not just used to hide the button client-side, since hiding a button is never real access control). An `ANTHROPIC_API_KEY` is optional; its absence just means the PDF ships without these sections, never a thrown error.

## Live SharePoint reference content, with static fallbacks

Two sections are pulled live from the company intranet (Microsoft Graph, app-only client-credentials auth) rather than hardcoded, each with a frozen static fallback if the live fetch fails so a report never ships missing a whole section:

- **Cybersecurity Systems descriptions** (which services this client has, ticked by cross-referencing the vendor cards above or the client's Autotask Classification against the table's own TC Elite/TC Essentials/All Clients columns) -- from the intranet's "Cybersecurity Services for Managed Service Clients" table, falling back to `CYBERSECURITY_EXPLANATIONS` in `pdf-template.js`.
- **Proactive Maintenance** items -- from the intranet's "Proactive Maintenance Jobs" table (its own "Show**" Y/N column + Schedule column), falling back to `PROACTIVE_MAINTENANCE_ITEMS` (an env var) and finally `DEFAULT_PROACTIVE_MAINTENANCE_ITEMS` (a frozen built-in list) if both the live fetch and the env var are unavailable.

Both live tables are cached for 1 hour (admin-edited reference content, not live telemetry) via a shared keyed cache in `sharepoint-client.js`.

## Caching

- Datto devices/open alerts: 20 minutes, independent cache instance from every other Datto-RMM-backed page on this dashboard (Check Client, Meeting Prep, Live Health Scores each keep their own).
- Per-device audits (disk/memory): 6 hours, keyed by device UID -- a real API call per device with no bulk variant, so this is deliberately much longer-lived than the other caches.
- Site alert breakdown: 20 minutes, keyed by site UID.
- M365 license counts, resolved company (for UDF/classification lookups): 20 minutes / 2 minutes respectively.
- SharePoint reference tables: 1 hour.
- `force=true` bypasses the relevant caches on the main report and vendor routes.

## PDF export

`POST /pdf` takes the *exact* `report`/`vendors` JSON the browser already has on screen (never re-fetched server-side), so the PDF always matches what's visibly rendered -- the only live re-check performed at PDF time is Email Domain Protection's DNS lookup (cheap enough to re-verify fresh rather than trust from the client). The branded PDF itself is drawn directly with `pdfkit` section by section (cover header, at-a-glance, executive summary, scorecard, device health breakdown, M365 licenses, device list, Cybersecurity Systems cards, score/module explanations, proactive maintenance note, recommendations) -- there is no HTML-to-PDF rendering step anywhere in this package.
