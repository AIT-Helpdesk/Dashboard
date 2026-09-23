// Tracker Manager -- a SEPARATE permission list from the single
// isDashboardAdmin() email (registry.js), specific to the rollout-tracker
// feature. By request: create a new tracker, add a column to one, and
// move one between Trackers / Trackers - Complete are all Tracker
// Manager actions; adding a row stays open to everyone signed in (no
// gate at all, see rollout-tracker-server.js's own POST /rows).
//
// Configured via .env's TRACKER_MANAGER -- comma-separated exact Entra ID
// display names (e.g. "Amber Worth, Jackson Worth"), not emails. This is
// the one deliberate departure from every other per-person gate on this
// dashboard (isDashboardAdmin, isColumnAdmin, AUTH_ALLOWED_USERS), which
// all match by email -- by request, for a human-editable .env list.
// Matched against req.session.user.name, which is MSAL's own
// account.name (Entra's displayName for that account, see
// packages/shell/auth.js), case-insensitive and trimmed. If a listed name
// ever silently stops being recognised, check the EXACT spelling/spacing
// Entra shows for that account (Admin Center -> Users) before assuming
// the code is wrong -- there's no error surfaced for a near-miss, it just
// reads as "not a manager".
//
// process.env.TRACKER_MANAGER is available here because shell/server.js
// loads .env (dotenv.config()) once, at process start, before requiring
// any page module -- same as every other env-configured feature on this
// dashboard, nothing extra needed in this file.
function trackerManagerNames() {
  return (process.env.TRACKER_MANAGER || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function isTrackerManager(req) {
  const name = req.session.user?.name;
  if (!name) return false;
  return trackerManagerNames().includes(name.trim().toLowerCase());
}

module.exports = { isTrackerManager };
