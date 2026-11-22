const { matchesWildcard } = require('@dashboard/autotask-client');

// Extracted out of @dashboard/meeting-prep/server.js when the Meeting Prep /
// Make Report / Service Actions pages were removed (superseded by Live
// Reports) -- this one function is the only piece of that package Live
// Reports and Live Health Scores actually depend on, so it gets its own
// small home rather than being deleted along with the rest. Everything
// else that function used to need (PDF report parsing, the data/ file
// store, classification filtering) stayed behind and was deleted with it --
// Live Reports is the only remaining caller, and it always passes no
// classification filter, so that's gone too (was a dead parameter for
// this caller).

// A stable, URL/DOM-safe id for a report component -- real site names can
// contain spaces/punctuation, so this isn't just the raw name.
function slugify(s) {
  return (
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'site'
  );
}

// Site-field/search-term matching, tolerant of "&" vs "and" -- confirmed
// the hard way (a real report's own site text can spell a client's name
// out in full, "G and H Civil Contractors", while the natural habit is to
// search "G & H" -- matchesWildcard() itself found neither in the other,
// since it's a plain substring/prefix/suffix matcher with no punctuation
// normalization at all). Applied to BOTH sides -- a real site field can
// use either spelling just as easily as a search term can.
function normalizeAmpersand(s) {
  return (s || '')
    .replace(/\s*&\s*/g, ' and ')
    .replace(/\s+/g, ' ')
    .trim();
}

function siteMatches(value, term, exact) {
  const v = normalizeAmpersand(value);
  const t = normalizeAmpersand(term);
  if (exact) return v.toLowerCase() === t.toLowerCase();
  return matchesWildcard(v, t);
}

function classifyFreshness(lastSeenIso) {
  if (!lastSeenIso) return 'unknown';
  const ageDays = (Date.now() - new Date(lastSeenIso).getTime()) / 86400000;
  if (!Number.isFinite(ageDays)) return 'unknown';
  if (ageDays < 7) return 'recent';
  if (ageDays < 30) return 'ageing';
  return 'stale';
}

function buildDattoLiveDevicesComponent(siteTerm, allDevices, asOf, exact) {
  const devices = allDevices.filter((d) => siteMatches(d.site, siteTerm, exact));
  // No matching devices -- omit the card entirely rather than show an
  // empty one.
  if (devices.length === 0) return null;

  const buckets = { recent: 0, ageing: 0, stale: 0, unknown: 0 };
  const byType = new Map();
  const rows = [];
  for (const d of devices) {
    const freshness = classifyFreshness(d.lastSeen);
    buckets[freshness] += 1;
    const type = d.deviceType || 'Unknown';
    byType.set(type, (byType.get(type) || 0) + 1);
    rows.push({
      id: d.id,
      hostname: d.hostname,
      type,
      lastSeen: d.lastSeen,
      freshness,
      online: d.online,
      lastUser: d.lastUser,
    });
  }
  rows.sort((a, b) => (a.hostname || '').localeCompare(b.hostname || ''));

  // The title is ONLY the real matched site name(s) -- Datto's own
  // siteName off the matched devices themselves, not the raw siteTerm
  // search text (which can be a wildcard like "Kraftur*" rather than a
  // clean name). Normally every matched device agrees on one real site
  // name; the rare case where a broad wildcard spans more than one is
  // called out explicitly rather than just picking one and hiding the
  // ambiguity.
  const siteNames = [...new Set(devices.map((d) => d.site).filter(Boolean))];
  const title = siteNames.length === 1 ? siteNames[0] : siteNames.length > 1 ? `${siteNames.length} sites matched` : 'Live Devices';

  return {
    id: `live-datto-devices-${slugify(siteTerm)}`,
    source: 'Datto RMM (live)',
    kind: 'datto-live-devices',
    title,
    // null when this one component's own devices span more than one real
    // site (same ambiguous-wildcard case `title` above already calls out)
    // -- there's no single real value to give here in that case.
    site: siteNames.length === 1 ? siteNames[0] : null,
    // Every real site name the search actually matched, in every case (not
    // just the ambiguous one) -- lets the client show the full list in a
    // tooltip when it puts up its "N sites matched" warning.
    matchedSites: siteNames,
    createDate: asOf,
    images: [],
    stats: { total: devices.length, notSeenStale: buckets.stale },
    summary: {
      total: devices.length,
      seenRecent: buckets.recent,
      seenAgeing: buckets.ageing,
      notSeenStale: buckets.stale,
      unknown: buckets.unknown,
    },
    byType: [...byType.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count),
    // See @dashboard/datto-rmm/lib.js's own mapDeviceSummary() comment -- the
    // deviceType field this breakdown is built from hasn't been confirmed
    // against a real payload from this account yet. Carried through here so
    // the client can show an honest caveat next to the widget rather than
    // presenting it as settled.
    deviceTypeConfirmed: false,
    devices: rows,
  };
}

module.exports = { buildDattoLiveDevicesComponent };
