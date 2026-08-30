import { createTabbedPageMount } from '/tab-page-client.js';

export const id = "licensing-tabs";
export const label = "Licensing";

// Same tabbed-layout treatment as Ticket Info (see @dashboard/shell's
// shared tab-page-client.js for the actual mechanism), pre-populated with
// the existing "Licensing" category's own pages.
export const mount = createTabbedPageMount({
  id,
  label,
  apiBase: '/api/licensing-tabs',
  defaultTabs: [
    { id: 'ingram-subscriptions', label: 'Ingram Subscriptions' },
    { id: 'ingram-orders', label: 'Ingram Orders' },
    { id: 'm365-environment', label: 'M365 Environment' },
    { id: 'csp-customers', label: 'CSP Customers' },
  ],
});
