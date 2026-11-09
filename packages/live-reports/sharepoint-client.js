// Reads 2 live tables off the company intranet, by request -- the
// Cybersecurity Services table (Business-Security-Essentials.aspx, fills
// the Cybersecurity Systems descriptions panel, with a green tick for
// whichever of those services this specific client actually has) and the
// Proactive Maintenance Jobs table (PC Security Settings Applied...aspx,
// fills server.js's own getProactiveMaintenanceItems() -- "do this now
// like we do for the Cybersecurity Systems descriptions"), replacing that
// file's old hand-transcribed default list the same way the Cybersecurity
// one already replaced CYBERSECURITY_EXPLANATIONS (pdf-template.js). Both
// tables share a "Show"-ish column (admin-added on the SharePoint page
// itself, Y/N) controlling which rows even show up here at all -- exact
// header spelling differs per table ("Show" vs "Show**"), left to each
// caller to read off `raw` rather than normalized here.
//
// Same app-only client-credentials pattern as
// packages/meeting-prep/sharepoint-client.js's own getToken() (that
// file's comment explains the 60s refresh-ahead caching) -- copied here
// rather than imported, same "each package keeps its own small copy, no
// shared sharepoint-client package yet" convention
// packages/invoice-intake/sharepoint-client.js already follows too.
//
// Env vars match what's actually in .env (set up directly in Azure
// Portal) -- AZURE_REPORT_INGEST_VALUE is the app registration's client
// SECRET (Azure Portal's "Certificates & secrets" page confusingly shows
// both a "Secret ID" and a "Value" for the same secret; VALUE is the one
// Graph's token endpoint actually accepts). AZURE_REPORT_INGEST_SECRET
// (the Secret ID) is never read here -- not a credential, just Azure's
// own identifier for which secret entry this is. Tenant is
// AZURE_TENANT_AMBIENTIT specifically, by request (not
// AZURE_REPORT_INGEST_TENANT -- the same tenant in practice, just the one
// actually asked for).
const axios = require('axios');

