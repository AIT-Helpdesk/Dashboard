const express = require('express');
const { get, fetchAllPages, isConnected } = require('@dashboard/strety-client');

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

// Same AEST-anchoring convention as periodKeyFor()'s daily branch (and
// every other date-scoped page on this dashboard) -- "today" for a Daily
// scorecard column, regardless of whether anyone's checked in yet.
function todayKeyAEST() {
  return new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function periodLabelFor(key, frequency) {
  if (frequency === 'daily') {
    const [, m, d] = key.split('-');
    return `${d}/${m}`;
  }
  if (frequency === 'weekly') {
    return `Wk ${Number(key.split('-W')[1])}`;
  }
  if (frequency === 'monthly') {
    const [y, m] = key.split('-');
    return `${MONTH_NAMES[Number(m) - 1]} ${y}`;
  }
  return key;
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

// One space (a team or a person) -> its metrics grouped by cadence, each
// group sharing one real set of period columns (the most recent 8 periods
// that ANY metric in the group actually has a check-in for -- not the last
// 8 calendar periods, which could be mostly empty if check-ins lag).
async function fetchScorecardsFor(spaceType, spaceId, allMetrics) {
  const metrics = allMetrics.filter(
    (m) => m.relationships?.space?.data?.type === spaceType && m.relationships.space.data.id === spaceId
  );

  const byFrequency = {};
  for (const freq of FREQUENCIES) {
    const freqMetrics = metrics.filter((m) => m.attributes.checkin_frequency === freq);
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

    const allKeys = new Set();
    periodMaps.forEach((map) => {
      for (const key of map.keys()) allKeys.add(key);
    });
    // Daily tables always get a column for today, by request, even with
    // zero check-ins logged yet today -- added to the set BEFORE sorting,
    // not appended after, so it naturally takes the "most recent" slot
    // (today can never be earlier than any real check-in) and the slice
    // below still correctly caps the total at HISTORY_LIMIT rather than
    // ever showing 9 columns.
    if (freq === 'daily') allKeys.add(todayKeyAEST());
    // Period keys are zero-padded and lexically sortable in every cadence
    // (YYYY-MM-DD, YYYY-Wnn, YYYY-MM) -- plain string sort gives correct
    // chronological order, most recent first after reversing.
    const columnKeys = [...allKeys].sort().reverse().slice(0, HISTORY_LIMIT);

    const rows = freqMetrics
      .map((m, i) => {
        const map = periodMaps[i];
        const cells = columnKeys.map((key) => {
          const c = map.get(key);
          if (!c) return null;
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
      columns: columnKeys.map((key) => periodLabelFor(key, freq)),
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
    console.error(err);
    const detail = err.response ? `Strety API returned HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
    res.status(500).json({ error: detail });
  }
});

module.exports = router;
