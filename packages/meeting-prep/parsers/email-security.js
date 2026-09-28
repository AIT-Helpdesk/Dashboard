// Parses an INKY "Summary Report" PDF's extracted text into the shape
// server.js's buildReportComponent('email-security', ...) expects. Unlike
// every other parser in this folder, the source PDF here doesn't arrive on
// its own in Incoming/ -- INKY emails it as an attachment on a report
// email (a .msg file), so ingest.js pulls the PDF bytes out of that .msg
// first (see extractMsgPdfAttachment() there) and hands this parser the
// same kind of already-extracted PDF text every other parser gets.
//
// Real layout (confirmed against 4 real samples -- Kraftur Pty Ltd, G and
// H Civil Contractors, SEQ Mortgage Brokers, Sleepys -- all dated 26 Sep
// 2026): title line varies per client ("Kraftur - INKY Summary Report",
// "INKY Summary Report - G & H Civil", "Email Security Summary", "INKY
// Summary Report - Sleepy's" -- INKY's own per-tenant branding, not a
// reliable field), but every sample after that line follows the exact
// same section order and label text:
//
//   for <Site Name> <Weekday>, <Month> <Day>, <Year>
//   Inbound Messages Processed / Unique Primary Recipients / AAA Detection Count
//   Threat Summary -- Neutral/Caution/Danger, each "<count> <pct>%"
//   Threats over time (a chart axis, not parsed -- no per-day breakdown in the text)
//   Top Threat Categories -- a variable-length list of "<label> <count> <pct>%" rows
//   Message Report Summary ("Messages Reported") -- same Neutral/Caution/Danger shape as Threat Summary
//   Link Click Breakdown -- 5 fixed "<label> <count> (of <n> ...) <pct>%" rows
//
// Page breaks ("-- N of M --") land in different places depending on how
// many threat categories a client has (SEQ Mortgage Brokers' short
// category list fits everything from "Top Threat Categories" onward onto
// one page; Kraftur's longer list pushes Link Click Breakdown onto its own
// page) -- this parser never anchors on page markers, only on the label
// text itself, so that variation doesn't matter.

function numberAfterLabel(text, label) {
  const re = new RegExp(`${label}\\s*\\n\\s*(\\d+)`);
  const m = re.exec(text);
  return m ? Number(m[1]) : null;
}

// The substring strictly between the FIRST occurrence of `startLabel` at
// or after `fromIndex` and the next occurrence of `endLabel` after that --
// `fromIndex` is what lets a caller skip past an earlier, unrelated
// occurrence of the same label text (e.g. "Messages Processed" also
// appears inside "Inbound Messages Processed" on page 1, well before the
// "Top Threat Categories" section actually wants).
function sliceBetween(text, startLabel, endLabel, fromIndex = 0) {
  const startAt = text.indexOf(startLabel, fromIndex);
  if (startAt === -1) return null;
  const from = startAt + startLabel.length;
  const endAt = endLabel ? text.indexOf(endLabel, from) : -1;
  return endAt === -1 ? text.slice(from) : text.slice(from, endAt);
}

// "Neutral 54 44.3%" -- same three-field shape used by both Threat
// Summary and Message Report Summary's own Neutral/Caution/Danger rows.
function countAfterLabel(slice, label) {
  if (!slice) return 0;
  const m = new RegExp(`${label}\\s+(\\d+)\\s+[\\d.]+%`).exec(slice);
  return m ? Number(m[1]) : 0;
}

// The category rows sit right after their own "Messages Processed"
// sub-header inside the Top Threat Categories slice -- everything from
// there to the end of the slice is one row per line, "<label> <count>
// <pct>%", where label can itself contain spaces/hyphens (e.g. "Spammy
// Top-Level Domain"), so the row regex anchors on the trailing "<count>
// <pct>%" rather than splitting on whitespace naively.
function parseTopThreatCategories(slice) {
  if (!slice) return [];
  const afterHeader = slice.slice(slice.indexOf('Messages Processed') + 'Messages Processed'.length);
  return afterHeader
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const m = /^(.+?)\s+(\d+)\s+([\d.]+)%$/.exec(line);
      return m ? { label: m[1].trim(), count: Number(m[2]), pct: Number(m[3]) } : null;
    })
    .filter(Boolean);
}

