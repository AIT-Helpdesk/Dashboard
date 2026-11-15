const express = require('express');
const { getClient, listAll, fetchByFieldIn, getCompanyUrl, parseWildcard, matchesWildcard } = require('@dashboard/autotask-client');

// Contact Search -- a general-purpose lookup across every Autotask Contact
// (active and inactive both -- by design, a lookup tool shouldn't silently
// hide a real record just because the client/contact is no longer active;
// unlike Client Contacts, there's no "Show Inactive" toggle here because
// there's no reason to default it off in the first place), by request:
// "any first name, surname in one field for Name; phone number, which
// will search all phone fields and Address which will search street
// suburb/city; email/domain". Every field is optional, but at least one
// is required -- there's no "browse everyone" mode.
//
// Four search boxes, each matched OR-across-its-own-related-fields,
// ANDed together across boxes (so filling in both Name and Phone narrows
// to a contact matching BOTH, not either):
//   Name    -> firstName OR lastName
//   Phone   -> phone OR mobilePhone OR alternatePhone
//   Address -> addressLine OR addressLine1 OR city (street + suburb/city,
//              confirmed live these are the real Contacts fields --
//              Contacts has no separate "suburb" field, city covers it)
//   Email   -> emailAddress OR emailAddress2 OR emailAddress3 (typing
//              part of a domain, e.g. "acme.com.au", already works here
//              as a plain substring match -- no separate domain-only mode
//              needed)
//
// Wildcard by default (parseWildcard()'s own "no stars -> contains"
// convention, shared with every other search box on this dashboard) --
// confirmed live that Autotask's query API accepts a nested `{op: 'or',
// items: [...]}` filter group, so this whole search is ONE query, not one
// query per field.
const FIELD_GROUPS = {
  name: ['firstName', 'lastName'],
  phone: ['phone', 'mobilePhone', 'alternatePhone'],
  address: ['addressLine', 'addressLine1', 'city'],
  email: ['emailAddress', 'emailAddress2', 'emailAddress3'],
};

