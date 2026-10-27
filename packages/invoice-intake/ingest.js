// Invoice/Receipt Intake -- watches the Inbox of the shared mailbox
// Invoices-IN@ambientit.com.au, pulls PDF/PNG/JPG/JPEG attachments off
// qualifying emails, extracts supplier/customer/description/date
// (extract.js), builds the fixed filename pattern (filename.js), and
// uploads into the SharePoint "For Entry - From Claude" folder -- by
// request ("Invoice and receipt intake automation" brief, Oct 2026). A
// successfully-filed message is moved to Inbox/Filed In SharePoint/
// Inbound-Claude; one with no suitable attachment (or that exhausts its
// retries) goes to Inbox/^NOT PROCESSED instead. Same runSync()-shaped job
// contract packages/meeting-prep/ingest.js and packages/contract-checks/
// sync.js already establish: `runIngest()` exported for a manual re-run,
// `node packages\invoice-intake\ingest.js` standalone for Task Scheduler
// (see DEPLOYMENT.md). Every attachment outcome (worked or failed) and
// every skipped message is also written to db.js's own data.db -- the
// package DOES now have a dashboard page (the Invoice Intake Log, added
// Oct 2026 by request), a read-only summary/log view over that same
// database; this file remains the only thing that ever writes to it.
//
// Loads the root .env itself, same as packages/contract-checks/sync.js --
// harmless when run inside the already-running shell server (which loads
// the same file at its own startup) and necessary when run standalone.
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });

const fs = require('fs');
const path = require('path');
const { isoDateAest } = require('@dashboard/autotask-client');

const mailbox = require('./graph-mailbox-client.js');
const sp = require('./sharepoint-client.js');
const { extractDocument, extractFromEmailBody, htmlToPlainText } = require('./extract.js');
const { resolveDocumentDate, buildFilename, dedupeFilename } = require('./filename.js');
const { buildPdfFromEmailBody } = require('./email-pdf.js');
const db = require('./db.js');

const STATE_PATH = path.join(__dirname, 'invoice-intake-state.json');

// Confirmed against the real site (Oct 2026) -- this exact folder already
// exists under Shared Documents/Supplier Docs/Invoices/For Bookkeeper/, as
// a sibling of "For Entry", "For Filing", "Remittances", etc. Files land
// flat in here -- no per-supplier subfolders, sorting happens later
// downstream (by request).
const DESTINATION_PATH = 'Supplier Docs/Invoices/For Bookkeeper/For Entry - From Claude';

const QUALIFYING_EXTENSIONS = new Set(['pdf', 'png', 'jpg', 'jpeg']);
// Filters out email-signature logos and tracking pixels, which are
// virtually always a few KB -- a real scanned invoice/receipt photo or PDF
// is reliably much larger than this even at low phone-camera quality.
const MIN_ATTACHMENT_BYTES = 15 * 1024;

// A message that keeps failing every attachment for this many consecutive
// runs is moved to Failed instead of retried forever -- still logged in
// detail each time before that point, so nothing fails silently.
const MAX_CONSECUTIVE_FAILURES = 5;

function loadState() {
  if (!fs.existsSync(STATE_PATH)) return { lastRunIso: new Date(0).toISOString(), messageRetryCounts: {} };
  return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
}
function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function extensionOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

// Shared by both filing paths below (a real attachment, or the email-body
// fallback) -- builds the filename, dedupes it against this run's own
// uploads so far, uploads the bytes, and returns the fields the caller
// writes to db.js. Required per the brief: still file it, under a clearly
// recognisable placeholder, rather than skip or block, whenever the model
// couldn't confidently read a supplier.
async function fileExtractedDocument({ extracted, receivedDateTime, buffer, contentType, ext, destFolderExistingNames, driveId }) {
  const receivedDateAestKey = isoDateAest(receivedDateTime);
  const date = resolveDocumentDate(extracted, receivedDateAestKey);
  const supplier = extracted.supplier || 'Unknown Supplier';

  const desiredName = buildFilename({ date, supplier, customer: extracted.customer, description: extracted.description, ext });
  const finalName = dedupeFilename(desiredName, destFolderExistingNames);

  await sp.uploadFile(driveId, DESTINATION_PATH, finalName, buffer, contentType);
  destFolderExistingNames.push(finalName); // keeps the dedupe check correct across several attachments/emails in the SAME run

  return { finalName, supplier, customer: extracted.customer || null, description: extracted.description || null, documentDate: date };
}

