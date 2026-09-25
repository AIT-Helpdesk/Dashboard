// Source PDF filenames follow "<Report Title> - <Client Name>.pdf" (confirmed
// against every real file currently in Incoming/Datto RMM/ this session --
// see ingest.js's own comment for the parsing that uses this). The Report
// Title half is Datto RMM/Dark Web ID's own display title, which does NOT
// reliably match this package's own REPORT_TITLES values verbatim (e.g. the
// real title "Monitoring Performance" has no REPORT_TITLES match at all) --
// so this is its own small, hand-maintained lookup, extended over time as
// new/unfamiliar titles show up. A title not listed here is left unprocessed
// by ingest.js and reported in that run's needsAttention list -- never
// guessed at.
//
// Confirmed against real filenames in Incoming/Datto RMM/ this session (13
// Datto titles, every one of the 12 Datto-sourced REPORT_TITLES kinds this
// package's server.js already renders, one-for-one, by dropping the
// trailing " Report" REPORT_TITLES itself carries). Dark Web Monitoring's
// own title is carried over from data/README.md's documented convention
// (no live Dark Web ID sample was in Incoming/ this session to confirm
// against -- flagged here, not silently trusted).
const TITLE_TO_KIND = {
  'Device Activity': 'device-activity',
  'Device Health Summary': 'device-health-summary',
  'Device Monitor Status': 'device-monitor-status',
  'Device Storage': 'device-storage',
  'Executive Summary': 'executive-summary',
  'Hardware Lifecycle': 'hardware-lifecycle',
  'Network Audit': 'network-audit',
  'Open Monitor Alerts': 'open-monitor-alerts',
  'Patch Management Activity': 'patch-management-activity',
  'Patch Management Details': 'patch-management-details',
  'Patch Management Summary': 'patch-management-summary',
  Software: 'software',
  // Unconfirmed against a real sample -- see this block's own comment above.
  'Dark Web Monitoring': 'dark-web-monitoring',
};

// Titles that show up in Incoming/ but are deliberately never processed --
// by request ("Ignore Monitoring Performance for now"). Distinct from an
// UNRECOGNIZED title (which is flagged in needsAttention as something that
// might need a new TITLE_TO_KIND entry): an ignored title is expected and
// permanent, so it's silently skipped every run rather than cluttering that
// list with the same "problem" forever.
const IGNORED_TITLES = new Set(['Monitoring Performance']);

// Longest-title-first so a title that happens to be a prefix of another
// (none currently overlap, but this stays correct if one ever does) always
// resolves to the more specific match.
const TITLES_BY_LENGTH_DESC = Object.keys(TITLE_TO_KIND).sort((a, b) => b.length - a.length);

// Splits "<Title> - <Client Name>.pdf" against the known title list above,
// rather than a blind split on the first " - " -- safer if a client name
// ever itself contains " - ". Returns { kind, clientName } on a real match,
// { ignored: true } for a deliberately-ignored title, or null when nothing
// in TITLE_TO_KIND matches this filename's own prefix at all.
function resolveTitleAndClient(filename) {
  const base = filename.replace(/\.pdf$/i, '');
  for (const title of [...TITLES_BY_LENGTH_DESC, ...IGNORED_TITLES]) {
    const prefix = `${title} - `;
    if (base.startsWith(prefix)) {
      const clientName = base.slice(prefix.length).trim();
      if (IGNORED_TITLES.has(title)) return { ignored: true, title, clientName };
      return { kind: TITLE_TO_KIND[title], title, clientName };
    }
  }
  return null;
}

module.exports = { TITLE_TO_KIND, IGNORED_TITLES, resolveTitleAndClient };
