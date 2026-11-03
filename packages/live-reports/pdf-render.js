const puppeteer = require('puppeteer-core');

// Renders a self-contained HTML string to a PDF buffer via puppeteer-core
// driving an EXISTING Chrome/Edge install, rather than the plain
// `puppeteer` package (which bundles its own ~300MB Chromium download) --
// this machine already has both Edge and Chrome (confirmed live), and a
// Windows Server box (where this dashboard is actually deployed) ships
// Edge by default, so there's no real reason to also ship a second,
// redundant browser binary just for this one feature.
const CANDIDATE_PATHS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

function findBrowserExecutable() {
  const fs = require('fs');
  return CANDIDATE_PATHS.find((p) => fs.existsSync(p)) || null;
}

function hasPdfBrowser() {
  return findBrowserExecutable() !== null;
}

// `headerTemplate`/`footerTemplate` are real HTML (their own tiny
// document, not CSS on the main page) -- Puppeteer's own PDF engine
// renders them on every page, which is the only way to get the repeating
// footer/page-number band a plain HTML page can't do by itself. Classes
// like `pageNumber`/`totalPages` are literal strings Puppeteer itself
// substitutes, not something this file's own CSS has to define.
async function renderPdf(html, { footerText }) {
  const executablePath = findBrowserExecutable();
  if (!executablePath) throw new Error('No Chrome/Edge install found to render the PDF (checked the usual Program Files locations).');

  const browser = await puppeteer.launch({ executablePath, headless: 'new', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '0.4in', bottom: '0.5in', left: '0.4in', right: '0.4in' },
      displayHeaderFooter: true,
      headerTemplate: '<span></span>', // blank -- the page's own navy header band already carries the logo/title, no need for Puppeteer's own header too
      footerTemplate: `
        <div style="font-size: 8px; color: #6b7280; width: 100%; padding: 0 0.4in; display: flex; justify-content: space-between; font-family: Arial, sans-serif;">
          <span>${footerText}</span>
          <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
        </div>`,
    });
    // Puppeteer's own page.pdf() resolves a plain Uint8Array, NOT a real
    // Node Buffer -- confirmed live this session the hard way: Express's
    // real res.send() only serializes an actual Buffer as binary; a
    // Uint8Array fails its Buffer.isBuffer() check and falls through to
    // being JSON-encoded instead (`{"0":37,"1":80,...}`), which downloads
    // as a same-sized file that LOOKS like a PDF in a byte count but isn't
    // one -- "the PDF can't be opened". Every direct-call diagnostic this
    // session happened to dodge this because each one manually wrapped
    // the result in Buffer.from() before writing it to disk; wrapped here
    // instead, at the source, so every real caller gets a true Buffer.
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

module.exports = { hasPdfBrowser, renderPdf };
