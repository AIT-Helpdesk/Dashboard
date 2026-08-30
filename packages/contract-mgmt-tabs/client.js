import { createTabbedPageMount } from '/tab-page-client.js';

export const id = "contract-mgmt-tabs";
export const label = "Contract Mgmnt";

// Same tabbed-layout treatment as Ticket Info (see @dashboard/shell's
// shared tab-page-client.js for the actual mechanism), pre-populated with
// the existing "Update Contracts" category's own pages.
export const mount = createTabbedPageMount({
  id,
  label,
  apiBase: '/api/contract-mgmt-tabs',
  defaultTabs: [
    { id: 'contract-checks', label: 'Contract Checks' },
    { id: 'check-client', label: 'Check Client' },
    { id: 'contract-services-update-contracts', label: 'Contract Services' },
    { id: 'ingram-subscriptions-update-contracts', label: 'Ingram Subscriptions' },
    { id: 'ingram-orders-update-contracts', label: 'Ingram Orders' },
  ],
});
