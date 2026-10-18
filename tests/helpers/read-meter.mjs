// READ-BUDGET: counts the Firestore reads the owner is billed for, around a firestoreRest() fake (firestore-rest-queries.mjs).
// One read per document a query or a list page returns (at least one per query or page), one per document GET (a
// missing one too), one per document a batchGet names and one per aggregation; writes, transactions and rollbacks are
// free. readMeter(fake) replaces fake.fetcher with a counting copy, so install it before the code under test first
// reads it (a fixture that reads fake.fetcher on each request picks it up). Synthetic data only.
export function readMeter(fake) {
  const inner = fake.fetcher;
  let tally = null;
  const add = (key, count) => { if (!tally) return; tally.byKey[key] = (tally.byKey[key] || 0) + count; tally.total += count; };
  fake.fetcher = async (env, input, options = {}) => {
    const response = await inner(env, input, options);
    if (!tally) return response;
    const url = new URL(String(input)), method = (options.method || 'GET').toUpperCase();
    const path = decodeURIComponent(url.pathname.split('/documents')[1] || '').replace(/^\//, '');
    const body = await response.clone().json().catch(() => null);
    if (method === 'POST' && path === ':runQuery') {
      const query = JSON.parse(options.body).structuredQuery, where = query.where;
      const field = where?.fieldFilter?.field.fieldPath || where?.unaryFilter?.field.fieldPath || where?.compositeFilter?.filters.map(item => item.fieldFilter?.field.fieldPath).join('+') || '';
      add(`query:${query.from[0].collectionId}:${field}`, Math.max(1, Array.isArray(body) ? body.filter(row => row?.document).length : 0));
    } else if (method === 'POST' && path === ':batchGet') add(`batchGet:${JSON.parse(options.body).documents[0]?.split('/documents/')[1]?.split('/')[0] || ''}`, JSON.parse(options.body).documents.length);
    else if (method === 'POST' && path === ':runAggregationQuery') add('aggregate', 1);
    else if (method === 'GET' && path.split('/').length % 2 === 0) add(`get:${path.split('/')[0]}${path.includes('_egc_schedule_lock_') ? ':lock' : ''}`, 1);
    else if (method === 'GET') add(`list:${path}`, Math.max(1, (body?.documents || []).length));
    return response;
  };
  return {
    /** Runs fn and answers {result, total, byKey} for the reads it made. */
    async measure(fn) {
      tally = { total: 0, byKey: {} };
      try { const result = await fn(); return { result, ...tally }; }
      finally { tally = null; }
    },
  };
}

/** The total of the keys that start with any of the prefixes. */
export const readsOf = (byKey, ...prefixes) => Object.entries(byKey).filter(([key]) => prefixes.some(prefix => key.startsWith(prefix))).reduce((sum, [, count]) => sum + count, 0);