const {
  AZURE_REPORT_INGEST_CLIENTID: CLIENT_ID,
  AZURE_REPORT_INGEST_VALUE: CLIENT_SECRET,
  AZURE_TENANT_AMBIENTIT: TENANT_ID,
  SHAREPOINT_SITE_ID: SITE_ID,
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

// Page addressing by filename directly into the sitePage cast+$expand
// combo 400s ("list ID must be a Guid"), confirmed live -- the real page
// GUID has to come from the plain pages listing first.
async function resolvePageId(token, pageName) {
  let url = `https://graph.microsoft.com/v1.0/sites/${SITE_ID}/pages?$top=50&$select=id,name`;
  while (url) {
    const list = await graphGet(token, url);
    const match = list.value.find((p) => p.name === pageName);
    if (match) return match.id;
    url = list['@odata.nextLink'] || null;
  }
  throw new Error(`Could not find "${pageName}" in the intranet site's pages.`);
}

// Strips a table cell's own rich HTML (bold spans, <br>, nested <p>/
// <span>, &nbsp;) down to plain text -- good enough for this one table's
// own simple cell shapes, not a general HTML-to-text converter.
function cellText(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

// Splits a "Security Product/Service" cell's own "Name\n(description)"
// shape (that's what cellText() above leaves once tags are stripped) into
// the 2 pieces the old hardcoded CYBERSECURITY_EXPLANATIONS list already
// carried separately.
function splitServiceCell(text) {
  const match = text.match(/^(.*?)\n?\(([\s\S]*)\)\s*$/);
  if (!match) return { name: text.trim(), description: '' };
  return { name: match[1].trim().replace(/\s+$/, ''), description: match[2].trim() };
}

// There's exactly one <table> on the given page immediately after its own
// tableTitle heading (confirmed live for both tables this file reads) --
// a plain indexOf + first-table-after-it is enough for these 2 known
// pages, no real HTML parser needed. The "Name\n(description)" split
// column is always the table's own FIRST column in both -- "Security
// Product/Service" for the Cybersecurity table, "Scheduled Job" for
// Proactive Maintenance Jobs -- so headers[0] is used directly rather
// than matching on a column name that differs per table.
function parseTable(pageHtml, tableTitle) {
  const titleIdx = pageHtml.indexOf(tableTitle);
  if (titleIdx === -1) throw new Error(`"${tableTitle}" heading not found on the page.`);
  const tableStart = pageHtml.indexOf('<table', titleIdx);
  const tableEnd = pageHtml.indexOf('</table>', tableStart);
  if (tableStart === -1 || tableEnd === -1) throw new Error('Table not found after the heading.');
  const tableHtml = pageHtml.slice(tableStart, tableEnd + '</table>'.length);

  const headerMatch = tableHtml.match(/<thead>([\s\S]*?)<\/thead>/i);
  const headers = headerMatch ? [...headerMatch[1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => cellText(m[1])) : [];

  const bodyMatch = tableHtml.match(/<tbody>([\s\S]*?)<\/tbody>/i);
  const bodyHtml = bodyMatch ? bodyMatch[1] : '';
  const rawRows = [...bodyHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((rowMatch) => {
    const cells = [...rowMatch[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => cellText(m[1]));
    const row = {};
    headers.forEach((h, i) => {
      row[h] = cells[i] || '';
    });
    return row;
  });

  const splitCol = headers[0];
  return rawRows
    .filter((r) => Object.values(r).some((v) => v)) // drop the trailing all-blank spacer row
    .map((r) => {
      const { name, description } = splitServiceCell(r[splitCol] || '');
      return { name, description, raw: r };
    })
    .filter((r) => r.name);
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour -- admin-edited reference content, not live telemetry

// One cache/in-flight pair PER (page, table) -- a module-scope Map keyed
// by `${pageName}::${tableTitle}` rather than 2 separate hardcoded
// cache/inFlight variable pairs, so a 3rd table later just works without
// another copy of this whole function. Returns
// [{ name, description, raw: {<every column header>: value} }], `raw`
// kept as-is (not just the 2 columns split out) so a caller can read the
// "Show"/tier columns -- or any future column added on the SharePoint
// page the same way -- without this file needing a matching code change
// every time.
const tableCaches = new Map(); // key -> { cache: {data, expiresAt} | null, inFlight: Promise | null }
async function fetchTable(pageName, tableTitle, force) {
  const key = `${pageName}::${tableTitle}`;
  let state = tableCaches.get(key);
  if (!state) {
    state = { cache: null, inFlight: null };
    tableCaches.set(key, state);
  }
  if (!force && state.cache && Date.now() < state.cache.expiresAt) return state.cache.data;
  if (!force && state.inFlight) return state.inFlight;
  state.inFlight = (async () => {
    const token = await getToken();
    const pageId = await resolvePageId(token, pageName);
    const page = await graphGet(token, `https://graph.microsoft.com/v1.0/sites/${SITE_ID}/pages/${pageId}/microsoft.graph.sitePage?$expand=canvasLayout`);
    let tableHtml = null;
    (page.canvasLayout?.horizontalSections || []).forEach((sec) => {
      (sec.columns || []).forEach((col) => {
        (col.webparts || []).forEach((wp) => {
          if (wp.innerHtml && wp.innerHtml.includes(tableTitle)) tableHtml = wp.innerHtml;
        });
      });
    });
    if (!tableHtml) throw new Error(`"${tableTitle}" table not found on "${pageName}".`);
    const rows = parseTable(tableHtml, tableTitle);
    state.cache = { data: rows, expiresAt: Date.now() + CACHE_TTL_MS };
    return rows;
  })().finally(() => {
    state.inFlight = null;
  });
  return state.inFlight;
}

async function getCybersecurityServicesTable(force) {
  return fetchTable('Business-Security-Essentials.aspx', 'Cybersecurity Services for Managed Service Clients', force);
}

// PC Security Settings Applied page, by request ("do this now like we do
// for the Cybersecurity Systems descriptions") -- replaces server.js's
// own hand-transcribed DEFAULT_PROACTIVE_MAINTENANCE_ITEMS the same way
// the Cybersecurity table already replaced pdf-template.js's
// CYBERSECURITY_EXPLANATIONS. Each row's `raw['Show**']` is 'Y'/'N' (the
// page's own "** Show on Client Executive Reports" footnote -- the ** is
// part of the real column header text, confirmed live), `raw.Schedule` is
// Daily/Weekly/Monthly -- server.js combines description + schedule into
// the final "Backup of drive encryption recovery keys (Weekly)"-style
// string, same shape its old static list already used.
async function getProactiveMaintenanceJobsTable(force) {
  return fetchTable('PC-Security-Settings-Applied-What,-How,-Where,-When.aspx', 'Proactive Maintenance Jobs', force);
}

module.exports = { getCybersecurityServicesTable, getProactiveMaintenanceJobsTable };