// "tickbox to go further and do a fuzzy search if required" -- ADDITIVE,
// not a replacement: the plain wildcard query above still runs every
// time; ticking Fuzzy just ALSO unions in close-but-not-quite matches a
// plain substring would have missed entirely (a typo, a transposed pair
// of digits in a phone number, "Rd" typed for a stored "Road"). Fuzzy
// matching can't be expressed as an Autotask query filter at all, so it
// works the opposite way around from the wildcard path: fetch EVERY
// contact once (cached -- confirmed live this account has ~6,100 active
// contacts alone, ~7s to fetch in full, too slow to redo on every
// keystroke-driven search but fine cached for a few minutes), then score
// each one in plain JS.
//
// Same plain Levenshtein-ratio-with-substring-bonus approach
// @dashboard/data-matching's own fuzzySimilarity() already uses and
// already proved out against real misses there -- copied rather than
// imported since that function lives inside that page's own server.js,
// not exported from a shared package (matching that file's own "plain
// calendar-day arithmetic... copied rather than imported" precedent for
// small page-local algorithms with no shared home yet).
function levenshteinDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[n];
}
function normalizeForFuzzyMatch(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function fuzzySimilarity(typed, candidate) {
  const a = normalizeForFuzzyMatch(typed);
  const b = normalizeForFuzzyMatch(candidate);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (b.includes(a) || a.includes(b)) return 0.95;
  const aCollapsed = a.replace(/ /g, '');
  const bCollapsed = b.replace(/ /g, '');
  if (bCollapsed.includes(aCollapsed) || aCollapsed.includes(bCollapsed)) return 0.85;
  const spacedRatio = 1 - levenshteinDistance(a, b) / Math.max(a.length, b.length);
  const collapsedRatio = 1 - levenshteinDistance(aCollapsed, bCollapsed) / Math.max(aCollapsed.length, bCollapsed.length);
  return Math.max(spacedRatio, collapsedRatio);
}
const FUZZY_MIN_SIMILARITY = 0.5;

// Phone numbers ignore spaces on either side of the match, by request --
// "0412 345 678" and "0412345678" should find each other regardless of
// which way round the stored value and the typed term are formatted.
// Autotask's query filter has no such normalization (its `contains` is a
// literal substring check against whatever's actually stored), so this
// can't be expressed as an Autotask filter at all -- whenever Phone is
// filled in, the WHOLE search runs against the full cached contact list
// below instead of a direct query, same mechanism the Fuzzy Search
// tickbox already uses, just triggered by which box is filled in rather
// than by a checkbox.
function stripSpaces(s) {
  return (s || '').replace(/\s+/g, '');
}
function matchesPhoneWildcard(value, term) {
  const parsed = parseWildcard(term);
  if (!parsed) return true;
  const v = stripSpaces(value).toLowerCase();
  const needle = stripSpaces(parsed.value).toLowerCase();
  if (parsed.op === 'beginsWith') return v.startsWith(needle);
  if (parsed.op === 'endsWith') return v.endsWith(needle);
  return v.includes(needle);
}

// One box's own match test against one contact -- `fuzzy` only ever
// loosens this (adds the Levenshtein fallback on top of the wildcard/
// phone-wildcard check), never narrows it. Shared by both the phone-
// present full-scan path and the Fuzzy Search union below, so the two
// "evaluate everyone in JS" cases can't quietly drift apart.
function boxMatches(contact, key, term, fuzzy) {
  if (!term) return true; // this box wasn't filled in -- doesn't constrain this contact
  const fields = FIELD_GROUPS[key];
  if (key === 'phone') {
    return fields.some((field) => {
      const value = contact[field] || '';
      if (!value) return false;
      if (matchesPhoneWildcard(value, term)) return true;
      return fuzzy && fuzzySimilarity(stripSpaces(term), stripSpaces(value)) >= FUZZY_MIN_SIMILARITY;
    });
  }
  return fields.some((field) => {
    const value = contact[field] || '';
    if (!value) return false;
    if (matchesWildcard(value, term)) return true;
    return fuzzy && fuzzySimilarity(term, value) >= FUZZY_MIN_SIMILARITY;
  });
}

// Full-table cache for the phone and fuzzy paths -- the plain wildcard
// path (no Phone, no Fuzzy Search) never needs this, it queries Autotask
// directly every time (same "narrow at the API, not in JS" approach every
// other search box on this dashboard uses). 10-min TTL, shorter than most
// of this dashboard's other full-scan caches (usually 20 min) since a
// freshly-edited contact (the exact kind of record someone's actively
// searching for right after fixing it) should show up again reasonably
// quickly.
const ALL_CONTACTS_TTL_MS = 10 * 60 * 1000;
let allContactsCache = null; // { data, expiresAt }
let allContactsInFlight = null;
async function getAllContacts(client) {
  if (allContactsCache && Date.now() < allContactsCache.expiresAt) return allContactsCache.data;
  if (!allContactsInFlight) {
    allContactsInFlight = listAll(client.contacts, [{ op: 'gte', field: 'id', value: 0 }])
      .then((data) => {
        allContactsCache = { data, expiresAt: Date.now() + ALL_CONTACTS_TTL_MS };
        return data;
      })
      .finally(() => {
        allContactsInFlight = null;
      });
  }
  return allContactsInFlight;
}

const router = express.Router();

router.get('/', async (req, res) => {
  const terms = {
    name: (req.query.name || '').trim(),
    phone: (req.query.phone || '').trim(),
    address: (req.query.address || '').trim(),
    email: (req.query.email || '').trim(),
  };
  const fuzzy = req.query.fuzzy === 'true';
  const activeOnly = req.query.activeOnly === 'true';

  if (!terms.name && !terms.phone && !terms.address && !terms.email) {
    return res.status(400).json({ error: 'Enter at least one of Name / Phone / Address / Email to search.' });
  }

  try {
    const client = await getClient();

    let matched;
    if (terms.phone) {
      // Phone's own space-insensitivity can't be expressed as an Autotask
      // filter (see matchesPhoneWildcard() above) -- once Phone is
      // filled in, EVERY box is evaluated in JS against the full cached
      // contact list instead of a direct query, rather than querying
      // Autotask for the other boxes and then ALSO scanning everyone for
      // Phone (that would mean two different code paths deciding what
      // "matches", an easy way for them to quietly disagree).
      const allContacts = await getAllContacts(client);
      matched = allContacts.filter((c) => Object.keys(FIELD_GROUPS).every((key) => boxMatches(c, key, terms[key], fuzzy)));
    } else {
      // The fast path -- one Autotask query, AND across whichever of
      // Name/Address/Email were filled in, OR within each box's own
      // related fields.
      const filter = [];
      for (const [key, fields] of Object.entries(FIELD_GROUPS)) {
        const term = terms[key];
        if (!term) continue;
        const wildcard = parseWildcard(term);
        if (!wildcard) continue; // a term that's JUST "*"/"**" etc parses to null -- nothing left to filter on
        filter.push({ op: 'or', items: fields.map((field) => ({ op: wildcard.op, field, value: wildcard.value })) });
      }
      const wildcardMatches = filter.length > 0 ? await listAll(client.contacts, filter) : [];

      // The "go further" path -- only when ticked, additive to the above.
      let fuzzyMatches = [];
      if (fuzzy) {
        const allContacts = await getAllContacts(client);
        fuzzyMatches = allContacts.filter((c) => Object.keys(FIELD_GROUPS).every((key) => boxMatches(c, key, terms[key], true)));
      }

      const byId = new Map();
      for (const c of wildcardMatches) byId.set(c.id, c);
      for (const c of fuzzyMatches) if (!byId.has(c.id)) byId.set(c.id, c);
      matched = [...byId.values()];
    }

    // "Ignore Inactive Contacts and Clients" -- Contacts.isActive first
    // (cheap, no extra fetch needed), the company's own isActive after
    // the company lookup below (a contact can be active while their own
    // company is inactive -- confirmed real shape elsewhere on this
    // dashboard, e.g. Client Contacts' own isActive handling -- so both
    // need checking, not just one or the other).
    if (activeOnly) matched = matched.filter((c) => c.isActive === 1);

    if (matched.length === 0) {
      return res.json({ ...terms, fuzzy, activeOnly, totalCount: 0, contacts: [] });
    }

    const companyIds = [...new Set(matched.map((c) => c.companyID).filter((v) => v !== null && v !== undefined))];
    const companies = companyIds.length > 0 ? await fetchByFieldIn(client.companies, 'id', companyIds) : [];
    const companiesById = new Map(companies.map((c) => [c.id, c]));

    if (activeOnly) {
      matched = matched.filter((c) => {
        const company = companiesById.get(c.companyID);
        return !company || company.isActive !== false; // no company on record -- nothing to exclude on
      });
    }

    const rows = [];
    for (const c of matched) {
      const company = companiesById.get(c.companyID);
      rows.push({
        contactId: c.id,
        companyId: c.companyID ?? null,
        companyName: company ? company.companyName : null,
        companyUrl: company ? await getCompanyUrl(company.id) : null,
        firstName: c.firstName,
        lastName: c.lastName,
        email: c.emailAddress || null,
        phone: c.phone || null,
        mobilePhone: c.mobilePhone || null,
        alternatePhone: c.alternatePhone || null,
        addressLine: c.addressLine || null,
        addressLine1: c.addressLine1 || null,
        city: c.city || null,
        isActive: c.isActive === 1,
      });
    }
    rows.sort((a, b) => (a.companyName || '').localeCompare(b.companyName || '') || (a.lastName || '').localeCompare(b.lastName || ''));

    res.json({ ...terms, fuzzy, activeOnly, totalCount: rows.length, contacts: rows });
  } catch (err) {
    console.error('Contact Search failed:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