async function processAttachment({ message, attachment, destFolderExistingNames, driveId }) {
  const ext = extensionOf(attachment.name);
  const buffer = await mailbox.downloadAttachmentBytes(message.id, attachment.id);

  const extracted = await extractDocument({
    buffer,
    contentType: attachment.contentType,
    filename: attachment.name,
    emailSubject: message.subject,
    emailBodyPreview: message.bodyPreview,
  });

  return fileExtractedDocument({ extracted, receivedDateTime: message.receivedDateTime, buffer, contentType: attachment.contentType, ext, destFolderExistingNames, driveId });
}

// The attachment_name value this fallback writes to db.js/shows in the log
// page's Attachment column -- a fixed, recognisable label (by request, Oct
// 2026) rather than a real filename, since there never was one.
const EMAIL_BODY_ATTACHMENT_LABEL = 'Used Email Body';

// Only called for a message with NO qualifying attachment -- some suppliers
// send the actual invoice as the email body/HTML itself, by request (Oct
// 2026). Returns null (meaning "genuinely nothing to file, fall through to
// the normal skip path") whenever the body is empty, the body fetch fails,
// the extraction call itself fails, or the model decides this isn't
// actually an invoice -- deliberately swallowed here rather than treated as
// a retryable failure, since the overwhelming majority of attachment-less
// emails are not invoices at all and shouldn't get stuck retrying forever.
async function tryEmailBodyAsInvoice(message) {
  let body;
  try {
    body = await mailbox.getMessageBody(message.id);
  } catch (err) {
    console.error(`[warn] "${message.subject}" -- could not fetch email body for the no-attachment fallback: ${err.message}`);
    return null;
  }
  const bodyText = body?.contentType === 'html' ? htmlToPlainText(body.content) : body?.content || '';
  if (!bodyText.trim()) return null;

  let extracted;
  try {
    extracted = await extractFromEmailBody({ bodyText, emailSubject: message.subject });
  } catch (err) {
    console.error(`[warn] "${message.subject}" -- email-body invoice check failed: ${err.message}`);
    return null;
  }
  if (!extracted.isInvoice) return null;
  return { extracted, bodyText };
}

async function processEmailBodyAsInvoice({ message, extracted, bodyText, destFolderExistingNames, driveId }) {
  const buffer = await buildPdfFromEmailBody({ subject: message.subject, receivedDateTime: message.receivedDateTime, bodyText });
  return fileExtractedDocument({ extracted, receivedDateTime: message.receivedDateTime, buffer, contentType: 'application/pdf', ext: 'pdf', destFolderExistingNames, driveId });
}

// Shared retry bookkeeping -- identical rule for an attachment failure and
// an email-body-fallback failure: leave the message unread for retry, but
// give up (move to ^NOT PROCESSED) after MAX_CONSECUTIVE_FAILURES straight
// failures. Returns true when the caller should move the message to
// notProcessedFolderId and clear its retry counter.
function bumpRetryCount(state, message) {
  const retryCount = (state.messageRetryCounts[message.id] || 0) + 1;
  state.messageRetryCounts[message.id] = retryCount;
  if (retryCount >= MAX_CONSECUTIVE_FAILURES) {
    console.error(`[fail] "${message.subject}" -- giving up after ${retryCount} consecutive failures, moving to ^NOT PROCESSED`);
    delete state.messageRetryCounts[message.id];
    return true;
  }
  return false;
}

