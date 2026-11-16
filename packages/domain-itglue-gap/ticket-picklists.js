const { getPicklistLabels } = require('@dashboard/autotask-client');

// Resolved by LABEL at runtime, not hardcoded numeric IDs -- confirmed live
// this session (Queue "Helpdesk" = 29682833, Priority "!! SET PRIORITY" = 2,
// Ticket Type "Change Request" = 4, Status "New" = 1), but Autotask picklist
// entries are account-editable, so this stays correct if one is ever
// relabeled without needing a code change. `getPicklistLabels()` itself
// (@dashboard/autotask-client) is forward-only (code -> label); this just
// adds the reverse lookup, same "iterate and match" shape
// resolveLeaveTimeOffRequestTypeIds() already uses in that same package.
async function resolveIdByLabel(entity, fieldName, label) {
  const labels = await getPicklistLabels(entity, fieldName);
  for (const [id, l] of labels.entries()) {
    if (l === label) return id;
  }
  throw new Error(`No "${fieldName}" picklist value found with label "${label}" on ${entity.endpoint}.`);
}

const QUEUE_LABEL = 'Helpdesk';
const PRIORITY_LABEL = '!! SET PRIORITY';
const TICKET_TYPE_LABEL = 'Change Request';
// "New", not "New - Helpdesk" -- the latter is a real, separate status in
// this account's picklist and may carry its own workflow automation; this
// job just wants a plain, unremarkable open status.
const STATUS_LABEL = 'New';

async function resolveTicketPicklists(client) {
  const [queueID, priority, ticketType, status] = await Promise.all([
    resolveIdByLabel(client.tickets, 'queueID', QUEUE_LABEL),
    resolveIdByLabel(client.tickets, 'priority', PRIORITY_LABEL),
    resolveIdByLabel(client.tickets, 'ticketType', TICKET_TYPE_LABEL),
    resolveIdByLabel(client.tickets, 'status', STATUS_LABEL),
  ]);
  return { queueID, priority, ticketType, status };
}

module.exports = { resolveTicketPicklists, resolveIdByLabel };
