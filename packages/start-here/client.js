export const id = "start-here";
export const label = "Start Here";

// External systems this dashboard doesn't cover -- opened in a new tab, not
// navigated to in place (leaving the dashboard entirely would be jarring
// for something meant as a quick jumping-off point). Grouped into named
// categories, by request (each its own .resource-group card + section
// heading, same visual convention the left column's own page-list groups
// already use -- see groupHtml() below). Every URL here is a real,
// confirmed login/portal URL supplied directly, OR a genuinely tenant-
// independent public tool's own homepage (One Time Secret/MX Toolbox/
// What's My DNS/Xero's login gate -- the same URL regardless of which
// account you sign into). `url: null` renders as a disabled-look
// placeholder (see externalLinkHtml below) rather than ever shipping a
// guessed tenant-specific login link that might be wrong for this
// specific account -- several entries below are still null for exactly
// that reason and need a real URL supplied.
//
// `icon` is a plain emoji, by request -- same lightweight-icon convention
// already used for the sidebar's own theme toggle ('☀️ Light Mode'/'🌙 Dark
// Mode' in app.js), not a real per-brand logo. Fetching each service's real
// favicon was deliberately not done -- would mean a live request out to
// dozens of different third-party domains just to render this page, for a
// purely cosmetic label decoration.
const EXTERNAL_LINK_GROUPS = [
  {
    label: 'Systems',
    links: [
      { label: 'Kaseya One', icon: '🖥️', url: 'https://one.kaseya.com/login?companyName=Ambient%20IT' },
      { label: 'AIT Intranet', icon: '🏢', url: 'https://ambientitptyltd.sharepoint.com/' },
      { label: 'Strety', icon: '📊', url: 'https://2.strety.com/714f93d7-437d-4d8d-a4f4-94f5da9c09ef/home' },
      { label: 'Rewst', icon: '🤖', url: 'https://app.rewst.asia/organizations/019f187a-5165-72c5-a370-e094207f9890/dashboard' },
    ],
  },
  {
    label: 'Monitoring',
    links: [
      // Antenna, not a floppy disk -- leans into the product's own "Radar" pun.
      { label: 'Backup Radar', icon: '📡', url: 'https://eu.backupradar.com/app/dashboard/tiles' },
      { label: 'Unifi Portal', icon: '📶', url: 'https://unifi.ui.com/' },
      { label: 'UNMS Portal', icon: '🔌', url: 'https://unms.ambientit.com.au/' },
    ],
  },
  {
    label: 'Services',
    links: [
      { label: 'Ingram Micro', icon: '🛒', url: 'https://au.ingrammicro.com/cep/app/home' },
      { label: 'Huntress', icon: '🛡️', url: 'https://ambient-it.huntress.io/account/command_center' },
      { label: 'AutoElevate', icon: '🔐', url: 'https://msp.autoelevate.com/login' },
      { label: 'EasyDMARC', icon: '✉️', url: 'https://app.easydmarc.com/dashboard' },
    ],
  },
  {
    label: 'Online Services',
    links: [
      { label: 'TPP Wholesale', icon: '🌐', url: 'https://www.tppwholesale.com.au/sign-in/' },
      { label: 'CloudFlare', icon: '☁️', url: 'https://dash.cloudflare.com/' },
      { label: 'WPEngine', icon: '🔧', url: 'https://my.wpengine.com/' },
    ],
  },
  {
    label: 'Internet & Telco',
    links: [
      { label: 'Access4-SasBoss', icon: '☎️', url: 'https://ambientit.sasboss.com.au' },
      { label: 'AussieBroadband', icon: '🐨', url: 'https://carbon.aussiebroadband.com.au/login' },
      // Loop pun.
      { label: 'Superloop', icon: '🔁', url: 'https://krypton.superloop.com/login' },
      // Wire/link pun.
      { label: 'Over the Wire', icon: '🔗', url: 'https://portal.overthewire.com.au/login' },
      // "Telco in a box" pun.
      { label: 'Telcoinabox (Octane)', icon: '📦', url: 'https://octane.telcoinabox.com/tiab/Login' },
    ],
  },
  {
    label: 'TOOLS',
    links: [
      { label: 'One Time Secret', icon: '🔒', url: 'https://onetimesecret.com/' },
      { label: 'Keeper Vault', icon: '🔑', url: 'https://keepersecurity.com/vault/' },
      { label: 'MX Toolbox', icon: '🧰', url: 'https://mxtoolbox.com/' },
      { label: "What's My DNS", icon: '🌍', url: 'https://www.whatsmydns.net/' },
      // Windows pun.
      { label: 'Microsoft Portals', icon: '🪟', url: 'https://msportals.io/?search=' },
    ],
  },
  {
    label: 'Finance/Admin',
    links: [
      // Fastway's login -- Fastway rebranded as Aramex in AU/NZ.
      { label: 'Aramex Shipping', icon: '🚚', url: 'https://identity.fastway.org/account/login' },
      { label: 'Xero Accounting', icon: '🧮', url: 'https://login.xero.com/' },
      { label: 'ZenContract', icon: '✍️', url: 'https://my.zencontract.com/edge?show2FAReminder=False' },
      // Hive pun.
      { label: 'GlassHive', icon: '🐝', url: 'https://app.glasshive.com/Marketing' },
    ],
  },
];