async function runIngest() {
  if (!mailbox.mailboxIntakeConfigured()) throw new Error('Invoice Intake mailbox access is not configured -- see .env.example (AZURE_INVOICE_INTAKE_*).');
  if (!sp.sharepointIntakeConfigured()) throw new Error('Invoice Intake SharePoint access is not configured -- see .env.example (AZURE_INVOICE_INTAKE_SP_*).');

  const state = loadState();
  const runStartedAt = new Date().toISOString();
  const runId = db.startRun();

  const driveId = await sp.resolveDriveId();
  await sp.ensureFolderPath(driveId, DESTINATION_PATH);
  const destFolderExistingNames = (await sp.listFolderChildren(driveId, DESTINATION_PATH)).map((f) => f.name);

  // Both inside Inbox, not mailbox-root-level siblings of it -- by request.
  // "Filed In SharePoint/Inbound-Claude" for anything successfully uploaded;
  // "^NOT PROCESSED" for a message with no suitable attachment, and also
  // (no separate folder was specified for this) for a message that exhausted
  // MAX_CONSECUTIVE_FAILURES below -- both are "we didn't file this" outcomes.
  const filedFolderId = await mailbox.ensureMailFolderPath(['Filed In SharePoint', 'Inbound-Claude']);
  const notProcessedFolderId = await mailbox.ensureMailFolderPath(['^NOT PROCESSED']);

  const messages = await mailbox.listQualifyingMessages(state.lastRunIso);

  // Closes a real gap confirmed in production (Oct 2026): a message that
  // FAILED last run is only retried while it stays unread AND its
  // receivedDateTime is still after the cursor -- both of which stop
  // holding the moment it gets marked read by anything else (a human
  // opening the shared mailbox) once the cursor has since moved past its
  // arrival time, which it always has by the next run. That silently
  // drops it from listQualifyingMessages() above forever -- never
  // retried again, never escalated to ^NOT PROCESSED either, with no
  // further trace in the log. state.messageRetryCounts already tracks
  // exactly which messages are mid-retry; explicitly re-fetching by id
  // anything in there that the query above didn't already return
  // guarantees a failed message keeps being retried regardless of read
  // state, until it succeeds or hits MAX_CONSECUTIVE_FAILURES below. A
  // 404 (getMessage() returns null) means it was moved/deleted by
  // something else since -- nothing left to retry, so its counter is
  // just dropped rather than treated as another failure.
  const alreadyQueued = new Set(messages.map((m) => m.id));
  for (const retryId of Object.keys(state.messageRetryCounts)) {
    if (alreadyQueued.has(retryId)) continue;
    const stuck = await mailbox.getMessage(retryId);
    if (stuck) {
      messages.push(stuck);
    } else {
      delete state.messageRetryCounts[retryId];
    }
  }

  let processedCount = 0;
  let skippedNoAttachmentCount = 0;
  let filesWrittenCount = 0;
  const failures = []; // { subject, reason }

  for (const message of messages) {
    const attachments = message.hasAttachments ? await mailbox.listAttachments(message.id) : [];
    const qualifying = attachments.filter(
      (a) => !a.isInline && QUALIFYING_EXTENSIONS.has(extensionOf(a.name)) && (a.size || 0) >= MIN_ATTACHMENT_BYTES
    );

    if (qualifying.length === 0) {
      // Before giving up: some suppliers send the actual invoice/receipt as
      // the email body itself, with nothing attached -- by request (Oct
      // 2026). tryEmailBodyAsInvoice() returns null for the overwhelming
      // majority of attachment-less mail (not an invoice at all), which
      // falls straight through to the pre-existing skip/^NOT PROCESSED path
      // below, unchanged.
      const emailBodyAttempt = await tryEmailBodyAsInvoice(message);
      if (!emailBodyAttempt) {
        // Inline-body invoice with no real attachment, or only non-matching
        // attachments (e.g. a tiny logo) -- log and move on, never error,
        // per the brief ("log it and skip, do not crash").
        console.log(`[skip] "${message.subject}" -- no qualifying PDF/PNG/JPG/JPEG attachment`);
        skippedNoAttachmentCount++;
        db.recordOutcome(runId, {
          messageId: message.id,
          emailSubject: message.subject,
          status: 'skipped',
          reason: 'No qualifying PDF/PNG/JPG/JPEG attachment',
        });
        await mailbox.markRead(message.id);
        await mailbox.moveMessage(message.id, notProcessedFolderId);
        continue;
      }

      try {
        const result = await processEmailBodyAsInvoice({
          message,
          extracted: emailBodyAttempt.extracted,
          bodyText: emailBodyAttempt.bodyText,
          destFolderExistingNames,
          driveId,
        });
        console.log(`[ok] "${message.subject}" -- email body -> "${result.finalName}"`);
        filesWrittenCount++;
        db.recordOutcome(runId, {
          messageId: message.id,
          emailSubject: message.subject,
          attachmentName: EMAIL_BODY_ATTACHMENT_LABEL,
          status: 'ok',
          finalFilename: result.finalName,
          supplier: result.supplier,
          customer: result.customer,
          description: result.description,
          documentDate: result.documentDate,
        });
        await mailbox.markRead(message.id);
        await mailbox.moveMessage(message.id, filedFolderId);
        delete state.messageRetryCounts[message.id];
        processedCount++;
      } catch (err) {
        const reason = err.response?.data?.error?.message || err.message;
        console.error(`[fail] "${message.subject}" -- ${reason}`);
        failures.push({ subject: message.subject, reason });
        db.recordOutcome(runId, {
          messageId: message.id,
          emailSubject: message.subject,
          attachmentName: EMAIL_BODY_ATTACHMENT_LABEL,
          status: 'fail',
          reason,
        });
        if (bumpRetryCount(state, message)) {
          await mailbox.moveMessage(message.id, notProcessedFolderId).catch(() => {});
        }
        // Left unread either way -- picked up again next run unless it was just moved to ^NOT PROCESSED above.
      }
      continue;
    }

    try {
      for (const attachment of qualifying) {
        try {
          const result = await processAttachment({ message, attachment, destFolderExistingNames, driveId });
          console.log(`[ok] "${message.subject}" -- ${attachment.name} -> "${result.finalName}"`);
          filesWrittenCount++;
          db.recordOutcome(runId, {
            messageId: message.id,
            emailSubject: message.subject,
            attachmentName: attachment.name,
            status: 'ok',
            finalFilename: result.finalName,
            supplier: result.supplier,
            customer: result.customer,
            description: result.description,
            documentDate: result.documentDate,
          });
        } catch (attachmentErr) {
          // Recorded per-attachment (which file, not just which message)
          // before rethrowing -- the outer catch below still owns the
          // existing retry/move bookkeeping unchanged, this just also
          // leaves a row for the log page to show.
          db.recordOutcome(runId, {
            messageId: message.id,
            emailSubject: message.subject,
            attachmentName: attachment.name,
            status: 'fail',
            reason: attachmentErr.response?.data?.error?.message || attachmentErr.message,
          });
          throw attachmentErr;
        }
      }
      await mailbox.markRead(message.id);
      await mailbox.moveMessage(message.id, filedFolderId);
      delete state.messageRetryCounts[message.id];
      processedCount++;
    } catch (err) {
      const reason = err.response?.data?.error?.message || err.message;
      console.error(`[fail] "${message.subject}" -- ${reason}`);
      failures.push({ subject: message.subject, reason });
      if (bumpRetryCount(state, message)) {
        await mailbox.moveMessage(message.id, notProcessedFolderId).catch(() => {});
      }
      // Left unread either way -- picked up again next run unless it was just moved to ^NOT PROCESSED above.
    }
  }

  state.lastRunIso = runStartedAt;
  saveState(state);

  const message = `Processed ${processedCount} message(s), ${filesWrittenCount} file(s) written, ${skippedNoAttachmentCount} skipped (no attachment), ${failures.length} failed.`;
  console.log(message);
  db.finishRun(runId, {
    ok: failures.length === 0,
    message,
    processedCount,
    filesWrittenCount,
    skippedCount: skippedNoAttachmentCount,
    failedCount: failures.length,
  });
  db.pruneOldRecords();
  return { ok: failures.length === 0, processedCount, filesWrittenCount, skippedNoAttachmentCount, failures, message };
}

module.exports = { runIngest };

if (require.main === module) {
  runIngest()
    .then((result) => process.exit(result.ok ? 0 : 1))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
