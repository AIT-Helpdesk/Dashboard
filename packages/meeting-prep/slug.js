// Factored out of server.js into its own tiny module so ingest.js can
// require the exact same function without a circular require (server.js
// requires ingest.js for its own POST /ingest route; ingest.js needs this
// same slugify() to build the client-slug it writes data/*.json under --
// requiring server.js back from ingest.js would hit Node's circular-require
// partial-exports gap, since server.js hasn't finished setting
// module.exports = router by the time its own top-of-file requires run).
function slugify(s) {
  return (
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'site'
  );
}

module.exports = { slugify };
