const axios = require('axios');

// Datto RMM API v2 client -- ported from a previous employee's separate
// React/Vite dashboard (C:\Code\Improved-Dashboards, server/dattoClient.js
// + server/services/dattoDataService.js), by request, adapted to this
// dashboard's own CommonJS/Express/axios conventions rather than copied
// verbatim (that project used ESM + the native fetch() API). The actual
// Datto auth flow and endpoint shapes are preserved as-is -- that part was
// already confirmed working against the real account by that earlier work.
const { DATTO_API_URL, DATTO_API_KEY, DATTO_API_SECRET } = process.env;

// DATTO_API_URL is region-specific (from the signed-in user's own Datto
// profile, e.g. https://syrah-api.centrastage.net) -- there's no single
// fixed API host the way most other integrations on this dashboard have.
// Trailing "/api" is stripped if present, same normalization the original
// client did, so a URL copied with or without it both work.
function resolveApiBaseUrl() {
  const raw = (DATTO_API_URL || '').trim();
  if (!raw) throw new Error('DATTO_API_URL is not configured in .env.');
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(withScheme);
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path === '/api' ? '' : path}`;
}

function hasDattoCredentials() {
  return Boolean((DATTO_API_KEY || '').trim());
}

// Two auth modes, same as the original: OAuth password-grant (API key as
// username, API secret as password) when a secret is configured, or a
// "key-only" fallback (the key used as BOTH username and password) for
// tenants whose API keys don't have a paired secret. Token cached
// in-process, same 60s-early-refresh convention as this dashboard's other
// OAuth-backed clients (CSP Customers, Teams Shifts).
let tokenCache = null; // { token, expiresAt }

async function fetchOAuthToken() {
  const apiKey = (DATTO_API_KEY || '').trim();
  const apiSecret = (DATTO_API_SECRET || '').trim();
  if (!apiKey) throw new Error('DATTO_API_KEY is not configured in .env.');

  const basic = Buffer.from('public-client:public').toString('base64');
  const res = await axios.post(
    `${resolveApiBaseUrl()}/auth/oauth/token`,
    new URLSearchParams({
      grant_type: 'password',
      username: apiKey,
      password: apiSecret || apiKey, // key-only fallback -- see above
    }).toString(),
    { headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  const expiresIn = Number(res.data.expires_in ?? 3600);
  tokenCache = { token: res.data.access_token, expiresAt: Date.now() + Math.max(60, expiresIn - 120) * 1000 };
  return tokenCache.token;
}

async function getAccessToken() {
  if (tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  return fetchOAuthToken();
}

// A single request against /api/v2/... . Retries once on a 401 with a
// forced fresh token (the original client's own retry behavior) -- a
// stale/revoked token shouldn't need a full page-load failure to recover
// from.
async function dattoRequest(path, params = {}, retried = false) {
  const token = await getAccessToken();
  try {
    const res = await axios.get(`${resolveApiBaseUrl()}/api${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      params,
    });
    return res.data;
  } catch (err) {
    if (err.response?.status === 401 && !retried) {
      tokenCache = null;
      return dattoRequest(path, params, true);
    }
    throw err;
  }
}

// Datto paginates via page[]/max[] query params plus a pageDetails object
// in the response body (nextPageUrl present/absent), not a full next-link
// URL the way Microsoft Graph does -- same shape the original client's own
// fetchAllPages() walked. max: 250 is Datto's own documented page-size
// ceiling for list endpoints.
async function fetchAllPages(path, params, listKey, maxPages = 50) {
  const items = [];
  for (let page = 0; page < maxPages; page++) {
    const payload = await dattoRequest(path, { ...params, page, max: 250 });
    items.push(...(payload[listKey] ?? []));
    if (!payload.pageDetails?.nextPageUrl) break;
  }
  return items;
}

