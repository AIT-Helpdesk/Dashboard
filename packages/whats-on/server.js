const express = require('express');
const { get, fetchAllPages, isConnected, connectedIdentity } = require('@dashboard/strety-client');

const HELPDESK_TEAM_NAME = 'Helpdesk Task Tracker';
// By request: only these three cadences -- Strety's real `checkin_frequency`
// values also include "annual" (confirmed against real data, 2 of the 74
// metrics on this account), deliberately left out here. Order here is the
// order groups render in.
const FREQUENCIES = ['daily', 'weekly', 'monthly'];
const HISTORY_LIMIT = 8;
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Same email-match convention as My Strety Tasks -- see that package's
// README for why this is safe (every real Ambient iT person's Strety email
// matches their Microsoft 365 one exactly).
async function findPersonByEmail(email) {
  const res = await get('/people', { 'filter[email]': email });
  return res.data[0] || null;
}

// A DELIBERATE exception to this dashboard's usual "no caching, always
// live" stance (see My Strety Tasks' README) -- confirmed against the real
// API this page was drawing real 429 "Too Many Requests" responses under
// normal use, and /metrics alone (74 rows, 4 pages) was the single biggest
// chunk of every request just to filter down to the ~5 rows one team
// actually needs (`filter[space_id]` is NOT a supported filter on /metrics,
// confirmed against the real API -- a 400 "not a supported filter for this
// resource"). Teams and metric DEFINITIONS (titles, targets, cadence) change
// on the order of "someone edited Strety," not minute to minute, so a short
// shared cache here doesn't cost meaningful freshness -- unlike the actual
// check-in HISTORY (the real data this page exists to show), which stays a
// fully live fetch every request, uncached, below.
const CATALOG_CACHE_TTL_MS = 60_000;
let catalogCache = null; // { teams, metrics, fetchedAt }

async function getCatalog() {
  if (catalogCache && Date.now() - catalogCache.fetchedAt < CATALOG_CACHE_TTL_MS) {
    return catalogCache;
  }
  // Sequential, not Promise.all -- confirmed against real use, a request
  // that gets a genuine 200 back can still come back with an empty/short
  // result under concurrent load (this page returned "no scorecards" with
  // no error at all, right after this used to fire /teams and /metrics at
  // the same time). @dashboard/strety-client's own get() now retries a real
  // 429 with backoff, but that can't help a request that came back 200 with
  // a suspiciously empty body -- avoiding concurrent Strety requests
  // entirely, here and in fetchScorecardsFor's per-metric loop below, is
  // the more defensive fix.
  const teams = await fetchAllPages('/teams', {});
  const metrics = await fetchAllPages('/metrics', {});
  catalogCache = { teams, metrics, fetchedAt: Date.now() };
  return catalogCache;
}

// Confirmed against real data: target_type is one of gte/gt/eq/lte/lt.
function checkinPasses(value, targetType, targetValue) {
  if (value === null || value === undefined || targetValue === null || targetValue === undefined) return null;
  switch (targetType) {
    case 'gte':
      return value >= targetValue;
    case 'gt':
      return value > targetValue;
    case 'eq':
      return value === targetValue;
    case 'lte':
      return value <= targetValue;
    case 'lt':
      return value < targetValue;
    default:
      return null;
  }
}

function targetLabel(targetType, targetValue) {
  const symbols = { gte: '≥', gt: '>', eq: '=', lte: '≤', lt: '<' };
  if (targetValue === null || targetValue === undefined) return '';
  return `${symbols[targetType] || targetType || ''} ${targetValue}`.trim();
}

