// Show README in Help -- a SEPARATE permission list from the single
// isDashboardAdmin() email (registry.js), specific to the dashboard-wide
// Help button's "Show README" sub-feature (app.js's openHelpModal()). By
// request: modeled directly on contract-manager-permissions.js's own
// CONTRACT_MANAGER shape (which itself follows rollout-tracker-
// permissions.js's TRACKER_MANAGER) -- a page's README can carry internal
// implementation detail not meant for every signed-in user, so this gets
// its own narrow, explicitly-named list rather than piggybacking on
// ADMIN_FULL_ACCESS or being visible to everyone.
//
// Configured via .env's SHOW_README_IN_HELP -- comma-separated exact Entra
// ID display names (e.g. "Amber Worth"), not emails, matched against
// req.session.user.name (MSAL's own account.name), case-insensitive and
// trimmed. Same "if a listed name silently stops matching, check the EXACT
// spelling/spacing Entra shows for that account" caveat TRACKER_MANAGER's
// own comment already documents -- there's no error surfaced for a
// near-miss, it just reads as "not allowed".
function showReadmeNames() {
  return (process.env.SHOW_README_IN_HELP || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function canShowReadmeInHelp(req) {
  const name = req.session.user?.name;
  if (!name) return false;
  return showReadmeNames().includes(name.trim().toLowerCase());
}

module.exports = { canShowReadmeInHelp };
