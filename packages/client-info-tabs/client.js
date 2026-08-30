import { createTabbedPageMount } from '/tab-page-client.js';

export const id = "client-info-tabs";
export const label = "Client Info";

// Same tabbed-layout treatment as Ticket Info (see @dashboard/shell's
// shared tab-page-client.js for the actual mechanism), pre-populated with
// the existing "Client Info" category's own pages.
export const mount = createTabbedPageMount({
  id,
  label,
  apiBase: '/api/client-info-tabs',
  defaultTabs: [
    { id: 'client-details', label: 'Client Details' },
    { id: 'client-contacts', label: 'Client Contacts' },
    { id: 'client-activity', label: 'Client Activity' },
    { id: 'classification-summary', label: 'Clients by Classification' },
    { id: 'find-passwords', label: 'Find Passwords' },
  ],
});