// number_format confirmed against real data: "number" (plain), "currency"
// (a real decimal dollar value, e.g. 9027.26 -- not cents), and "percentage"
// (already a whole percentage, e.g. 12 means 12%, not 0.12) all confirmed
// from real check-ins. "time" has ZERO real check-ins anywhere on this
// account as of writing -- its unit (seconds? minutes?) is NOT confirmed, so
// rather than guess a conversion that might be wrong, it falls back to the
// plain-number branch like anything else unrecognized.
function formatValue(value, numberFormat) {
  if (value === null || value === undefined) return '';
  if (numberFormat === 'currency') {
    return `$${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  if (numberFormat === 'percentage') return `${value}%`;
  return String(value);
}

// A single shared "period" identity per cadence, so every metric in a group
// lines up against the SAME real columns instead of each row showing its
// own independent "last 8" (which, confirmed against real data, don't land
// on the same actual dates row to row -- e.g. three "Daily Backup Checks"
// check-ins landed on the very same calendar day while a sibling metric's
// check-ins didn't). Weekly/monthly use the check-in's own `iso_week`/
// `iso_week_year`/`month`/`year` attributes directly (confirmed present on
// every real check-in) rather than computed date math this package could get
// wrong; daily has no such attribute, so it's derived from `created_at`'s
// AEST calendar day -- same AEST-anchoring convention every other
// date-scoped page on this dashboard follows.
function periodKeyFor(attrs, frequency) {
  if (frequency === 'daily') {
    const aest = new Date(new Date(attrs.created_at).getTime() + 10 * 60 * 60 * 1000);
    return aest.toISOString().slice(0, 10); // YYYY-MM-DD, lexically sortable
  }
  if (frequency === 'weekly') {
    return `${attrs.iso_week_year}-W${String(attrs.iso_week).padStart(2, '0')}`;
  }
  if (frequency === 'monthly') {
    return `${attrs.year}-${String(attrs.month).padStart(2, '0')}`;
  }
  return null;
}

// AEST "today" (same AEST-anchoring convention as periodKeyFor()'s daily
// branch and every other date-scoped page on this dashboard), as a real
// UTC-midnight Date -- the anchor Daily/Weekly's fixed column windows below
// count back from, regardless of whether anyone's checked in yet.
function todayAestDate() {
  const aest = new Date(Date.now() + 10 * 60 * 60 * 1000);
  return new Date(Date.UTC(aest.getUTCFullYear(), aest.getUTCMonth(), aest.getUTCDate()));
}

function dailyKeyForDate(d) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function dailyLabelForDate(d) {
  const [, m, day] = dailyKeyForDate(d).split('-');
  return `${day}/${m}`;
}

// Standard ISO 8601 week algorithm -- the week containing a date's nearest
// Thursday is that date's ISO week. This has to MATCH Strety's own
// iso_week/iso_week_year check-in attributes exactly (see periodKeyFor()),
// since the fixed 8-week column list below and each metric's real
// check-ins both need to land on the same period keys to line up.
function isoWeekInfo(d) {
  const target = new Date(d.getTime());
  const dayNum = target.getUTCDay() || 7; // Mon=1..Sun=7
  target.setUTCDate(target.getUTCDate() + 4 - dayNum); // Thursday of this ISO week
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const isoWeek = Math.ceil((((target - yearStart) / 86400000) + 1) / 7);
  return { isoWeek, isoWeekYear: target.getUTCFullYear() };
}

function weeklyKeyForDate(d) {
  const { isoWeek, isoWeekYear } = isoWeekInfo(d);
  return `${isoWeekYear}-W${String(isoWeek).padStart(2, '0')}`;
}

// The Monday of the ISO week containing d -- by request, Weekly's column
// header shows this instead of the week number. getUTCDay() is Sun=0..
// Sat=6; days-since-Monday is (day + 6) % 7 (Monday itself -> 0).
function weeklyLabelForDate(d) {
  const daysSinceMonday = (d.getUTCDay() + 6) % 7;
  const monday = new Date(d.getTime());
  monday.setUTCDate(d.getUTCDate() - daysSinceMonday);
  const dd = String(monday.getUTCDate()).padStart(2, '0');
  const mm = String(monday.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}`;
}

// Monthly is still purely data-driven (see fetchScorecardsFor) -- this only
// needs to turn a "YYYY-MM" key into a label, unlike daily/weekly which now
// generate their (key, label) pairs directly from real dates.
function periodLabelFor(key) {
  const [y, m] = key.split('-');
  return `${MONTH_NAMES[Number(m) - 1]} ${y}`;
}

// Walks every page of this metric's check-ins (order is NOT reliable --
// confirmed against real data neither created_at nor updated_at, ascending
// or descending, explains the order the API actually returns -- same
// "don't trust the API's own ordering" situation already confirmed for
// /todos), then collapses them to one check-in per real period, keeping
// whichever is most recently created if a period somehow has more than one
// (confirmed against real data this happens -- multiple same-day check-ins
// on one daily metric -- the latest logged one wins as "the" value for that
// period).
async function fetchMetricPeriodMap(metric) {
  const checkins = await fetchAllPages(`/metrics/${metric.id}/check_ins`, {});
  const byPeriod = new Map();
  for (const c of checkins) {
    const key = periodKeyFor(c.attributes, metric.attributes.checkin_frequency);
    if (!key) continue;
    const existing = byPeriod.get(key);
    if (!existing || c.attributes.created_at > existing.attributes.created_at) {
      byPeriod.set(key, c);
    }
  }
  return byPeriod;
}

// Strety has no "category" concept on a metric via the API at all --
// confirmed against real data, every attribute/relationship key on every
// real metric was dumped and there's nothing resembling one (a category
// list only exists in Strety's own Scorecard UI, not exposed here). By
// request, a metric that shouldn't show on this page is instead marked by
// prefixing its own title with "NOT READY:" directly in Strety -- a manual
// workaround, not a real API field, so this just filters on that prefix
// (case-insensitive, tolerant of leading whitespace) before a metric's
// check-in history is even fetched, saving the API call entirely for a
// metric that's about to be hidden anyway.
const NOT_READY_PREFIX = /^not ready\s*:/i;
function isNotReady(metric) {
  return NOT_READY_PREFIX.test(metric.attributes.title.trim());
}

// One space (a team or a person) -> its metrics grouped by cadence, each
// group sharing one set of period columns per cadence. Daily/Weekly use a
// FIXED calendar window (today/this week back HISTORY_LIMIT periods, by
// request); Monthly is still data-driven (the most recent periods that ANY
// metric in the group actually has a check-in for) -- see the column-
// computation branch below for why.
async function fetchScorecardsFor(spaceType, spaceId, allMetrics) {
  const metrics = allMetrics.filter(
    (m) => m.relationships?.space?.data?.type === spaceType && m.relationships.space.data.id === spaceId
  );

  const byFrequency = {};
  for (const freq of FREQUENCIES) {
    const freqMetrics = metrics.filter((m) => m.attributes.checkin_frequency === freq && !isNotReady(m));
    if (freqMetrics.length === 0) continue;

    // Sequential, not Promise.all -- each metric's history is its own
    // fetchAllPages() walk (its own burst of requests already), and Strety
    // does enforce a real rate limit (confirmed against the real API: a
    // burst of requests -- admittedly from repeated manual testing, not a
    // single normal page load -- drew a real 429 "Too Many Requests").
    // Firing every metric in a cadence group at once multiplies that burst
    // by however many metrics are in the group; one at a time keeps this
    // page's own footprint modest regardless of how many metrics a space
    // ends up with.
    const periodMaps = [];
    for (const m of freqMetrics) {
      periodMaps.push(await fetchMetricPeriodMap(m));
    }

    let columnKeys;
    let columnLabels;
    if (freq === 'daily' || freq === 'weekly') {
      // Fixed window, by request -- always the most recent HISTORY_LIMIT
      // real calendar days/ISO weeks counting back from today/this week,
      // regardless of whether any metric has a check-in in a given one
      // (unlike Monthly below, which only shows periods that actually have
      // data). i=0 is today/this week; i=HISTORY_LIMIT-1 is the oldest.
      const today = todayAestDate();
      columnKeys = [];
      columnLabels = [];
      for (let i = 0; i < HISTORY_LIMIT; i++) {
        const d = new Date(today.getTime());
        d.setUTCDate(today.getUTCDate() - i * (freq === 'weekly' ? 7 : 1));
        columnKeys.push(freq === 'weekly' ? weeklyKeyForDate(d) : dailyKeyForDate(d));
        columnLabels.push(freq === 'weekly' ? weeklyLabelForDate(d) : dailyLabelForDate(d));
      }
    } else {
      // Monthly -- unchanged: the most recent periods that ANY metric in
      // this cadence group actually has a check-in for (a union across the
      // group, not a fixed calendar window), so the columns reflect real
      // activity rather than mostly-empty calendar slots if check-ins lag.
      const allKeys = new Set();
      periodMaps.forEach((map) => {
        for (const key of map.keys()) allKeys.add(key);
      });
      // Period keys are zero-padded and lexically sortable ("YYYY-MM") --
      // plain string sort gives correct chronological order, most recent
      // first after reversing.
      columnKeys = [...allKeys].sort().reverse().slice(0, HISTORY_LIMIT);
      columnLabels = columnKeys.map(periodLabelFor);
    }

    const rows = freqMetrics
      .map((m, i) => {
        const map = periodMaps[i];
        const cells = columnKeys.map((key) => {
          const c = map.get(key);
          // A check-in record can exist for a period with its own value
          // cleared to null (confirmed against real data -- editing a
          // check-in in Strety can leave the record in place with no
          // value, rather than deleting it outright). Treated the same as
          // no check-in at all for that period -- a blank cell, not a
          // "populated" cell with an empty display string, which would
          // otherwise still count as truthy (`Boolean(cell)`) client-side
          // for the title's green/red "has recent data" highlight.
          if (!c || c.attributes.value === null || c.attributes.value === undefined) return null;
          return {
            displayValue: formatValue(c.attributes.value, m.attributes.number_format),
            context: c.attributes.context || '',
            pass: checkinPasses(c.attributes.value, m.attributes.target_type, m.attributes.target_value),
          };
        });
        return {
          id: m.id,
          title: m.attributes.title,
          target: targetLabel(m.attributes.target_type, m.attributes.target_value),
          cells,
        };
      })
      // No inherent order from the API -- alphabetical by title within a cadence.
      .sort((a, b) => a.title.localeCompare(b.title));

    byFrequency[freq] = {
      columns: columnLabels,
      rows,
    };
  }
  return byFrequency;
}

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    if (!isConnected()) {
      return res.json({ status: 'not-connected' });
    }

    const email = req.session?.user?.email;
    if (!email) {
      return res.json({ status: 'no-session-email' });
    }

    const person = await findPersonByEmail(email);
    if (!person) {
      return res.json({ status: 'person-not-found', email });
    }

    const { teams, metrics: allMetrics } = await getCatalog();
    const helpdeskTeam = teams.find((t) => t.attributes.name === HELPDESK_TEAM_NAME) || null;

    const groups = [];

    if (helpdeskTeam) {
      groups.push({
        label: HELPDESK_TEAM_NAME,
        byFrequency: await fetchScorecardsFor('team', helpdeskTeam.id, allMetrics),
      });
    } else {
      // Surfaced to the user rather than silently dropped -- a renamed or
      // deleted team in Strety shouldn't just make this section vanish
      // without explanation.
      groups.push({ label: HELPDESK_TEAM_NAME, notFound: true, byFrequency: {} });
    }

    groups.push({
      label: `Personal -- ${person.attributes.name}`,
      byFrequency: await fetchScorecardsFor('person', person.id, allMetrics),
    });

    res.json({
      status: 'ok',
      personName: person.attributes.name,
      asOf: new Date().toISOString(),
      groups,
    });
  } catch (err) {
    if (err.strety_not_connected) {
      return res.json({ status: 'not-connected' });
    }
    // Distinct from 'not-connected' -- this connection WAS working and its
    // stored refresh token has since gone stale/revoked (confirmed against
    // real data this happens periodically). Same fix either way (redo the
    // browser login), but the message should say which situation it is
    // rather than showing a raw error for something with a known, simple
    // remedy.
    if (err.strety_reauth_required) {
      return res.json({ status: 'reauth-required', connectedAs: connectedIdentity() });
    }
    console.error(err);
    const detail = err.response ? `Strety API returned HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
    res.status(500).json({ error: detail });
  }
});

module.exports = router;
