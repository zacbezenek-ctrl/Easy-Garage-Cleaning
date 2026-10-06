/* Offline storage for the knock page: an outbox of append-only events waiting to sync, and a
   small key/value cache (profile, territory, houses) so the page opens with no signal.
   Its own IndexedDB database, lock name and keys; it never touches the field-job outbox.
   Fields starting with "_" stay on the phone and are stripped before an event is sent. */

const DB = 'egc-knock';
const VERSION = 2;
const LOCK = 'egc-knock-outbox';

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function memoryStore() {
  const events = new Map(), cache = new Map();
  return {
    persistent: false,
    events: {
      all: async () => [...events.values()].map(e => structuredClone(e)),
      get: async id => (events.has(id) ? structuredClone(events.get(id)) : null),
      put: async e => { events.set(e.id, structuredClone(e)); },
      remove: async id => { events.delete(id); },
    },
    cache: {
      get: async key => (cache.has(key) ? structuredClone(cache.get(key)) : null),
      set: async (key, value) => { cache.set(key, structuredClone(value)); },
      remove: async key => { cache.delete(key); },
    },
  };
}

export async function openKnockStore(indexedDB = globalThis.indexedDB) {
  if (!indexedDB) return memoryStore();
  let db;
  try {
    const open = indexedDB.open(DB, VERSION);
    open.onupgradeneeded = () => {
      const base = open.result;
      // Pre-release builds kept the cache with out-of-line keys; it only holds re-downloadable copies.
      if (base.objectStoreNames.contains('cache') && open.transaction?.objectStore('cache').keyPath !== 'key') base.deleteObjectStore('cache');
      if (!base.objectStoreNames.contains('events')) base.createObjectStore('events', { keyPath: 'id' });
      if (!base.objectStoreNames.contains('cache')) base.createObjectStore('cache', { keyPath: 'key' });
    };
    db = await request(open);
  } catch {
    return memoryStore();
  }
  const tx = (store, mode) => db.transaction(store, mode).objectStore(store);
  const done = t => new Promise((resolve, reject) => { t.oncomplete = () => resolve(); t.onerror = () => reject(t.error); t.onabort = () => reject(t.error); });
  const writeOne = async (store, fn) => { const t = db.transaction(store, 'readwrite'); fn(t.objectStore(store)); await done(t); };
  return {
    persistent: true,
    events: {
      all: () => request(tx('events', 'readonly').getAll()),
      get: async id => (await request(tx('events', 'readonly').get(id))) || null,
      put: e => writeOne('events', s => s.put(e)),
      remove: id => writeOne('events', s => s.delete(id)),
    },
    cache: {
      get: async key => (await request(tx('cache', 'readonly').get(key)))?.value ?? null,
      set: (key, value) => writeOne('cache', s => s.put({ key, value })),
      remove: key => writeOne('cache', s => s.delete(key)),
    },
  };
}

export const forServer = event => Object.fromEntries(Object.entries(event).filter(([key]) => !key.startsWith('_') && !['user', 'seq', 'state', 'error', 'attempts', 'queuedAt'].includes(key)));

// Why a sync attempt failed: 'network' (no connection), 'auth' (sign in again), 'transient' (retry later).
export function classify(error) {
  if (!error?.status) return 'network';
  if (error.status === 401) return 'auth';
  if (error.status >= 500 || error.status === 408 || error.status === 429) return 'transient';
  return 'rejected';
}

/* transport(events) -> { results: [{ id, status: 'applied'|'duplicate'|'rejected', code?, error? }], ...rest }
   rejects with an Error carrying .status for HTTP failures (0 / missing for network). */
