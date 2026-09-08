const express = require('express');
const { getClient, listAll, fetchByFieldIn, resolveCompanyName, mapWithConcurrency, getCompanyUrl, todayAestKey } = require('@dashboard/autotask-client');

// First pass, by request ("let's start with that and see what we get") --
// for every client with a "TC Elite" contract, count the current seats
// (ContractServiceUnits' own `units`) across that contract's real TC
// Elite service lines, counting only lines whose CURRENT period has a
// positive `price`. Confirmed against real data before writing any of
// this (see the package README's own "Confirmed against real data"
// section for the full investigation):
//
// - Autotask's own contract NAME for this is "Tech Cover Elite", not the
//   literal abbreviation "TC Elite" -- a Services-catalog search for "TC
//   Elite" returns nothing; the real branding is "Tech Cover Elite"
//   throughout (contracts, services, invoice descriptions alike).
// - "Tech Cover Elite" is a RECURRING SERVICE contract (contractType 7),
//   entirely separate from a same-client "T&M TC Elite [tier]" contract
//   (contractType 1, Time & Materials -- that one governs the default
//   service-desk hourly rate, and carries zero ContractServices/Units of
//   its own). The seat/unit billing this page reports on lives on the
//   "Tech Cover Elite" contract specifically.
// - Exactly three real Services carry the "Tech Cover Elite" branding in
//   this Autotask instance (confirmed via a Services-catalog search, not
//   guessed): id 207 "Tech Cover Elite - Managed Support Plan" (the main
//   seat line on almost every contract), id 471 "Tech Cover Elite
//   Discount/Credit", id 478 "Tech Cover Elite - Specialist Service".
const TC_ELITE_SERVICE_IDS = [207, 471, 478];

// Contracts literally named "Tech Cover Elite" (not a wildcard/contains
// match -- every real one confirmed to use this exact name), restricted
// to status 1 (In Effect) -- every such contract found against real data
// was already status 1, but this is still an explicit filter, not an
// assumption, so a future terminated one doesn't silently start showing.
async function fetchTcEliteContracts(client) {
  return listAll(client.contracts, [
    { op: 'eq', field: 'contractName', value: 'Tech Cover Elite' },
    { op: 'eq', field: 'status', value: 1 },
  ]);
}

// "Current" period, by request-equivalent reasoning ("count of units...
// for TC Elite services" reads as a present-tense snapshot, not a
// specific month) -- the ContractServiceUnits row whose own start/end
// date range actually contains TODAY (AEST calendar date, plain string
// comparison against the "YYYY-MM-DD" slice -- no AEST-offset conversion
// needed for the comparison itself, only for what "today" means, same as
// every other AEST-anchored date-only comparison on this dashboard).
// Every real contract checked had exactly one (or zero) such row per
// line, so "the" current period is well-defined in practice; if a line
// somehow has more than one (an Autotask data overlap), the LAST one
// found wins -- an edge case, not expected in real data.
function isCurrentPeriod(unit, today) {
  const startKey = unit.startDate.slice(0, 10);
  const endKey = unit.endDate.slice(0, 10);
  return startKey <= today && today <= endKey;
}

