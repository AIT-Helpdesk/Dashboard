import { createTabbedPageMount } from '/tab-page-client.js';

export const id = "ticket-info-tabs";
export const label = "Ticket Info";

// A different layout experiment, by request: instead of four separate
// sidebar entries (the existing "Ticket Info" category -- now hidden, by
// request, in favour of this page -- Asked for Review / Tickets Created /
// Completed Tickets / Ticket Times), this ONE page shows all four as
// tabs, each mounting that page's own REAL client.js module unmodified.
// The actual tab-strip mechanism (drag-to-reorder, drag-a-sidebar-page-in
// to add a personal tab, admin-only "make permanent for everyone", the
// Help tab) lives in @dashboard/shell's shared tab-page-client.js -- see
// that file for the full implementation, now reused by every tabbed page
// on this dashboard, not just this one.
//
// Time Summaries ('times') was a 5th default tab here; removed by request
// when that page moved into the new admin-only "Builders" category and
// picked up its own `restrictedTo`. createTabbedPageMount()'s own
// DEFAULT_TABS are rendered unconditionally (unlike dragged-in/permanent
// tabs, which are filtered against PAGES_BY_ID -- see tab-page-client.js),
// so leaving a now-restricted page in this list would show every non-admin
// a tab whose client.js/API 404s the moment they click it.
export const mount = createTabbedPageMount({
  id,
  label,
  apiBase: '/api/ticket-info-tabs',
  defaultTabs: [
    { id: 'asked-for-review', label: 'Asked for Review' },
    { id: 'tickets-created-today', label: 'Tickets Created' },
    { id: 'completed-tickets', label: 'Completed Tickets' },
    { id: 'ticket-times', label: 'Ticket Times' },
  ],
});
