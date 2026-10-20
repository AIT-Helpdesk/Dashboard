const axios = require('axios');
const { PDFParse } = require('pdf-parse');

// Reads supplier/customer/description/date out of one invoice or receipt
// attachment. Two paths converge on the same single Azure OpenAI chat call:
//   - a PDF with real embedded text -> plain text extraction (pdf-parse,
//     same extractPdfText() call as packages/meeting-prep/ingest.js)
//   - a scanned/image-only PDF, or a plain PNG/JPG/JPEG attachment (often a
//     skewed, poorly-lit phone photo) -> render/encode to image(s) and let
//     a VISION-capable chat deployment do OCR and structured extraction in
//     one call, rather than wiring in a separate OCR engine (Tesseract,
//     etc.) -- a vision model reading a messy phone photo directly tends to
//     cope with skew/lighting better than classic OCR + a second text pass,
//     and it's one fewer dependency.
//
// Own dedicated Azure OpenAI resource (AZURE_OPENAI_INVOICE_*), not reused
// from Voice Scheduler or the Report page -- invoices/receipts carry real
// supplier and financial detail, same "own resource, own content-filter/
// abuse-monitoring policy for sensitive content" reasoning packages/report
// already applies to client device/patch data.
const {
  AZURE_OPENAI_INVOICE_KEY,
  AZURE_OPENAI_INVOICE_ENDPOINT,
  AZURE_OPENAI_INVOICE_CHAT_DEPLOYMENT,
} = process.env;

function extractionModelConfigured() {
  return !!(AZURE_OPENAI_INVOICE_KEY && AZURE_OPENAI_INVOICE_ENDPOINT && AZURE_OPENAI_INVOICE_CHAT_DEPLOYMENT);
}

function baseUrl() {
  return AZURE_OPENAI_INVOICE_ENDPOINT.replace(/\/+$/, '');
}

// Pinned, not "latest" -- same reasoning as every other Azure OpenAI caller
// on this dashboard (voice-scheduler/server.js, report/server.js): an
// Azure-side version bump changing the response shape underneath this code
// without anyone touching it here is worse than occasionally bumping this
// constant on purpose. Confirm against the real resource once it exists
// (Phase A) -- adjust if Azure reports DeploymentNotFound against it.
const CHAT_API_VERSION = '2025-03-01-preview';

async function chatJson(messages) {
  const url = `${baseUrl()}/openai/deployments/${AZURE_OPENAI_INVOICE_CHAT_DEPLOYMENT}/chat/completions?api-version=${CHAT_API_VERSION}`;
  const res = await axios.post(
    url,
    { messages, temperature: 0, response_format: { type: 'json_object' } },
    { headers: { 'api-key': AZURE_OPENAI_INVOICE_KEY, 'Content-Type': 'application/json' } }
  );
  const content = res.data.choices?.[0]?.message?.content || '{}';
  return JSON.parse(content);
}

// A real embedded-text PDF (an emailed Xero/MYOB-style invoice, say) comes
// back with thousands of characters; a scanned/image-only PDF comes back
// with little or nothing (pdf-parse finds no text operators to read) -- this
// threshold is just "clearly real text was found", not a precise measure.
const MIN_TEXT_LENGTH_FOR_TEXT_PATH = 40;

async function extractPdfText(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result.text || '';
  } finally {
    await parser.destroy();
  }
}

// Renders up to the first few pages of a PDF straight to data URLs --
// PDFParse.getScreenshot({ imageDataUrl: true }) does the rasterizing (via
// its own bundled canvas dependency), no separate PDF-to-image library
// needed. Capped at 3 pages: an invoice/receipt is virtually always 1-2
// pages, and sending more just inflates the vision call for no benefit.
const MAX_SCREENSHOT_PAGES = 3;

async function renderPdfPagesToDataUrls(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getScreenshot({ imageDataUrl: true, scale: 2, first: MAX_SCREENSHOT_PAGES });
    return (result.pages || []).map((p) => p.dataUrl).filter(Boolean);
  } finally {
    await parser.destroy();
  }
}

function imageBufferToDataUrl(buffer, contentType) {
  return `data:${contentType};base64,${buffer.toString('base64')}`;
}

