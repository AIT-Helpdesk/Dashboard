// Same escaping convention @dashboard/contact-search's own downloadCsv()
// uses client-side (csvField()/\r\n rows) -- ported here as a plain
// server-side string builder (no Blob/browser APIs), since this CSV gets
// base64-encoded and attached to the Autotask ticket, not downloaded.
function csvField(value) {
  const str = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function csvRow(values) {
  return values.map(csvField).join(',');
}

// Two sections, same shape as the ticket body: domains missing from IT Glue
// (with their resolved Autotask Client), then domains with no Name:TPP
// match at all (with their raw TPP account reference, by request -- TPP's
// bulk domain list has no actual customer-name field, confirmed live, so
// the account reference is labelled honestly as what it is).
function buildGapCsv(gaps, unmatched) {
  const lines = [
    'Section,Domain,Expiry Date,Autotask Client,TPP Account Reference',
    ...gaps.map((d) => csvRow(['Missing from IT Glue', d.domainName, d.expiryDate, d.autotaskClientName, d.accountReference || ''])),
    ...unmatched.map((d) => csvRow(['No matching Autotask Client', d.domainName, d.expiryDate, '', d.accountReference || ''])),
  ];
  return lines.join('\r\n');
}

module.exports = { buildGapCsv, csvField, csvRow };
