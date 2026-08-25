const express = require('express');
const { getClient, listAll, getTicketUrl } = require('@dashboard/autotask-client');
const { listDeliveries, getDelivery, createDelivery, updateDelivery, getDeliveryHistory } = require('./db.js');

// { email, name } for whoever's making this request -- requireAuth (see
// packages/shell/auth.js) already guarantees a signed-in session before any
// route on this router runs, same as every other page's server.js.
function actorFrom(req) {
  return { email: req.session.user.email, name: req.session.user.name };
}

// Resolves a typed ticket number (e.g. "T20260730.0020") to the real
// Autotask ticket's internal id -- or null, gracefully, for a blank value,
// zero matches, more-than-one match (ambiguous, treated the same as
// not-found rather than guessing), or the lookup itself failing (a network
// blip shouldn't block saving the delivery). The typed text always saves
// regardless -- this only controls whether it links out. Same pattern
// Workshop Board's own resolveTicketAutotaskId() uses.
async function resolveTicketAutotaskId(ticketNumber) {
  const trimmed = (ticketNumber || '').trim();
  if (!trimmed) return null;
  try {
    const client = await getClient();
    const matches = await listAll(client.tickets, [{ op: 'eq', field: 'ticketNumber', value: trimmed }]);
    return matches.length === 1 ? matches[0].id : null;
  } catch (err) {
    console.error('Goods Received: ticket lookup failed for', trimmed, err);
    return null;
  }
}

function shapeDelivery(row) {
  return {
    id: row.id,
    receivedAt: row.received_at,
    receiverName: row.receiver_name,
    sender: row.sender,
    freightCompany: row.freight_company,
    customer: row.customer,
    ticketNumber: row.ticket_number,
    ticketAutotaskId: row.ticket_autotask_id,
    contents: row.contents,
    cartonCount: row.carton_count,
    slipChecked: !!row.slip_checked,
    matchedWithOrder: !!row.matched_with_order,
    notes: row.notes,
    createdAt: row.created_at,
    createdByName: row.created_by_name,
    updatedAt: row.updated_at,
    updatedByName: row.updated_by_name,
  };
}

// Attaches the resolved Autotask ticket's URL to each already-shaped
// delivery -- just a link out, unlike Workshop Board's own withTicketDetails()
// this page doesn't also pull a live due date/status/client name, since
// nothing here depends on those (deliberately kept simple; Client is its own
// typed field on this page, not overridden by the ticket's resolved
// company). getTicketUrl() caches the one web-URL lookup it needs across
// every call (see @dashboard/autotask-client), so this costs nothing extra
// per delivery after the first.
async function withTicketUrls(shapedDeliveries) {
  return Promise.all(
    shapedDeliveries.map(async (delivery) => ({
      ...delivery,
      ticketUrl: delivery.ticketAutotaskId ? await getTicketUrl(delivery.ticketAutotaskId) : null,
    }))
  );
}

function shapeHistoryRow(row) {
  return {
    changedAt: row.changed_at,
    changedByName: row.changed_by_name,
    field: row.field,
    oldValue: row.old_value,
    newValue: row.new_value,
  };
}

const router = express.Router();
router.use(express.json());

router.get('/', async (req, res) => {
  try {
    const deliveries = await withTicketUrls(listDeliveries().map(shapeDelivery));
    res.json({ deliveries, asOf: new Date().toISOString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Shared body-shaping for POST / and PATCH /:id -- resolves ticketNumber to
// a real Autotask ticket id when present, and coerces cartonCount to a real
// integer or null (a raw string from the client would otherwise get bound
// as-is).
async function parseDeliveryBody(body) {
  const fields = {};
  if ('receivedAt' in body) fields.receivedAt = body.receivedAt ? String(body.receivedAt).trim() : null;
  if ('receiverName' in body) fields.receiverName = body.receiverName ? String(body.receiverName).trim() : null;
  if ('sender' in body) fields.sender = body.sender ? String(body.sender).trim() : null;
  if ('freightCompany' in body) fields.freightCompany = body.freightCompany ? String(body.freightCompany).trim() : null;
  if ('customer' in body) fields.customer = body.customer ? String(body.customer).trim() : null;
  if ('ticketNumber' in body) fields.ticketNumber = body.ticketNumber ? String(body.ticketNumber).trim() : null;
  if ('contents' in body) fields.contents = body.contents ? String(body.contents).trim() : null;
  if ('notes' in body) fields.notes = body.notes ? String(body.notes).trim() : null;
  if ('cartonCount' in body) {
    const n = body.cartonCount === '' || body.cartonCount === null || body.cartonCount === undefined ? null : Number(body.cartonCount);
    if (n !== null && (!Number.isInteger(n) || n < 0)) throw { status: 400, message: 'cartonCount must be a whole number of 0 or more.' };
    fields.cartonCount = n;
  }
  if ('slipChecked' in body) fields.slipChecked = !!body.slipChecked;
  if ('matchedWithOrder' in body) fields.matchedWithOrder = !!body.matchedWithOrder;

  // Always a real null by default, never undefined -- node:sqlite's bind
  // params reject undefined outright ("Provided value cannot be bound to
  // SQLite parameter N"), unlike null, which is a perfectly valid bind
  // value.
  let ticketAutotaskId = null;
  if ('ticketNumber' in fields) {
    ticketAutotaskId = await resolveTicketAutotaskId(fields.ticketNumber);
  }
  return { fields, ticketAutotaskId };
}

router.post('/', async (req, res) => {
  try {
    const { fields, ticketAutotaskId } = await parseDeliveryBody(req.body || {});
    const deliveryId = createDelivery(fields, ticketAutotaskId, actorFrom(req));
    const [shaped] = await withTicketUrls([shapeDelivery(getDelivery(deliveryId))]);
    res.status(201).json(shaped);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const deliveryId = Number(req.params.id);
    if (!getDelivery(deliveryId)) return res.status(404).json({ error: 'Delivery not found.' });
    const { fields, ticketAutotaskId } = await parseDeliveryBody(req.body || {});
    const updated = updateDelivery(deliveryId, fields, ticketAutotaskId, actorFrom(req));
    const [shaped] = await withTicketUrls([shapeDelivery(updated)]);
    res.json(shaped);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/history', (req, res) => {
  try {
    const deliveryId = Number(req.params.id);
    if (!getDelivery(deliveryId)) return res.status(404).json({ error: 'Delivery not found.' });
    res.json({ history: getDeliveryHistory(deliveryId).map(shapeHistoryRow) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
