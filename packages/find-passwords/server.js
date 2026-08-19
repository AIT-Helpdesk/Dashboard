const express = require('express');
// The one piece of @dashboard/autotask-client this page uses -- not for
// Autotask data (it has none), but to reuse the dashboard-wide wildcard
// convention (`*` prefix/suffix -> beginsWith/endsWith/contains) so
// searching here behaves identically to every other search box on this
// dashboard, rather than inventing separate matching rules. IT Glue's own
// `filter[name]` is exact-match only (confirmed against the real API --
// unlike Autotask, there's no operator/wildcard syntax that works: `%`,
// `*`, `filter[name][cont]`, and a plain `search` param were all tried and
// either matched nothing or silently returned the full unfiltered set), so
// matching happens here in JS, not as an upstream query filter.
const { matchesWildcard } = require('@dashboard/autotask-client');
const { get: itglueGet } = require('@dashboard/itglue-client');

// Deliberately NEVER requested/returned by this page, per explicit
// instruction: the password value itself (IT Glue's list endpoint doesn't
// even include it, confirmed against real data) and the `notes` field
// (which DOES come back with real content on the list endpoint -- simply
// never read here). Every attribute this page DOES use is metadata only.
//
// "Type" maps to `cached-resource-type-name` -- what IT Glue resource (if
// any) this password is attached to, e.g. "Configuration" -- confirmed via
// real data as the only field that reads as a distinct "type" concept
// separate from Category (`password-category-name`, e.g. "Active
// Directory", "Microsoft 365", "Network Device"). Null/blank for a
// standalone login not linked to any specific asset.
function toRow(p) {
  const a = p.attributes;
  return {
    id: p.id,
    clientName: a['organization-name'] || null,
    passwordName: a.name,
    username: a.username || null,
    shareable: !!a.shareable,
    type: a['cached-resource-type-name'] || null,
    category: a['password-category-name'] || null,
    otpConfigured: !!a['otp-enabled'],
    dateLastChanged: a['password-updated-at'] || null,
    itglueUrl: a['resource-url'] || null,
  };
}

// The FULL password list (metadata only, per toRow() above), fetched once
// and cached, then filtered by name in JS per search -- not a per-search
// upstream fetch, since IT Glue has no server-side partial-match filter to
// push the search term into anyway, so every search would need the same
// full fetch regardless. ~3,621 real passwords confirmed against the real
// API, comfortably fetched in 4 requests at the max page size of 1000.
const LIST_CACHE_TTL_MS = 10 * 60 * 1000; // shorter than most pages' 20 min -- this is credential metadata, worth not letting go too stale
let listCache = null; // { data, expiresAt }
let listInFlight = null;

async function getAllPasswords(force) {
  if (!force && listCache && Date.now() < listCache.expiresAt) return listCache.data;
  if (!listInFlight) {
    listInFlight = (async () => {
      const rows = [];
      let page = 1;
      for (;;) {
        const res = await itglueGet('/passwords', { 'page[size]': 1000, 'page[number]': page });
        for (const p of res.data) rows.push(toRow(p));
        if (page >= res.meta['total-pages']) break;
        page++;
      }
      listCache = { data: rows, expiresAt: Date.now() + LIST_CACHE_TTL_MS };
      return rows;
    })().finally(() => {
      listInFlight = null;
    });
  }
  return listInFlight;
}

const router = express.Router();

router.get('/', async (req, res) => {
  const nameTerm = (req.query.name || '').trim();
  if (!nameTerm) {
    return res.status(400).json({ error: 'Query param "name" is required.' });
  }
  try {
    const all = await getAllPasswords(req.query.force === 'true');
    const results = all
      .filter((p) => matchesWildcard(p.passwordName, nameTerm))
      .sort((a, b) => (a.clientName || '').localeCompare(b.clientName || '') || a.passwordName.localeCompare(b.passwordName));
    res.json({
      nameTerm,
      asOf: new Date().toISOString(),
      totalCount: results.length,
      results,
    });
  } catch (err) {
    console.error(err);
    const detail = err.response ? `IT Glue API returned HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
    res.status(500).json({ error: detail });
  }
});

module.exports = router;
