// Shared localStorage bridge between Meeting Prep (writer) and Report
// (reader), by request -- "The selections will be made on Meeting Prep and
// then displayed on Report page". localStorage, not sessionStorage: shared
// across every tab/window on this ORIGIN (sessionStorage is per-tab, which
// would defeat the whole "prep in one tab, present in another" point of
// Report), and survives an accidental reload of either tab mid-meeting.
// Deliberately browser-local, not server-persisted -- confirmed this is
// fine, Report is only ever opened in a different TAB of the same browser
// Meeting Prep is being driven from, never a separate device/browser.
const STORAGE_KEY = 'meeting-prep:report-selection';

// `payload` shape: { siteTerm, asOf, savedAt, selectedComponents,
// allComponents }. selectedComponents is the ticked subset, in Meeting
// Prep's own current tile order (already filtered/ordered by the caller);
// allComponents is everything /components returned for this search,
// regardless of tick state -- Report's own Recommendations Summary needs
// the FULL set to match what Meeting Prep's own "Generate Recommendations
// Summary" button would produce (that button always reads from every
// loaded component, not just what's ticked -- see meeting-prep/client.js's
// own summaryButton handler). Every component object here is exactly what
// /components already returned, so Report never has to re-fetch anything.
export function saveSelection(payload) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (err) {
    // Quota exceeded, private-browsing restrictions, etc. -- Report simply
    // won't see this update; Meeting Prep itself is unaffected either way,
    // so this is a silent best-effort, not a user-facing error.
    console.error('Meeting Prep: failed to save selection for Report:', err);
  }
}

export function loadSelection() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.error('Report: failed to read Meeting Prep selection:', err);
    return null;
  }
}

// Report's own live-update hook -- fires `cb` whenever Meeting Prep (in
// ANOTHER tab/window of this same browser) calls saveSelection() above.
// The native `storage` event only ever fires in OTHER tabs, never the one
// that made the change, which is exactly what Report wants: it re-reads
// via loadSelection() rather than trusting the event's own newValue, so a
// stale/failed parse can't slip through. Returns an unsubscribe function --
// Report calls it once its own container leaves the DOM (same self-
// cleaning reasoning as every other page-lifetime listener/interval on
// this dashboard, which has no explicit unmount hook to rely on).
export function onSelectionChange(cb) {
  const handler = (e) => {
    if (e.key === STORAGE_KEY) cb();
  };
  window.addEventListener('storage', handler);
  return () => window.removeEventListener('storage', handler);
}
