export const id = "dns-check";
export const label = "DNS Check";

// Module-scope, not inside mount() -- the shell tears down/re-mounts the DOM
// on every nav, but this module stays alive for the session, so the last
// search restores instantly instead of coming back blank.
let lastDomain = '';
let lastData = null;
let activeRender = null;
// Certificate Transparency (crt.sh) toggle, by request -- on by default,
// remembered across re-mounts same as lastDomain above.
let lastCtEnabled = true;

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// By request -- bolds every occurrence of "easydmarc" (case-insensitive,
// original casing preserved) wherever it shows up in the page's own text.
// Applied AFTER escapeHtml() everywhere it's used below -- "easydmarc"
// itself has no characters escapeHtml would touch, so matching it in the
// already-escaped string is exactly equivalent to matching the raw value.
function boldEasyDmarc(html) {
  return html.replace(/easydmarc/gi, (match) => `<strong>${match}</strong>`);
}

// Content-based, not info-string-based -- the guess-based path tags a TXT
// record's own `info` as 'SPF', but the Cloudflare-sourced path doesn't
// always carry that same label through, and this needs to work identically
// regardless of which path produced the entry. Checking the record's own
// value directly works either way.
function isSpfRecord(entry) {
  return entry.type === 'TXT' && /v=spf/i.test(entry.value);
}

// SPF's own syntax is a space-separated list of directives/mechanisms
// ("v=spf1 include:_spf.google.com ~all") -- by request, broken apart and
// listed vertically (one per line) in its Value cell rather than as one
// long run-on string.
function spfValueHtml(value) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => boldEasyDmarc(escapeHtml(token)))
    .join('<br>');
}

function entryValueHtml(entry) {
  if (isSpfRecord(entry)) return spfValueHtml(entry.value);
  return boldEasyDmarc(escapeHtml(entry.value));
}

// Green-highlighted rows, by request -- narrowed down to just the mail
// security items: every DKIM record (name contains "._domainkey."), the
// _dmarc record, and the SPF record. (Previously also covered the root A
// record(s), www, and MX -- dropped per request, mail security only now.)
function shouldHighlightGreen(entry, domain) {
  const name = entry.name.toLowerCase();
  const d = domain.toLowerCase();
  if (name.includes('._domainkey.')) return true; // DKIM
  if (name === `_dmarc.${d}` || name.startsWith('_dmarc.')) return true; // DMARC
  if (isSpfRecord(entry)) return true; // SPF
  return false;
}

