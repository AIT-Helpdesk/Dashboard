export const id = 'morning-pulse';
export const label = 'Morning Pulse';

let lastData = null;
let activeRender = null;

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatAgo(iso) {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} day(s) ago`;
}

export function mount(container) {
  container.classList.add('morning-pulse-page');
  container.innerHTML = `
    <header class="page-header">
      <h1>Morning Pulse</h1>
      <button type="button" id="refresh-button" class="button-link button-link--small">Refresh</button>
    </header>
    <p id="status" class="status">Loading...</p>
    <div id="results"></div>
  `;

  const refreshButton = container.querySelector('#refresh-button');
  const statusEl = container.querySelector('#status');
  const resultsEl = container.querySelector('#results');

  refreshButton.addEventListener('click', () => load());

  async function load() {
    refreshButton.disabled = true;
    statusEl.hidden = false;
    statusEl.textContent = 'Loading...';
    try {
      const res = await fetch('/api/morning-pulse');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastData = data;
      activeRender(data);
    } catch (err) {
      statusEl.hidden = false;
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      refreshButton.disabled = false;
    }
  }

  function render(data) {
    if (data.neverRun) {
      statusEl.hidden = false;
      statusEl.textContent = 'No run yet -- Morning Pulse runs on a schedule (see its README). Nothing to show until the first run completes.';
      resultsEl.innerHTML = '';
      return;
    }
    statusEl.hidden = true;
    if (!data.success) {
      resultsEl.innerHTML = `<p class="status error">The last run (${escapeHtml(formatAgo(data.ranAt))}) failed entirely: ${escapeHtml(data.fatalError || 'unknown error')}</p>`;
      return;
    }
    resultsEl.innerHTML = renderReport(data.report, data.ranAt);
  }

  function renderReport(report, ranAt) {
    const verdictClass = `mp-verdict mp-verdict--${report.verdict.toLowerCase()}`;
    const headline = report.plan[0]
      ? `<strong>${escapeHtml(report.plan[0].title)}</strong> leads the plan.`
      : report.outages.length
        ? 'A site is down.'
        : 'Nothing new broke overnight.';

    return `
      <div class="${verdictClass}">
        <div class="mp-verdict-badge">${report.verdict}</div>
        <div>
          <p class="mp-verdict-headline">${headline}</p>
          <p class="mp-verdict-meta"><strong>${report.totals.sites}</strong> sites &middot; <strong>${report.totals.devices}</strong> devices &middot; <strong>${report.totals.infraOnline}</strong> of ${report.totals.infraDevices} infrastructure online &middot; generated ${escapeHtml(formatAgo(ranAt))}</p>
        </div>
      </div>

      ${renderPlan(report)}
      ${renderOutages(report)}
      ${renderSection('Site outages (overnight, not fully down)', report.siteOutages.map((o) => `${escapeHtml(o.site)} -- ${o.infraOffline} of ${o.infraTotal} infrastructure offline, ${o.newDropCount} new`))}
      ${renderSection('Recurring offline pattern', report.recurrence.map((r) => `${escapeHtml(r.hostname)} (${escapeHtml(r.site)}) -- ${r.pattern === 'scheduled' ? 'looks scheduled' : 'flapping'}, ${r.occurrences} time(s) across ${r.days} day(s)`))}
      ${renderSection('Cross-site correlation', report.correlatedGroups.map((g) => `${g.devices.map(escapeHtml).join(', ')} recovered within minutes of each other (around ${escapeHtml(formatAgo(g.resolvedAround))})`))}
      ${renderSection(
        `Open Critical security-threat alerts, last 21 days (outside this page's own scope)${report.securityThreatsTotalCount > report.securityThreats.length ? ` -- showing ${report.securityThreats.length} of ${report.securityThreatsTotalCount}` : ''}`,
        report.securityThreats.map((s) => `${escapeHtml(s.deviceName)} (${escapeHtml(s.siteName)})${s.ticketNumber ? ` -- ticket ${escapeHtml(s.ticketNumber)}` : ' -- no ticket'}`)
      )}
      ${renderSection('Monitoring gaps (offline infrastructure with no alert on file)', report.monitoringGaps.map((g) => `${escapeHtml(g.hostname)} (${escapeHtml(g.site)})`))}
      <p class="status mp-coverage">
        Long-term offline: <strong>${report.longTermOffline.count}</strong> infrastructure device(s) across <strong>${report.longTermOffline.siteCount}</strong> site(s).
        ${report.dormantSites.length ? ` Dormant sites: ${report.dormantSites.map(escapeHtml).join(', ')}.` : ''}
        Window start ${escapeHtml(new Date(report.windowStart).toLocaleString('en-AU'))} &middot; run took ${Math.round(report.durationMs / 1000)}s.
      </p>
    `;
  }

  function renderPlan(report) {
    if (!report.plan.length) {
      return '<p class="status">The plan is empty -- nothing today\'s capacity needs to cover.</p>';
    }
    const rows = report.plan
      .map(
        (item, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${escapeHtml(item.effortLabel)}</td>
        <td><strong>${escapeHtml(item.title)}</strong></td>
        <td>${escapeHtml(item.why)}</td>
      </tr>`
      )
      .join('');
    const skipped = report.skippedForCapacity.length
      ? `<p class="status">Dropped for capacity: ${report.skippedForCapacity.map((s) => escapeHtml(s.title)).join('; ')}</p>`
      : '';
    return `
      <h2>The first ${Math.round(report.capacityMinutes / 60)} hours</h2>
      <table>
        <thead><tr><th>#</th><th>Effort</th><th>Task</th><th>Why</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      ${skipped}
    `;
  }

  function renderOutages(report) {
    if (!report.outages.length) return '';
    const rows = report.outages
      .map((o) => `<tr><td>${escapeHtml(o.site)}</td><td>${o.infraOffline} of ${o.totalDevices}</td><td>${escapeHtml(new Date(o.lastSeen).toLocaleString('en-AU'))}</td></tr>`)
      .join('');
    return `
      <h2>Outages</h2>
      <table>
        <thead><tr><th>Site</th><th>Infrastructure offline</th><th>Last seen</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  function renderSection(title, lines) {
    if (!lines.length) return '';
    return `<p class="status"><strong>${escapeHtml(title)}:</strong></p><ul class="mp-list">${lines.map((l) => `<li>${l}</li>`).join('')}</ul>`;
  }

  activeRender = render;
  if (lastData) render(lastData);
  else load();
}