// The actual "who has TC Elite, how many seats" computation. Returns one
// row per company that currently has at least one qualifying line --
// "qualifying" meaning: on an active "Tech Cover Elite" contract, its
// underlying service is one of TC_ELITE_SERVICE_IDS, its CURRENT period
// exists, and that period's `price` is positive (excludes a $0 line --
// e.g. a placeholder/comment row -- and any credit/discount line that
// nets to zero or negative, by request: "count only the TC Elite lines
// on entries with a positive $ value").
//
// `units` is summed AS-IS across every qualifying line for that company,
// by request -- worth knowing honestly: on real contracts this is not
// always a literal "one unit = one person" count. A handful of real
// lines reuse the SAME service ID (207) under a custom
// invoiceDescription for a genuinely different kind of unit -- e.g. a
// server count or a website count, not a user seat -- rather than the
// usual "Managed Support Plan" per-user line. This is a deliberate first
// pass (see the README's own "Not yet built" section) that counts
// whatever `units` says on any TC-Elite-tagged line; a more refined
// "user seats only" rule (e.g. matching on invoiceDescription text, not
// just the service ID) is easy to layer on once this first pass has been
// reviewed against what it actually surfaces.
async function fetchTcEliteSeats() {
  const client = await getClient();
  const today = todayAestKey();

  const contracts = await fetchTcEliteContracts(client);
  const contractById = new Map(contracts.map((c) => [c.id, c]));
  const contractIds = contracts.map((c) => c.id);

  const allContractServices = contractIds.length > 0 ? await fetchByFieldIn(client.contractServices, 'contractID', contractIds) : [];
  const tcEliteContractServices = allContractServices.filter((cs) => TC_ELITE_SERVICE_IDS.includes(cs.serviceID));

  const csIds = tcEliteContractServices.map((cs) => cs.id);
  const allUnits = csIds.length > 0 ? await fetchByFieldIn(client.contractServiceUnits, 'contractServiceID', csIds) : [];
  const currentUnitByCsId = new Map();
  for (const u of allUnits) {
    if (isCurrentPeriod(u, today)) currentUnitByCsId.set(u.contractServiceID, u);
  }

  const byCompany = new Map(); // companyID -> { seats, totalPrice, lines: [] }
  for (const cs of tcEliteContractServices) {
    const contract = contractById.get(cs.contractID);
    const unit = currentUnitByCsId.get(cs.id);
    if (!contract || !unit || !(unit.price > 0)) continue;

    if (!byCompany.has(contract.companyID)) byCompany.set(contract.companyID, { seats: 0, totalPrice: 0, lines: [] });
    const entry = byCompany.get(contract.companyID);
    entry.seats += unit.units;
    entry.totalPrice += unit.price;
    entry.lines.push({
      // First line only -- some invoiceDescriptions here are long,
      // multi-paragraph service blurbs (see server.js's own note on
      // Contract Services for the identical pattern); the first line
      // alone is enough to tell one line item apart from another in this
      // page's own hover/detail view.
      description: (cs.invoiceDescription || '').split('\n')[0].trim() || null,
      units: unit.units,
      price: unit.price,
      periodStart: unit.startDate,
      periodEnd: unit.endDate,
    });
  }

  const companyIds = [...byCompany.keys()];
  await mapWithConcurrency(companyIds, 3, (id) => resolveCompanyName(client, id));

  const rows = [];
  for (const [companyId, entry] of byCompany.entries()) {
    rows.push({
      companyId,
      companyName: await resolveCompanyName(client, companyId),
      companyUrl: await getCompanyUrl(companyId),
      seats: entry.seats,
      totalPrice: entry.totalPrice,
      lines: entry.lines,
    });
  }
  // Most seats first, by request-equivalent reasoning (the biggest TC
  // Elite clients are the most useful to see at a glance) -- company name
  // as the tiebreak for a stable, predictable order among equal counts.
  rows.sort((a, b) => b.seats - a.seats || a.companyName.localeCompare(b.companyName));

  return { asOf: new Date().toISOString(), today, rows };
}

// Same reasoning Service Calls'/Today Things' own report caches give for
// their own short windows -- a contract change (a client added/removed,
// seats adjusted) should stop showing stale within the hour, not linger
// for this dashboard's more usual 20-minute default.
const CACHE_TTL_MS = 10 * 60 * 1000;
let cached = null; // { data, expiresAt }
let inFlight = null;

async function getTcEliteSeats(force) {
  if (!force && cached && Date.now() < cached.expiresAt) return cached.data;
  if (!inFlight) {
    inFlight = fetchTcEliteSeats()
      .then((data) => {
        cached = { data, expiresAt: Date.now() + CACHE_TTL_MS };
        return data;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const data = await getTcEliteSeats(req.query.force === 'true');
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
