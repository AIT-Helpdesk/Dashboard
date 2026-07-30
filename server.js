require('dotenv').config();
const path = require('path');
const express = require('express');
const { AutotaskClient } = require('autotask-node');

const PORT = process.env.PORT || 3000;

let clientPromise = null;
function getClient() {
  if (!clientPromise) {
    clientPromise = AutotaskClient.create(
      {
        username: process.env.AUTOTASK_USERNAME,
        secret: process.env.AUTOTASK_SECRET,
        integrationCode: process.env.AUTOTASK_INTEGRATION_CODE,
      },
      // Autotask's API does not handle gzip-encoded POST bodies well; the SDK's
      // compression option gzips request bodies, which breaks POST /query calls.
      { enableCompression: false }
    );
  }
  return clientPromise;
}

// Autotask rate-limits to ~5 req/s by default; firing a large Promise.all burst of
// lookups causes silent failures under load, so resolution is capped at low concurrency.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const resourceNameCache = new Map();
async function resolveResourceName(client, id) {
  if (!id) return null;
  if (resourceNameCache.has(id)) return resourceNameCache.get(id);
  try {
    const res = await client.resources.get(id);
    const r = res.data || {};
    const name = [r.firstName, r.lastName].filter(Boolean).join(' ').trim() || `Resource #${id}`;
    resourceNameCache.set(id, name);
    return name;
  } catch (err) {
    console.error(`Failed to resolve resource ${id}:`, err.message);
    const fallback = `Resource #${id}`;
    resourceNameCache.set(id, fallback);
    return fallback;
  }
}

const companyNameCache = new Map();
async function resolveCompanyName(client, id) {
  if (id === null || id === undefined) return 'Unknown';
  if (companyNameCache.has(id)) return companyNameCache.get(id);
  try {
    const res = await client.companies.get(id);
    const name = res.data?.companyName || `Company #${id}`;
    companyNameCache.set(id, name);
    return name;
  } catch (err) {
    console.error(`Failed to resolve company ${id}:`, err.message);
    const fallback = id === 0 ? 'Ambient IT (internal)' : `Company #${id}`;
    companyNameCache.set(id, fallback);
    return fallback;
  }
}

async function fetchTicketsCompletedOn(client, dateStr) {
  const startISO = `${dateStr}T00:00:00.000Z`;
  const endDate = new Date(`${dateStr}T00:00:00.000Z`);
  endDate.setUTCDate(endDate.getUTCDate() + 1);
  const endISO = endDate.toISOString();

  const all = [];
  const pageSize = 500;
  // Safety cap: a single client site won't plausibly complete more than 10k tickets in a day.
  for (let page = 1; page <= 20; page++) {
    const result = await client.tickets.list({
      filter: [
        { op: 'eq', field: 'status', value: 5 },
        { op: 'gte', field: 'completedDate', value: startISO },
        { op: 'lt', field: 'completedDate', value: endISO },
      ],
      page,
      pageSize,
    });

    const batch = result.data || [];
    all.push(...batch);
    if (batch.length < pageSize) break;
  }
  return all;
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', async (req, res) => {
  try {
    const client = await getClient();
    const ok = await client.testConnection();
    res.json({ ok });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/completed-tickets', async (req, res) => {
  const date = req.query.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Query param "date" is required in YYYY-MM-DD format.' });
  }

  try {
    const client = await getClient();
    const tickets = await fetchTicketsCompletedOn(client, date);

    const uniqueResourceIDs = [...new Set(tickets.map((t) => t.completedByResourceID).filter(Boolean))];
    const uniqueCompanyIDs = [...new Set(tickets.map((t) => t.companyID).filter((id) => id !== null && id !== undefined))];

    await mapWithConcurrency(uniqueResourceIDs, 3, (id) => resolveResourceName(client, id));
    await mapWithConcurrency(uniqueCompanyIDs, 3, (id) => resolveCompanyName(client, id));

    const enriched = tickets.map((t) => ({
      id: t.id,
      ticketNumber: t.ticketNumber,
      title: t.title,
      companyID: t.companyID,
      company: companyNameCache.get(t.companyID) || `Company #${t.companyID}`,
      completedByResourceID: t.completedByResourceID || null,
      completedBy: t.completedByResourceID ? resourceNameCache.get(t.completedByResourceID) : 'Unassigned',
      completedDate: t.completedDate,
      priority: t.priority,
    }));

    const byResourceMap = new Map();
    for (const t of enriched) {
      const key = t.completedByResourceID || 'unassigned';
      if (!byResourceMap.has(key)) {
        byResourceMap.set(key, { resourceId: t.completedByResourceID, resourceName: t.completedBy, tickets: [] });
      }
      byResourceMap.get(key).tickets.push(t);
    }
    const byResource = [...byResourceMap.values()]
      .map((g) => ({ ...g, count: g.tickets.length }))
      .sort((a, b) => b.count - a.count);

    res.json({
      date,
      totalCount: enriched.length,
      byResource,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Autotask dashboard running at http://localhost:${PORT}`);
});
