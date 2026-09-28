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
// headings and links eg. RMM Report and RMM Live") -- Meeting Prep's own
// cards/headings keep their real component.source values ("Datto RMM
// Report", "Datto RMM (live)" -- meeting-prep/server.js's own
// REPORT_SOURCES/buildDattoLiveDevicesComponent()), scoped to this page
// only since Amber's own working view has no reason to hide which vendor
// system a report came from.
function clientFacingSource(source) {
  return (source || '').replace(/^Datto\s+/i, '').replace(/\(live\)/i, 'Live');
}

export const id = 'report';
export const label = 'Make Report';

export function mount(container) {
  // Ambient IT letterhead, by request ("use this image as a page header
  // for the report ... On the Make Report page and on the PDF") --
  // served from shell/public (same convention as logo.png/favicon.png), a
  // straight copy of Amber's own supplied file, not regenerated or
  // resized. Outside #report-content, not rebuilt by render() -- a page
  // header, shown regardless of whether there's a selection to display
  // yet.
  container.innerHTML = `
    <img src="/report-letterhead.png" alt="Ambient IT" class="mtg-report-letterhead" />
    <p id="report-status" class="status">Nothing selected yet. Tick components on Meeting Prep to have them appear here.</p>
    <div id="report-content"></div>
  `;
  const statusEl = container.querySelector('#report-status');
  const contentEl = container.querySelector('#report-content');

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
    const heading = `${escapeHtml(clientFacingSource(c.source))} -- ${escapeHtml(c.title)}`;
    let tableBlock = '';
    if (table) {
      const appendixNum = appendixNumberById.get(c.id);
      const inlineOnScreen = c.kind === 'datto-live-devices' ? table : detailsBlock('Show full table data', table);
      // Screen: the inline copy above (wrapped .no-print so it never
      // shows up in the printed/exported output too, alongside the
      // appendix). Print: a link down to that section's own Appendix
      // (mtg-report-appendix-link starts hidden, switched on only inside
      // @media print -- see styles.css).
      tableBlock = `
        <div class="no-print">${inlineOnScreen}</div>
        <p class="mtg-report-appendix-link"><a href="#${appendixAnchorId(appendixNum)}">Show full table data (Appendix ${appendixNum})</a></p>`;
    }
    return `
      <div id="${sectionAnchorId(i)}" class="mtg-report-section${compact ? ' mtg-report-section--compact' : ''}">
        <h3>${heading}</h3>
        ${widgets}
        ${tableBlock}
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
    const sourceTitle = `${escapeHtml(clientFacingSource(c.source))} -- ${escapeHtml(c.title)}`;
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
        <p class="mtg-report-asof">As of ${escapeHtml(formatDateTime(selection.asOf))}</p>
      </div>
      ${reportNotes}
      <div class="mtg-overview-panel">${sections}</div>
      ${appendices}
    `;
    wireDeviceFilters(contentEl);
    // Native print dialog -- "Save as PDF" is a destination choice inside
    // it on every real OS/browser, not a separate code path this page has
    // to implement itself. styles.css's own @media print rules (the
    // .no-print button included) handle what the resulting document looks
    // like.
    contentEl.querySelector('#report-print-button').addEventListener('click', () => window.print());
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
