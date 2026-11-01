// Per-report-kind config for AI-drafted commentary on the Make Report page
// -- by request ("AI-Assisted Reporting Brief", Oct 2026): "design the
// payload-assembly step generically... Adding a new report type should mean
// adding a new config/mapping entry, not modifying the core drafting
// pipeline." Mirrors the shape of @dashboard/shell/public's own
// widgetsHtmlForComponent()/fullTableHtmlForComponent() dispatchers (one
// entry per `component.kind`), except this one reduces a component down to
// a SMALL, labelled metrics object instead of HTML -- that's the thing this
// dashboard didn't already have one of (confirmed: neither of those two
// dispatchers, nor meeting-prep-recommendations.js's computeFindings(),
// already does this).
//
// Deliberately NOT reusing `component.stats` uncritically for every kind --
// confirmed live that hardware-lifecycle's own `stats.{within12,
// months12to24,plus24}` are currently always 0 (the parser never populates
// `bands[].devices`), so that entry below pulls the real counts from
// `summary.replacementRecommendation` instead. Every entry pulls from
// whichever field is ACTUALLY populated for that kind, not just `stats`
// uniformly.
//
// server.js (POST /draft-commentary) is the only caller, and re-derives this
// payload itself from the component the client posted -- never trusts the
// client to have already minimized it. A kind with no entry here simply
// gets no "Draft Commentary" button client-side (report/client.js checks
// `hasAiPayloadConfig(kind)`), same "quietly not there" convention this
// dashboard already uses for unconfigured integrations.

function round1(n) {
  return n === null || n === undefined ? null : Math.round(n * 10) / 10;
}

const CONFIG = {
  'executive-summary': {
    label: 'Executive Summary',
    buildPayload(c) {
      const sections = c.sections || [];
      const metrics = { 'Overall Score (%)': c.stats?.overallScore ?? null };
      for (const s of sections) {
        if (s.kind === 'summary' || s.kind === 'proactive-maintenance') continue;
        metrics[`${s.title} Score (%)`] = s.score ?? null;
      }
      return metrics;
    },
  },
  'device-storage': {
    label: 'Device Storage',
    buildPayload(c) {
      return {
        'Drives Monitored': c.stats?.driveCount ?? 0,
        'Drives Critically Low (>=90% used)': c.stats?.criticalCount ?? 0,
      };
    },
  },
  'patch-management-summary': {
    label: 'Patch Management Summary',
    buildPayload(c) {
      const summary = c.summary || {};
      return {
        'Fully Patched': summary['Fully Patched'] || 0,
        'Approved Pending': summary['Approved Pending'] || 0,
        'Install Error': summary['Install Error'] || 0,
        'Reboot Required': summary['Reboot Required'] || 0,
        'No Data': summary['No Data'] || 0,
        'No Policy': summary['No Policy'] || 0,
        'Total Devices': c.stats?.total ?? 0,
      };
    },
  },
  'device-health-summary': {
    label: 'Device Health Summary',
    buildPayload(c) {
      const byType = c.summary?.byDeviceType || {};
      return {
        'Health Checks Passed': c.stats?.checksPassed ?? 0,
        'Health Checks Failed': c.stats?.checksFailed ?? 0,
        'Devices Covered': (c.devices || []).length,
        ...Object.fromEntries(Object.entries(byType).map(([k, v]) => [`${k} (count)`, v])),
      };
    },
  },
  'hardware-lifecycle': {
    label: 'Hardware Lifecycle',
    buildPayload(c) {
      // NOT c.stats -- see this file's own header comment. The real counts
      // live in summary.replacementRecommendation.
      const rec = c.summary?.replacementRecommendation || {};
      const os = c.summary?.osSupport || {};
      return {
        'Replacement Recommended (within 12 months)': rec['Replacement recommended within 12 months'] || 0,
        'Replacement Recommended (12-24 months)': rec['Replacement recommended within 12-24 months'] || 0,
        'Suitable for 24 Months+': rec['Suitable for 24 months+'] || 0,
        'Unknown Lifecycle': rec['Unknown'] || 0,
        'OS Supported': os['Operating system is supported'] || 0,
        'OS Unsupported': os['Operating system is unsupported'] || 0,
      };
    },
  },
  'network-audit': {
    label: 'Network Audit',
    buildPayload(c) {
      return {
        'Managed Devices': c.stats?.managedCount ?? 0,
        'Unmanaged Devices': c.stats?.unmanagedCount ?? 0,
      };
    },
  },
  'open-monitor-alerts': {
    label: 'Open Monitor Alerts',
    buildPayload(c) {
      return {
        'Total Open Alerts': c.stats?.totalOpen ?? 0,
        'Devices With Open Alerts': c.stats?.devicesWithAlerts ?? 0,
      };
    },
  },
  'patch-management-activity': {
    label: 'Patch Management Activity',
    buildPayload(c) {
      return { 'Patch Install Events (period)': c.stats?.totalPatchInstallEvents ?? 0 };
    },
  },
  software: {
    label: 'Software',
    buildPayload(c) {
      return { 'Distinct Software Titles Installed': c.stats?.distinctTitles ?? 0 };
    },
  },
  'dark-web-monitoring': {
    label: 'Dark Web Monitoring',
    buildPayload(c) {
      return {
        'Total Compromises Found': c.stats?.totalCompromises ?? 0,
        'Customer-Average Compromises (benchmark)': round1(c.stats?.customerAverage),
      };
    },
  },
  'email-security': {
    label: 'Email Security',
    buildPayload(c) {
      return {
        'Messages Processed': c.stats?.messagesProcessed ?? 0,
        'Dangerous Messages Detected': c.stats?.dangerCount ?? 0,
      };
    },
  },
  'datto-live-devices': {
    label: 'Datto RMM (live)',
    buildPayload(c) {
      return {
        'Total Devices': c.stats?.total ?? 0,
        'Devices Not Seen Recently (stale)': c.stats?.notSeenStale ?? 0,
      };
    },
  },
  'autotask-tickets': {
    label: 'Autotask Ticket Counts',
    buildPayload(c) {
      return {
        'Currently Open Tickets': c.stats?.openCount ?? 0,
        'Opened This Month': c.stats?.openedThisMonth ?? 0,
        'Closed This Month': c.stats?.closedThisMonth ?? 0,
      };
    },
  },
};

function hasAiPayloadConfig(kind) {
  return Object.prototype.hasOwnProperty.call(CONFIG, kind);
}

// The client-side source of truth for which kinds get a "Draft Commentary"
// button at all (report/client.js fetches this once via GET
// /api/report/ai-kinds) -- so the list of supported kinds lives in exactly
// ONE place (this file), not duplicated into client.js by hand and left to
// drift the next time a kind is added here.
function supportedKinds() {
  return Object.keys(CONFIG);
}

function buildAiPayload(component) {
  const entry = CONFIG[component?.kind];
  if (!entry) return null;
  return { kindLabel: entry.label, metrics: entry.buildPayload(component) };
}

module.exports = { hasAiPayloadConfig, buildAiPayload, supportedKinds };
