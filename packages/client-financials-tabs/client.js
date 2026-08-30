import { createTabbedPageMount } from '/tab-page-client.js';

export const id = "client-financials-tabs";
export const label = "Client Financials";

// Same tabbed-layout treatment as Ticket Info (see @dashboard/shell's
// shared tab-page-client.js for the actual mechanism), pre-populated with
// the existing "Client Financials" category's own pages.
export const mount = createTabbedPageMount({
  id,
  label,
  apiBase: '/api/client-financials-tabs',
  defaultTabs: [
    { id: 'client-summary', label: 'Client Summary' },
    { id: 'contract-services', label: 'Contract Services' },
    { id: 'client-financials', label: 'Client Financials' },
  ],
});
