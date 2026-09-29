// "Present to Client" -> Make Report -- a read-only, button-free display of
// whatever's currently TICKED on Meeting Prep, by request: "This will show
// only the results from the selections made on the Meeting Prep page
// including the results of the Generate Recommendations Summary and all of
// the content but without the buttons and tiles. The selections will be
// made on Meeting Prep and then displayed on Report page." No search form,
// no card grid, no checkboxes, no ingest/summary buttons -- just the same
// widgets Meeting Prep's own "Selected Overview" tile shows for a ticked
// component, one after another, plus a "Report Notes" section.
//
// "Report Notes" (reportNotesHtml() below), by request -- ONLY the "Worth
// mentioning in the meeting" (tier: 'watch') findings from the shared
// recommendations rules engine (computeFindings(), meeting-prep-
// recommendations.js), not the full 4-tier Recommendations Summary Meeting
// Prep's own button shows -- the other three tiers (action/gather/good)
// are prep work for BEFORE the meeting, not something to put in front of
// the client. Placed first, by request ("Place this section at the
// beginning").
//
// Reads its data from localStorage (meeting-prep-selection.js), not a
// server fetch of its own -- Meeting Prep already fetched everything a
// ticked component needs to render (widgets, tables, device lists) and
// pushes it here on every tick/untick/reorder/new search. Confirmed this
// only ever needs to work within the SAME browser (a second tab/window
// next to Meeting Prep, e.g. a presentation screen), never a different
// device -- see that module's own header for the full reasoning.
//
// "Show full table data" renders as BOTH an inline, collapsed <details>
// toggle (screen only -- same look Meeting Prep's own Selected Overview
// tile uses, detailsBlock()) AND a real #anchor link down to a numbered
// Appendix (print only) -- by request: "when displaying on the screen,
// keep the sections that will become the Appendices minimised. Expand in
// place when clicked and create as Appendices only when making the PDF."
// Both are built into the DOM up front for every table-bearing section;
// styles.css's own @media print rules are what actually decide which one
// shows -- .no-print hides the inline <details> when printing, and
// .mtg-report-appendix-link/.mtg-report-appendix (display: none normally)
// only switch on inside @media print. No JS needed to detect "about to
// print" this way; a plain CSS media query already knows. A <details>
// toggle is JS-driven and wouldn't do anything in an exported PDF anyway,
// which is why print gets the anchor-link/appendix version instead --
// Chrome's Print to PDF keeps same-page #anchor links as clickable
// internal links in the resulting file, a <details> toggle would not.
// Deliberately NOT reusing overviewSectionHtml for this reason -- it calls
// widgetsHtmlForComponent/fullTableHtmlForComponent/detailsBlock directly
// instead, building its own section/appendix markup around the exact same
// underlying widget/table HTML.
import { widgetsHtmlForComponent, fullTableHtmlForComponent, detailsBlock, wireDeviceFilters, formatDateTime, escapeHtml } from '/meeting-prep-report-render.js';
import { computeFindings } from '/meeting-prep-recommendations.js';
import { loadSelection, onSelectionChange } from '/meeting-prep-selection.js';

// Client-facing labels only, by request ("Remove the mentions of Datto on
// headings and links eg. RMM Report and RMM Live", then "leave the word
// INKY out of the report, screen and pdf") -- Meeting Prep's own cards/
// headings keep their real component.source values ("Datto RMM Report",
// "Datto RMM (live)", "INKY" -- meeting-prep/server.js's own
// REPORT_SOURCES/buildDattoLiveDevicesComponent()), scoped to this page
// only since Amber's own working view has no reason to hide which vendor
// system a report came from. INKY's own source value is the WHOLE string
// (not a prefix like "Datto "), so stripping it can leave nothing at all
// -- reportHeading() below drops the "<source> -- " part entirely rather
// than showing a bare " -- " when that happens.
function clientFacingSource(source) {
  return (source || '')
    .replace(/^Datto\s+/i, '')
    .replace(/\(live\)/i, 'Live')
    .replace(/^INKY$/i, '')
    .trim();
}

// "<source> -- <title>" everywhere on this page a component gets a
// heading/back-link label -- built in one place so the "no source left
// after stripping" case (INKY) only has to be handled once.
function reportHeading(c) {
  const source = clientFacingSource(c.source);
  return source ? `${escapeHtml(source)} -- ${escapeHtml(c.title)}` : escapeHtml(c.title);
}

export const id = 'report';
export const label = 'Make Report';

