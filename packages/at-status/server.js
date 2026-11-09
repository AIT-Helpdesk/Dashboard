const express = require('express');
const { getClient } = require('@dashboard/autotask-client');

const router = express.Router();

// Same entityInformation/fields endpoint @dashboard/autotask-client's own
// getPicklistLabels() uses (see its comment in packages/autotask-client/
// index.js), but kept separate here rather than reused -- that helper only
// returns a bare value->label Map, and this page's whole point is showing
// everything else Autotask tracks per status (Active/Inactive, Default,
// System, sort order), confirmed live against the real field metadata.
// Cached in-process, same "static configuration, not per-record data"
// reasoning as the shared helper -- a process restart is how a genuine
// change in Autotask's own status list picklist shows up here.
let cachedStatuses = null;

async function getTicketStatuses() {
  if (cachedStatuses) return cachedStatuses;
  const client = await getClient();
  const res = await client.tickets.axios.get(`${client.tickets.endpoint}/entityInformation/fields`);
  const field = (res.data?.fields || []).find((f) => f.name === 'status');
  cachedStatuses = (field?.picklistValues || []).map((pv) => ({
    value: Number(pv.value),
    label: pv.label,
    isActive: !!pv.isActive,
    isDefaultValue: !!pv.isDefaultValue,
    isSystem: !!pv.isSystem,
    sortOrder: pv.sortOrder,
  }));
  return cachedStatuses;
}

router.get('/', async (req, res) => {
  try {
    const statuses = await getTicketStatuses();
    res.json({ statuses });
  } catch (err) {
    console.error('AT Status: failed to load ticket status picklist:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
