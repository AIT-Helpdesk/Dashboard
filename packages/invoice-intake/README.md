# @dashboard/invoice-intake

A scheduled, unattended job, now paired with a small read-only dashboard page (the **Invoice Intake Log**, added Oct 2026 by request). `ingest.js` watches the shared mailbox `Invoices-IN@ambientit.com.au`, pulls PDF/PNG/JPG/JPEG attachments off qualifying emails, reads each document, extracts supplier/customer/description/date, renames it, and uploads it into a SharePoint folder -- by request ("Invoice and receipt intake automation" brief, Oct 2026). No human handling between an email arriving and the file landing in SharePoint. The dashboard page just shows what happened -- it has no write path of its own into the mailbox or SharePoint.

Run it once by hand (`node packages/invoice-intake/ingest.js`) or on a 15-minute Windows Task Scheduler trigger in production -- see root `DEPLOYMENT.md`'s "Setting up the Invoice Intake automation" section for the real `Register-ScheduledTask` commands.

## Files

- `ingest.js` -- the orchestrator (`runIngest()`, exported for a manual re-run, plus a `require.main === module` CLI entry point). Lists qualifying messages from the mailbox's Inbox, filters/extracts/names/uploads each qualifying attachment, marks messages read and moves them to Inbox/Filed In SharePoint/Inbound-Claude (or, if there's no suitable attachment or it exhausts its retries, to Inbox/^NOT PROCESSED).
- `graph-mailbox-client.js` -- app-only Microsoft Graph access to the mailbox (list/download/mark-read/move, Mail.Read + Mail.ReadWrite application permissions).
- `sharepoint-client.js` -- app-only Microsoft Graph access to the destination SharePoint library (Sites.Selected application permission, scoped to just the one site).
- `extract.js` -- reads one attachment's content (text or vision path) and returns `{ supplier, customer, description, documentDate, documentDateConfident }` via a dedicated Azure OpenAI chat deployment. Also holds the email-body-as-invoice extraction path (`extractFromEmailBody()`) and an HTML-to-plain-text helper (`htmlToPlainText()`), both used only by the no-attachment fallback below.
- `email-pdf.js` -- `buildPdfFromEmailBody()`, a quick plain-text PDF (via `pdfkit`) of an email's own body -- used only when that email itself turns out to be the invoice/receipt (see below).
- `filename.js` -- pure, credential-free helpers: the date-fallback rule, filename building/sanitising, and dedupe-on-collision. Directly unit-testable with no live credentials (see "Testing" below).
- `invoice-intake-state.json` (gitignored, runtime state) -- `{ lastRunIso, messageRetryCounts }`, the "since last successful run" cursor and per-message consecutive-failure counter.
- `db.js` -- the Invoice Intake Log's own SQLite database (`data.db`, gitignored, same `node:sqlite`/WAL pattern as TC Elite Rollout/Workshop/Contract Checks). One `runs` row per `ingest.js` invocation, one `records` row per attachment outcome (`ok`/`fail`) or skipped message -- the durable "what happened" history the log page reads. Written exclusively by `ingest.js`; `server.js` only ever reads it.
- `server.js`/`client.js` -- the Invoice Intake Log dashboard page itself: two read-only endpoints (`/summary`, `/records?status=`) over `db.js`, and a client rendering stat tiles (last 24h/7 days/all-time worked/failed/skipped counts, last run) plus a filterable table of individual outcomes. 180-day retention (`db.js`'s `pruneOldRecords()`, called at the end of every run) -- the SharePoint uploads themselves are the real permanent record, this log is for recent troubleshooting/visibility, not an archive.

## Why two separate Entra app registrations, not one

Every integration on this dashboard that needs its own unattended Graph/API access gets its own app registration with the minimum permission it actually needs (CSP Customers, Teams Shifts, Report Ingest each have their own -- see root `.env.example`). This feature needs two genuinely different Graph capabilities -- reading/writing one mailbox, and writing one SharePoint site -- so it gets two separate app registrations rather than one app holding both permission sets, keeping each credential's blast radius to exactly the one thing it's for. Both are deliberately **separate from the dashboard's own sign-in app** (`AUTH_CLIENT_ID`) too, even though that app already uses Graph successfully for calendar entries (Voice Scheduler) -- a leaked secret for either of these new apps only ever grants unattended mailbox/SharePoint access, never sign-in for the whole dashboard.

## Why a vision model instead of a separate OCR engine

Scanned PDFs and phone-photo receipts (skewed, poorly lit, held in someone's hand) go through the same Azure OpenAI vision-capable chat deployment that does the structured extraction, in ONE call -- not a dedicated OCR library (Tesseract, etc.) followed by a second extraction pass. `pdf-parse` (already a dependency, proven elsewhere in this workspace via `packages/meeting-prep`) exposes `PDFParse.getScreenshot({ imageDataUrl: true })`, which rasterises a PDF page straight to a data URL with no new dependency at all -- confirmed live against a real sample PDF this session (text extraction and page-to-image rendering both worked). A vision model reading a genuinely messy photo directly tends to cope with skew/lighting better than classic OCR + a second text-only pass would, and it's one fewer moving part.

## No-attachment fallback: the email body itself as the invoice

By request (Oct 2026): some suppliers send the actual invoice/receipt as the email's own body (HTML or plain text), with nothing attached at all. Only when a message has no qualifying PDF/PNG/JPG/JPEG attachment, `ingest.js`'s `tryEmailBodyAsInvoice()` fetches the full body (`graph-mailbox-client.js`'s `getMessageBody()` -- not the truncated `bodyPreview` already on the message), strips it to plain text, and asks the extraction model to decide `isInvoice` before extracting anything -- the overwhelming majority of attachment-less mail (notifications, reply threads, marketing) is correctly `isInvoice: false` and falls straight through to the pre-existing skip/^NOT PROCESSED path, unchanged. Only a genuine `isInvoice: true` goes on to get filed: `email-pdf.js` renders a quick plain-text PDF of the body (subject, received date, then the text -- not a faithful re-rendering of the original HTML), which is then named/deduped/uploaded exactly like a real attachment would be. The log page's Attachment column shows the fixed label **"Used Email Body"** for these rows, so they stay visibly distinct from a real file attachment.

## Exclaimer invoices: "End User" as the customer

By request (Oct 2026): Exclaimer (an email signature management vendor) invoices typically list one or more "End User" entries -- a column/field naming the actual client a licence line is billed for -- rather than naming the real client as the bill-to party (which is almost always this MSP's own entity, not useful in the filename). `extract.js`'s shared extraction rules (used by both the normal attachment path and the email-body fallback above) tell the model: when the supplier is Exclaimer, read the End User value directly off the document and use it as `customer` instead of the billed-to company; if several End User lines appear on one document, use the first. This is handled entirely by the extraction prompt, not a hand-written Exclaimer-specific parser -- the model already reads the full document text/image either way, so it can locate the column regardless of exact layout.

## Web-link invoices (not yet built)

Raised Oct 2026: some suppliers send a "view your invoice" link instead of attaching the file or including it in the body. Deliberately not implemented yet -- real risk/reliability concerns rather than a simple fetch: most such links are session/SSO-protected vendor portals (a plain server-side GET has no login, so it'd typically hit a redirect-to-login page or a 403, not the invoice), some are tracking redirectors needing a real browser, and blindly following arbitrary links out of inbound email is an SSRF-ish risk worth scoping deliberately (e.g. an explicit allow-list of known supplier domains) rather than building in the abstract. Worth a second pass once there's a real example link from an actual supplier to test against.

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

- The exact SharePoint site/library resolution (see Phase A item 4 above) is unverified against the real tenant -- this is the single highest-risk assumption in this package and should be the very first thing checked once real credentials exist.