export function mount(container) {
  // The Ambient IT letterhead banner that used to sit here (first shown
  // on both screen and PDF, then PDF-only) is gone entirely, by request
  // ("remove the image at the top of the pdf") -- the plain logo in
  // render()'s own topbar (top-right, both screen and print) is the only
  // Ambient IT branding on this page now.
  container.innerHTML = `
    <p id="report-status" class="status">Nothing selected yet. Tick components on Meeting Prep to have them appear here.</p>
    <div id="report-content"></div>
  `;
  const statusEl = container.querySelector('#report-status');
  const contentEl = container.querySelector('#report-content');

  // Tab Mode (one section visible at a time, a tab strip under Report
  // Notes) vs Page Mode (everything flowing down, unchanged from before
  // this feature) -- by request. Default Tab Mode on every fresh open of
  // this page; switching to Page Mode mid-session sticks across a live
  // selection update (see onSelectionChange() below) but resets back to
  // Tab Mode the next time this page is mounted, same "in-memory only,
  // nothing persisted" scope Meeting Prep's own tick/order state uses.
  // Printing/exporting is NOT affected by either mode -- styles.css's own
  // @media print rules force every section visible regardless, so the PDF
  // always reads like Page Mode, by request ("Page Mode will be as the
  // report is now").
  let reportMode = 'tabs';
  let activeSectionIndex = 0;

  // A section's own on-page id (jumped to FROM its appendix's back-links),
  // index-based since a component's own `id` field can contain characters
  // (slashes, etc., from siteSlug) that aren't guaranteed safe as a bare
  // HTML id/fragment. An appendix's own id is keyed by its APPENDIX
  // NUMBER instead, not the same index -- appendix order is independent
  // of section order (see appendixComponents in render(), below), so the
  // two numbering schemes deliberately don't line up 1:1.
  const sectionAnchorId = (i) => `report-section-${i}`;
  const appendixAnchorId = (num) => `report-appendix-${num}`;

  // datto-live-devices' own device list, by request, stays inline and
  // always visible on screen (unlike every other kind's table, minimised
  // behind a click-to-expand toggle) -- "Keep it in its current position
  // with the side scroll in screen mode" (.mtg-device-table-wrap's own
  // existing scroll box, styles.css, untouched here). Only at print time
  // does it disappear from the section (replaced by the same Appendix
  // link every other kind gets) and reappear as its own Appendix instead.
  function reportSectionHtml(c, i, appendixNumberById) {
    const widgets = widgetsHtmlForComponent(c);
    const table = fullTableHtmlForComponent(c);
    const compact = !widgets;
    const heading = reportHeading(c);
    // Tab Mode only, by request ("Display this in Tab View only and do
    // not include in the PDF") -- styles.css's own .mtg-report-original-link
    // rules handle both halves of that: hidden by default (covers Page
    // Mode), shown only while #report-sections carries the Tab Mode class
    // (mtg-overview-panel--tabs, toggled by applyMode()), and forced
    // hidden again in print regardless of which screen mode was active
    // when Export to PDF was clicked.
    const originalFileLink = c.sourceUrl
      ? `<a class="mtg-report-original-link" href="${escapeHtml(c.sourceUrl)}" target="_blank" rel="noopener noreferrer">Original File</a>`
      : '';
    let tableBlock = '';
    if (table) {
      const appendixNum = appendixNumberById.get(c.id);
      const inlineOnScreen = c.kind === 'datto-live-devices' ? table : detailsBlock('Show full table data', table);
      // Screen: the inline copy above, alongside Original File on the
      // same line, by request ("on the same line next to the 'Show full
      // table data' instead of below it") -- .mtg-report-table-row is
      // what actually lines them up (styles.css), wrapped in .no-print so
      // neither shows up in the printed/exported output (Original File
      // never prints at all -- see above -- and this inline copy is
      // replaced by the real Appendix link below it when printing). Print:
      // a link down to that section's own Appendix (mtg-report-appendix-
      // link starts hidden, switched on only inside @media print -- see
      // styles.css).
      tableBlock = `
        <div class="no-print mtg-report-table-row">
          <div class="mtg-report-table-row-content">${inlineOnScreen}</div>
          ${originalFileLink}
        </div>
        <p class="mtg-report-appendix-link"><a href="#${appendixAnchorId(appendixNum)}">Show full table data (Appendix ${appendixNum})</a></p>`;
    }
    return `
      <div id="${sectionAnchorId(i)}" class="mtg-report-section${compact ? ' mtg-report-section--compact' : ''}" data-section-index="${i}">
        <h3>${heading}</h3>
        ${widgets}
        ${tableBlock}
        ${!table ? originalFileLink : ''}
      </div>`;
  }

  // One appendix per section that actually has full-table data (Autotask
  // Tickets has none -- see fullTableHtmlForComponent()'s own comment --
  // so it gets no appendix, same as it gets no "Show full table data" link
  // above). Starts on its own printed page (styles.css's own
  // .mtg-report-appendix break-before) and carries a back-link at BOTH the
  // top and bottom, by request -- a long appendix (a full device list,
  // say) can run to several printed pages of its own, so the bottom link
  // matters just as much as the top one for actually getting back to
  // where you were.
  function reportAppendixHtml(c, appendixNum, sectionAnchorById) {
    const table = fullTableHtmlForComponent(c);
    const sourceTitle = reportHeading(c);
    const heading = `Appendix ${appendixNum}: ${sourceTitle}`;
    const backLink = `<p class="mtg-report-appendix-nav"><a href="#${sectionAnchorById.get(c.id)}">&uarr; Back to ${sourceTitle}</a></p>`;
    return `
      <div id="${appendixAnchorId(appendixNum)}" class="mtg-report-appendix">
        ${backLink}
        <h2>${heading}</h2>
        ${table}
        ${backLink}
      </div>`;
  }

  // Same "all loaded components, not just ticked" scope Meeting Prep's own
  // "Generate Recommendations Summary" button uses -- see meeting-prep-
  // selection.js's own saveSelection() comment for why allComponents is
  // carried separately from selectedComponents. Only the 'watch' tier
  // ("Worth mentioning in the meeting") shows here -- see this file's own
  // top-of-file comment for why the other three tiers don't belong on a
  // client-facing page.
  function reportNotesHtml(allComponents) {
    if (!allComponents || allComponents.length === 0) return '';
    const findings = computeFindings(allComponents).filter((f) => f.tier === 'watch');
    if (findings.length === 0) return '';
    const items = findings
      .map(
        (f) => `
        <div class="mtg-rec-item">
          <p class="mtg-rec-item-title">${escapeHtml(f.title)}</p>
          <p class="mtg-rec-item-detail">${escapeHtml(f.detail)}</p>
        </div>`
      )
      .join('');
    return `
      <div class="mtg-report-notes">
        <h2>Report Notes</h2>
        <div class="mtg-rec-group mtg-rec-group--watch">${items}</div>
      </div>`;
  }

  // One tab per ticked section, by request. Own dedicated classes
  // (.mtg-report-tab*, styles.css), not Meeting Prep's own subtler
  // .mtg-overview-tab site-tabs -- by request ("make the tabs look more
  // like tabs, particularly more noticeable"), a bolder tab-bar look that
  // would be too heavy for Meeting Prep's own smaller per-site strip, so
  // this page gets its own look rather than reusing/changing that shared
  // class. Tab label is just the title -- NOT reportHeading()'s own
  // "<source> -- <title>" the section's on-page heading uses, by request
  // ("remove the '<something> --' from the tab names. The part following
  // is enough").
  function reportTabLabel(c) {
    return escapeHtml(c.title);
  }

  function buildTabStrip(selected) {
    const tabsEl = contentEl.querySelector('#report-tabs');
    if (!tabsEl) return;
    if (activeSectionIndex >= selected.length) activeSectionIndex = 0;
    tabsEl.innerHTML = selected
      .map(
        (c, i) =>
          `<button type="button" class="mtg-report-tab${i === activeSectionIndex ? ' mtg-report-tab--active' : ''}" data-section-index="${i}">${reportTabLabel(c)}</button>`
      )
      .join('');
    tabsEl.querySelectorAll('.mtg-report-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeSectionIndex = Number(btn.dataset.sectionIndex);
        applyMode();
      });
    });
  }

  // Shows/hides sections per the current mode -- plain `hidden` on each
  // section element (not a CSS class), same "toggle via el.hidden, not
  // style.display" convention this dashboard uses everywhere else. Print
  // ignores this entirely (styles.css's own @media print rule un-hides
  // every section), so switching modes never changes what a PDF export
  // looks like.
  function applyMode() {
    const tabsEl = contentEl.querySelector('#report-tabs');
    const dividerEl = contentEl.querySelector('#report-page-divider');
    const sectionsEl = contentEl.querySelector('#report-sections');
    const modeToggle = contentEl.querySelector('#report-mode-toggle');
    if (!sectionsEl) return;
    const sectionEls = [...sectionsEl.querySelectorAll('.mtg-report-section')];
    const inTabs = reportMode === 'tabs';
    if (tabsEl) tabsEl.hidden = !inTabs;
    // A plain grey rule in the tab strip's own spot, by request ("add a
    // grey horizontal line in Page Mode where the Tabs used to be") --
    // exactly inverted from the tabs' own visibility (shown in Page Mode,
    // hidden in Tab Mode), so there's always something marking that seam
    // between Report Notes and the sections below, whichever mode is on.
    if (dividerEl) dividerEl.hidden = inTabs;
    sectionsEl.classList.toggle('mtg-overview-panel--tabs', inTabs);
    sectionEls.forEach((el) => {
      el.hidden = inTabs && Number(el.dataset.sectionIndex) !== activeSectionIndex;
    });
    if (tabsEl) {
      tabsEl.querySelectorAll('.mtg-report-tab').forEach((btn) => {
        btn.classList.toggle('mtg-report-tab--active', Number(btn.dataset.sectionIndex) === activeSectionIndex);
      });
    }
    if (modeToggle) modeToggle.textContent = inTabs ? 'Page Mode' : 'Tab Mode';
  }

  function render(selection) {
    const selected = (selection && selection.selectedComponents) || [];
    if (selected.length === 0) {
      statusEl.hidden = false;
      contentEl.innerHTML = '';
      return;
    }
    statusEl.hidden = true;

    // Appendix order/numbering is independent of section order -- the
    // Datto Live Devices' own device list always becomes Appendix 1
    // regardless of where its section sits among what's ticked, by
    // request ("move the Device List from the RMM Live section to be the
    // first Appendix"). Only components that actually have table content
    // get an appendix at all (fullTableHtmlForComponent() returns null
    // for the ones that don't).
    const withTables = selected.filter((c) => !!fullTableHtmlForComponent(c));
    const deviceListFirst = withTables.filter((c) => c.kind === 'datto-live-devices');
    const restInOrder = withTables.filter((c) => c.kind !== 'datto-live-devices');
    const appendixComponents = [...deviceListFirst, ...restInOrder];
    const appendixNumberById = new Map(appendixComponents.map((c, i) => [c.id, i + 1]));
    const sectionAnchorById = new Map(selected.map((c, i) => [c.id, sectionAnchorId(i)]));

    const reportNotes = reportNotesHtml(selection.allComponents);
    const sections = selected.map((c, i) => reportSectionHtml(c, i, appendixNumberById)).join('');
    const appendices = appendixComponents.map((c) => reportAppendixHtml(c, appendixNumberById.get(c.id), sectionAnchorById)).join('');

    contentEl.innerHTML = `
      <div class="mtg-report-topbar">
        <button type="button" id="report-print-button" class="button-link button-link--small no-print">Export to PDF</button>
        <button type="button" id="report-mode-toggle" class="button-link button-link--small no-print"></button>
        <div class="mtg-report-topbar-right">
          <img src="/logo.png" alt="Ambient IT" class="mtg-report-logo" />
          <p class="mtg-report-asof">As of ${escapeHtml(formatDateTime(selection.asOf))}</p>
        </div>
      </div>
      ${reportNotes}
      <div class="mtg-report-tabs no-print" id="report-tabs"></div>
      <hr class="mtg-report-page-divider no-print" id="report-page-divider" />
      <div class="mtg-overview-panel" id="report-sections">${sections}</div>
      ${appendices}
    `;
    wireDeviceFilters(contentEl);
    // Native print dialog -- "Save as PDF" is a destination choice inside
    // it on every real OS/browser, not a separate code path this page has
    // to implement itself. styles.css's own @media print rules (the
    // .no-print button included) handle what the resulting document looks
    // like.
    contentEl.querySelector('#report-print-button').addEventListener('click', () => window.print());
    contentEl.querySelector('#report-mode-toggle').addEventListener('click', () => {
      reportMode = reportMode === 'tabs' ? 'page' : 'tabs';
      applyMode();
    });
    buildTabStrip(selected);
    applyMode();
  }

  render(loadSelection());

  // Live-updates while this page sits open in one tab and Meeting Prep is
  // being ticked in another (the main real-world shape: presenting on a
  // second screen while picking components on your own laptop). Self-
  // cleaning -- unsubscribes the moment this page's own container leaves
  // the DOM, same reasoning as every other page-lifetime listener on this
  // dashboard that has no explicit unmount hook to rely on.
  const unsubscribe = onSelectionChange(() => {
    if (!container.isConnected) {
      unsubscribe();
      return;
    }
    render(loadSelection());
  });
}