// A curated shortlist, by request -- confirmed against the real account
// this has 125 real filters (custom + Datto's own built-in "default"
// ones), mostly OS/hardware/software inventory (e.g. "MS Win Server 2003",
// "Veeam", "Webroot"), not health-style signals. Rendering all 125 would be
// slow (one API call per filter, even batched) and mostly clutter -- this
// keeps the page fast and focused on filters that actually read as "does
// something need attention." Matched by NAME, not id, same not-a-hardcoded-
// id convention as this dashboard's other pages -- confirmed exact real
// names on this account via a live filter dump. Order here is the display
// order.
const CURATED_FILTER_NAMES = [
  'Offline Devices',
  'STALE Devices: Not seen for 90 days',
  'Reboot Required',
  'Antivirus Disabled',
  'Suspended Devices',
  'No MS Office',
];

// Every saved filter (custom + Datto's own built-in "default" ones),
// deduplicated by id -- confirmed necessary in the original client's own
// implementation, so kept here too. Narrowed down to CURATED_FILTER_NAMES
// (case-insensitive exact match) -- a curated name missing from the real
// account (renamed/deleted since) is logged and just omitted from the
// result, same "degrade quietly" reasoning as a person with no personal
// Strety metrics -- this is one card missing from a list of several, not
// the page's whole subject the way a not-found Team is on Teams Shifts.
async function loadCuratedFilters() {
  const [custom, defaults] = await Promise.all([
    fetchAllPages('/v2/filter/custom-filters', {}, 'filters'),
    fetchAllPages('/v2/filter/default-filters', {}, 'filters'),
  ]);
  const byId = new Map();
  for (const filter of [...custom, ...defaults]) {
    if (filter?.id != null) byId.set(filter.id, filter);
  }
  const byLowerName = new Map([...byId.values()].map((f) => [(f.name ?? '').trim().toLowerCase(), f]));

  const found = [];
  for (const name of CURATED_FILTER_NAMES) {
    const filter = byLowerName.get(name.toLowerCase());
    if (!filter) {
      console.warn(`Datto RMM: curated filter "${name}" not found on this account -- omitted from the overview.`);
      continue;
    }
    found.push(filter);
  }
  return found;
}

async function getTotalDeviceCount() {
  const payload = await dattoRequest('/v2/account/devices', { max: 1, page: 0 });
  return Number(payload.pageDetails?.totalCount ?? 0);
}

async function countDevicesForFilter(filterId) {
  const payload = await dattoRequest('/v2/account/devices', { filterId, max: 1, page: 0 });
  return Number(payload.pageDetails?.totalCount ?? payload.devices?.length ?? 0);
}

// "Open Alerts" means High + Critical priority only, by request -- NOT
// literally every alert Datto's API calls "open". Confirmed against real
// data this is necessary, not just a preference: `/v2/account/alerts/open`
// has NO real `pageDetails.totalCount` at all (confirmed always
// `undefined`) -- the ORIGINAL client's own count logic (ported here in an
// earlier pass) silently fell back to `alerts.length`, which just reflects
// whatever `max` was requested (1), not a real total.
//
// The genuine total is enormous, and this was fully confirmed, not
// estimated: paginating all the way to the real end (122 pages, ~20s) gives
// **30,410 total real open alerts**, of which **1,734 are High/Critical**.
// The vast majority of the rest are "Information" priority -- routine
// notifications (e.g. "Backup Finished... successfully"), not things
// needing attention, and each carries a real `autoresolveMins: 1` field
// that suggests a genuine Datto RMM configuration issue on the account
// itself (they're evidently not actually auto-resolving) -- separate from
// anything fixable here, and worth raising with whoever administers Datto
// RMM directly. `MAX_ALERT_PAGES` (200) is set with real margin above the
// confirmed-sufficient 122 -- if this account's raw alert volume keeps
// growing, that margin may eventually not be enough again; `truncated`
// stays honest about whether the cap was hit.
//
// No server-side priority filter exists on this endpoint either -- tested
// several real parameter name guesses (`priority`, `Priority`,
// `alertPriority`), Datto silently ignored all of them and returned the
// same unfiltered results regardless. So this fetches broadly (accepting
// the real ~20s cost, tolerable since it's cached 20 minutes same as the
// rest of the overview, not paid on every page view) and filters
// client-side.
const ALERT_PRIORITY_FILTER = new Set(['High', 'Critical']);
const MAX_ALERT_PAGES = 200; // confirmed real total needs 122; this is a comfortable margin above that, not the confirmed number itself
const MAX_ALERTS_RETURNED = 250; // same display-list cap/reasoning as getDevicesForFilter() -- 1,734 real rows is too many for one popup list