export function mount(container) {
  // Scopes this page's own table-sizing overrides below (dns-check-page in
  // styles.css) without touching the generic table/th/td rules every other
  // page on the dashboard relies on.
  container.classList.add('dns-check-page');
  container.innerHTML = `
    <header class="page-header">
      <h1>DNS Check</h1>
      <form id="filter-form" class="date-form">
        <label for="domain-input">Domain</label>
        <input type="text" id="domain-input" name="domain" placeholder="e.g. example.com" required />
        <label for="ct-toggle-input" class="inline-checkbox-label">
          <input type="checkbox" id="ct-toggle-input" /> Check Certificate Transparency (crt.sh)
        </label>
        <button type="submit" id="search-button">Check</button>
      </form>
    </header>
    <p id="status" class="status">Enter a domain.</p>
    <div id="summary" class="summary" hidden></div>
    <div id="results" class="results"></div>
  `;

  const form = container.querySelector('#filter-form');
  const domainInput = container.querySelector('#domain-input');
  const ctToggleInput = container.querySelector('#ct-toggle-input');
  const searchButton = container.querySelector('#search-button');
  const statusEl = container.querySelector('#status');
  const summaryEl = container.querySelector('#summary');
  const resultsEl = container.querySelector('#results');

  if (lastDomain) domainInput.value = lastDomain;
  ctToggleInput.checked = lastCtEnabled;

  activeRender = render;

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    load(domainInput.value, ctToggleInput.checked);
  });

  resultsEl.addEventListener('click', (e) => {
    const lookupBtn = e.target.closest('.dns-check-lookup-btn');
    if (lookupBtn) { handleLookupClick(lookupBtn); return; }
    const propagationBtn = e.target.closest('.dns-check-propagation-btn');
    if (propagationBtn) handlePropagationClick(propagationBtn);
  });

  async function load(domain, ctEnabled) {
    searchButton.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = `Looking up "${domain}"...`;
    summaryEl.hidden = true;
    resultsEl.innerHTML = '';

    try {
      const params = new URLSearchParams({ domain, ct: ctEnabled ? 'true' : 'false' });
      const res = await fetch(`/api/dns-check?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastDomain = domain;
      lastCtEnabled = ctEnabled;
      lastData = data;
      activeRender(data);
    } catch (err) {
      // render() hides statusEl as its very first line, before it can throw
      // -- unhide it here too, or a bug inside render() fails completely
      // silently instead of showing this message.
      statusEl.hidden = false;
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      searchButton.disabled = false;
    }
  }

  function render(data) {
    statusEl.hidden = true;
    summaryEl.hidden = false;

    const nsHasRecords = data.ns.ok && data.ns.records.length > 0;
    if (data.entries.length === 0 && !nsHasRecords) {
      summaryEl.innerHTML = `<span class="status error">No DNS records of any kind found for "${escapeHtml(data.domain)}" -- it may not exist, or its DNS may not be configured yet.</span>`;
      resultsEl.innerHTML =
        topNoteHtml(data.source) + certTransparencyNoteHtml(data.certTransparency) + registrationHtml(data.registration) + soaHtml(data.soa);
      return;
    }

    summaryEl.innerHTML = `<span class="inline-subtext"><strong>${escapeHtml(data.domain)}</strong> -- as of ${formatDateTime(data.asOf)}</span>`;

    const tableHtml =
      data.entries.length > 0
        ? `
      <div class="resource-group">
        <div class="resource-group-header"><span>DNS Records</span><span class="count">${data.entries.length}</span></div>
        <table class="dns-check-entries-table">
          <thead>
            <tr><th></th><th>Type</th><th>Name</th><th>Value</th></tr>
          </thead>
          <tbody>
            ${data.entries.map((e, i) => entryRowHtml(e, data.domain, i)).join('')}
          </tbody>
        </table>
      </div>`
        : '';

    resultsEl.innerHTML =
      topNoteHtml(data.source) +
      certTransparencyNoteHtml(data.certTransparency) +
      registrationHtml(data.registration) +
      nsHtml(data.ns, data.hoster, data.domain) +
      nsButtonsHtml(data) +
      tableHtml +
      notFoundHtml(data.notFound) +
      soaHtml(data.soa);
  }

  // TPP Wholesale / Cloudflare quick-link buttons, by request -- placed
  // right after the Name Servers box in the HTML above, which (like
  // Domain Registration/Name Servers themselves) lands beside it rather
  // than below, since all three share the same inline-block/vertical-
  // align:top treatment (.dns-check-compact-table / .dns-check-ns-buttons).
  // Same button markup/classes as What's On's own external-system quick
  // links (externalLinkHtml() in whats-on/client.js) -- a plain, not
  // per-domain/per-account, portal login URL for each, since neither TPP
  // nor Cloudflare has a way to deep-link straight to one specific
  // domain's own management screen.
  //
  // TPP Wholesale: shown when this domain's real registrar (Domain
  // Registration's own Registrar field, from getRegistrationInfo() in
  // server.js) is tagged "(TPP)" -- our own accredited-registrar tag,
  // not just "DNS happens to be hosted at tppwholesale.com.au" (that's
  // the separate Cloudflare-style source/hoster check TPP's own
  // nsHtml() hoster guess already covers).
  //
  // Cloudflare: shown when data.source === 'cloudflare' -- this request
  // already came back as a complete record set pulled live from one of
  // OUR discovered Cloudflare accounts (cloudflareFindZone() in
  // server.js tries every one of them), exactly "any one of our
  // Cloudflare accounts". Independent of the TPP check above -- a domain
  // can be registered through our TPP account while its DNS is hosted on
  // our Cloudflare, so both buttons can show together.
  function nsButtonsHtml(data) {
    const isTppRegistrar = !!(data.registration && data.registration.registrar && /\(TPP\)/.test(data.registration.registrar));
    const isOurCloudflare = data.source === 'cloudflare';
    if (!isTppRegistrar && !isOurCloudflare) return '';
    const buttons = [];
    if (isTppRegistrar) buttons.push(externalLinkHtml({ label: 'TPP Wholesale', icon: '🌐', url: 'https://www.tppwholesale.com.au/sign-in/' }));
    if (isOurCloudflare) buttons.push(externalLinkHtml({ label: 'CloudFlare', icon: '☁️', url: 'https://dash.cloudflare.com/' }));
    return `<div class="dns-check-ns-buttons"><div class="start-here-buttons">${buttons.join('')}</div></div>`;
  }

  // Same markup as whats-on/client.js's own externalLinkHtml() -- kept as
  // a second copy rather than a shared import, matching how every other
  // small rendering helper on this dashboard stays local to its own
  // page's client.js.
  function externalLinkHtml(link) {
    const iconHtml = link.icon ? `<span class="button-link-icon" aria-hidden="true">${link.icon}</span>` : '';
    return `<a class="button-link" href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer" onclick="window.open(this.href, '_blank', 'noopener,noreferrer,width=1200,height=900'); return false;">${iconHtml}${escapeHtml(link.label)}</a>`;
  }

  // Registrar + expiry date, by request -- shown above the Name Servers
  // section, since "who's the registrar" is a different question from "who
  // serves the DNS" (see getRegistrationInfo in server.js: a domain can be
  // DNS-hosted on Cloudflare but still registered through our own TPP
  // Wholesale reseller account, or vice versa). Omitted entirely rather than
  // shown with blank fields when neither TPP nor a public WHOIS lookup
  // turned up anything at all.
  function registrationHtml(registration) {
    if (!registration) return '';
    const hasNameServers = registration.nameServers && registration.nameServers.length > 0;
    if (!registration.registrar && !registration.expiryDate && !hasNameServers) return '';
    // No lookup/propagation icons here, by request -- those live once, in
    // the Name Servers section below, rather than repeated before every
    // nameserver (both sections would otherwise be checking the exact same
    // thing -- this domain's own NS records -- which only needs asking
    // once per page, not once per row).
    const nameServersCell = hasNameServers
      ? registration.nameServers.map((ns) => boldEasyDmarc(escapeHtml(ns))).join('<br>')
      : '<span class="inline-subtext">Unknown</span>';
    return `
      <div class="resource-group dns-check-compact-table">
        <div class="resource-group-header"><span>Domain Registration</span></div>
        <table>
          <tbody>
            <tr><th>Registrar</th><td>${registration.registrar ? boldEasyDmarc(escapeHtml(registration.registrar)) : '<span class="inline-subtext">Unknown</span>'}</td></tr>
            <tr><th>Expiry Date</th><td>${registration.expiryDate ? escapeHtml(registration.expiryDate) : '<span class="inline-subtext">Unknown</span>'}</td></tr>
            <tr><th>Registered Name Servers</th><td>${nameServersCell}</td></tr>
          </tbody>
        </table>
      </div>`;
  }

  // Cloudflare-sourced data is the real, complete record set pulled
  // straight from Cloudflare's own API (we manage this domain's DNS
  // ourselves), so the usual "this is only a guess" warning would be
  // actively wrong here -- swapped for a plain confirmation note instead.
  // Otherwise (the normal case), the DKIM/Microsoft 365/mail security
  // checks really are best-effort against a curated list of known
  // selectors/names, not an exhaustive scan of every record that could
  // exist for a domain, so the warning stays.
  function topNoteHtml(source) {
    if (source === 'cloudflare') {
      return '<p class="inline-subtext dns-check-disclaimer">This domain is managed in our Cloudflare account -- showing the complete record set pulled directly from Cloudflare, not a guess.</p>';
    }
    if (source === 'tpp') {
      return '<p class="inline-subtext dns-check-disclaimer">This domain is managed in our TPP Wholesale reseller account -- showing the complete record set pulled directly from TPP, not a guess.</p>';
    }
    return '<p class="inline-subtext dns-check-disclaimer"><strong class="dns-check-disclaimer-warning">Beware</strong>: This is not a complete list of DNS records. We are only querying known common records.</p>';
  }

  // Certificate Transparency (crt.sh) -- by request, to catch unusual/custom
  // hostnames the curated lists above wouldn't think to check. Any entries
  // it actually found are already merged straight into the main table
  // server-side (tagged "Found via Certificate Transparency" in Other
  // Info); this is just the summary line about the lookup itself.
  function certTransparencyNoteHtml(ct) {
    if (!ct) return '';
    if (!ct.ok) {
      return `<p class="inline-subtext dns-check-section-note">Certificate Transparency lookup (crt.sh) unavailable: ${escapeHtml(ct.error)}.</p>`;
    }
    if (ct.totalDiscovered === 0) {
      return '<p class="inline-subtext dns-check-section-note">Certificate Transparency (crt.sh): no additional hostnames discovered beyond what\'s already checked above.</p>';
    }
    const truncatedPart = ct.truncated ? ` (checked the first ${ct.checkedCount} of ${ct.totalDiscovered} -- capped to keep this page responsive)` : '';
    // "Hostnames discovered" and "DNS records found" are deliberately
    // different numbers, called out separately -- one hostname can carry
    // several records (a CNAME plus multiple load-balanced A records), so
    // the record count is routinely higher than the hostname count. Phrased
    // this way after it read as contradictory ("1 hostname... 5 resolving?")
    // when both were just run together in one sentence.
    return `<p class="inline-subtext dns-check-section-note">Certificate Transparency (crt.sh): ${ct.totalDiscovered} additional hostname${ct.totalDiscovered === 1 ? '' : 's'} discovered${truncatedPart} -- ${ct.foundCount} DNS record${ct.foundCount === 1 ? '' : 's'} across ${ct.totalDiscovered === 1 ? 'it' : 'them'} still resolving today.</p>`;
  }

  // The live-lookup (per-row DNS check) and propagation-check (several
  // public resolvers, see server.js) icon pair -- shared by the main
  // entries table below, the Name Servers section, and Domain
  // Registration's own Registered Name Servers row, since all three show
  // real DNS record values that can come from Cloudflare/TPP's own stored
  // config rather than a live query, equally worth double-checking anywhere
  // they appear. `rowId` just has to be unique within its own immediate
  // <tbody> (see handleLookupClick's toggle below), not page-wide.
  function lookupIconsHtml(type, name, rowId) {
    const lookupBtn = `<button type="button" class="dns-check-lookup-btn" data-row-id="${rowId}" data-type="${escapeHtml(type)}" data-name="${escapeHtml(name)}" title="Check this record against live DNS">&#128269;</button>`;
    const propagationBtn = `<button type="button" class="dns-check-propagation-btn" data-type="${escapeHtml(type)}" data-name="${escapeHtml(name)}" title="Check DNS propagation across public resolvers">&#127760;</button>`;
    return `${lookupBtn}${propagationBtn}`;
  }

  function entryRowHtml(entry, domain, rowIndex) {
    const infoPart = entry.info ? `<br><span class="dns-check-info-inline">[${boldEasyDmarc(escapeHtml(entry.info))}]</span>` : '';
    const nameHtml = boldEasyDmarc(escapeHtml(entry.name));
    const nameCell = shouldHighlightGreen(entry, domain) ? `<span class="dns-check-highlight-name">${nameHtml}</span>` : nameHtml;
    return `
      <tr data-row-id="${rowIndex}">
        <td>${lookupIconsHtml(entry.type, entry.name, rowIndex)}</td>
        <td>${escapeHtml(entry.type)}</td>
        <td>${nameCell}</td>
        <td>${entryValueHtml(entry)}${infoPart}</td>
      </tr>`;
  }

  // Click handler for the lookup icon above -- event-delegated on resultsEl
  // (attached once in mount(), see below) since the table itself gets torn
  // down and rebuilt on every render(). Clicking a second time collapses
  // the result row back out, same toggle convention as most expandable rows
  // elsewhere on this dashboard.
  async function handleLookupClick(btn) {
    const tr = btn.closest('tr');
    const rowId = tr.dataset.rowId;
    const existing = tr.parentElement.querySelector(`tr.dns-check-lookup-result[data-row-id="${rowId}"]`);
    if (existing) {
      existing.remove();
      return;
    }

    const type = btn.dataset.type;
    const name = btn.dataset.name;
    btn.disabled = true;
    const resultTr = document.createElement('tr');
    resultTr.className = 'dns-check-lookup-result';
    resultTr.dataset.rowId = rowId;
    const colCount = tr.children.length;
    resultTr.innerHTML = `<td colspan="${colCount}"><span class="inline-subtext">Checking live DNS&hellip;</span></td>`;
    tr.insertAdjacentElement('afterend', resultTr);

    try {
      const params = new URLSearchParams({ type, name });
      const res = await fetch(`/api/dns-check/live-lookup?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      const liveHtml =
        data.records.length > 0
          ? data.records.map((r) => boldEasyDmarc(escapeHtml(r))).join('<br>')
          : '<span class="inline-subtext">No live record found.</span>';
      resultTr.innerHTML = `<td colspan="${colCount}"><span class="inline-subtext">Live DNS result for <strong>${escapeHtml(name)}</strong> (${escapeHtml(type)}):</span><br>${liveHtml}</td>`;
    } catch (err) {
      resultTr.innerHTML = `<td colspan="${colCount}"><span class="status error">Live lookup failed: ${escapeHtml(err.message)}</span></td>`;
    } finally {
      btn.disabled = false;
    }
  }

  // Propagation-check popup -- a plain new window (by request) rather than
  // an in-page modal, so it can sit next to the main page while comparing.
  // Self-contained inline styles since window.open() gives a blank document
  // with none of this dashboard's own stylesheet -- small text and tight
  // row heights, by request, since this is a dense comparison table, not a
  // page someone reads line by line.
  function propagationPopupHtml(type, name, results) {
    const rows = results
      .map((r) => {
        let resultHtml;
        if (!r.ok) {
          resultHtml = `<span class="pc-error">${escapeHtml(r.error)}</span>`;
        } else if (r.records.length === 0) {
          resultHtml = '<span class="pc-empty">No record</span>';
        } else {
          resultHtml = r.records.map((v) => escapeHtml(v)).join('<br>');
        }
        return `<tr><td>${escapeHtml(r.label)}</td><td>${escapeHtml(r.ip)}</td><td>${resultHtml}</td></tr>`;
      })
      .join('');
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>DNS Propagation -- ${escapeHtml(name)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif; margin: 12px; font-size: 0.72rem; color: #222; }
  h1 { font-size: 0.85rem; margin: 0 0 8px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 2px 8px; border-bottom: 1px solid #e2e2e2; vertical-align: top; line-height: 1.15; }
  th { font-size: 0.68rem; color: #666; font-weight: 600; }
  .pc-empty { color: #999; font-style: italic; }
  .pc-error { color: #b00020; }
</style>
</head>
<body>
  <h1>${escapeHtml(name)} &ndash; ${escapeHtml(type)}</h1>
  <table>
    <thead><tr><th>Resolver</th><th>IP</th><th>Result</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;
  }

  async function handlePropagationClick(btn) {
    const type = btn.dataset.type;
    const name = btn.dataset.name;
    btn.disabled = true;
    try {
      const params = new URLSearchParams({ type, name });
      const res = await fetch(`/api/dns-check/propagation-check?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      const popup = window.open('', '_blank', 'width=480,height=420');
      if (!popup) {
        alert('Please allow popups for this site to see the propagation check results.');
        return;
      }
      popup.document.write(propagationPopupHtml(type, name, data.results));
      popup.document.close();
    } catch (err) {
      alert(`Propagation check failed: ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  }

  // NS records get their own section at the very top, by request, with the
  // hoster guess (if any) right next to this heading rather than in the
  // page-level summary line.
  function nsHtml(result, hoster, domain) {
    const hosterPart = hoster ? ` &ndash; ${escapeHtml(hoster)}` : '';
    let body;
    if (result.ok && result.records.length > 0) {
      // One icon pair for the whole section, by request -- not one per
      // nameserver, since every row would be checking the exact same thing
      // (this domain's own NS records). Its own row at the top of the
      // table, rather than the section header, so it can reuse the plain
      // tr-based result-insertion handleLookupClick already does for the
      // main entries table, unchanged.
      const checkRow = `<tr data-row-id="ns-check"><td>${lookupIconsHtml('NS', domain, 'ns-check')} <span class="inline-subtext">Check this domain's NS records</span></td></tr>`;
      body = `
        <table>
          <tbody>
            ${checkRow}
            ${result.records.map((host) => `<tr><td>${boldEasyDmarc(escapeHtml(host))}</td></tr>`).join('')}
          </tbody>
        </table>`;
    } else if (result.ok || result.code === 'ENOTFOUND' || result.code === 'ENODATA') {
      body = '<p class="inline-subtext dns-check-section-note">No NS records.</p>';
    } else {
      body = `<p class="status error dns-check-section-note">Lookup failed: ${escapeHtml(result.message || result.code)}</p>`;
    }
    return `
      <div class="resource-group dns-check-compact-table">
        <div class="resource-group-header"><span>Name Servers (NS)${hosterPart}</span></div>
        ${body}
      </div>`;
  }

  // The best-effort checks (DKIM selectors, Microsoft 365 records, other
  // mail security records) that came back empty -- kept visible, separate
  // from the main table, so it's clear what was actually checked rather
  // than silently omitted. One list per category, by request -- a single
  // comma-joined paragraph of a dozen-plus items was unreadable.
  function notFoundHtml(notFound) {
    const groups = [
      { label: 'DKIM selectors checked, not found', items: notFound.dkim },
      { label: 'Microsoft 365 records checked, not found', items: notFound.m365 },
      { label: 'Other security records checked, not found', items: notFound.security },
      { label: 'Legacy mail hostnames checked, not found', items: notFound.legacyMail },
      { label: 'Website checked, not found', items: notFound.website },
    ].filter((g) => g.items.length > 0);
    if (groups.length === 0) return '';
    const groupsHtml = groups
      .map(
        (g) => `
      <div class="dns-check-notfound-group">
        <p class="inline-subtext dns-check-notfound-label">${escapeHtml(g.label)}:</p>
        <ul class="dns-check-notfound-list">${g.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
      </div>`
      )
      .join('');
    // Side by side when there's more than one section, by request -- a
    // single section just stays full-width (a 2-column grid with only one
    // item would leave an odd empty column). Always wrapped in
    // .dns-check-notfound-wrap (whether columned or not) so there's one
    // consistent place to put spacing before the SOA section below it.
    const columnsClass = groups.length > 1 ? ' dns-check-notfound-grid' : '';
    return `<div class="dns-check-notfound-wrap${columnsClass}">${groupsHtml}</div>`;
  }

  function soaHtml(result) {
    let body;
    if (result.ok && result.records.length > 0) {
      const soa = result.records[0];
      body = `
        <table>
          <tbody>
            <tr><th>Primary Nameserver</th><td>${boldEasyDmarc(escapeHtml(soa.nsname))}</td></tr>
            <tr><th>Admin Email</th><td>${boldEasyDmarc(escapeHtml((soa.hostmaster || '').replace('.', '@')))}</td></tr>
            <tr><th>Serial</th><td>${escapeHtml(soa.serial)}</td></tr>
            <tr><th>Refresh</th><td>${escapeHtml(soa.refresh)}s</td></tr>
            <tr><th>Retry</th><td>${escapeHtml(soa.retry)}s</td></tr>
            <tr><th>Expire</th><td>${escapeHtml(soa.expire)}s</td></tr>
            <tr><th>Minimum TTL</th><td>${escapeHtml(soa.minttl)}s</td></tr>
          </tbody>
        </table>`;
    } else if (result.ok || result.code === 'ENOTFOUND' || result.code === 'ENODATA') {
      body = '<p class="inline-subtext dns-check-section-note">No SOA record.</p>';
    } else {
      body = `<p class="status error dns-check-section-note">Lookup failed: ${escapeHtml(result.message || result.code)}</p>`;
    }
    return `
      <div class="resource-group dns-check-compact-table">
        <div class="resource-group-header"><span>SOA Record</span></div>
        ${body}
      </div>`;
  }

  if (lastData) render(lastData);

  function formatDateTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString();
  }
}
