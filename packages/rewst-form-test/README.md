# @dashboard/rewst-form-test

This looks like a one-off trial of embedding a Rewst-hosted form inside the dashboard shell, not a finished feature -- say so plainly. There's no backend of our own at all (no `server.js` in this package; `dashboardPage.external: true` in `package.json`); `client.js` just points an `<iframe>` at a fixed Rewst URL. That URL (`ambientit-com-au-test-aw.asia.rew.st`) is itself Rewst's own test/automation-workflow subdomain, not a production one, and both the page's own label and the id are "Rewst Form Test" -- nothing about this page is dressed up as anything other than a test.

- `client.js` - the entire package. Renders a single `<iframe>` pointed at `EMBED_URL`, a hardcoded Rewst form link.

## Iframe caveat

Same pattern -- and same caveat -- as `technician-forms/client.js`: a Rewst-hosted form embedded this way can silently fail to hold a session inside the frame if third-party cookies are blocked in the browser. If the form inside the iframe ever seems to do nothing, opening `EMBED_URL` directly in its own tab (rather than inside this dashboard) is the fallback.