function mapAlert(a) {
  return {
    alertUid: a.alertUid,
    priority: a.priority || 'Unknown',
    timestamp: a.timestamp || null,
    source: a.alertContext?.source || null,
    message: a.alertContext?.description || a.diagnostics || null,
    deviceUid: a.alertSourceInfo?.deviceUid || null,
    deviceName: a.alertSourceInfo?.deviceName || 'Unknown device',
    siteName: a.alertSourceInfo?.siteName || '—',
  };
}

// The one real fetch behind both the Open Alerts card's count AND its own
// drill-down list -- there's no cheaper "just the count" path anymore (see
// above), so both are served from the same full fetch rather than
// duplicating the expensive pagination. Sorted newest-first (most likely
// to matter right now) before capping the RETURNED list at
// MAX_ALERTS_RETURNED -- `totalCount` is still the real, uncapped
// High/Critical count (confirmed accurate, not itself truncated, as long
// as `truncated` below is false).
async function getOpenAlerts() {
  const rawAlerts = await fetchAllPages('/v2/account/alerts/open', {}, 'alerts', MAX_ALERT_PAGES);
  const hitSafetyCap = rawAlerts.length >= MAX_ALERT_PAGES * 250;
  const matched = rawAlerts.filter((a) => ALERT_PRIORITY_FILTER.has(a.priority)).map(mapAlert);
  matched.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  const alerts = matched.slice(0, MAX_ALERTS_RETURNED);
  return {
    alerts,
    totalCount: matched.length,
    truncated: hitSafetyCap || matched.length > alerts.length,
  };
}

// --- Asset Management / Monitoring live data (Live Reports) --------------
// Confirmed live this session, replacing two earlier approximations that
// were built before these were known to exist:
//   - warrantyDate/siteUid are already free fields on the bulk device list
//     (see mapDeviceSummary() above) -- no extra call needed for those.
//   - Disk free space and installed memory are NOT on the bulk list at all;
//     the only source is this per-device audit endpoint, confirmed with no
//     bulk/list variant (one call per device -- callers should cache this
//     aggressively, it's by far the most expensive thing in this file per
//     device touched).
//   - Datto's own canned report scores Monitoring from a RESOLVED-RATIO per
//     alert-priority tier (Score = (Raised-Unresolved)/Raised*100, Raised =
//     Resolved+still-Unresolved), not a raw open-alert-count penalty -- this
//     needs full open+resolved history for the SITE, which only exists on
//     the site-scoped endpoints below (the account-wide
//     /v2/account/alerts/open used elsewhere in this file has no per-site
//     resolved-history equivalent). CONFIRMED live this session:
//   `/v2/site/{siteUid}/alerts/open` and `/v2/site/{siteUid}/alerts/
//   resolved` both work and are genuinely site-scoped -- `pageDetails.count`
//   on these is the COUNT ON THIS PAGE, not a real total (confirmed by
//   varying `max` and watching `count` track it exactly) -- so, same as
//   every other list endpoint in this file, the real total needs a full
//   fetchAllPages() walk, not a read of `pageDetails.count`.

// Reuses parseDisksFromAudit() (already defined above for getDeviceDetails())
// -- same confirmed-real `logicalDisks`/`freespace` shape, no second parsing
// path needed. System drive is "C:" by convention (every real device this
// session has only ever shown Windows-style drive letters) -- falls back to
// the first disk present for a device where "C:" genuinely isn't one.
async function getDeviceAudit(deviceUid) {
  const audit = await dattoRequest(`/v2/audit/device/${deviceUid}`);
  const disks = parseDisksFromAudit(audit);
  const systemDisk = disks.find((d) => d.drive === 'C:') ?? disks[0] ?? null;
  const memoryBytes = toNumber(audit?.systemInfo?.totalPhysicalMemory);
  return {
    systemDiskFreePercent: systemDisk?.freePercent ?? null,
    memoryGB: memoryBytes != null ? memoryBytes / 1024 ** 3 : null,
  };
}