function systemPrompt() {
  return `You are reading one invoice or receipt document (a PDF or a photo of a paper receipt -- photos are often skewed, poorly lit, or held in someone's hand) for an MSP's bookkeeping intake pipeline. Extract exactly this JSON shape and nothing else, no markdown fencing:

{"supplier": "..." or null, "customer": "..." or null, "description": "..." or null, "documentDate": "YYYY-MM-DD" or null, "documentDateConfident": true or false}

Rules:
- "supplier" is who ISSUED this document (who is being paid) -- read it from the document's own letterhead/branding/content, NEVER from an email sender address or forwarder name (accounts systems, bookkeepers, and forwarding services commonly send these on the supplier's behalf). If the issuer's own letterhead shows it is trading under a different name than its registered legal entity (e.g. "Legal Entity Pty Ltd (Operating as X)", "Legal Entity Pty Ltd T/As X", "trading as X"), use ONLY that trading name X as "supplier" -- not the full legal entity name alongside it. null only if genuinely unreadable.
- "customer" is who the document was issued TO (the paying party), if clearly identifiable on the document itself or obvious from the accompanying email subject/body given below. EXCEPTION: if this document is for registering, purchasing, transferring, or renewing one or more domain names, set "customer" to the domain name itself (e.g. "example.com.au") instead of the paying company name -- the paying company is almost always this MSP itself, which isn't useful here, while the domain name is. If several domains appear, use the main/first one. Otherwise null if not clear.
- "description" is a SHORT (a few words) description of what the document is for, ONLY if something clear and brief is obvious (e.g. from the email subject). null if nothing short and clear comes to mind -- never pad this out or guess at length.
- "documentDate" is the invoice/receipt date actually printed on the document, as YYYY-MM-DD. Set "documentDateConfident": true only when you can read it clearly; set it false (and documentDate can still be your best guess, or null) whenever the date is ambiguous, unclear, or not visibly printed at all -- a calling system will fall back to the email's received date whenever this is false.
- Respond with ONLY the JSON object.`;
}

function userContextText({ emailSubject, emailBodyPreview, documentText }) {
  const lines = [
    `Email subject: ${emailSubject || '(none)'}`,
    `Email body preview: ${(emailBodyPreview || '(none)').slice(0, 500)}`,
  ];
  if (documentText) lines.push('', 'Document text:', documentText.slice(0, 8000));
  return lines.join('\n');
}

async function extractDocument({ buffer, contentType, filename, emailSubject, emailBodyPreview }) {
  if (!extractionModelConfigured()) {
    throw new Error('Azure OpenAI (invoice extraction) is not configured -- see .env.example (AZURE_OPENAI_INVOICE_*).');
  }

  const isPdf = /\.pdf$/i.test(filename) || contentType === 'application/pdf';
  let textContent = '';
  if (isPdf) {
    try {
      textContent = await extractPdfText(buffer);
    } catch {
      textContent = ''; // a malformed/scanned PDF can fail text extraction outright -- falls through to the vision path below
    }
  }

  const useTextPath = isPdf && textContent.trim().length >= MIN_TEXT_LENGTH_FOR_TEXT_PATH;

  let userContent;
  if (useTextPath) {
    userContent = userContextText({ emailSubject, emailBodyPreview, documentText: textContent });
  } else {
    const dataUrls = isPdf ? await renderPdfPagesToDataUrls(buffer) : [imageBufferToDataUrl(buffer, contentType)];
    if (dataUrls.length === 0) throw new Error('Could not render any page/image for the vision extraction path.');
    userContent = [
      { type: 'text', text: userContextText({ emailSubject, emailBodyPreview, documentText: '' }) },
      ...dataUrls.map((url) => ({ type: 'image_url', image_url: { url } })),
    ];
  }

  const messages = [
    { role: 'system', content: systemPrompt() },
    { role: 'user', content: userContent },
  ];

  const result = await chatJson(messages);
  return {
    supplier: result.supplier || null,
    customer: result.customer || null,
    description: result.description || null,
    documentDate: result.documentDate || null,
    documentDateConfident: !!result.documentDateConfident,
  };
}

module.exports = { extractionModelConfigured, extractDocument, extractPdfText, renderPdfPagesToDataUrls };
