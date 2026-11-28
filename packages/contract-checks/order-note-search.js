const { listAll, fetchByFieldIn } = require('@dashboard/autotask-client');

// Searches TicketNotes.description for `text` (optionally only notes
// created on/after `sinceISO`) and resolves each match back to its real
// parent Ticket. Pulled into its own tiny module (not left inline in
// server.js) specifically so sync.js can reuse this EXACT same query --
// server.js's own interactive "Search Order Number" popup and sync.js's
// own automatic per-order ticket discovery (by request) must never
// quietly drift apart on what counts as a match. server.js already
// requires sync.js, so sync.js requiring server.js back would be a real
// circular require (Node would hand it an incomplete, still-being-built
// module); this file depends on neither, so both can require it cleanly.
async function findTicketsByNoteText(client, text, sinceISO) {
  const dateFilter = sinceISO ? [{ op: 'gte', field: 'createDateTime', value: sinceISO }] : [];
  const noteMatches = await listAll(client.ticketNotes, [{ op: 'contains', field: 'description', value: text }, ...dateFilter]);
  const ticketIds = [...new Set(noteMatches.map((n) => n.ticketID).filter((id) => id != null))];
  if (ticketIds.length === 0) return [];
  return fetchByFieldIn(client.tickets, 'id', ticketIds);
}

module.exports = { findTicketsByNoteText };
