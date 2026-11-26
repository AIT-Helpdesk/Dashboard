# @dashboard/vicyber-reports

Dashboard page: upload a ViCyber "scan_consolidated" vulnerability scan
export (xlsx) against a nominated Autotask Client, see a summary grouped by
device or by finding type, and compare any two of a Client's own past
uploads to see what's Fixed, New, or Still Open since the earlier one.

- `client.js` - frontend module: Client nominate (same free-text wildcard +
  "Exact Match" checkbox + Search convention `@dashboard/check-client`
  already uses), file upload, a Past Reports list (each row tickable for
  compare, max 2 at a time), and the report/compare viewer itself --
  category tabs (`.rmmf-tabs`/`.rmmf-tab`) plus a By Device/By Finding Type
  grouping toggle, collapsible groups (same `.resource-group-header--toggle`
  convention Check Client/Classification Summary already use), one
  expandable "Details" row per finding for its full Recommendation/CVE/etc.
  text.
- `server.js` - Express router: `/resolve-client` (identical shape to Check
  Client's own route), `/upload` (multer memory storage + `xlsx` parse),
  `/reports`, `/reports/:id`, `/compare`.
- `parse.js` - turns a real ViCyber workbook into normalized finding rows.
- `db.js` - `node:sqlite` persistence (`reports` + `findings`), same
  WAL/`CREATE TABLE IF NOT EXISTS` house style every other page's db.js
  already uses.
- `compare.js` - the Fixed/New/Still Open diff itself.

## Why the Client is nominated, never read from the file

ViCyber's own "Asset Owner" column is its own internal account name, which
can genuinely disagree with the real Autotask Client -- confirmed live
against a real sample export, where "Asset Owner" read "Fairway Capital"
throughout a report that was actually for "Flow Financial Planning". This
column is never read by `parse.js` at all; the Client a report belongs to
is always whichever one was explicitly resolved via the page's own Client
search before upload.

## The 4 sheets, confirmed live against a real export

A real ViCyber "scan_consolidated" workbook has 4 sheets, each a
genuinely different shape -- `parse.js` normalizes all of them down to the
same `{ device, severity, title, detectedDate, recommendation, details }`
row shape before anything is stored, so the rest of this package (storage,
summary, compare) never has to know which sheet a finding came from beyond
its own `category` tag.

- **Endpoint** - Asset Owner, Asset/IP, Severity, Vulnerability, Date
  Detected, CVE ID, Threat, Recommendation, Ref. `device` = Asset/IP
  (already combines IP + hostname, e.g. "192.168.88.46 - FC-TIM-LT").
- **WebApp** - Asset Owner, URL, Severity, Vulnerability, Date Detected,
  Threat, Impact, Recommendation. `device` = URL.
- **Network** - Asset Owner, Host, Port, Severity, Vulnerability, Date
  Detected, Description, Recommendation, Ref. `device` = `<Host>:<Port>` --
  the same Host on a different Port is a genuinely different finding, not a
  duplicate.
- **DarkWeb** - Asset Owner, Account, Severity, Password Exposed, Found
  Location, Date Of Leak, Recommendation. No real "finding type" column the
  way the other 3 have -- every row IS an exposed credential, so `title` is
  the fixed label "Exposed Credential" rather than read from the sheet;
  `device` = Account. A row with a blank "Password Exposed" (ViCyber's own
  "No leaks found" placeholder row, confirmed live) is skipped entirely, not
  stored as a finding.

`Severity` is the same LOW/MEDIUM/HIGH/VERY HIGH scale across all 3 of
Endpoint/WebApp/Network (confirmed live); DarkWeb's placeholder row uses
INFO, which is otherwise unused since real DarkWeb findings weren't
available to confirm their own severity values against.

`Recommendation` exists on all 4 sheets and is pulled into its own column;
everything else category-specific (CVE ID/Threat/Ref/Impact/Description/
Found Location) goes into a single `details` JSON column rather than a
sparse table of mostly-NULL columns.

## Comparison

Diffed on `category + device + title` -- the only stable identifying triple
a real ViCyber export has (there's no per-finding ID anywhere in the file).
`compare.js`'s `diffFindings(earlier, later)` returns `{ fixed, added,
stillOpen }`; `server.js`'s own `/compare` route decides which of the two
chosen reports is actually the earlier one by `uploaded_at`, regardless of
which order their ids were passed in -- the page lets a reader tick any two
of a Client's own past reports without having to think about which came
first.
