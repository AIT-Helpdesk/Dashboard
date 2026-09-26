// Contract Manager -- a SEPARATE permission list from the single
// isDashboardAdmin() email (registry.js), specific to Check Client's
// "adjust contract units" feature (packages/check-client + packages/
// contract-services). By request: modeled directly on rollout-tracker-
// permissions.js's own TRACKER_MANAGER shape, not the dashboard-wide admin
// gate -- this writes real, hard-to-reverse changes to a client's Autotask
// contract billing (see contract-services/server.js's own adjustUnits()
// comment), so it gets its own narrow, explicitly-named list rather than
// piggybacking on ADMIN_FULL_ACCESS.
//
// Configured via .env's CONTRACT_MANAGER -- comma-separated exact Entra ID
// display names (e.g. "Amber Worth"), not emails, matched against
// req.session.user.name (MSAL's own account.name), case-insensitive and
// trimmed. Same "if a listed name silently stops matching, check the EXACT
// spelling/spacing Entra shows for that account" caveat TRACKER_MANAGER's
// own comment already documents -- there's no error surfaced for a
// near-miss, it just reads as "not a manager".
function contractManagerNames() {
  return (process.env.CONTRACT_MANAGER || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function isContractManager(req) {
  const name = req.session.user?.name;
  if (!name) return false;
  return contractManagerNames().includes(name.trim().toLowerCase());
}

module.exports = { isContractManager };
