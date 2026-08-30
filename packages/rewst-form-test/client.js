export const id = "rewst-form-test";
export const label = "Rewst Form Test";

// Rewst-hosted form, embedded via iframe -- no backend of ours involved at
// all (no server.js in this package), just pointing an iframe at Rewst's own
// URL. Same pattern as technician-forms/client.js (see that file's own
// comment for the third-party-cookie caveat if the form ever seems to
// silently fail to hold a session inside the frame -- opening EMBED_URL
// directly in its own tab is the fallback).
const EMBED_URL = "https://ambientit-com-au-test-aw.asia.rew.st/s/home";

export function mount(container) {
  container.innerHTML = `
    <iframe
      src="${EMBED_URL}"
      title="Rewst Form Test"
      class="embedded-frame"
    ></iframe>
  `;
}
