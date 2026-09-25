// Parses a Datto RMM "Device Storage Report" PDF's extracted text into the
// shape server.js's buildReportComponent('device-storage', ...) expects --
// validated against the real, hand-verified data/fairway-capital/
// 2026-09-25/device-storage.json (sourceUrl added afterward by ingest.js).
//
// Real layout (confirmed against the live "Device Storage - Blake Sign
// Co.pdf" sample): a per-drive row is NOT one clean line -- pdf-parse's own
// line-wrapping splits "Local Fixed"/"Disk" (the drive type) onto separate
// lines, and a device with only one drive gets its name+description
// combined with the first drive's stats on one line, while a device with
// STILL its first drive puts name+description on their OWN line, stats
// following on the next. The two anchors that stay reliable regardless of
// wrapping are the stats triple (Size/Free/Used%) and the drive-letter
// token (e.g. "C:") -- this parser locates every stats-triple match, then
// reads the drive type + letter from the text immediately AFTER it (up to
// the drive-letter token) and the device name + description from the text
// immediately BEFORE it (empty when it's a second/third drive on the same
// device just seen -- carried forward from the previous drive in that
// case, exactly matching the real DESKTOP-QA7322R two-drive case).
const STATS_RE = /([\d.]+[A-Z]{1,2}B)\s+([\d.]+[A-Z]{1,2}B)\s+([\d.]+)%/g;
const DRIVE_LETTER_RE = /([A-Z]{1,2}):/;

function collapse(s) {
  return s.replace(/\s+/g, ' ').trim();
}

function parseDrives(body) {
  const statMatches = [...body.matchAll(STATS_RE)];
  const drives = [];
  let cursor = 0;
  let currentDevice = null;
  let currentDescription = null;

  for (let i = 0; i < statMatches.length; i++) {
    const m = statMatches[i];
    const beforeText = collapse(body.slice(cursor, m.index));
    if (beforeText) {
      const spaceIndex = beforeText.indexOf(' ');
      if (spaceIndex === -1) {
        currentDevice = beforeText;
        currentDescription = beforeText;
      } else {
        currentDevice = beforeText.slice(0, spaceIndex);
        currentDescription = beforeText.slice(spaceIndex + 1).trim();
      }
    }
    // else: no new name/description text since the last drive -- this is
    // another drive on the SAME device just seen, by design (see this
    // file's own top comment).

    const afterStart = m.index + m[0].length;
    const nextStart = i + 1 < statMatches.length ? statMatches[i + 1].index : body.length;
    const afterText = body.slice(afterStart, nextStart);
    const letterMatch = DRIVE_LETTER_RE.exec(afterText);
    if (!letterMatch) {
      cursor = nextStart; // malformed/unexpected shape for this one row -- skip it rather than guess a drive letter
      continue;
    }
    const driveType = collapse(afterText.slice(0, letterMatch.index));
    const drive = `${letterMatch[1]}:`;
    // Resume scanning right after the drive letter, not at nextStart -- so
    // the NEXT iteration's beforeText only ever sees trailing name/
    // description text (if any), never driveType text a second time.
    cursor = afterStart + letterMatch.index + letterMatch[0].length;

    drives.push({
      device: currentDevice,
      description: currentDescription,
      drive,
      driveType,
      size: m[1],
      free: m[2],
      usedPercent: Number(m[3]),
    });
  }
  return drives;
}

function parse(text) {
  const lines = text.split('\n').map((l) => l.trim());

  let createDate = null;
  let site = null;
  let deviceCount = null;
  let devicesLineIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!createDate) {
      const m = /^Create Date:\s*(.+)$/.exec(line);
      if (m) createDate = m[1].trim();
    }
    if (!site) {
      const m = /^Sites:\s*(.+)$/.exec(line);
      if (m) site = m[1].trim();
    }
    if (deviceCount === null) {
      const m = /^Devices:\s*(\d+)$/.exec(line);
      if (m) {
        deviceCount = Number(m[1]);
        devicesLineIndex = i;
      }
    }
  }
  if (!createDate || !site || deviceCount === null) {
    throw new Error(`Could not find header fields (createDate=${createDate}, site=${site}, deviceCount=${deviceCount})`);
  }

  const body = lines
    .slice(devicesLineIndex + 1)
    .filter((l) => l && !/^-- \d+ of \d+ --$/.test(l) && l !== 'Device Storage Report' && l !== 'Network Devices' && !l.startsWith('Device Name') && l !== site.toUpperCase())
    .join('\n');

  const drives = parseDrives(body);
  if (drives.length === 0) throw new Error('Parsed zero drives from the device storage table');

  return { site, createDate, deviceCount, drives };
}

module.exports = { parse };
