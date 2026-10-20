// Pure, credential-free helpers -- the filename pattern/sanitisation rules
// and the documentDate fallback rule from Amber's brief, kept separate from
// Graph/OpenAI plumbing so they're trivially unit-testable (node --eval /
// a throwaway script) without any live credentials.

// Brief's own flagged assumption, adopted as proposed: use the date printed
// on the document when the model read it confidently; otherwise fall back
// to the email's own received date (already resolved to its AEST calendar
// date by the caller).
function resolveDocumentDate(extracted, receivedDateAestKey) {
  if (extracted.documentDate && extracted.documentDateConfident) return extracted.documentDate;
  return receivedDateAestKey;
}

const MAX_FILENAME_LENGTH = 180; // generous cap, comfortably under Windows'/SharePoint's own limits with room for a " (2)" suffix

// Strips characters invalid on Windows/SharePoint (/ \ : * ? " < > |),
// collapses whitespace, and trims leading/trailing space/dot (a trailing
// dot or space is silently stripped by Windows anyway, which can otherwise
// produce a filename that looks fine here but lands differently on disk).
function sanitisePart(s) {
  return String(s || '')
    .replace(/[/\\:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s.]+$/, '')
    .replace(/^[\s.]+/, '');
}

// Builds "YYYY-MM-DD, Supplier, Customer, Description.ext" -- each part
// after the date is optional and simply omitted (never a dangling comma)
// when not known. `supplier` should already be "Unknown Supplier" by the
// time this is called if extraction couldn't read one -- this function
// itself has no opinion on that fallback, it just joins whatever parts it's
// given.
function buildFilename({ date, supplier, customer, description, ext }) {
  const parts = [date, supplier, customer, description].map(sanitisePart).filter(Boolean);
  let name = parts.join(', ');
  const extension = (ext || '').replace(/^\./, '').toLowerCase();
  const suffix = extension ? `.${extension}` : '';
  const maxBase = MAX_FILENAME_LENGTH - suffix.length;
  if (name.length > maxBase) name = name.slice(0, maxBase).replace(/[\s,]+$/, '');
  return `${name}${suffix}`;
}

// Appends " (2)", " (3)", ... before the extension until the name is free
// in `existingNames` (case-insensitive -- SharePoint/Windows both treat
// filenames case-insensitively for collision purposes).
function dedupeFilename(desiredName, existingNames) {
  const existingLower = new Set((existingNames || []).map((n) => n.toLowerCase()));
  if (!existingLower.has(desiredName.toLowerCase())) return desiredName;
  const dotIndex = desiredName.lastIndexOf('.');
  const base = dotIndex > 0 ? desiredName.slice(0, dotIndex) : desiredName;
  const ext = dotIndex > 0 ? desiredName.slice(dotIndex) : '';
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base} (${n})${ext}`;
    if (!existingLower.has(candidate.toLowerCase())) return candidate;
  }
  throw new Error(`Could not find a free filename for "${desiredName}" after 999 attempts.`);
}

module.exports = { resolveDocumentDate, sanitisePart, buildFilename, dedupeFilename };