// One-line descriptions for the internal page list -- kept
// here rather than in each page's own package.json so adding this page
// didn't require touching all ~23 others. Deliberately NOT the single
// source of truth for which pages exist or what they're called, though --
// that's still `/pages-registry.js` + `/api/nav-layout` (fetched live below,
// same as the sidebar itself), so a page id with no entry here just shows
// with no description rather than silently vanishing from the list.

const PAGE_DESCRIPTIONS = {
  'whats-on': "Helpdesk Task Tracker, Your personal scorecards, and the Team Shifts quick viewer.",
  'my-strety-tasks': 'Your own open Strety to-dos, sorted by due date.',
  'service-calls': 'Month calendar of every Service Call, showing which technician is assigned.',
  'subscriptions-expiring': 'Ingram Micro subscriptions expiring in a chosen window -- a renewals watch-list.',
  'workshop': 'Workshop job/device board -- ticket, client, status, priority, and location, replacing the physical whiteboard.  Updates to Jobs will update the ticket. Adding a ticket number will apply the whole history to the ticket note. Changing a ticket number will not the change on the old ticket and update the new ticket',
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

// A curated "start your day" callout, by request -- distinct from (and
// separate to) PAGE_DESCRIPTIONS' plain one-liners below: What's On is
// featured prominently with the real detail of what to actually DO there
// (not just what it shows), then three more daily-check pages are called
// out underneath with their own short reason-to-check-it blurbs. Static,
// same "never lost or flashed away by a slow load" reasoning as INTRO_TEXT
// -- lives in mount()'s initial render, not the live-fetched #page-groups
// region. Hrefs are plain `#pageId` hash links, same in-app navigation
// convention as pageItemHtml() below, just hardcoded here since this is a
// fixed, curated list rather than the live/reconciled full page list.
const DAILY_CHECKLIST_HTML = `
  <div class="resource-group start-here-checklist">
    <div class="section-heading section-heading--nav">Daily Checklist</div>
    <div class="start-here-checklist-featured">
      <div class="start-here-checklist-col start-here-checklist-col-main">
        <a href="#whats-on" class="start-here-checklist-title">What's On</a>
        <p>Check this page for:</p>
        <ul>
          <li>Helpdesk Task Tracker, plus your own personal To Dos.
            <ul>
              <li>Complete any Helpdesk Daily, Weekly, Monthly metrics and Jobs.</li>
              <li>Jobs marked as <strong>AUTO:</strong> are managed/filled by automated processes.</li>
            </ul>
          </li>
          <li>Team Shifts: know who's On Call, who's Helpdesk Handler, who's away, etc.
            <ul>
              <li>Apply for leave in Autotask, but make sure it's also entered in Shifts.</li>
            </ul>
          </li>
        </ul>
        </br>
        <p class="start-here-checklist-subheading">Other Daily Activities -- check these dashboard pages:</p>
        <ul class="start-here-checklist-other">
          <li><a href="#service-calls">Service Calls</a> <span class="cell-subtext">-- what's scheduled in Autotask</span></li>
          <li><a href="#subscriptions-expiring">Subscriptions Expiring</a> <span class="cell-subtext">-- Ingram Micro / Microsoft licenses</span></li>
          <li><a href="#my-strety-tasks">My Strety Tasks</a> <span class="cell-subtext">-- your to-dos. Don't leave it till the last moment.</span></li>
        </ul>
      </div>
      <!-- Second column, by request -- a heading linking to the real
           Updates page (@dashboard/updates), plus a live excerpt of its
           most recent entries (fetched below -- see loadUpdatesExcerpt()).
           Its own .start-here-checklist-col class (shared with the main
           column above) carries the flex sizing; this one additionally
           gets the dividing border -- see styles.css. -->
      <div class="start-here-checklist-col start-here-checklist-col-updates">
        <a href="#updates" class="start-here-checklist-title">Recent Updates</a>
        <div id="updates-excerpt"><p class="status">Loading...</p></div>
      </div>
    </div>
  </div>
`;

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>About your Dashboards</h1>
    </header>
    <div class="start-here-layout">
      <div class="start-here-pages">
        <p class="status">${INTRO_TEXT}</p>
        ${DAILY_CHECKLIST_HTML}
        <div id="page-groups"><p class="status">Loading page list...</p></div>
      </div>
      <div class="start-here-links">
        ${EXTERNAL_LINK_GROUPS.map(externalLinkGroupHtml).join('')}
      </div>
    </div>
  `;

  loadPageList(container.querySelector('#page-groups'));
  loadUpdatesExcerpt(container.querySelector('#updates-excerpt'));
}

const UPDATES_EXCERPT_LIMIT = 5;

// Cross-page fetch to @dashboard/updates' own /recent route (returns
// content_html only, no images -- see that page's server.js) -- the same
// "cross-page call to that page's own route" convention What's On already
// uses for Service Calls, not a duplicated read of its data/DB.
async function loadUpdatesExcerpt(el) {
  try {
    const res = await fetch(`/api/updates/recent?limit=${UPDATES_EXCERPT_LIMIT}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    renderUpdatesExcerpt(el, data.entries);
  } catch {
    // Quiet failure -- this is a small callout on the way to the real
    // Updates page, not a page of its own; no real page-level Loading/Error
    // state is worth showing here just for this one column.
    el.innerHTML = '<p class="status">Recent updates unavailable.</p>';
  }
}

