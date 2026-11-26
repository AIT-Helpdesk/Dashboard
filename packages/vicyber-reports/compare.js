// Diffs two reports' own findings lists -- Fixed (present in the earlier
// report, gone from the later one) / New (the reverse) / Still Open (present
// in both). Keyed on category + device + title, the same normalized triple
// every finding already carries regardless of which of ViCyber's 4 very
// different sheets it came from (see parse.js/db.js's own comments) --
// there's no stable per-finding ID anywhere in a real ViCyber export to key
// on instead.
function keyFor(f) {
  return `${f.category}\u0000${f.device}\u0000${f.title}`;
}

// `earlier`/`later` are plain findings arrays (db.js's own
// listFindingsForReport() shape) -- which report is actually older is
// decided by the caller (server.js, by `uploaded_at`), not guessed here.
function diffFindings(earlier, later) {
  const earlierByKey = new Map(earlier.map((f) => [keyFor(f), f]));
  const laterByKey = new Map(later.map((f) => [keyFor(f), f]));

  const fixed = [];
  const stillOpen = [];
  for (const [key, f] of earlierByKey) {
    if (laterByKey.has(key)) stillOpen.push(laterByKey.get(key));
    else fixed.push(f);
  }
  const added = [];
  for (const [key, f] of laterByKey) {
    if (!earlierByKey.has(key)) added.push(f);
  }
  return { fixed, added, stillOpen };
}

module.exports = { diffFindings };
