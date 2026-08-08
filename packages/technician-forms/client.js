export const id = "technician-forms";
export const label = "Automation Forms";

// Rewst-hosted portal, embedded via iframe -- no backend of ours involved at
// all (no server.js in this package), just pointing an iframe at Rewst's own
// URL. Confirmed the site sends no X-Frame-Options/Content-Security-Policy
// header that would block being framed, before building this.
//
// Caveat worth knowing about if this ever seems to silently fail to log in
// inside the frame: modern browsers restrict third-party cookies inside
// iframes by default (stricter in some browsers than others), which can
// break session persistence for a site not designed with framing in mind,
// even though nothing here (or on Rewst's side) is explicitly blocking the
// frame itself. If that happens, opening EMBED_URL directly in its own
// browser tab is the fallback -- no framing-related restriction applies to
// a normal top-level tab.
const EMBED_URL = "https://ambientit-com-au-roc-technician-forms-portal.asia.rew.st/";

export function mount(container) {
  container.innerHTML = `
    <iframe
      src="${EMBED_URL}"
      title="Automation Forms Portal"
      class="embedded-frame"
    ></iframe>
  `;
}