function renderUpdatesExcerpt(el, entries) {
  if (entries.length === 0) {
    el.innerHTML = '<p class="status">No updates yet.</p>';
    return;
  }
  el.innerHTML = `
    <ul class="start-here-updates-list">
      ${entries.map(updatesExcerptItemHtml).join('')}
    </ul>
    <div class="start-here-updates-footer"><a class="button-link button-link--small" href="#updates">Show All Updates</a></div>
  `;
}

// Only the FIRST line is a link (jumps straight to this entry on the real
// Updates page, via its own ?entry=<id> deep link -- see
// @dashboard/updates/client.js's scrollToDeepLinkedEntry()); the second, if
// there is one, is plain text underneath it, by request ("the first 2 lines
// only with a clickable on the first line"). The date, by request, is
// combined onto that same first line -- in brackets, right after the text
// -- rather than sitting on its own line above it.
function updatesExcerptItemHtml(entry) {
  const [line1, line2] = firstTwoTextLines(entry.contentHtml);
  const dateLabel = escapeHtml(formatShortDate(entry.entryDate));
  const line1Html = `<a class="start-here-update-link" href="/?entry=${encodeURIComponent(entry.id)}#updates">${escapeHtml(line1 || '(no details)')} <span class="start-here-update-date">(${dateLabel})</span></a>`;
  const line2Html = line2 ? `<div class="start-here-update-line2">${escapeHtml(line2)}</div>` : '';
  return `<li class="start-here-update-item">${line1Html}${line2Html}</li>`;
}

