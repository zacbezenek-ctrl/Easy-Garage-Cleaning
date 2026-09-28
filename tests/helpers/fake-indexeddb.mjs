// Minimal asynchronous IndexedDB stand-in for vm-loaded browser modules. It
// models open/upgrade, keyPath stores, getAll/put/delete requests and
// transaction completion, plus an injectable failure for unavailable storage.
const copy = value => JSON.parse(JSON.stringify(value));
const later = callback => setTimeout(callback, 0);

export function fakeIndexedDB() {
  const databases = new Map(), stats = { opens: 0, closes: 0, transactions: 0 };
  let failOpen = false;
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
        const operations = [], transaction = { oncomplete: null, onerror: null, onabort: null };
        const queue = run => { const pending = request(); operations.push(() => { pending.result = run(); pending.onsuccess?.(); }); return pending; };
        transaction.objectStore = () => ({
          getAll: () => queue(() => [...store.rows.values()].map(copy)),
          put(value) { if (mode !== 'readwrite') throw new Error('ReadOnlyError'); return queue(() => { store.rows.set(value[store.keyPath], copy(value)); return value[store.keyPath]; }); },
          delete(key) { if (mode !== 'readwrite') throw new Error('ReadOnlyError'); return queue(() => { store.rows.delete(key); }); },
        });
        later(() => { for (const operation of operations) operation(); transaction.oncomplete?.(); });
        return transaction;
      },
    };
  }
  return {
    databases, stats,
    failNextOpen() { failOpen = true; },
    rows(name, store) { return [...(databases.get(name)?.stores.get(store)?.rows.values() || [])].map(copy); },
    open(name, version) {
      stats.opens++;
      const pending = request();
      later(() => {
        if (failOpen) { failOpen = false; pending.onerror?.(); return; }
        const created = !databases.has(name);
        if (created) databases.set(name, { version, stores: new Map() });
        pending.result = connection(name);
        if (created) pending.onupgradeneeded?.();
        pending.onsuccess?.();
      });
      return pending;
    },
  };
}
