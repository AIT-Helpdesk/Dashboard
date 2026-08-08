# @dashboard/technician-forms

Dashboard page: embeds the Rewst-hosted ROC Technician Forms portal (`ambientit-com-au-roc-technician-forms-portal.asia.rew.st`) directly in an iframe, plus an "Open in new tab" link.

- `client.js` - frontend module. Exports `id`, `label`, and `mount(container)`, picked up automatically by the shell. No `server.js` -- there's no backend of ours involved at all, just an iframe pointed at Rewst's own URL.

## Why this works

Confirmed before building this: the target site sends no `X-Frame-Options` or `Content-Security-Policy` header that would block itself from being framed by another origin. Without that check, embedding could silently fail (a blank iframe) regardless of anything on our side -- that's a decision the *target* site makes, not something any code here can override.

## Known limitation: third-party cookies

Modern browsers restrict third-party cookies inside iframes by default, to varying degrees depending on the browser. A site not specifically designed to be framed (most aren't) can have its login/session state silently fail to persist inside the iframe even though the page itself loads fine and framing isn't blocked. If Technician Forms seems to load but won't stay signed in, that's the likely cause -- the **"Open in new tab"** link is the fallback, since no framing-related cookie restriction applies to a normal top-level browser tab.

## Sizing

`.embedded-frame` (`packages/shell/public/styles.css`) is sized via `calc(100vh - 9rem)` -- an approximation of "fill the space below the page header," not a pixel-perfect calculation (the header's own height varies slightly with content), but close enough to read as a real full-height panel.
