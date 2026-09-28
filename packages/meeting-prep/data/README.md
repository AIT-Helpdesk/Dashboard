# Report data

One JSON file per report per site per date, read by `server.js`'s `loadFileReportComponents()` on every `/components` request (there's no cache here, these are small local files). Where they come from and how they get here is a separate question from what's in them, covered below.

## Folder structure

`<client-slug>/<date>/<report-kind>.json`, mirroring the SharePoint `Client Reports/Processed/<Client Name>/<date>/` structure 1:1 (by request, so the two stay easy to reason about together) -- `client-slug` is the same `slugify()` the rest of this page already uses for component ids, `date` is `YYYY-MM-DD` (the report's own date, not the date it happened to be parsed), and `report-kind` is one of:

- `executive-summary`
- `device-health-summary`
- `device-storage`
- `hardware-lifecycle`
- `patch-management-summary`
- `dark-web-monitoring` -- first source that isn't a Datto RMM Report Center PDF at all (see below)
- `email-security` -- INKY's own report, the first source whose "report PDF" doesn't arrive as a bare PDF at all (see below)

`server.js` derives the kind from the filename alone now (the whole thing, minus `.json` -- no more `<slug>--` prefix, since the client is already the containing folder). The actual matching against a search term still uses the `site` field *inside* each file, via the same wildcard rules as every other search on this dashboard.

**History is kept, not overwritten.** A new run of the same report for the same client goes into its own new `<date>/` folder rather than replacing the previous one -- `loadFileReportComponents()` always picks the LATEST date's file for each report kind (per client, independently -- one kind's latest date can be older than another's, e.g. a client with a fresh Datto run but a month-old Dark Web Monitoring one), so the page always shows the current picture, but nothing on disk is ever destroyed. Older dates aren't surfaced on this page yet -- see the main README's "Not yet built" for a future trend-over-time view once there's enough history to make one worthwhile.

This replaced an earlier flat `data/<slug>--<kind>.json` layout (silently overwritten on every re-run, no history at all) once keeping history actually started to matter, once more than one report run existed for the same client (Kraftur's own re-parse, 19 -> 21 devices, was the point this stopped being hypothetical).

`data/images/` (see below) is a separate, unrelated flat naming scheme living alongside the client folders in this same directory -- `loadFileReportComponents()` explicitly skips it by name when walking client folders.

## What's inside each file

The output of `ingest.js`'s own parser registry (`parsers/<kind>.js`, one file per report type, checked into this repo and run automatically by the "Process Incoming Reports" button/`node packages\meeting-prep\ingest.js` -- see below for where the SOURCE files themselves come from). The first 5 kinds all come from Datto RMM's actual Report Center PDFs -- Datto's Report Center/Analytics has no REST API at all (confirmed against Datto's own docs), so this is the only way to get real report content into the dashboard rather than a reformatting of raw live device/alert data. Every field on those 5 was validated by hand against the real PDF output for site "Kraftur Pty Ltd", including the pass/fail icon grids on Device Health Summary and Hardware Lifecycle, which aren't text in the PDF at all and needed a pixel-colour classification step to read.

`dark-web-monitoring` is the first source from a completely different vendor (Dark Web ID's monthly business report, not Datto RMM), proving the loader/dispatch mechanism above needed zero changes to onboard a second system -- only additive entries in `server.js`'s lookup tables plus one new `buildReportComponent()` branch. Its own JSON shape: `periodStart`/`periodEnd` instead of Datto's single `createDate` (normalised to a display range by `server.js`), `summary` (total compromises, the monitored IPs/emails/domains scope, and the per-category count+change breakdown), `benchmark` (this client's multiplier vs. the customer average), `monitoring` (last information-found date, and a Top 5 list per category), `organizationalCompromises` and `breaches` (both lists, empty on a clean month). **Caveat, worth knowing before trusting this on a "dirty" month:** the only real sample parsed so far (Kraftur, August 2026) was a clean month with zero compromises and zero breaches, so the row-extraction logic for `organizationalCompromises`, `breaches`, and the `top5ByCategory` lists is written against the structure Dark Web ID's own template clearly implies, not validated against an actual populated row. Worth a second look -- re-parse and spot-check against the source PDF by eye -- the first time a report comes through with a real finding in it.

`email-security` is INKY's own "Summary Report", the third vendor onboarded -- and the first whose source file isn't a bare report PDF at all: INKY emails the report as a PDF *attachment* on a report email, delivered to `Incoming/INKY/` as the raw `.msg` file (Outlook's own binary email format), not a `.pdf`. `ingest.js`'s own `extractMsgPdfAttachment()` opens that `.msg` as an OLE Compound File (via the `cfb` package -- the same container format `.xls` used, so no dedicated `.msg`-parsing library was needed) and pulls out the one attachment ending in `.pdf` (INKY's own emails also carry 1-2 small `.png` logo images inlined into the email body -- never the report -- which this deliberately ignores), then hands that PDF's extracted text to `parsers/email-security.js` exactly like every other source. Its own JSON shape: `overview` (messages processed, unique recipients, AAA detection count), `threatSummary` (Neutral/Caution/Danger counts), `topThreatCategories` (a variable-length list of `{label, count, pct}`), `messageReportSummary` (the same Neutral/Caution/Danger shape, this time for "messages reported"), `linkClickBreakdown` (the funnel from messages-with-links through to unsafe-links-followed). Confirmed against 4 real samples (Kraftur Pty Ltd, G and H Civil Contractors, SEQ Mortgage Brokers, Sleepys, all dated 26 Sep 2026) -- every one parsed cleanly, including clients with zero and non-zero Danger counts and category lists ranging from 3 to 15 rows, so the parser's own label-anchored (not page-anchored) approach has been exercised across genuinely different report shapes, not just one lucky sample. `email-security`'s own filename convention is also reversed from every PDF source: `<Client Name> - Email Security Report.msg`, client name FIRST -- see `ingest-title-map.js`'s own `resolveInkyClientAndKind()`.

**`sourceUrl`** (present on every file parsed from a real SharePoint source) is the webUrl of the original report PDF this component was parsed from, rendered by `client.js` as an "Original File" link at the bottom of each card. Points at wherever that file actually sits in SharePoint -- currently `Client Reports/Processed/<Client Name>/<date>/`, see "Where files come from" below.

## Where files come from, and how that's expected to change

**SharePoint layout** (`Client Reports` document library, site `General`):

```
Client Reports/
  Incoming/
    Datto RMM/          -- new report PDFs land here, one per client, un-parsed
    Dark Web ID/         -- same, for that source
    INKY/                -- INKY's own report EMAILS (.msg, not .pdf -- see above), one per client
    <future source>/     -- one subfolder per source system, by request -- lets whatever
                             eventually automates pickup (below) know which parser a file
                             needs just from which folder it's in, rather than guessing from
                             content/filename. A source whose own files cover ALL clients at
                             once (not yet built) is still just one file in its own Incoming
                             subfolder -- splitting it into per-client output is that
                             source's own parser's job, not a folder-structure concern.
  Processed/
    <Client Name>/
      <date>/             -- one subfolder per report run, keeping history (see above)
```

Right now: by hand, whenever a report PDF gets parsed -- dropped into the relevant `Incoming/<source>/` folder, parsed, the resulting JSON written into this `data/` folder (mirroring the structure above), and the source PDF moved into `Processed/<Client Name>/<date>/`. This is a known gap, not the intended end state -- the plan (not yet built) is a scheduled job that watches each `Incoming/<source>/` folder on its own, parses whatever shows up with that source's own parser, writes straight into this `data/` folder, and moves the source file into `Processed/` itself. If you're looking at this file and wondering why a report seems stale, that's almost certainly why.

**A gotcha worth watching for once a second source is involved:** the `site` field inside each file is whatever that report's own cover page calls the client, and different vendors aren't guaranteed to agree -- Dark Web ID's report literally says "Prepared for Kraftur", while Datto's own `siteName` for the same client is "Kraftur Pty Ltd". Since search matching is against this field, a mismatch here can make one source's card go missing for a search term that still finds the others. The `dark-web-monitoring` file for Kraftur was hand-aligned to "Kraftur Pty Ltd" to match its siblings rather than left as the PDF's own shorter name -- worth checking by hand each time a new non-Datto source is added for a client, until the eventual automated pickup job (above) can do that reconciliation itself.
