export const id = "start-here";
export const label = "Start Here";

// External systems this dashboard doesn't cover -- opened in a new tab, not
// navigated to in place (leaving the dashboard entirely would be jarring
// for something meant as a quick jumping-off point). `url: null` means the
// real login URL hasn't been confirmed yet -- rendered as a disabled-look
// placeholder rather than ever shipping a guessed link that might be wrong
// for this specific account/tenant.
const EXTERNAL_LINKS = [
  { label: 'Kaseya One', url: null },
  { label: "Ambient iT's SharePoint", url: null },
  { label: 'Ingram Micro', url: null },
  { label: 'Backup Radar', url: null },
  { label: 'AutoElevate', url: null },
  { label: 'Huntress', url: null },
  { label: 'EasyDMARC', url: null },
  { label: 'Access4', url: null },
  { label: 'Aussie Broadband', url: null },
  { label: 'TPP', url: null },
  { label: 'CloudFlare', url: 'https://dash.cloudflare.com/' },
  { label: 'WP Engine', url: 'https://my.wpengine.com/' },
];

// One-line descriptions for the internal page list -- kept
// here rather than in each page's own package.json so adding this page
// didn't require touching all ~23 others. Deliberately NOT the single
// source of truth for which pages exist or what they're called, though --
// that's still `/pages-registry.js` + `/api/nav-layout` (fetched live below,
// same as the sidebar itself), so a page id with no entry here just shows
// with no description rather than silently vanishing from the list.
const PAGE_DESCRIPTIONS = {
  'whats-on': "Helpdesk Task Tracker's Strety scorecards, plus your own personal ones.",
  'my-strety-tasks': 'Your own open Strety to-dos, sorted by due date.',
  'service-calls': 'Month calendar of every Service Call, showing which technician is assigned.',
  'subscriptions-expiring': 'Ingram Micro subscriptions expiring in a chosen window -- a renewals watch-list.',
  'technician-forms': 'The Rewst-hosted ROC Technician Forms portal, embedded directly.',
  'client-details': 'Look up clients by criteria, optionally filtered by name.',
  'client-contacts': 'Look up contacts across active clients -- primary, billing, or all.',
  'client-activity': "A client's ticket volume, logged hours, and open tickets over the last 12 months.",
  'classification-summary': 'Active client counts by classification, as a clickable bar chart.',
  'find-passwords': 'Search IT Glue password entries by name -- metadata only, never the password itself.',
  'asked-for-review': 'Tickets asked for a Google review in a chosen week.',
  'tickets-created-today': 'Every ticket created on a chosen date, grouped by company.',
  'completed-tickets': 'Every ticket completed on a chosen date, grouped by technician.',
  'ticket-times': 'Every ticket with time logged on a chosen date, grouped by technician.',
  'client-summary': "A single client's at-a-glance page -- details, financials, contracts, tickets, security alerts.",
  'contract-services': 'Active contract service/bundle items for a chosen month, by company.',
  'client-financials': "A client's 12-month invoiced-amounts summary and invoice list.",
  'ingram-subscriptions': 'Ingram Micro Cloud Marketplace subscriptions by client.',
  'ingram-orders': 'Ingram Micro Cloud Marketplace orders placed since a chosen date.',
  'm365-environment': "A client's Microsoft 365 tenant snapshot from IT Glue -- domains, licenses, admin roles.",
  'csp-customers': 'Every CSP customer and their Microsoft tenant ID.',
  'saasalerts-alerts': 'Medium/critical SaaS Alerts security events in a chosen window, across all customers.',
  'saasalerts-customers': 'Every customer under the SaaS Alerts partner account.',
};

const INTRO_TEXT =
  "This dashboard pulls together Autotask (tickets, clients, financials), Ingram Micro licensing, IT Glue, SaaS Alerts, and Strety scorecards into one place for Ambient iT's day-to-day work -- daily checks, client look-ups, and ticket/financial reporting, all in one app instead of jumping between systems.";

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>About your Dashboards</h1>
    </header>
    <div class="start-here-layout">
      <div class="start-here-pages">
        <p class="status">${INTRO_TEXT}</p>
        <div id="page-groups"><p class="status">Loading page list...</p></div>
      </div>
      <div class="start-here-links">
        <div class="start-here-buttons">
          ${EXTERNAL_LINKS.map(externalLinkHtml).join('')}
        </div>
      </div>
    </div>
  `;

  loadPageList(container.querySelector('#page-groups'));
}

function externalLinkHtml(link) {
  if (!link.url) {
    // Not a real disabled <button> -- an <a> with no href isn't focusable/
    // clickable at all by default, which is enough here without extra ARIA.
    return `<span class="button-link button-link--pending" title="URL not confirmed yet">${escapeHtml(link.label)}</span>`;
  }
  return `<a class="button-link" href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.label)}</a>`;
}

// Pulled live from the same two sources the sidebar itself uses
// (`/pages-registry.js` for id -> label, `/api/nav-layout` for the
// category grouping and page order) rather than a separately hardcoded
// page list -- so this stays in sync with the real sidebar automatically,
// the same "single source of truth" reasoning the sidebar's own
// reconcileTree() follows. Only the one-line descriptions above are
// maintained separately, since there's nowhere else on this dashboard that
// already holds them.
async function loadPageList(el) {
  try {
    const [{ pages }, navRes] = await Promise.all([import('/pages-registry.js'), fetch('/api/nav-layout')]);
    const nav = await navRes.json();
    const pagesById = new Map(pages.map((p) => [p.id, p]));
    const tree = Array.isArray(nav.tree) ? nav.tree : [];

    const seen = new Set([id]); // never list this page about itself
    const groups = [];
    for (const node of tree) {
      if (node.type === 'page') {
        if (node.id === id || seen.has(node.id) || !pagesById.has(node.id)) continue;
        seen.add(node.id);
        groups.push({ label: null, items: [pagesById.get(node.id)] });
      } else if (node.type === 'category') {
        const items = node.children.filter((c) => c.id !== id && !seen.has(c.id) && pagesById.has(c.id)).map((c) => {
          seen.add(c.id);
          return pagesById.get(c.id);
        });
        if (items.length) groups.push({ label: node.label, items });
      }
    }
    // Any registered page missing from the saved layout (freshly added,
    // never dragged into a category) -- same fallback reconcileTree() uses
    // in app.js, so a brand-new page still shows up here.
    const leftovers = pages.filter((p) => p.id !== id && !seen.has(p.id));
    if (leftovers.length) groups.push({ label: 'Other', items: leftovers });

    el.innerHTML = groups.map(groupHtml).join('') || '<p class="status">No other pages configured.</p>';
  } catch (err) {
    el.innerHTML = `<p class="status error">Couldn't load the page list: ${escapeHtml(err.message)}</p>`;
  }
}

function groupHtml(group) {
  const heading = group.label ? `<div class="section-heading section-heading--nav">${escapeHtml(group.label)}</div>` : '';
  return `
    <div class="resource-group">
      ${heading}
      <ul class="start-here-page-list">
        ${group.items.map(pageItemHtml).join('')}
      </ul>
    </div>
  `;
}

function pageItemHtml(page) {
  const description = PAGE_DESCRIPTIONS[page.id];
  return `
    <li>
      <a href="#${escapeHtml(page.id)}">${escapeHtml(page.label)}</a>
      ${description ? `<span class="cell-subtext">${escapeHtml(description)}</span>` : ''}
    </li>
  `;
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
