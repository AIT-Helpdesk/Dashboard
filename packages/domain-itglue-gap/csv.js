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

// Four sections, same shape as the ticket body: domains missing from IT
// Glue (with their resolved Autotask Client), domains with no Name:TPP
// match at all (with their raw TPP account reference, by request -- TPP's
// bulk domain list has no actual customer-name field, confirmed live, so
// the account reference is labelled honestly as what it is), domains
// filed under the WRONG Client in IT Glue (both the correct Client and the
// wrong organisation it's actually sitting under, by request), and domains
// that don't match their Client's own Primary Contact email domain (by
// request). Neither Expiry Mismatch nor its own "off by exactly 1 day"
// sibling bucket is included here at all -- by request ("Don't add the
// expiry discrepancies to the ticket at all ... it's all too crappy"),
// the whole check is dashboard-only (see job.js's own buildTicketBody()
// comment). The "IT Glue Expires" column this file used to carry only for
// Expiry Mismatch's own rows is gone too, for the same reason.
function buildGapCsv(gaps, unmatched, wrongClient, emailDomainMismatch) {
  const lines = [
    'Section,Domain,Expiry Date,Autotask Client,Currently Filed Under (IT Glue),Primary Contact Email Domain,TPP Account Reference',
    ...gaps.map((d) => csvRow(['Missing from IT Glue', d.domainName, d.expiryDate, d.autotaskClientName, '', '', d.accountReference || ''])),
    ...unmatched.map((d) => csvRow(['No matching Autotask Client', d.domainName, d.expiryDate, '', '', '', d.accountReference || ''])),
    ...wrongClient.map((d) => csvRow(['Wrong Client in IT Glue', d.domainName, d.expiryDate, d.autotaskClientName, d.wrongOrgName, '', d.accountReference || ''])),
    ...emailDomainMismatch.map((d) => csvRow(['Email Domain Mismatch', d.domainName, d.expiryDate, d.autotaskClientName, '', d.contactEmailDomain, d.accountReference || ''])),
  ];
  return lines.join('\r\n');
}

module.exports = { buildGapCsv, csvField, csvRow };
