// Cybersecurity Services table, read live from the company intranet (the
// "Cybersecurity Services for Managed Service Clients" table on
// Business-Security-Essentials.aspx), by request -- fills the
// Cybersecurity Systems descriptions panel instead of the old hardcoded
// CYBERSECURITY_EXPLANATIONS list (pdf-template.js), with a green tick for
// whichever of those services this specific client actually has, and a
// "Show" column (admin-added on the SharePoint page itself) controlling
// which rows even show up here at all.
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

const PAGE_NAME = 'Business-Security-Essentials.aspx';
const TABLE_TITLE = 'Cybersecurity Services for Managed Service Clients';

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
async function resolvePageId(token) {
  let url = `https://graph.microsoft.com/v1.0/sites/${SITE_ID}/pages?$top=50&$select=id,name`;
  while (url) {
    const list = await graphGet(token, url);
    const match = list.value.find((p) => p.name === PAGE_NAME);
    if (match) return match.id;
    url = list['@odata.nextLink'] || null;
  }
  throw new Error(`Could not find "${PAGE_NAME}" in the intranet site's pages.`);
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

// There's exactly one <table> on this page immediately after the
// TABLE_TITLE heading (confirmed live) -- a plain indexOf + first-table-
// after-it is enough for this one known page, no real HTML parser needed.
function parseTable(pageHtml) {
  const titleIdx = pageHtml.indexOf(TABLE_TITLE);
  if (titleIdx === -1) throw new Error(`"${TABLE_TITLE}" heading not found on the page.`);
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

  const serviceCol = headers.find((h) => /security product|service/i.test(h)) || headers[0];
  return rawRows
    .filter((r) => Object.values(r).some((v) => v)) // drop the trailing all-blank spacer row
    .map((r) => {
      const { name, description } = splitServiceCell(r[serviceCol] || '');
      return { name, description, raw: r };
    })
    .filter((r) => r.name);
}

let cache = null; // { data, expiresAt }
let inFlight = null;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour -- admin-edited reference content, not live telemetry

// Returns [{ name, description, raw: {<every column header>: value} }],
// `raw` kept as-is (not just the 2 columns this file currently uses) so a
// caller can read the "Show"/tier columns -- or any future column added
// on the SharePoint page the same way -- without this file needing a
// matching code change every time.
async function getCybersecurityServicesTable(force) {
  if (!force && cache && Date.now() < cache.expiresAt) return cache.data;
  if (!force && inFlight) return inFlight;
  inFlight = (async () => {
    const token = await getToken();
    const pageId = await resolvePageId(token);
    const page = await graphGet(token, `https://graph.microsoft.com/v1.0/sites/${SITE_ID}/pages/${pageId}/microsoft.graph.sitePage?$expand=canvasLayout`);
    let tableHtml = null;
    (page.canvasLayout?.horizontalSections || []).forEach((sec) => {
      (sec.columns || []).forEach((col) => {
        (col.webparts || []).forEach((wp) => {
          if (wp.innerHtml && wp.innerHtml.includes(TABLE_TITLE)) tableHtml = wp.innerHtml;
        });
      });
    });
    if (!tableHtml) throw new Error(`"${TABLE_TITLE}" table not found on the page.`);
    const rows = parseTable(tableHtml);
    cache = { data: rows, expiresAt: Date.now() + CACHE_TTL_MS };
    return rows;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

module.exports = { getCybersecurityServicesTable };
