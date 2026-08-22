export const id = 'datto-rmm';
export const label = 'Datto RMM';

// Module-scope, not inside mount() -- same restore-instantly-on-remount
// pattern as CSP Customers/Teams Shifts.
let lastData = null;

// Same status-color palette as the original app this was ported from
// (C:\Code\Improved-Dashboards), by request, for visual continuity with
// what technicians are already used to seeing there.
const STATUS_COLORS = {
  healthy: '#28a745',
  warning: '#f39c12',
  danger: '#dc3545',
  neutral: '#5dade2',
};

export function mount(container) {
  container.innerHTML = `
    <header class="page-header">
      <h1>Datto RMM</h1>
      <div class="date-form">
        <button type="button" id="refresh-button">Refresh</button>
      </div>
    </header>
    <p id="status" class="status">Loading...</p>
    <div id="summary" class="summary" hidden></div>
    <div id="cards" class="datto-card-grid"></div>
  `;

  const refreshButton = container.querySelector('#refresh-button');
  const statusEl = container.querySelector('#status');
  const summaryEl = container.querySelector('#summary');
  const cardsEl = container.querySelector('#cards');

  refreshButton.addEventListener('click', () => load(true));

  if (lastData) render(lastData);
  else load(false);

  async function load(force) {
    refreshButton.disabled = true;
    statusEl.hidden = false;
    statusEl.className = 'status';
    statusEl.textContent = 'Loading...';
    summaryEl.hidden = true;
    cardsEl.innerHTML = '';

    try {
      const res = await fetch(`/api/datto-rmm${force ? '?force=true' : ''}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      lastData = data;
      render(data);
    } catch (err) {
      statusEl.className = 'status error';
      statusEl.textContent = `Error: ${err.message}`;
    } finally {
      refreshButton.disabled = false;
    }
  }

  function render(data) {
    if (data.status === 'not-connected') {
      statusEl.hidden = false;
      statusEl.className = 'status error';
      statusEl.textContent = 'Datto RMM is not configured -- set DATTO_API_URL/DATTO_API_KEY (and DATTO_API_SECRET, if your key needs one) in .env.';
      cardsEl.innerHTML = '';
      return;
    }

    statusEl.hidden = true;
    summaryEl.hidden = false;
    summaryEl.innerHTML = `<strong>${data.totalDevices}</strong> devices<span class="inline-subtext"> -- as of ${formatDateTime(data.asOf)}</span>`;

    cardsEl.innerHTML = '';
    // filterId: null (not undefined) marks Total Devices -- "clickable, no
    // filter" -- distinct from Open Alerts below, which passes no filterId
    // at all and stays un-clickable (an alert isn't a device-filter
    // concept, and Datto's /devices endpoint has no "alerting devices"
    // filter to drill into the same way).
    cardsEl.appendChild(
      donutCard({
        name: 'Total Devices',
        count: data.totalDevices,
        total: data.totalDevices,
        status: 'neutral',
        subtext: `${data.totalDevices} devices`,
        filterId: null,
      })
    );
    cardsEl.appendChild(
      donutCard({
        name: 'Open Alerts',
        count: data.openAlerts.count,
        total: Math.max(data.totalDevices, data.openAlerts.count),
        status: data.openAlerts.status,
        subtext: `${data.openAlerts.count} open`,
      })
    );
    for (const f of data.filters) {
      if (f.available === false) {
        cardsEl.appendChild(unavailableCard(f.name));
        continue;
      }
      cardsEl.appendChild(
        donutCard({
          name: f.name,
          count: f.count,
          total: f.total,
          status: f.status,
          subtext: `${f.count} of ${f.total} devices`,
          filterId: f.id,
        })
      );
    }
  }

  function unavailableCard(name) {
    const div = document.createElement('div');
    div.className = 'datto-card datto-card--unavailable';
    div.innerHTML = `
      <div class="datto-card-label">${escapeHtml(name)}</div>
      <div class="datto-card-sub">Unavailable -- Datto's API returned an error for this filter.</div>
    `;
    return div;
  }

  function donutCard({ name, count, total, status, subtext, filterId }) {
    const color = STATUS_COLORS[status] || STATUS_COLORS.neutral;
    const clickable = filterId !== undefined;
    const div = document.createElement('div');
    div.className = 'datto-card' + (clickable ? ' datto-card--clickable' : '');
    div.innerHTML = `
      <div class="datto-donut-wrap">
        ${donutSvg(count, total, color)}
        <div class="datto-donut-center"><span class="datto-donut-count">${count}</span></div>
      </div>
      <div class="datto-card-label">${escapeHtml(name)}</div>
      <div class="datto-card-sub">${escapeHtml(subtext)}</div>
    `;
    if (clickable) {
      div.title = `Click to see the ${count} device${count === 1 ? '' : 's'}`;
      div.addEventListener('click', () => openDevicesPopup(name, filterId));
    }
    return div;
  }

  // Real popup window, same convention as Service Calls'/Teams Shifts' own
  // day popups -- but UNLIKE those (which just dump already-loaded client
  // data into a static document), this one embeds real, live JavaScript:
  // the device list for a filter can be hundreds of rows and each device's
  // full detail (disks, processor, memory) is its own separate API call,
  // so prefetching everything before opening the popup isn't practical the
  // way it is for a day's already-small shift/service-call list. The
  // embedded script below fetches from THIS dashboard's own /api/datto-rmm
  // endpoints directly -- same-origin, so the browser's existing session
  // cookie covers it, no separate auth needed.
  //
  // Built via string concatenation, not a nested template literal -- the
  // popup's own script needs its own backtick-free string building, since
  // it lives inside THIS file's own template literal (an unescaped
  // backtick in the inner script would terminate the outer one early).
  function openDevicesPopup(title, filterId) {
    const popup = window.open('', '_blank', 'width=920,height=800,scrollbars=yes');
    if (!popup) return; // genuinely blocked by the browser's popup blocker

    const isDark =
      document.documentElement.getAttribute('data-theme') === 'dark' ||
      (document.documentElement.getAttribute('data-theme') !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const colors = isDark
      ? { bg: '#14161a', fg: '#eef0f3', muted: '#9aa3af', border: '#2a2e35', card: '#1b1e24', accent: '#5b8def' }
      : { bg: '#ffffff', fg: '#1a1a1a', muted: '#6b7280', border: '#e5e7eb', card: '#f9fafb', accent: '#2563eb' };

    const query = filterId != null ? '?filterId=' + encodeURIComponent(filterId) : '';

    const script = [
      '(function () {',
      '  var statusEl = document.getElementById("status");',
      '  var contentEl = document.getElementById("content");',
      '  var detailCache = {};',
      '  function esc(s) {',
      '    if (s === null || s === undefined) return "";',
      '    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");',
      '  }',
      '  function fmtDate(ms) { return ms ? new Date(ms).toLocaleString() : "—"; }',
      '  fetch("/api/datto-rmm/devices' + query + '")',
      '    .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })',
      '    .then(function (res) {',
      '      if (!res.ok) throw new Error(res.data.error || "Request failed");',
      '      renderList(res.data);',
      '    })',
      '    .catch(function (err) { statusEl.textContent = "Error: " + err.message; statusEl.className = "err"; });',
      '  function renderList(data) {',
      '    statusEl.style.display = "none";',
      '    var note = data.truncated',
      '      ? "Showing " + data.devices.length + " of " + data.totalCount + " devices."',
      '      : data.totalCount + " device(s). Click a row for full detail.";',
      '    var rows = data.devices.map(function (d) {',
      '      var badge = d.online',
      '        ? "<span class=\\"badge badge-online\\">Online</span>"',
      '        : "<span class=\\"badge badge-offline\\">Offline</span>";',
      '      return "<tr data-uid=\\"" + esc(d.id) + "\\"><td>" + esc(d.hostname) + "</td><td>" + esc(d.site) + "</td><td>" + esc(d.os) + "</td><td>" + badge + "</td><td>" + esc(d.patchStatus) + "</td></tr>";',
      '    }).join("");',
      '    contentEl.innerHTML =',
      '      "<p class=\\"muted\\">" + note + "</p><table><thead><tr><th>Hostname</th><th>Site</th><th>OS</th><th>Status</th><th>Patch</th></tr></thead><tbody>" + rows + "</tbody></table>";',
      '    var trs = contentEl.querySelectorAll("tr[data-uid]");',
      '    for (var i = 0; i < trs.length; i++) {',
      '      trs[i].addEventListener("click", (function (tr) { return function () { toggleDetail(tr); }; })(trs[i]));',
      '    }',
      '  }',
      '  function toggleDetail(tr) {',
      '    var uid = tr.getAttribute("data-uid");',
      '    var existing = document.getElementById("detail-" + uid);',
      '    if (existing) { existing.parentNode.removeChild(existing); return; }',
      '    var row = document.createElement("tr");',
      '    row.id = "detail-" + uid;',
      '    var cell = document.createElement("td");',
      '    cell.colSpan = 5;',
      '    cell.className = "detail-cell";',
      '    cell.innerHTML = "<p class=\\"muted\\">Loading detail…</p>";',
      '    row.appendChild(cell);',
      '    tr.parentNode.insertBefore(row, tr.nextSibling);',
      '    if (detailCache[uid]) { renderDetail(cell, detailCache[uid]); return; }',
      '    fetch("/api/datto-rmm/device/" + encodeURIComponent(uid))',
      '      .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })',
      '      .then(function (res) {',
      '        if (!res.ok) throw new Error(res.data.error || "Failed to load device");',
      '        detailCache[uid] = res.data.device;',
      '        renderDetail(cell, res.data.device);',
      '      })',
      '      .catch(function (err) { cell.innerHTML = "<p class=\\"err\\">Error: " + esc(err.message) + "</p>"; });',
      '  }',
      '  function renderDetail(cell, d) {',
      '    var disksHtml = (d.disks && d.disks.length)',
      '      ? d.disks.map(function (disk) {',
      '          return "<div class=\\"disk" + (disk.lowSpace ? " disk-low" : "") + "\\">" + esc(disk.drive) + (disk.fileSystem ? " (" + esc(disk.fileSystem) + ")" : "") + " — " + esc(disk.freeFormatted || "?") + " free of " + esc(disk.totalFormatted || "?") + (disk.freePercent != null ? " (" + disk.freePercent + "%)" : "") + "</div>";',
      '        }).join("")',
      '      : "<p class=\\"muted\\">No disk data.</p>";',
      '    cell.innerHTML =',
      '      "<dl>" +',
      '      "<dt>Model</dt><dd>" + esc([d.manufacturer, d.model].filter(Boolean).join(" ") || "—") + "</dd>" +',
      '      "<dt>Processor</dt><dd>" + esc(d.processor || "—") + "</dd>" +',
      '      "<dt>Memory</dt><dd>" + esc(d.memoryFormatted || "—") + "</dd>" +',
      '      "<dt>IP address</dt><dd>" + esc(d.ipAddress || "—") + "</dd>" +',
      '      "<dt>Domain</dt><dd>" + esc(d.domain || "—") + "</dd>" +',
      '      "<dt>Last user</dt><dd>" + esc(d.lastUser || "—") + "</dd>" +',
      '      "<dt>Last seen</dt><dd>" + fmtDate(d.lastSeen) + "</dd>" +',
      '      "<dt>Reboot required</dt><dd>" + (d.rebootRequired ? "Yes" : "No") + "</dd>" +',
      '      "<dt>Open alerts</dt><dd>" + d.openAlertCount + "</dd>" +',
      '      "</dl><h3>Disks</h3>" + disksHtml;',
      '  }',
      '})();',
    ].join('\n');

    popup.document.open();
    popup.document.write(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Datto RMM -- ${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; background: ${colors.bg}; color: ${colors.fg}; margin: 0; padding: 1rem 1.25rem; }
  h1 { font-size: 1.15rem; margin: 0 0 0.75rem; }
  h3 { font-size: 0.9rem; margin: 0.75rem 0 0.35rem; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th, td { text-align: left; padding: 0.4rem 0.5rem; border-bottom: 1px solid ${colors.border}; }
  thead th { color: ${colors.muted}; font-weight: 600; }
  tbody tr[data-uid] { cursor: pointer; }
  tbody tr[data-uid]:hover { background: ${colors.card}; }
  .detail-cell { background: ${colors.card}; }
  .muted { color: ${colors.muted}; font-size: 0.85rem; }
  .err { color: #dc3545; }
  .badge { display: inline-block; font-size: 0.72rem; padding: 0.1rem 0.45rem; border-radius: 999px; }
  .badge-online { background: color-mix(in srgb, #28a745 20%, transparent); color: #28a745; }
  .badge-offline { background: color-mix(in srgb, ${colors.muted} 25%, transparent); color: ${colors.muted}; }
  dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 0.15rem 0.75rem; font-size: 0.85rem; }
  dt { color: ${colors.muted}; }
  dd { margin: 0; }
  .disk { font-size: 0.85rem; padding: 0.15rem 0; }
  .disk-low { color: #dc3545; font-weight: 600; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p id="status">Loading devices...</p>
<div id="content"></div>
<script>${script}<\/script>
</body>
</html>`);
    popup.document.close();
  }

  // A single-arc donut ring (count/total as one colored sweep over a plain
  // background ring), ported/simplified from the original app's own
  // two-segment SVG donut (C:\Code\Improved-Dashboards\src\components\
  // widgets\DonutWidget.jsx) -- same arc math, drawn as a plain template
  // string here since this dashboard has no React/component layer.
  function donutSvg(count, total, color, size = 120) {
    const cx = size / 2;
    const cy = size / 2;
    const r = size * 0.4;
    const stroke = size * 0.14;
    const pct = total > 0 ? Math.min(1, count / total) : 0;
    const sweep = pct * 360;
    const bg = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--border)" stroke-width="${stroke}" />`;
    const arc = sweep > 0 ? `<path d="${describeArc(cx, cy, r, 0, sweep)}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="butt" />` : '';
    return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${bg}${arc}</svg>`;
  }

  function polarToCartesian(cx, cy, r, angleDeg) {
    const rad = ((angleDeg - 90) * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  }

  function describeArc(cx, cy, r, startAngle, endAngle) {
    const start = polarToCartesian(cx, cy, r, endAngle);
    const end = polarToCartesian(cx, cy, r, startAngle);
    const largeArc = endAngle - startAngle <= 180 ? '0' : '1';
    return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 0 ${end.x} ${end.y}`;
  }

  function formatDateTime(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleString();
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