export function createOutbox(store, { transport, locks = globalThis.navigator?.locks, batchSize = 40, now = () => Date.now() } = {}) {
  const listeners = new Set();
  let flushing = null;
  let chain = Promise.resolve();
  const serial = task => { const next = chain.then(task); chain = next.catch(() => {}); return next; };
  const notify = () => listeners.forEach(fn => { try { fn(); } catch {} });

  async function list(user) {
    const rows = await store.events.all();
    return rows.filter(e => e.user === user).sort((a, b) => a.seq - b.seq);
  }

  function enqueue(event) {
    return serial(async () => {
      if (!event?.id || !event.user || !event.type) throw new Error('An event needs an id, user and type.');
      const existing = await store.events.get(event.id);
      if (existing) return existing;
      const rows = await store.events.all();
      const seq = rows.reduce((max, e) => Math.max(max, e.seq || 0), 0) + 1;
      const row = { ...event, seq, state: 'queued', attempts: 0, queuedAt: now() };
      await store.events.put(row);
      notify();
      return row;
    });
  }

  // Change a queued (unsent) event, e.g. editing the last door before it synced. `changes` is merged,
  // or given a function it receives the event and returns the new one.
  function amend(id, changes) {
    return serial(async () => {
      const row = await store.events.get(id);
      if (!row || row.state !== 'queued') return null;
      const updated = typeof changes === 'function' ? changes(structuredClone(row)) : { ...row, ...changes };
      const next = { ...updated, id: row.id, seq: row.seq, user: row.user, type: row.type, state: row.state };
      await store.events.put(next);
      notify();
      return next;
    });
  }

  function remove(id) {
    return serial(async () => { await store.events.remove(id); notify(); });
  }

  function retry(id) {
    return serial(async () => {
      const row = await store.events.get(id);
      if (row) await store.events.put({ ...row, state: 'queued', error: null });
      notify();
    });
  }

  async function run(user, onApplied) {
    const summary = { applied: 0, rejected: 0, stopped: null, remaining: 0 };
    for (;;) {
      const queued = (await list(user)).filter(e => e.state === 'queued');
      if (!queued.length) break;
      const batch = queued.slice(0, batchSize);
      let response;
      try {
        response = await transport(batch.map(forServer));
      } catch (error) {
        summary.stopped = { reason: classify(error), error };
        if (summary.stopped.reason === 'transient') {
          await serial(async () => { for (const e of batch) { const row = await store.events.get(e.id); if (row) await store.events.put({ ...row, attempts: (row.attempts || 0) + 1 }); } });
        }
        if (summary.stopped.reason === 'rejected') {
          // The whole request was refused (e.g. account turned off); keep the events, surface the reason.
          await serial(async () => { for (const e of batch) { const row = await store.events.get(e.id); if (row) await store.events.put({ ...row, state: 'error', error: { message: error.message, code: error.code || '' } }); } });
        }
        break;
      }
      const results = new Map((response?.results || []).map(r => [r.id, r]));
      await serial(async () => {
        for (const e of batch) {
          const result = results.get(e.id);
          if (!result) continue;
          if (result.status === 'applied' || result.status === 'duplicate') { await store.events.remove(e.id); summary.applied += 1; }
          else { await store.events.put({ ...e, state: 'error', error: { message: result.error || 'Refused', code: result.code || '' } }); summary.rejected += 1; }
        }
      });
      notify();
      if (onApplied) await onApplied(response);
      if (!batch.some(e => results.has(e.id))) { summary.stopped = { reason: 'transient', error: new Error('The server did not answer for these events.') }; break; }
    }
    summary.remaining = (await list(user)).filter(e => e.state === 'queued').length;
    return summary;
  }

  function flush({ user, onApplied } = {}) {
    if (!user) return Promise.resolve({ applied: 0, rejected: 0, stopped: { reason: 'auth' }, remaining: 0 });
    if (flushing) return flushing;
    const work = () => run(user, onApplied);
    flushing = (locks?.request ? locks.request(LOCK, work) : work()).finally(() => { flushing = null; notify(); });
    return flushing;
  }

  return { enqueue, amend, remove, retry, list, flush, onChange: fn => { listeners.add(fn); return () => listeners.delete(fn); }, persistent: store.persistent };
}

export function httpTransport(fetcher = (...args) => fetch(...args)) {
  return async events => {
    let response;
    try {
      response = await fetcher('/api/knock-sync', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events }),
      });
    } catch {
      throw Object.assign(new Error('No connection'), { status: 0 });
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw Object.assign(new Error(data.error || `Sync failed (${response.status})`), { status: response.status, code: data.code || '' });
    return data;
  };
}
