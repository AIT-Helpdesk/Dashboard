const axios = require('axios');

// App-only Microsoft Graph client for ONE shared mailbox (Invoices-IN@
// ambientit.com.au) -- same token-cache shape as packages/teams-shifts/
// lib.js's own getToken() (60s refresh-ahead), but a SEPARATE Entra app
// registration/credentials from every other integration here (Mail.Read +
// Mail.ReadWrite application permissions, admin-consented, scoped to just
// this one mailbox via an Exchange Online Application Access Policy -- see
// packages/invoice-intake/README.md "Phase A"). Env var names match the
// AZURE_REPORT_INGEST_* convention in .env.example: *_VALUE is the app
// registration's client secret VALUE (not the Secret ID, which Azure
// Portal also shows but Graph's token endpoint rejects).
const {
  AZURE_INVOICE_INTAKE_CLIENTID: CLIENT_ID,
  AZURE_INVOICE_INTAKE_VALUE: CLIENT_SECRET,
  AZURE_INVOICE_INTAKE_TENANT: TENANT_ID,
  INVOICE_INTAKE_MAILBOX: MAILBOX,
} = process.env;

function mailboxIntakeConfigured() {
  return !!(CLIENT_ID && CLIENT_SECRET && TENANT_ID && MAILBOX);
}

let tokenCache = null; // { token, expiresAt }
async function getToken() {
  if (tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  const res = await axios.post(
    `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
    new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default',
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  tokenCache = { token: res.data.access_token, expiresAt: Date.now() + (res.data.expires_in - 60) * 1000 };
  return tokenCache.token;
}

async function graphGet(token, url) {
  const res = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
  return res.data;
}

async function graphGetBinary(token, url) {
  const res = await axios.get(url, { headers: { Authorization: `Bearer ${token}` }, responseType: 'arraybuffer' });
  return Buffer.from(res.data);
}

async function graphPatch(token, url, body) {
  const res = await axios.patch(url, body, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
  return res.data;
}

async function graphPost(token, url, body) {
  const res = await axios.post(url, body, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
  return res.data;
}

// "Unprocessed" = still unread, OR arrived since the last successful run --
// the OR covers a message whose isRead flag got touched some other way
// (someone opens the shared mailbox directly) without this job losing track
// of it. $select keeps the per-message payload small; attachments are
// fetched separately per-message below (listing attachments inline on every
// page would bloat the list response for messages this job skips anyway).
async function listQualifyingMessages(sinceIso) {
  const token = await getToken();
  const filter = `(isRead eq false) or (receivedDateTime gt ${sinceIso})`;
  let url =
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAILBOX)}/mailFolders/inbox/messages` +
    `?$filter=${encodeURIComponent(filter)}` +
    `&$select=id,subject,bodyPreview,receivedDateTime,hasAttachments&$top=50`;
  const all = [];
  while (url) {
    const data = await graphGet(token, url);
    all.push(...data.value);
    url = data['@odata.nextLink'] || null;
  }
  return all;
}

async function listAttachments(messageId) {
  const token = await getToken();
  let url =
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAILBOX)}/messages/${messageId}/attachments` +
    `?$select=id,name,contentType,size,isInline&$top=50`;
  const all = [];
  while (url) {
    const data = await graphGet(token, url);
    all.push(...data.value);
    url = data['@odata.nextLink'] || null;
  }
  return all;
}

// File attachments come back with their bytes base64-encoded in
// contentBytes directly on the attachment resource (confirmed Graph's own
// documented shape for fileAttachment) -- no separate /$value download
// needed, unlike a drive item's content. Deliberately NO $select here --
// confirmed live (Oct 2026): ?$select=contentBytes 400s ("Could not find a
// property named 'contentBytes' on type 'microsoft.graph.attachment'",
// since $select validates against the BASE type's declared schema, which
// doesn't include contentBytes), and the documented microsoft.graph.
// fileAttachment type-cast segment that normally works around that for
// drive items 404s here instead ("Resource not found for the segment
// 'Microsoft.OutlookServices.FileAttachment'") -- unreliable against the
// mail API. A plain GET with no $select avoids both: the response still
// serializes as the real underlying fileAttachment, contentBytes included.
async function downloadAttachmentBytes(messageId, attachmentId) {
  const token = await getToken();
  const data = await graphGet(
    token,
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAILBOX)}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`
  );
  return Buffer.from(data.contentBytes, 'base64');
}

async function markRead(messageId) {
  const token = await getToken();
  await graphPatch(token, `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAILBOX)}/messages/${messageId}`, { isRead: true });
}

// Idempotent create-or-find, same per-segment shape as
// meeting-prep/sharepoint-client.js's ensureFolderPath() -- but mail
// folders, not drive folders, and always resolved UNDER Inbox (Graph's
// well-known "inbox" id as the root), not as mailbox-root-level siblings of
// Inbox -- by request, since the real destinations are "Inbox/Filed In
// SharePoint/Inbound-Claude" and "Inbox/^NOT PROCESSED", both inside Inbox.
let folderIdCache = { inbox: 'inbox' }; // "inbox" or "inbox/<segment>/<segment>..." -> id
async function ensureMailFolderPath(pathSegments) {
  const token = await getToken();
  let parentId = 'inbox';
  let cacheKey = 'inbox';
  for (const segment of pathSegments) {
    cacheKey += `/${segment}`;
    if (folderIdCache[cacheKey]) {
      parentId = folderIdCache[cacheKey];
      continue;
    }
    const existing = await graphGet(
      token,
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAILBOX)}/mailFolders/${parentId}/childFolders` +
        `?$filter=${encodeURIComponent(`displayName eq '${segment.replace(/'/g, "''")}'`)}`
    );
    let id = existing.value?.[0]?.id;
    if (!id) {
      const created = await graphPost(
        token,
        `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAILBOX)}/mailFolders/${parentId}/childFolders`,
        { displayName: segment }
      );
      id = created.id;
    }
    folderIdCache[cacheKey] = id;
    parentId = id;
  }
  return parentId;
}

async function moveMessage(messageId, destinationFolderId) {
  const token = await getToken();
  await graphPost(token, `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAILBOX)}/messages/${messageId}/move`, {
    destinationId: destinationFolderId,
  });
}

module.exports = {
  mailboxIntakeConfigured,
  listQualifyingMessages,
  listAttachments,
  downloadAttachmentBytes,
  markRead,
  ensureMailFolderPath,
  moveMessage,
};
