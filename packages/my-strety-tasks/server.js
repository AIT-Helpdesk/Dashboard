const express = require('express');
const { get, fetchAllPages, isConnected } = require('@dashboard/strety-client');

// Strety's own person directory -- matched against the dashboard's signed-in
// email (`req.session.user.email`, the same Microsoft 365 identity every
// other "my X" feature on this dashboard uses, e.g. Ticket Times' current-
// user pinning), NOT a query param, so this page always shows the actual
// signed-in user's own tasks. Confirmed against real data: every real
// Ambient iT person in Strety uses their exact @ambientit.com.au address,
// matching the dashboard's own Entra email one-for-one -- `filter[email]`
// is an exact match (same convention as every other exact-match filter
// found on this integration), so no wildcard/fuzzy matching is needed or
// attempted here.
async function findPersonByEmail(email) {
  const res = await get('/people', { 'filter[email]': email });
  return res.data[0] || null;
}

// Open == `completed_at` is null, exposed via `filter[completed]=false` --
// confirmed against real data this is the only working "open" filter
// (`filter[status]=open` and `filter[completed_at]=null` both 400). Scoped
// to just this person's todos via `filter[assignee_id]`, confirmed against
// real data that /todos is account-wide (not scoped to the connected
// token's own owner), so this correctly returns THIS person's tasks
// regardless of which Strety account originally connected the integration.
async function fetchOpenTasksFor(personId) {
  const todos = await fetchAllPages('/todos', {
    'filter[completed]': 'false',
    'filter[assignee_id]': personId,
  });

  // Sorted here, not via the API's own `sort` param -- confirmed against
  // real data that `sort=due_date` combined with these filters does NOT
  // produce a reliably ascending order (a real request came back in no
  // discernible order at all). No due date sorts LAST, not first -- a task
  // with no deadline isn't more urgent than one that's actually due soon.
  const rows = todos.map((t) => ({
    id: t.id,
    title: t.attributes.title,
    dueDate: t.attributes.due_date || null,
    priority: t.attributes.priority || null,
    description: t.attributes.description || null,
    createdAt: t.attributes.created_at,
    updatedAt: t.attributes.updated_at,
  }));
  rows.sort((a, b) => {
    if (a.dueDate === null && b.dueDate === null) return 0;
    if (a.dueDate === null) return 1;
    if (b.dueDate === null) return -1;
    return a.dueDate.localeCompare(b.dueDate);
  });
  return rows;
}

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    if (!isConnected()) {
      return res.json({ status: 'not-connected' });
    }

    const email = req.session?.user?.email;
    if (!email) {
      return res.json({ status: 'no-session-email' });
    }

    const person = await findPersonByEmail(email);
    if (!person) {
      return res.json({ status: 'person-not-found', email });
    }

    const tasks = await fetchOpenTasksFor(person.id);
    res.json({
      status: 'ok',
      personName: person.attributes.name,
      personEmail: person.attributes.email,
      asOf: new Date().toISOString(),
      totalCount: tasks.length,
      tasks,
    });
  } catch (err) {
    if (err.strety_not_connected) {
      return res.json({ status: 'not-connected' });
    }
    console.error(err);
    const detail = err.response ? `Strety API returned HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
    res.status(500).json({ error: detail });
  }
});

module.exports = router;
