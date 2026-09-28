// Minimal asynchronous IndexedDB stand-in for vm-loaded browser modules. It
// models open/upgrade, keyPath stores, get/getAll/put/delete requests, transaction
// completion, databases()/deleteDatabase(), plus injectable failures for
// unavailable storage and a full device (QuotaExceededError aborts the write).
// idle() lets a test wait for this fake's outstanding work by events, not time.
const copy = value => JSON.parse(JSON.stringify(value));

export function fakeIndexedDB() {
  const databases = new Map(), stats = { opens: 0, closes: 0, transactions: 0, deleted: [] }, waiters = [];
  let failOpen = false, quota = false, scheduled = 0;
  // Requests and transactions complete on a later turn, like the real API.
  const later = callback => { scheduled++; setTimeout(() => { scheduled--; callback(); if (!scheduled) for (const resolve of waiters.splice(0)) resolve(); }, 0); };
  const request = () => ({ result: undefined, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null });
  function connection(name) {
    const data = databases.get(name);
    return {
      objectStoreNames: { contains: store => data.stores.has(store) },
      createObjectStore(store, { keyPath }) { data.stores.set(store, { keyPath, rows: new Map() }); },
      close() { stats.closes++; },
      transaction(storeName, mode) {
        const store = data.stores.get(storeName);
        if (!store) throw new Error(`NotFoundError: ${storeName}`);
        stats.transactions++;
        const operations = [], transaction = { oncomplete: null, onerror: null, onabort: null, error: null }, before = new Map(store.rows);
        let writes = false;
        const queue = run => { const pending = request(); operations.push(() => { pending.result = run(); pending.onsuccess?.(); }); return pending; };
        transaction.objectStore = () => ({
          getAll: () => queue(() => [...store.rows.values()].map(copy)),
          get: key => queue(() => store.rows.has(key) ? copy(store.rows.get(key)) : undefined),
          put(value) { if (mode !== 'readwrite') throw new Error('ReadOnlyError'); writes = true; return queue(() => { store.rows.set(value[store.keyPath], copy(value)); return value[store.keyPath]; }); },
          delete(key) { if (mode !== 'readwrite') throw new Error('ReadOnlyError'); return queue(() => { store.rows.delete(key); }); },
        });
        later(() => {
          for (const operation of operations) operation();
          // A full device aborts the whole write transaction and keeps the old rows.
          if (writes && quota) { quota = false; store.rows = before; transaction.error = { name: 'QuotaExceededError' }; transaction.onabort?.(); return; }
          transaction.oncomplete?.();
        });
        return transaction;
      },
    };
  }
  return {
    stored: databases, stats,
    failNextOpen() { failOpen = true; },
    fillNextWrite() { quota = true; },
    // Resolves once no request or transaction of this fake is outstanding and
    // every promise callback they led to has run (setImmediate follows the
    // microtask queue), however slow the machine is.
    async idle() {
      for (;;) {
        await new Promise(resolve => setImmediate(resolve));
        if (!scheduled) return;
        await new Promise(resolve => waiters.push(resolve));
      }
    },
    async databases() { return [...databases.entries()].map(([name, data]) => ({ name, version: data.version })); },
    deleteDatabase(name) { stats.deleted.push(name); databases.delete(name); const pending = request(); later(() => pending.onsuccess?.()); return pending; },
    rows(name, store) { return [...(databases.get(name)?.stores.get(store)?.rows.values() || [])].map(copy); },
    open(name, version) {
      stats.opens++;
      const pending = request();
      later(() => {
        if (failOpen) { failOpen = false; pending.onerror?.(); return; }
        const created = !databases.has(name);
        if (created) databases.set(name, { version: version || 1, stores: new Map() });
        pending.result = connection(name);
        if (created) pending.onupgradeneeded?.();
        pending.onsuccess?.();
      });
      return pending;
    },
  };
}
