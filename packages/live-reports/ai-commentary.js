const Anthropic = require('@anthropic-ai/sdk');

// Writes the PDF report's narrative sections (Executive Summary, On
// Track/Watch/Action Needed, Our Recommendations) -- by request ("add
// some AI recommendations and commentary"), modeled on the DRG example
// report's own "What this means for you"/"Our recommendations" sections.
// Optional: a missing ANTHROPIC_API_KEY just means the PDF ships without
// these sections (pdf-template.js already handles a null commentary),
// never a thrown error -- the rest of the report is real live data either
// way.
function hasAnthropicCredentials() {
  return Boolean((process.env.ANTHROPIC_API_KEY || '').trim());
}

// Per this dashboard's own claude-api skill guidance -- default to Claude
// Opus 5 for anything beyond a trivial call, unless told otherwise.
const MODEL = 'claude-opus-5';

// Trimmed down to just the numbers worth reasoning over -- not the full
// raw device list (pdf-template.js's own deviceTableHtml() already
// builds that straight from report.dattoLive, no need for Claude to see
// every hostname) -- keeps the prompt small and fast, and keeps Claude
// from inventing device-level detail it wasn't actually given.
function buildPromptData(report, vendors) {
  return {
    client: report.siteName,
    asOf: report.asOf,
    overallScore: report.overallScore,
    workstations: report.workstation && {
      deviceCount: report.workstation.total,
      healthScore: Math.round(report.workstation.healthScore),
      patchScore: report.workstation.patch.score,
      patchLegend: report.workstation.patch.legend,
      softwareScore: report.workstation.software.score,
      softwareLegend: report.workstation.software.legend,
      antivirusScore: report.workstation.antivirus.score,
      antivirusLegend: report.workstation.antivirus.legend,
    },
    servers: report.server && {
      deviceCount: report.server.total,
      healthScore: Math.round(report.server.healthScore),
      antivirusScore: report.server.antivirus.score,
      antivirusLegend: report.server.antivirus.legend,
    },
    deviceFreshness: report.dattoLive && report.dattoLive.summary,
    openAlerts: { total: report.alertsTotalCount, byPriority: report.alertsByPriority },
    saasAlerts: vendors.saasAlerts,
    saasProtection: vendors.saasProtection,
    dattoEdr: vendors.dattoEdr,
    autoElevate: vendors.autoElevate,
    huntress: vendors.huntress,
  };
}

function buildPrompt(report, vendors) {
  const data = buildPromptData(report, vendors);
  return `You are writing the narrative sections of a monthly Managed Services Report for an MSP called Ambient iT, for their client "${report.siteName}". You are given a JSON snapshot of that client's current live IT health data (device patching/antivirus/software compliance, open alerts, and security tool coverage across several systems). Write in the MSP's own voice, addressing the client directly ("your computers", "your team"), plain English, no jargon, no padding -- specific and concrete, naming exact numbers where relevant, never vague filler.

DATA:
${JSON.stringify(data, null, 2)}

Return ONLY a single JSON object (no markdown fences, no commentary outside the JSON) with exactly this shape:
{
  "executiveSummary": "2-4 sentence paragraph summarizing the month's overall picture",
  "onTrack": ["short bullet", "..."],
  "watch": ["short bullet", "..."],
  "actionNeeded": ["short bullet", "..."],
  "recommendations": [
    { "priority": "Action needed" | "Watch", "recommendation": "short imperative sentence", "whyItMatters": "short reason" }
  ]
}

"onTrack"/"watch"/"actionNeeded" each take 0-4 short bullets -- return an empty array for any that genuinely have nothing to report, rather than inventing filler. "recommendations" takes 2-6 rows, most urgent first. Base every claim strictly on the DATA given -- never invent a number, device name, or incident that isn't in it.`;
}

async function buildCommentary(report, vendors) {
  if (!hasAnthropicCredentials()) return null;
  const client = new Anthropic();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    messages: [{ role: 'user', content: buildPrompt(report, vendors) }],
  });
  const text = (response.content.find((b) => b.type === 'text') || {}).text || '';
  // Claude sometimes wraps JSON in a markdown fence even when explicitly
  // told not to -- stripped defensively rather than trusting the prompt
  // alone, same "don't trust, verify" reasoning this dashboard already
  // applies to every other external API response.
  const jsonText = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(jsonText);
  } catch (err) {
    console.error('live-reports: AI commentary came back as non-JSON, skipping it for this PDF:', err.message);
    return null;
  }
}

module.exports = { hasAnthropicCredentials, buildCommentary };
