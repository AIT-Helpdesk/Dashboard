// Parses a real ViCyber "scan_consolidated" export -- confirmed live against
// a real sample ("scan_consolidated - Report - 31st Aug 2026.xlsx"), 4
// sheets, each a genuinely different shape:
//   Endpoint -- Asset Owner, Asset/IP, Severity, Vulnerability, Date
//     Detected, CVE ID, Threat, Recommendation, Ref
//   WebApp   -- Asset Owner, URL, Severity, Vulnerability, Date Detected,
//     Threat, Impact, Recommendation
//   Network  -- Asset Owner, Host, Port, Severity, Vulnerability, Date
//     Detected, Description, Recommendation, Ref
//   DarkWeb  -- Asset Owner, Account, Severity, Password Exposed, Found
//     Location, Date Of Leak, Recommendation
// "Asset Owner" is deliberately never read here -- confirmed live it can
// disagree with the real Autotask Client (see db.js's own comment) -- the
// Client this report belongs to is always the one explicitly nominated on
// this page, never guessed from the file.
const XLSX = require('xlsx');

const MONTH_BY_ABBR = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

// ViCyber's own date format, confirmed live: "18/Aug/2026", "9/Aug/2026" --
// day (1 or 2 digits), 3-letter month abbreviation, 4-digit year. Normalized
// to a plain ISO date (sorts/compares correctly as a string, unlike the raw
// format) -- returns null for anything that doesn't match rather than
// guessing, same "never guess" convention this dashboard already follows
// elsewhere for messy real-world input.
function parseViCyberDate(raw) {
  const s = String(raw || '').trim();
  const m = /^(\d{1,2})\/([A-Za-z]{3})\/(\d{4})$/.exec(s);
  if (!m) return null;
  const month = MONTH_BY_ABBR[m[2]];
  if (!month) return null;
  return `${m[3]}-${String(month).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

function str(v) {
  return String(v ?? '').trim();
}

function sheetRows(workbook, sheetName) {
  const ws = workbook.Sheets[sheetName];
  if (!ws) return [];
  // defval: '' -- a blank cell comes back as '' rather than being omitted
  // from the row object entirely, so every row has every column key
  // regardless of which cells happened to be empty in that row.
  return XLSX.utils.sheet_to_json(ws, { defval: '' });
}

// A row missing its own identifying device/title is not a real finding --
// covers ViCyber's own "nothing found" placeholder row (confirmed live on
// DarkWeb: Account "No leaks found", every other column blank) without
// hardcoding that exact string, so the same guard also protects Endpoint/
// WebApp/Network if ViCyber ever ships an equivalent empty-sheet placeholder
// there.
function parseEndpoint(workbook) {
  return sheetRows(workbook, 'Endpoint')
    .filter((r) => str(r['Asset/IP']) && str(r['Vulnerability']))
    .map((r) => ({
      device: str(r['Asset/IP']),
      severity: str(r['Severity']) || null,
      title: str(r['Vulnerability']),
      detectedDate: parseViCyberDate(r['Date Detected']),
      recommendation: str(r['Recommendation']) || null,
      details: { cveId: str(r['CVE ID']) || null, threat: str(r['Threat']) || null, ref: str(r['Ref']) || null },
    }));
}

function parseWebApp(workbook) {
  return sheetRows(workbook, 'WebApp')
    .filter((r) => str(r['URL']) && str(r['Vulnerability']))
    .map((r) => ({
      device: str(r['URL']),
      severity: str(r['Severity']) || null,
      title: str(r['Vulnerability']),
      detectedDate: parseViCyberDate(r['Date Detected']),
      recommendation: str(r['Recommendation']) || null,
      details: { threat: str(r['Threat']) || null, impact: str(r['Impact']) || null },
    }));
}

// device combines Host + Port ("192.168.88.1:443") -- the same Host probing
// different ports is a genuinely different finding, not a duplicate; Port
// "0" (ViCyber's own convention for a host-level, not port-level, finding --
// confirmed live, e.g. "It is possible to determine the exact time set on
// the remote host.") is kept as-is rather than special-cased, so the device
// string still reads as "<host>:0" consistently.
function parseNetwork(workbook) {
  return sheetRows(workbook, 'Network')
    .filter((r) => str(r['Host']) && str(r['Vulnerability']))
    .map((r) => ({
      device: `${str(r['Host'])}:${str(r['Port'])}`,
      severity: str(r['Severity']) || null,
      title: str(r['Vulnerability']),
      detectedDate: parseViCyberDate(r['Date Detected']),
      recommendation: str(r['Recommendation']) || null,
      details: { host: str(r['Host']), port: str(r['Port']), description: str(r['Description']) || null, ref: str(r['Ref']) || null },
    }));
}

// DarkWeb has no "finding type" the way the other 3 sheets do -- every row
// IS an exposed credential, so `title` is a fixed label rather than read
// from the sheet (its own "Password Exposed" column holds the exposed
// VALUE, not a category of finding -- kept in details, shown alongside the
// other fields rather than as the headline). `device` is the Account, same
// role Asset/IP/URL/Host play for the other 3 categories -- what this
// finding is actually about.
const DARKWEB_TITLE = 'Exposed Credential';
function parseDarkWeb(workbook) {
  return sheetRows(workbook, 'DarkWeb')
    .filter((r) => str(r['Account']) && str(r['Password Exposed']))
    .map((r) => ({
      device: str(r['Account']),
      severity: str(r['Severity']) || null,
      title: DARKWEB_TITLE,
      detectedDate: parseViCyberDate(r['Date Of Leak']),
      recommendation: str(r['Recommendation']) || null,
      details: { passwordExposed: str(r['Password Exposed']), foundLocation: str(r['Found Location']) || null },
    }));
}

// Reads straight from an in-memory Buffer (multer's own memoryStorage, see
// server.js) -- nothing written to disk at any point.
function parseViCyberWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  return {
    endpoint: parseEndpoint(workbook),
    webapp: parseWebApp(workbook),
    network: parseNetwork(workbook),
    darkweb: parseDarkWeb(workbook),
  };
}

module.exports = { parseViCyberWorkbook, parseViCyberDate };