const MONITORING_PRIORITIES = ['Critical', 'High', 'Moderate', 'Low', 'Information'];

async function fetchAllSiteAlerts(siteUid, status) {
  // 50 pages * 250/page = 12,500 -- a single site's own alert history,
  // comfortably above anything realistic (the account-wide equivalent of
  // this, MAX_ALERT_PAGES above, needed 200 pages for the WHOLE account).
  return fetchAllPages(`/v2/site/${siteUid}/alerts/${status}`, {}, 'alerts', 50);
}

// Critical/High/Moderate, by request ("Open alerts critical, high,
// moderate on the widget ... also list them") -- this site-scoped
// widget/list's own priority scope. Deliberately a SEPARATE set from the
// shared ALERT_PRIORITY_FILTER above (Critical/High only, untouched) --
// that one still drives the account-wide getOpenAlerts() (Check Client,
// the Datto RMM overview page, and live-reports' own PDF/scorecard
// Open Alerts (Critical/High) figure, by request kept as-is, not widened
// to Moderate), so this page's own ON-SCREEN widget needed its own
// broader scope rather than changing what every other page already means
// by "Open Alerts".
const SITE_ALERT_LIST_PRIORITIES = new Set(['Critical', 'High', 'Moderate']);
const RAISED_WINDOW_DAYS = 30;

// Raised/Unresolved per priority tier for one site, matching exactly what
// Datto's own canned report's "Total Alerts by Priority" table shows --
// Raised = every alert this site has ever had at that priority (open +
// resolved), Unresolved = still open right now. live-reports/server.js's
// own monitoringScore() turns this into the real resolved-ratio score per
// tier. A priority with zero alerts either way still gets a {raised: 0,
// unresolved: 0, raisedLast30Days: 0} entry (not omitted) so the caller's
// own per-tier scoring doesn't need a presence check.
//
// `raisedLast30Days` (per tier, open+resolved alerts combined, filtered
// by `timestamp`) and `openAlertsList` (the actual Critical/High/Moderate
// open alerts themselves, same mapAlert() shape/newest-first sort as the
// account-wide getOpenAlerts() above) both ride along on this same call,
// by request -- live-reports' own Overall Health View shows the counts on
// its own widget and the open ones individually below it, so Amber can
// cross-check directly against Datto RMM's own console rather than just
// trust a count. Built from the SAME openAlerts/resolvedAlerts fetches
// already done for the breakdown itself -- no extra API calls.
async function getSiteAlertsBreakdown(siteUid) {
  const [openAlerts, resolvedAlerts] = await Promise.all([fetchAllSiteAlerts(siteUid, 'open'), fetchAllSiteAlerts(siteUid, 'resolved')]);
  const allAlerts = [...openAlerts, ...resolvedAlerts];
  const raisedCutoff = Date.now() - RAISED_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const byPriority = {};
  for (const priority of MONITORING_PRIORITIES) {
    const unresolved = openAlerts.filter((a) => a.priority === priority).length;
    const resolved = resolvedAlerts.filter((a) => a.priority === priority).length;
    const raisedLast30Days = allAlerts.filter((a) => a.priority === priority && (a.timestamp || 0) >= raisedCutoff).length;
    byPriority[priority] = { raised: unresolved + resolved, unresolved, raisedLast30Days };
  }
  const openAlertsList = openAlerts
    .filter((a) => SITE_ALERT_LIST_PRIORITIES.has(a.priority))
    .map(mapAlert)
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  return { byPriority, openAlertsList };
}

