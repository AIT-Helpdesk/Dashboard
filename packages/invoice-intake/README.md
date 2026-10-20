# @dashboard/invoice-intake

A scheduled, unattended job -- **not a dashboard page** (no `dashboardPage` key in `package.json`, same shape as `@dashboard/strety-autotask-sync`). Watches the shared mailbox `Invoices-IN@ambientit.com.au`, pulls PDF/PNG/JPG/JPEG attachments off qualifying emails, reads each document, extracts supplier/customer/description/date, renames it, and uploads it into a SharePoint folder -- by request ("Invoice and receipt intake automation" brief, Oct 2026). No human handling between an email arriving and the file landing in SharePoint.

Run it once by hand (`node packages/invoice-intake/ingest.js`) or on a 15-minute Windows Task Scheduler trigger in production -- see root `DEPLOYMENT.md`'s "Setting up the Invoice Intake automation" section for the real `Register-ScheduledTask` commands.

## Files

- `ingest.js` -- the orchestrator (`runIngest()`, exported for a manual re-run, plus a `require.main === module` CLI entry point). Lists qualifying messages from the mailbox's Inbox, filters/extracts/names/uploads each qualifying attachment, marks messages read and moves them to Inbox/Filed In SharePoint/Inbound-Claude (or, if there's no suitable attachment or it exhausts its retries, to Inbox/^NOT PROCESSED).
- `graph-mailbox-client.js` -- app-only Microsoft Graph access to the mailbox (list/download/mark-read/move, Mail.Read + Mail.ReadWrite application permissions).
- `sharepoint-client.js` -- app-only Microsoft Graph access to the destination SharePoint library (Sites.Selected application permission, scoped to just the one site).
- `extract.js` -- reads one attachment's content (text or vision path) and returns `{ supplier, customer, description, documentDate, documentDateConfident }` via a dedicated Azure OpenAI chat deployment.
- `filename.js` -- pure, credential-free helpers: the date-fallback rule, filename building/sanitising, and dedupe-on-collision. Directly unit-testable with no live credentials (see "Testing" below).
- `invoice-intake-state.json` (gitignored, runtime state) -- `{ lastRunIso, messageRetryCounts }`, the "since last successful run" cursor and per-message consecutive-failure counter.

## Why two separate Entra app registrations, not one

Every integration on this dashboard that needs its own unattended Graph/API access gets its own app registration with the minimum permission it actually needs (CSP Customers, Teams Shifts, Report Ingest each have their own -- see root `.env.example`). This feature needs two genuinely different Graph capabilities -- reading/writing one mailbox, and writing one SharePoint site -- so it gets two separate app registrations rather than one app holding both permission sets, keeping each credential's blast radius to exactly the one thing it's for. Both are deliberately **separate from the dashboard's own sign-in app** (`AUTH_CLIENT_ID`) too, even though that app already uses Graph successfully for calendar entries (Voice Scheduler) -- a leaked secret for either of these new apps only ever grants unattended mailbox/SharePoint access, never sign-in for the whole dashboard.

## Why a vision model instead of a separate OCR engine

Scanned PDFs and phone-photo receipts (skewed, poorly lit, held in someone's hand) go through the same Azure OpenAI vision-capable chat deployment that does the structured extraction, in ONE call -- not a dedicated OCR library (Tesseract, etc.) followed by a second extraction pass. `pdf-parse` (already a dependency, proven elsewhere in this workspace via `packages/meeting-prep`) exposes `PDFParse.getScreenshot({ imageDataUrl: true })`, which rasterises a PDF page straight to a data URL with no new dependency at all -- confirmed live against a real sample PDF this session (text extraction and page-to-image rendering both worked). A vision model reading a genuinely messy photo directly tends to cope with skew/lighting better than classic OCR + a second text-only pass would, and it's one fewer moving part.

## The date rule (the brief's own flagged assumption)

Use the invoice/receipt date actually printed on the document when the model reports it confidently (`documentDateConfident: true`); otherwise fall back to the AEST calendar date the email itself was received on. The fallback decision happens in code (`filename.js`'s `resolveDocumentDate()`), not inside the model's own output, so it's never silently wrong from an overconfident guess.

## Own dedicated Azure OpenAI resource

Same reasoning as `packages/report`'s own resource (client device/patch data gets its own content-filter + Modified Abuse Monitoring application, not reused from Voice Scheduler's resource): invoices and receipts carry real supplier and financial detail, so extraction gets its own resource (`AZURE_OPENAI_INVOICE_*`) too.

## Phase A -- infra to confirm before this works for real

Not code this package can run itself -- a checklist for the Azure/Exchange admin side:

1. A new Entra app registration for the mailbox, with `Mail.Read` + `Mail.ReadWrite` **application** permissions, admin-consented, and an Exchange Online **Application Access Policy** (`New-ApplicationAccessPolicy`) scoping it to exactly `Invoices-IN@ambientit.com.au` -- not every mailbox in the tenant.
2. A second new Entra app registration for SharePoint, with `Sites.Selected` **application** permission, then a Graph site-permission grant (`POST /sites/{site-id}/permissions`) scoping it to write access on just the target site.
3. A new, dedicated Azure OpenAI resource with a vision-capable chat deployment (e.g. `gpt-4o-mini`), ideally with Modified Abuse Monitoring applied.
4. **Confirm the exact SharePoint site + library** before trusting `sharepoint-client.js`'s `SITE_NAME`/`LIBRARY_NAME` constants (both currently `'General'`) -- `meeting-prep/sharepoint-client.js` already hit a real collision once where a plain site-name search matched more than one real site. Resolve this with one real Graph query against the tenant and adjust those two constants (or add a `webUrl` filter alongside the name match) if it doesn't resolve cleanly to one site.
5. Hand over the real values for every env var below.

## Environment variables

See the `AZURE_INVOICE_INTAKE_*` / `AZURE_INVOICE_INTAKE_SP_*` / `AZURE_OPENAI_INVOICE_*` / `INVOICE_INTAKE_MAILBOX` block in the root `.env.example`.

## Testing

`filename.js`'s functions need no credentials at all -- e.g.:

```js
const { buildFilename, dedupeFilename, resolveDocumentDate } = require('./filename.js');
buildFilename({ date: '2026-10-20', supplier: 'Acme Plumbing', customer: 'Smith Construction', description: 'Hot water repair', ext: 'pdf' });
// "2026-10-20, Acme Plumbing, Smith Construction, Hot water repair.pdf"
```

`extract.js`'s `extractPdfText()`/`renderPdfPagesToDataUrls()` need no credentials either (confirmed against a real sample PDF this session) -- only the actual `extractDocument()` chat call needs `AZURE_OPENAI_INVOICE_*` configured. Before trusting the full flow end to end, run through the spread of real samples the brief calls for: a clean text PDF, a scanned/image-only PDF, a phone-photo PNG/JPEG, and an email with several attachments.

## Not yet built / open items

- A UI/status surface -- deliberately out of scope, per the brief (a script + a log file, not a page). `logs/invoice-intake.log` (Task Scheduler's own stdout/stderr redirect, same convention as every other scheduled job here) is the troubleshooting surface.
- The exact SharePoint site/library resolution (see Phase A item 4 above) is unverified against the real tenant -- this is the single highest-risk assumption in this package and should be the very first thing checked once real credentials exist.
