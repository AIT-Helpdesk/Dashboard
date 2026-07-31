const { AutotaskClient } = require('autotask-node');

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

module.exports = {
  getClient,
  mapWithConcurrency,
  resolveResourceName,
  resolveCompanyName,
};