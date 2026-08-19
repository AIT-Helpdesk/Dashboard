const express = require('express');
const cheerio = require('cheerio');
const { get: itglueGet } = require('@dashboard/itglue-client');
const { getClient, resolveSingleCompany, getCompanyUrl } = require('@dashboard/autotask-client');

// IT Glue's flexible-asset TYPE name for the auto-synced Microsoft 365
// tenant snapshot (populated by a Rewst automation, confirmed against real
// data) -- NOT a built-in IT Glue feature, an org-specific custom asset
// type, so resolved by name rather than a hardcoded id.
const M365_TYPE_NAME = 'MS365 Environment (auto)';

// --- Autotask company <-> IT Glue organization mapping -------------------
// IT Glue's own PSA (Autotask) sync is exposed via an organization's
// `adapters-resources` relationship (fetched with `include=adapters-resources`,
// NOT a directly-queryable sub-resource -- confirmed against real data: every
// other URL shape for this 404s). The included adapter record's `remote-id`
// IS the Autotask company id -- confirmed two ways against real data:
// Ambient IT's own IT Glue org has remote-id "0", matching Autotask's own
// internal company id 0; "Redlands Sporting Club Inc" has remote-id "178",
// matching that real Autotask company's id exactly (same org name too).
//
// Built once for ALL ~1,941 organizations (2 requests at the max page size
// of 1000) and cached, rather than a per-search lookup -- IT Glue has no
// "find the org synced to Autotask company X" filter, so there's no way to
// search for just one.
const ORG_MAP_TTL_MS = 20 * 60 * 1000;
let orgMapCache = null; // { data: Map<autotaskCompanyId, itglueOrgId>, expiresAt }
let orgMapInFlight = null;

async function getOrgMap() {
  if (orgMapCache && Date.now() < orgMapCache.expiresAt) return orgMapCache.data;
  if (!orgMapInFlight) {
    orgMapInFlight = (async () => {
      const map = new Map();
      let page = 1;
      for (;;) {
        const res = await itglueGet('/organizations', { 'page[size]': 1000, 'page[number]': page, include: 'adapters-resources' });
        const remoteIdByAdapterId = new Map((res.included || []).map((a) => [a.id, a.attributes['remote-id']]));
        for (const org of res.data) {
          const refs = org.relationships?.['adapters-resources']?.data || [];
          for (const ref of refs) {
            const remoteId = remoteIdByAdapterId.get(ref.id);
            if (remoteId != null && remoteId !== '') map.set(String(remoteId), org.id);
          }
        }
        if (page >= res.meta['total-pages']) break;
        page++;
      }
      orgMapCache = { data: map, expiresAt: Date.now() + ORG_MAP_TTL_MS };
      return map;
    })().finally(() => {
      orgMapInFlight = null;
    });
  }
  return orgMapInFlight;
}

// The "MS365 Environment (auto)" flexible-asset TYPE's own id -- resolved
// once by name and cached indefinitely for the life of the process, same
// rationale as getBillingCodeIdByName() in @dashboard/autotask-client
// (asset type definitions are effectively static configuration).
let m365TypeIdPromise = null;
async function getM365TypeId() {
  if (!m365TypeIdPromise) {
    m365TypeIdPromise = itglueGet('/flexible_asset_types', { 'filter[name]': M365_TYPE_NAME }).then((res) => {
      const match = res.data.find((t) => t.attributes.name === M365_TYPE_NAME);
      return match ? match.id : null;
    });
  }
  return m365TypeIdPromise;
}

// Rewst renders every field on this asset as an HTML snippet (table markup
// with inline styles), not structured data -- confirmed against a real
// record. Parsed into a plain {headers, rows} shape here so the page can
// render it with the dashboard's own styling/dark-mode support, rather than
// embedding un-sanitized third-party HTML with its own hardcoded colors.
//
// A cell can contain multiple `<br>`-separated values (e.g. the Privileged
// Group Membership table's "Members" column lists several names in one
// cell) -- `<br>` is converted to a newline before text extraction so those
// don't get silently concatenated together, then re-joined with ", " for
// display as one cell value.
function cellText($, el) {
  const html = $(el).html() || '';
  const withBreaks = html.replace(/<br\s*\/?>/gi, '\n');
  const $$ = cheerio.load(`<div>${withBreaks}</div>`);
  return $$('div')
    .text()
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .join(', ');
}