// Deliberately NOT the original client's own metricStatus() -- confirmed
// against real data that logic doesn't fit here. The original treated a
// filter matching UNDER half the account's devices as the thing to flag
// ("warning"), which is backwards for every filter in CURATED_FILTER_NAMES:
// a real run showed "Offline Devices" at 1163/1616 (72%) coming back
// "healthy" under that rule, when 72% of the fleet offline is exactly the
// kind of thing this page exists to surface. Every curated filter here is
// inherently a "count of devices with a problem" -- Offline, Stale,
// Reboot Required, AV Disabled, Suspended, No Office -- so status is just
// count > 0, same binary "any is worth flagging" rule Open Alerts already
// uses, not a percentage-of-total comparison. "warning" (amber), not
// "danger" (red), for the filter cards -- red is reserved for Open Alerts,
// an actually-firing alert, which reads as more urgent than "236 devices
// are due a reboot."
function metricStatus(count, type) {
  if (type === 'open-alerts') return count > 0 ? 'danger' : 'healthy';
  return count > 0 ? 'warning' : 'healthy';
}

// The one entry point this page's server.js calls -- total devices, open
// alerts (with status), and each curated filter's own device count/total/
// status. Filter counts are fetched with limited concurrency (3 at a time,
// via the shared mapWithConcurrency() already used elsewhere on this
// dashboard for Autotask name resolution) -- only 6 filters now (see
// CURATED_FILTER_NAMES) so this isn't strictly needed for speed the way it
// would be for all 125, but kept anyway as a small courtesy to Datto's API.
//
// A single filter's count call failing does NOT fail the whole page --
// confirmed necessary against the real API: `filterId=2275` ("Google
// Chrome", a Datto built-in filter) returns a genuine `500 Internal Server
// Error` from Datto's own server, not anything wrong on this end. That
// specific filter isn't in the curated shortlist, but the same defensive
// handling is kept here regardless, since any filter could 500 the same
// way -- one broken card is shown as unavailable rather than taking down
// every other card on the page.
async function getOverview(mapWithConcurrency) {
  const [total, openAlertsResult, curatedFilters] = await Promise.all([
    getTotalDeviceCount(),
    getOpenAlerts(),
    loadCuratedFilters(),
  ]);
  const openAlertsCount = openAlertsResult.totalCount;

  const filters = await mapWithConcurrency(curatedFilters, 3, async (filter) => {
    try {
      const count = await countDevicesForFilter(filter.id);
      return {
        id: filter.id,
        name: filter.name ?? `Filter ${filter.id}`,
        count,
        total,
        status: metricStatus(count, 'filter-metric'),
        available: true,
      };
    } catch (err) {
      console.error(`Datto RMM: count failed for filter "${filter.name}" (id ${filter.id}):`, err.message);
      return { id: filter.id, name: filter.name ?? `Filter ${filter.id}`, available: false };
    }
  });

  return {
    asOf: new Date().toISOString(),
    totalDevices: total,
    openAlerts: { count: openAlertsCount, status: metricStatus(openAlertsCount, 'open-alerts') },
    filters,
  };
}

