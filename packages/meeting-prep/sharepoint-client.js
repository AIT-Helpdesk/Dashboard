const axios = require('axios');

// Report Ingest's own Microsoft Graph plumbing -- same app-only client-
// credentials pattern as packages/teams-shifts/lib.js's getToken()/graphGet()
// (that file's own comment explains the 60s refresh-ahead caching), extended
// with the file operations this package's own ingest.js needs: list a
// folder, download a file's bytes, create a folder, move an item. This is a
// SEPARATE, dedicated Entra app registration from Teams Shifts/CSP
// Customers -- same "one app per integration, minimum permission it
// actually needs" convention .env.example already documents for those two
// (this one needs Sites.ReadWrite.All on the Client Reports library, not
// Group/Schedule/User Graph scopes).
//
// Env var names match what's actually in .env (set up directly in Azure
// Portal, not renamed to match this file) -- AZURE_REPORT_INGEST_VALUE is
// the app registration's client SECRET (Azure Portal's "Certificates &
// secrets" page confusingly shows both a "Secret ID" and a "Value" for the
// same secret; VALUE is the one Graph's token endpoint actually accepts).
// AZURE_REPORT_INGEST_SECRET (the Secret ID) is never read here -- it's not
// a credential, just Azure's own identifier for which secret entry this is,
// kept in .env for reference only.
const {
  AZURE_REPORT_INGEST_CLIENTID: CLIENT_ID,
  AZURE_REPORT_INGEST_VALUE: CLIENT_SECRET,
  AZURE_REPORT_INGEST_TENANT: TENANT_ID,
} = process.env;

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

// PUT with @microsoft.graph.conflictBehavior: 'fail' still returns the
// EXISTING item (200, not a real conflict) when a folder of that name is
// already there -- confirmed against the real Graph API this session, this
// is the documented idempotent-create shape (unlike a plain nested-path PUT,
// which errors if a middle segment is missing -- this creates the whole
// leaf folder directly under an already-resolved parent).
async function ensureChildFolder(token, driveId, parentItemId, folderName) {
  const res = await axios.post(
    `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${parentItemId}/children`,
    { name: folderName, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  ).catch((err) => {
    if (err.response?.status === 409) {
      // Real folder-already-exists conflict -- look it up instead of failing.
      return null;
    }
    throw err;
  });
  if (res) return res.data;
  const existing = await graphGet(token, `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${parentItemId}:/${encodeURIComponent(folderName)}`);
  return existing;
}

// Site "General" carries more than one real site sharing that search term
// (confirmed live -- a subsite "OnboardingTool" also matched a plain
// ?search=General query) -- filtered down to the exact top-level site by
// name, not just "first result", so this never silently resolves to the
// wrong site.
const SITE_NAME = 'General';
const LIBRARY_NAME = 'Client Reports';

let driveIdCache = null;
async function resolveDriveId() {
  if (driveIdCache) return driveIdCache;
  const token = await getToken();
  const sites = await graphGet(token, `https://graph.microsoft.com/v1.0/sites?search=${encodeURIComponent(SITE_NAME)}`);
  const site = sites.value.find((s) => s.name === SITE_NAME);
  if (!site) throw new Error(`Could not resolve SharePoint site "${SITE_NAME}".`);
  const drives = await graphGet(token, `https://graph.microsoft.com/v1.0/sites/${site.id}/drives?$select=id,name`);
  const drive = drives.value.find((d) => d.name === LIBRARY_NAME);
  if (!drive) throw new Error(`Could not resolve "${LIBRARY_NAME}" library on site "${SITE_NAME}".`);
  driveIdCache = drive.id;
  return driveIdCache;
}

// Root-relative path lookup (e.g. "Incoming/Datto RMM") -- Graph's own
// colon-path addressing, same shape confirmed live against the real
// Incoming/Processed folders this session.
async function getItemByPath(driveId, relativePath) {
  const token = await getToken();
  return graphGet(token, `https://graph.microsoft.com/v1.0/drives/${driveId}/root:/${relativePath.split('/').map(encodeURIComponent).join('/')}:`);
}

async function listFolderChildren(driveId, relativePath) {
  const token = await getToken();
  let url = `https://graph.microsoft.com/v1.0/drives/${driveId}/root:/${relativePath
    .split('/')
    .map(encodeURIComponent)
    .join('/')}:/children?$select=id,name,size,webUrl,file,folder&$top=200`;
  const all = [];
  while (url) {
    const data = await graphGet(token, url);
    all.push(...data.value);
    url = data['@odata.nextLink'] || null;
  }
  return all;
}

async function downloadFileContent(driveId, itemId) {
  const token = await getToken();
  return graphGetBinary(token, `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/content`);
}

// Creates every missing segment of a relative folder path (e.g.
// "Processed/Fairway Capital/2026-09-25"), one level at a time, idempotent
// at each level via ensureChildFolder() above -- a client/date combination
// that's never been processed before won't have either segment yet.
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

// Moves (and optionally renames) an item within the SAME drive -- a plain
// parentReference PATCH, confirmed the correct Graph shape for a same-drive
// move (no copy+delete dance needed, unlike the interactive SharePoint MCP
// connector's own flakier sharepoint_move_item noted elsewhere this
// session -- this is a direct, single Graph REST call).
async function moveItem(driveId, itemId, destinationFolderId, newName) {
  const token = await getToken();
  const body = { parentReference: { id: destinationFolderId } };
  if (newName) body.name = newName;
  return graphPatch(token, `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}`, body);
}

module.exports = {
  getToken,
  graphGet,
  resolveDriveId,
  getItemByPath,
  listFolderChildren,
  downloadFileContent,
  ensureFolderPath,
  moveItem,
};