// Rewst sometimes appends a plain-text note directly after a table (e.g.
// "Displaying 10 of 20 users. See attachments for the full list.") --
// confirmed against real data on the User Licence Assignment field, which
// is genuinely truncated to the first 10 (alphabetical) users, not the
// full license-assignment list. Surfaced separately so the UI can show
// that honestly instead of silently presenting a partial list as complete.
function parseTraitTable(html) {
  if (!html) return null;
  const $ = cheerio.load(html);
  const table = $('table').first();
  if (table.length === 0) return null;

  let headers = null;
  const rows = [];
  table.find('tr').each((i, tr) => {
    const ths = $(tr).find('th');
    if (ths.length > 0 && !headers) {
      headers = ths.toArray().map((th) => $(th).text().trim());
      return;
    }
    const tds = $(tr).find('td');
    if (tds.length > 0) rows.push(tds.toArray().map((td) => cellText($, td)));
  });

  const fullText = $.root().text();
  const noteMatch = fullText.match(/Displaying \d+ of \d+[^\n]*/i);
  return { headers, rows, note: noteMatch ? noteMatch[0].trim() : null };
}

const router = express.Router();

router.get('/', async (req, res) => {
  const clientSearch = (req.query.client || '').trim();
  if (!clientSearch) {
    return res.status(400).json({ error: 'Query param "client" is required.' });
  }
  const companyId = req.query.companyId ? Number(req.query.companyId) : null;

  try {
    const client = await getClient();
    const resolved = await resolveSingleCompany(client, clientSearch, companyId);
    if (resolved.status !== 'ok') {
      return res.json({ client: clientSearch, ...resolved });
    }
    const company = resolved.company;
    const companyUrl = await getCompanyUrl(company.id);
    const base = { client: clientSearch, status: 'ok', companyId: company.id, companyName: company.companyName, companyUrl };

    const [orgMap, m365TypeId] = await Promise.all([getOrgMap(), getM365TypeId()]);
    const itglueOrgId = orgMap.get(String(company.id));

    if (!itglueOrgId) {
      return res.json({ ...base, itglueLinked: false, hasM365Asset: false });
    }
    if (!m365TypeId) {
      return res.json({ ...base, itglueLinked: true, hasM365Asset: false, error: `IT Glue has no "${M365_TYPE_NAME}" asset type configured.` });
    }

    const assetsRes = await itglueGet('/flexible_assets', {
      'filter[flexible-asset-type-id]': m365TypeId,
      'filter[organization-id]': itglueOrgId,
    });
    const asset = assetsRes.data[0]; // one MS365 Environment record per org, confirmed against real data
    if (!asset) {
      return res.json({ ...base, itglueLinked: true, hasM365Asset: false });
    }

    const t = asset.attributes.traits || {};
    res.json({
      ...base,
      itglueLinked: true,
      hasM365Asset: true,
      itglueResourceUrl: asset.attributes['resource-url'],
      updatedAt: asset.attributes['updated-at'],
      tenantDisplayName: t['tenant-display-name'] || null,
      defaultDomainName: t['default-domain-name'] || null,
      overview: parseTraitTable(t.overview),
      domains: parseTraitTable(t.domains),
      privilegedGroupMembership: parseTraitTable(t['privileged-group-membership']),
      licences: parseTraitTable(t.licences),
      userLicenceAssignment: parseTraitTable(t['user-licence-assignment']),
    });
  } catch (err) {
    console.error(err);
    const detail = err.response ? `IT Glue/Autotask API returned HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
    res.status(500).json({ error: detail });
  }
});

module.exports = router;