// Device summary field mapping -- ported from the original client's own
// mapDeviceSummary() (server/lib/deviceDetails.js). `pick()` walks a list of
// candidate field names and returns the first non-empty one -- Datto's real
// device payload has several near-duplicate fields for the same concept
// (e.g. intIpAddress/extIpAddress/ipAddress) and this is how the original
// client picked a single display value from them.
function pick(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function toNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function formatBytes(bytes) {
  const value = toNumber(bytes);
  if (value == null || value < 0) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit >= 2 ? 1 : 0)} ${units[unit]}`;
}

function mapDeviceSummary(device) {
  if (!device) return null;
  const patchStatus = device.patchManagement?.patchStatus ?? device.patchManagement?.status ?? (device.rebootRequired ? 'Pending reboot' : null);
  return {
    id: device.uid ?? String(device.id),
    hostname: device.hostname ?? 'Unknown',
    site: device.siteName ?? '—',
    // CONFIRMED live on the raw bulk /v2/account/devices payload (both are
    // top-level fields, no extra call needed) -- added for Live Reports' own
    // Asset Management (warrantyDate) and Monitoring (siteUid, needed to call
    // the site-scoped /v2/site/{siteUid}/alerts/open|resolved endpoints)
    // scores. Purely additive, same reasoning as every other field here.
    siteUid: device.siteUid ?? null,
    warrantyDate: device.warrantyDate ?? null,
    os: device.operatingSystem ?? '—',
    online: Boolean(device.online),
    patchStatus: patchStatus ?? 'Unknown',
    ipAddress: pick(device.intIpAddress, device.extIpAddress, device.ipAddress),
    // The external IP specifically, NOT blended with the internal one the
    // way ipAddress above is -- added for Check Client's own Datto RMM
    // device list (by request, "last seen external IP address"). Same
    // confirmed-real field (extIpAddress) ipAddress already reads above,
    // just exposed on its own rather than folded into that combined value.
    extIpAddress: device.extIpAddress ?? null,
    model: pick(device.model, device.systemModel, device.chassisType),
    manufacturer: pick(device.manufacturer, device.systemManufacturer),
    serialNumber: device.serialNumber ?? null,
    lastUser: device.lastLoggedInUser ?? null,
    domain: device.domain ?? null,
    lastSeen: device.lastSeen ?? device.lastSeenDate ?? null,
    agentVersion: device.aor ?? device.agentVersion ?? null,
    rebootRequired: Boolean(device.rebootRequired),
    // CONFIRMED live against this account's real payload (1,589 devices,
    // this session): real category values are 'Desktop', 'Laptop',
    // 'Server', 'Printer', 'Datto Continuity', and several 'Network
    // Device (...)' variants -- the nested `deviceType: { category, type }`
    // object this reads from is real, not the originally-unconfirmed
    // shape this comment used to flag. Added for Meeting Prep's own live
    // "Core Resources" widgets (by request), same purely-additive
    // reasoning getAllDevices() itself was added under -- every existing
    // export/behavior in this file is unchanged.
    deviceType: pick(device.deviceType?.category, device.deviceType?.type) ?? 'Unknown',
    // Three more CONFIRMED-live fields (same session), added for Live
    // Reports' own per-client Patch Management/Software Management/
    // Antivirus breakdown (by request) -- raw Datto enum values, not
    // display labels (that mapping is the caller's job, same as every
    // other display-formatting decision on this dashboard). Purely
    // additive, same reasoning as deviceType/extIpAddress above.
    patchStatusRaw: device.patchManagement?.patchStatus ?? null,
    antivirusStatus: device.antivirus?.antivirusStatus ?? null,
    softwareStatus: device.softwareStatus ?? null,
  };
}

// Devices matching a filter (or every device, when filterId is omitted --
// used for the Total Devices card's own drill-down). Capped at 250 (Datto's
// own per-page ceiling, same as everywhere else in this file) -- a filter
// like "Offline Devices" can genuinely match over a thousand real devices,
// and listing all of them in a popup isn't useful; `truncated` tells the
// caller whether the real total is bigger than what's returned so it can
// say so rather than implying this is the complete list.
async function getDevicesForFilter(filterId) {
  const payload = await dattoRequest('/v2/account/devices', { ...(filterId ? { filterId } : {}), max: 250, page: 0 });
  const totalCount = Number(payload.pageDetails?.totalCount ?? payload.devices?.length ?? 0);
  const devices = (payload.devices ?? []).map(mapDeviceSummary).filter(Boolean);
  return { devices, totalCount, truncated: totalCount > devices.length };
}

// Every device on the account, fully paginated -- unlike
// getDevicesForFilter() (capped at one page/250, by design, for its own
// popup-list use case), this is for a caller that needs the REAL complete
// device list to filter/group itself. Added for Check Client's own Datto
// RMM section (by request -- "collect report content... segmented by
// client" needed the full device list grouped by real Datto site, not
// just a single filter's own count/list). Confirmed against the real
// account: ~1629 devices as of this addition, needing 7 pages at
// 250/page -- MAX_DEVICE_PAGES (50) leaves comfortable headroom for real
// fleet growth well beyond that, same margin-above-confirmed-need
// reasoning as MAX_ALERT_PAGES above. Purely additive -- every existing
// export/behavior in this file is unchanged.
const MAX_DEVICE_PAGES = 50;

async function getAllDevices() {
  const raw = await fetchAllPages('/v2/account/devices', {}, 'devices', MAX_DEVICE_PAGES);
  return raw.map(mapDeviceSummary).filter(Boolean);
}

// Disk-space parsing -- the ORIGINAL client's own parseDisksFromAudit()
// used a multi-key-guess + deep-recursive-search approach, on the theory
// that Datto's audit shape for disks varies by OS/agent version. Confirmed
// against a real raw audit dump this was TWO real bugs, not caution that
// happened to be unnecessary:
//   1. Wrong field names -- real disks are `freespace` (lowercase, one
//      word) and `diskIdentifier` (e.g. "C:"), not `freeSpace`/
//      `driveLetter` -- so free space came back null on every real disk
//      even though the data was right there in the response the whole time.
//   2. The deep recursive search swept up `physicalMemory[]` (real RAM
//      module entries -- each one happens to carry its own `size` field)
//      as fake "disks", alongside the real ones.
// Fixed here by reading the confirmed real top-level `logicalDisks` key
// directly first; the old recursive walk (now excluding known non-disk
// keys) is kept only as a fallback for a shape that doesn't have
// `logicalDisks` at all (unconfirmed against real data -- every device
// tested while building this had it).
const NON_DISK_KEYS = ['physicalMemory', 'processors', 'nics', 'videoBoards', 'attachedDevices', 'displays', 'mobileInfo', 'snmpInfo', 'bios', 'baseBoard'];

function normalizeDiskEntry(raw, index) {
  if (!raw || typeof raw !== 'object') return null;
  const drive = pick(raw.diskIdentifier, raw.driveLetter, raw.drive, raw.letter, raw.mountPoint, raw.volume, raw.name, raw.deviceId) ?? `Disk ${index + 1}`;
  const totalBytes = toNumber(pick(raw.size, raw.totalBytes, raw.totalSpace, raw.capacity, raw.total, raw.max));
  const freeBytes = toNumber(pick(raw.freespace, raw.freeSpace, raw.freeBytes, raw.availableBytes, raw.free, raw.remainingBytes));
  const usedBytes = totalBytes != null && freeBytes != null ? Math.max(0, totalBytes - freeBytes) : toNumber(raw.usedSpace);
  const freePercent = totalBytes != null && totalBytes > 0 && freeBytes != null ? Math.round((freeBytes / totalBytes) * 100) : null;
  return {
    drive: String(drive),
    fileSystem: pick(raw.description, raw.fileSystem, raw.fs, raw.type), // "description" (e.g. "Local Fixed Disk") is real Windows logicalDisks data, more useful than nothing
    totalFormatted: formatBytes(totalBytes),
    freeFormatted: formatBytes(freeBytes),
    usedFormatted: formatBytes(usedBytes),
    freePercent,
    lowSpace: freeBytes != null && freeBytes < 2 * 1024 * 1024 * 1024, // < 2GB free -- same threshold the original client used
  };
}

// Fallback only -- see parseDisksFromAudit() below, which tries the
// confirmed real `logicalDisks` key first and only reaches this for a
// shape that doesn't have one. NON_DISK_KEYS is skipped entirely during the
// recursive descent -- confirmed necessary against real data (see above):
// without this exclusion, `physicalMemory[]`'s own RAM module entries (each
// with a `size` field) get swept up as fake disks.
function collectDiskCandidates(node, depth = 0, out = []) {
  if (!node || depth > 6) return out;
  if (Array.isArray(node)) {
    for (const item of node) {
      if (item && typeof item === 'object') {
        const hasDiskHints = 'diskIdentifier' in item || 'driveLetter' in item || 'freespace' in item || 'freeSpace' in item || 'freeBytes' in item || 'totalSpace' in item || 'size' in item || 'mountPoint' in item || 'volume' in item;
        if (hasDiskHints) out.push(item);
        else collectDiskCandidates(item, depth + 1, out);
      }
    }
    return out;
  }
  if (typeof node === 'object') {
    for (const key of ['logicalDisks', 'logicaldisks', 'disks', 'volumes', 'diskDrives', 'storage', 'partitions']) {
      if (Array.isArray(node[key])) out.push(...node[key]);
    }
    for (const [key, value] of Object.entries(node)) {
      if (NON_DISK_KEYS.includes(key)) continue;
      if (value && typeof value === 'object') collectDiskCandidates(value, depth + 1, out);
    }
  }
  return out;
}

function parseDisksFromAudit(audit) {
  const raw = Array.isArray(audit?.logicalDisks) ? audit.logicalDisks : collectDiskCandidates(audit);
  const seen = new Set();
  const disks = [];
  for (const item of raw) {
    const disk = normalizeDiskEntry(item, disks.length);
    // A real logicalDisks entry with no size AND no free space at all
    // (confirmed real example: a CD-ROM drive, "D:", both null) isn't a
    // real capacity figure worth a row -- skipped rather than shown as an
    // empty "no data" line.
    if (!disk || (disk.totalFormatted == null && disk.freeFormatted == null)) continue;
    const key = `${disk.drive}|${disk.totalFormatted}|${disk.freeFormatted}`;
    if (seen.has(key)) continue;
    seen.add(key);
    disks.push(disk);
  }
  return disks.sort((a, b) => a.drive.localeCompare(b.drive, undefined, { numeric: true }));
}

// Full device detail -- device summary + audit (processor/memory/disks) +
// that device's own open alerts, fetched in parallel with each piece
// individually caught (a partial-data device detail beats none at all;
// Datto's audit endpoint in particular is known, from the original client's
// own comments, to sometimes lag behind a freshly-added device).
async function getDeviceDetails(deviceUid) {
  const [device, audit, openAlerts] = await Promise.all([
    dattoRequest(`/v2/device/${deviceUid}`).catch((err) => {
      console.error(`Datto RMM: device fetch failed (${deviceUid}):`, err.message);
      return null;
    }),
    dattoRequest(`/v2/audit/device/${deviceUid}`).catch((err) => {
      console.error(`Datto RMM: device audit failed (${deviceUid}):`, err.message);
      return null;
    }),
    dattoRequest(`/v2/device/${deviceUid}/alerts/open`, { max: 50, page: 0 }).catch((err) => {
      console.error(`Datto RMM: device alerts failed (${deviceUid}):`, err.message);
      return null;
    }),
  ]);
  if (!device) return null;

  const summary = mapDeviceSummary(device);
  const systemInfo = audit?.systemInfo ?? audit?.system ?? audit?.computerSystem ?? {};
  return {
    ...summary,
    model: pick(summary.model, systemInfo.model, systemInfo.systemModel),
    manufacturer: pick(summary.manufacturer, systemInfo.manufacturer, systemInfo.vendor),
    // Real field is `processors` (plural, an array of {name}), not
    // `processor` -- confirmed against a real raw audit dump. The original
    // client's own singular `audit?.processor?.name` never matched.
    processor: pick(systemInfo.processorName, systemInfo.cpu, audit?.processors?.[0]?.name, audit?.processor?.name),
    memoryFormatted: formatBytes(toNumber(pick(systemInfo.totalPhysicalMemory, systemInfo.memory, audit?.memory?.total))),
    disks: parseDisksFromAudit(audit),
    openAlertCount: openAlerts?.pageDetails?.totalCount ?? openAlerts?.alerts?.length ?? 0,
  };
}

module.exports = { hasDattoCredentials, getOverview, getDevicesForFilter, getDeviceDetails, getOpenAlerts, getAllDevices, getDeviceAudit, getSiteAlertsBreakdown };
