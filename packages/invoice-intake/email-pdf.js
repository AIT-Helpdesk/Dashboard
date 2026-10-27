const PDFDocument = require('pdfkit');

// Builds a quick, plain-text PDF of an email's own body -- used only by
// ingest.js's email-body-as-invoice fallback (no attachment, but the email
// itself is the invoice/receipt, by request Oct 2026). Deliberately NOT a
// faithful re-rendering of the original HTML (no logos/tables/styling) --
// just enough structure (subject, received date, then the body text) that
// the filed PDF is self-contained and useful on its own later, without
// pulling in a browser-rendering dependency (Puppeteer et al.) for what's
// explicitly meant to be a quick fallback, not the primary path.
function buildPdfFromEmailBody({ subject, receivedDateTime, bodyText }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(14).text(subject || '(no subject)', { underline: true });
    if (receivedDateTime) {
      doc.moveDown(0.3).fontSize(9).fillColor('#666666').text(`Received: ${receivedDateTime}`);
      doc.fillColor('#000000');
    }
    doc.moveDown(1).fontSize(11).text(bodyText || '(empty body)', { align: 'left' });
    doc.end();
  });
}

module.exports = { buildPdfFromEmailBody };