// "Messages With Links 111 (of 122 messages) 91.0%" -- all 5 Link Click
// Breakdown rows share this "<label> <count> (of <n> <unit>) <pct>%"
// shape; the "(of ...)" clause's own inner text differs per row ("of 122
// messages" vs "of 111 messages with links" vs "of 0 links clicked" etc.)
// but is never needed here -- every number this component actually shows
// is recoverable from the label + leading count alone.
function parseLinkClickBreakdown(slice) {
  const empty = {
    totalInboundMessages: null,
    messagesWithLinks: null,
    messagesWithLinksPct: null,
    messagesWithLinksClicked: null,
    messagesWithLinksClickedPct: null,
    unsafeLinksClicked: null,
    unsafeLinksClickedPct: null,
    linksFollowed: null,
    linksFollowedPct: null,
    unsafeLinksFollowed: null,
    unsafeLinksFollowedPct: null,
  };
  if (!slice) return empty;
  const totalMatch = /(\d+)/.exec(slice);
  const rows = {};
  const rowRe = /([A-Za-z][A-Za-z \-]*?)\s+(\d+)\s+\(of\s+\d+[^)]*\)\s+([\d.]+)%/g;
  let m;
  while ((m = rowRe.exec(slice))) {
    rows[m[1].trim()] = { count: Number(m[2]), pct: Number(m[3]) };
  }
  const row = (label) => rows[label] || { count: null, pct: null };
  return {
    totalInboundMessages: totalMatch ? Number(totalMatch[1]) : null,
    messagesWithLinks: row('Messages With Links').count,
    messagesWithLinksPct: row('Messages With Links').pct,
    messagesWithLinksClicked: row('Messages With Links Clicked').count,
    messagesWithLinksClickedPct: row('Messages With Links Clicked').pct,
    unsafeLinksClicked: row('Unsafe Links Clicked').count,
    unsafeLinksClickedPct: row('Unsafe Links Clicked').pct,
    linksFollowed: row('Links Followed').count,
    linksFollowedPct: row('Links Followed').pct,
    unsafeLinksFollowed: row('Unsafe Links Followed').count,
    unsafeLinksFollowedPct: row('Unsafe Links Followed').pct,
  };
}

const MONTHS_SHORT = new Set(['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']);

function parse(text) {
  // "for Kraftur Pty Ltd Saturday, Sep 26, 2026" -- the one line every
  // sample carries verbatim regardless of the report's own varying title
  // line above it. Normalised to "26 SEP 2026" (dd MON yyyy) here, not
  // left as "Sep 26, 2026", so ingest.js's own isoDateFromCreateDate()
  // (built against Datto's own dd-MON-yyyy convention) keeps working
  // unchanged for this source too.
  const headerMatch = /\bfor\s+(.+?)\s+\w+day,\s+([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4})/.exec(text);
  if (!headerMatch) throw new Error('Could not find the "for <Client> <Weekday>, <Month> <Day>, <Year>" header line');
  const [, site, monAbbr, day, year] = headerMatch;
  const monUpper = monAbbr.toUpperCase();
  if (!MONTHS_SHORT.has(monUpper)) throw new Error(`Unrecognised month abbreviation "${monAbbr}"`);
  const createDate = `${day.padStart(2, '0')} ${monUpper} ${year}`;

  const overview = {
    messagesProcessed: numberAfterLabel(text, 'Inbound Messages Processed'),
    uniqueRecipients: numberAfterLabel(text, 'Unique Primary Recipients'),
    aaaDetectionCount: numberAfterLabel(text, 'AAA Detection Count'),
  };
  if (overview.messagesProcessed === null || overview.uniqueRecipients === null || overview.aaaDetectionCount === null) {
    throw new Error(`Could not find the overview counts (${JSON.stringify(overview)})`);
  }

  const threatSlice = sliceBetween(text, 'Threat Summary', 'Threats over time');
  const threatSummary = {
    neutral: countAfterLabel(threatSlice, 'Neutral'),
    caution: countAfterLabel(threatSlice, 'Caution'),
    danger: countAfterLabel(threatSlice, 'Danger'),
  };

  const topCategoriesStart = text.indexOf('Top Threat Categories');
  const topThreatCategories = parseTopThreatCategories(sliceBetween(text, 'Top Threat Categories', 'Message Report Summary', topCategoriesStart));

  // Scoped to start searching from "Top Threat Categories" onward, same
  // reasoning as topCategoriesStart above -- "Messages Reported" is a
  // one-off label (unlike "Messages Processed"/"Neutral" etc.), but
  // scoping consistently here too costs nothing and keeps every slice in
  // this parser anchored the same way.
  const reportedSlice = sliceBetween(text, 'Messages Reported', 'Link Click Breakdown', topCategoriesStart);
  const messageReportSummary = {
    neutral: countAfterLabel(reportedSlice, 'Neutral'),
    caution: countAfterLabel(reportedSlice, 'Caution'),
    danger: countAfterLabel(reportedSlice, 'Danger'),
  };

  const linkSlice = sliceBetween(text, 'Link Click Breakdown', null, topCategoriesStart);
  const linkClickBreakdown = parseLinkClickBreakdown(linkSlice);

  return { site, createDate, overview, threatSummary, topThreatCategories, messageReportSummary, linkClickBreakdown };
}

module.exports = { parse };
