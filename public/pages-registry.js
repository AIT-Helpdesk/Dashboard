// To add a new dashboard page: create public/pages/your-page.js exporting
// `id`, `label`, and `mount(container)`, then add an entry here.
export const pages = [
  {
    id: 'completed-tickets',
    label: 'Completed Tickets',
    module: () => import('./pages/completed-tickets.js'),
  },
];