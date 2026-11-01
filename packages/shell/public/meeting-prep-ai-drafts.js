// Report's own AI-drafted-commentary store -- by request ("AI-Assisted
// Reporting Brief", Oct 2026). Deliberately a SEPARATE localStorage key
// from meeting-prep-selection.js's own 'meeting-prep:report-selection', not
// extra fields bolted onto those component objects: Meeting Prep wholesale-
// overwrites that key (no merge) on every tick/untick/reorder/search, and
// Report's own render() does a fresh JSON.parse + full rebuild on every
// change with no reconciliation against a previous render -- any field
// stashed on a component object there would be silently discarded the next
// time either page touches it. This key is written ONLY by Report
// (client.js), never by Meeting Prep, so nothing else can clobber it.
//
// Keyed by `${component.id}::${component.createDate}`, NOT component.id
// alone -- component.id (meeting-prep/server.js's buildReportComponent())
// is `report-<kind>-<siteSlug>`, with no date in it, so it stays identical
// across different dated report runs for the same site+kind. Keying only
// by id would silently resurface last month's AI commentary (drafted
// against last month's metrics) as if it still applied once a newer report
// lands for that same client -- createDate in the key means a new report
// run for the same site+kind starts with no draft rather than a stale one.
const STORAGE_KEY = 'meeting-prep:report-ai-drafts';

function draftKey(component) {
  return `${component.id}::${component.createDate || ''}`;
}

function readAll() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    console.error('Report: failed to read AI drafts:', err);
    return {};
  }
}

function writeAll(all) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch (err) {
    // Quota exceeded, private-browsing restrictions, etc. -- best-effort,
    // same reasoning meeting-prep-selection.js's own saveSelection() uses:
    // the TAM still sees their draft on screen for this session, it just
    // won't survive a reload.
    console.error('Report: failed to save AI draft:', err);
  }
}

// `{ text, edited, generatedAt }` or null if this component has never been
// drafted (or its report run has moved on since -- see draftKey() above).
export function getDraft(component) {
  return readAll()[draftKey(component)] || null;
}

// `entry`: `{ text, edited, generatedAt }`. A full replace of this one
// component's own entry, not a merge -- same "whole-value write" convention
// saveSelection() already uses, just scoped to one key within this store
// rather than the whole store.
export function saveDraft(component, entry) {
  const all = readAll();
  all[draftKey(component)] = entry;
  writeAll(all);
}

// Used by the Export-to-PDF review gate -- true if ANY of the currently
// ticked components has a draft recorded, regardless of whether it's since
// been hand-edited.
export function anyDrafted(components) {
  const all = readAll();
  return (components || []).some((c) => !!all[draftKey(c)]);
}
