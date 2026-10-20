const axios = require('axios');

// Invoice Intake's own Microsoft Graph SharePoint plumbing -- same app-only
// client-credentials shape as packages/meeting-prep/sharepoint-client.js
// (getToken/resolveDriveId/ensureFolderPath/listFolderChildren copied near
// verbatim), but a SEPARATE Entra app registration/credentials (Sites.Selected
// application permission, granted on just the one target site via Graph's
// own site-permission grant -- see README.md "Phase A" -- not Report
// Ingest's Sites.ReadWrite.All). Env var names match the AZURE_REPORT_INGEST_*
// convention: *_VALUE is the client secret VALUE (not the Secret ID).
const {
  AZURE_INVOICE_INTAKE_SP_CLIENTID: CLIENT_ID,
  AZURE_INVOICE_INTAKE_SP_VALUE: CLIENT_SECRET,
  AZURE_INVOICE_INTAKE_SP_TENANT: TENANT_ID,
  AZURE_INVOICE_INTAKE_SP_SITE_ID: SITE_ID,
} = process.env;

function sharepointIntakeConfigured() {
  return !!(CLIENT_ID && CLIENT_SECRET && TENANT_ID && SITE_ID);
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

async function ensureChildFolder(token, driveId, parentItemId, folderName) {
  const res = await axios
    .post(
      `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${parentItemId}/children`,
      { name: folderName, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    )
    .catch((err) => {
      if (err.response?.status === 409) return null; // real folder-already-exists conflict -- look it up instead of failing
      throw err;
    });
  if (res) return res.data;
  const existing = await graphGet(token, `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${parentItemId}:/${encodeURIComponent(folderName)}`);
  return existing;
}

// A plain ?search=General site lookup is NOT reliable -- confirmed against
// the real tenant (Oct 2026): it matches folders/pages elsewhere that merely
// happen to be named "General" too (e.g. a "Teams Wiki Data/General" folder
// on a totally different site), the same false-positive-collision shape
// meeting-prep/sharepoint-client.js hit before. So this addresses the site
// directly by its already-resolved Graph site id (AZURE_INVOICE_INTAKE_SP_SITE_ID,
// resolved once via Graph Explorer: GET /sites/ambientitptyltd.sharepoint.com:/sites/General)
// instead of searching by name at runtime. LIBRARY_NAME is "Documents" --
// confirmed against the real site's drives: the default document library
// displays as "Shared Documents" in the UI/webUrl, but its Graph API `name`
// is just "Documents" (a standard SharePoint quirk). This is the library
// Supplier Docs/Invoices/... already lives in, not a library literally
// named "General".
const LIBRARY_NAME = 'Documents';

let driveIdCache = null;
async function resolveDriveId() {
  if (driveIdCache) return driveIdCache;
  const token = await getToken();
  const drives = await graphGet(token, `https://graph.microsoft.com/v1.0/sites/${SITE_ID}/drives?$select=id,name`);
  const drive = drives.value.find((d) => d.name === LIBRARY_NAME);
  if (!drive) throw new Error(`Could not resolve "${LIBRARY_NAME}" library on site id "${SITE_ID}".`);
  driveIdCache = drive.id;
  return driveIdCache;
}

async function listFolderChildren(driveId, relativePath) {
  const token = await getToken();
  let url = `https://graph.microsoft.com/v1.0/drives/${driveId}/root:/${relativePath
    .split('/')
    .map(encodeURIComponent)
    .join('/')}:/children?$select=id,name,size,webUrl&$top=200`;
  const all = [];
  while (url) {
    const data = await graphGet(token, url);
    all.push(...data.value);
    url = data['@odata.nextLink'] || null;
  }
  return all;
}

async function ensureFolderPath(driveId, relativePath) {
  const token = await getToken();
  const rootItem = await graphGet(token, `https://graph.microsoft.com/v1.0/drives/${driveId}/root`);
  let parentId = rootItem.id;
  for (const segment of relativePath.split('/').filter(Boolean)) {
    const folder = await ensureChildFolder(token, driveId, parentId, segment);
    parentId = folder.id;
  }
  return parentId;
}

// Simple-upload PUT -- fine for invoices/receipts, comfortably under
// Graph's 4MB simple-upload ceiling (a resumable upload session is only
// needed above that). '@microsoft.graph.conflictBehavior' isn't set here
// because filename.js's dedupeFilename() has already guaranteed this exact
// name doesn't exist in the destination before this is called -- a plain
// PUT-by-path creates it fresh.
async function uploadFile(driveId, folderRelativePath, filename, buffer, contentType) {
  const token = await getToken();
  const path = `${folderRelativePath}/${filename}`.split('/').map(encodeURIComponent).join('/');
  const res = await axios.put(`https://graph.microsoft.com/v1.0/drives/${driveId}/root:/${path}:/content`, buffer, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType || 'application/octet-stream' },
    maxBodyLength: Infinity,
  });
  return res.data;
}

module.exports = {
  sharepointIntakeConfigured,
  resolveDriveId,
  listFolderChildren,
  ensureFolderPath,
  uploadFile,
};