// Reads an update entry's rich HTML as up to 2 plain-text "lines" -- block
// boundaries (paragraphs/list items/line breaks, exactly what the rich text
// toolbar's own Bold/Underline/Bulleted-list/Link output produces) count as
// line breaks, not just wherever a long run of text happens to wrap on
// screen. Plain text, not HTML -- this excerpt intentionally drops
// formatting (bold/links/etc), which doesn't carry any real meaning at this
// compact a size.
function firstTwoTextLines(html) {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = html || '';
  wrapper.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
  // Inserted BEFORE each block element, not appended after it -- a
  // contenteditable's own FIRST line is commonly left as bare text with no
  // wrapping <p>/<div> at all (only lines added later, after pressing
  // Enter, get wrapped), so appending after each block left that leading
  // unwrapped run with no separator in front of the next block's text at
  // all -- confirmed the hard way ("the sample case is combining line 1
  // and line 2 into one"). Inserting before instead correctly separates
  // that leading text (wrapped or not) from whatever block follows it.
  wrapper.querySelectorAll('p, li, div').forEach((el) => el.before('\n'));
  return wrapper.textContent
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 2);
}

function formatShortDate(dateKey) {
  if (!dateKey) return '';
  const d = new Date(`${dateKey}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateKey;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

// Same .resource-group + .section-heading--nav card look the left
// column's own page-list groups use (see groupHtml() below) -- one card
// per named category, by request.
function externalLinkGroupHtml(group) {
  return `
    <div class="resource-group">
      <div class="section-heading section-heading--nav">${escapeHtml(group.label)}</div>
      <div class="start-here-buttons">
        ${group.links.map(externalLinkHtml).join('')}
      </div>
    </div>
  `;
}

function externalLinkHtml(link) {
  const iconHtml = link.icon ? `<span class="button-link-icon" aria-hidden="true">${link.icon}</span>` : '';
  if (!link.url) {
    // Not a real disabled <button> -- an <a> with no href isn't focusable/
    // clickable at all by default, which is enough here without extra ARIA.
    return `<span class="button-link button-link--pending" title="URL not confirmed yet">${iconHtml}${escapeHtml(link.label)}</span>`;
  }
  // Real popup window, not just a new tab -- same convention every other
  // external link on this dashboard uses.
  return `<a class="button-link" href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer" onclick="window.open(this.href, '_blank', 'noopener,noreferrer,width=1200,height=900'); return false;">${iconHtml}${escapeHtml(link.label)}</a>`;
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

    // Never list this page about itself, and never re-list What's On or
    // Updates -- both are already featured prominently in their own green
    // "Daily Checklist" callout above (DAILY_CHECKLIST_HTML, one column
    // each), so listing either again down here would just be redundant.
    // Adding them to `seen` up front (rather than a special-case check per
    // branch below) means this holds regardless of whether it's a
    // top-level page or gets dragged into a category later -- both the
    // `node.type === 'page'` branch and the leftovers fallback already
    // skip anything in `seen`.
    const seen = new Set([id, 'whats-on', 'updates']);
    const groups = [];
    for (const node of tree) {
      if (node.type === 'page') {
        if (node.id === id || seen.has(node.id) || !pagesById.has(node.id)) continue;
        seen.add(node.id);
        groups.push({ label: null, items: [pagesById.get(node.id)] });
      } else if (node.type === 'category') {
        // The whole Testing category (and everything in it) left off this
        // page's descriptions entirely, by request -- still marked `seen`
        // so none of its pages leak into the "Other" leftovers group
        // below either.
        if (node.id === 'testing') {
          node.children.forEach((c) => seen.add(c.id));
          continue;
        }
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
