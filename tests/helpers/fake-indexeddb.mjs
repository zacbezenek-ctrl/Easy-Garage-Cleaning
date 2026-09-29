// Minimal asynchronous IndexedDB stand-in for vm-loaded browser modules. It
// models open/upgrade (a new database, or a higher version of an existing one),
// an upgrade aborted from onupgradeneeded (request.transaction.abort(): a new
// database is not kept), an upgrade blocked by a connection to the database that
// is still open (each is sent versionchange; if one stays open the request gets
// blocked, and the upgrade goes ahead once they have all closed), keyPath stores,
// get/getAll/put/delete requests, transactions over one or more stores and their
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
    const db = {
      onversionchange: null,
      objectStoreNames: { contains: store => data.stores.has(store) },
      createObjectStore(store, { keyPath }) { data.stores.set(store, { keyPath, rows: new Map() }); },
      // An upgrade that waited for this connection goes ahead once the last one closes.
      close() { stats.closes++; if (!data.connections.delete(db) || data.connections.size) return; for (const resume of data.blocked.splice(0)) resume(); },
      transaction(storeNames, mode) {
        const names = [].concat(storeNames);
        for (const name of names) if (!data.stores.has(name)) throw new Error(`NotFoundError: ${name}`);
        stats.transactions++;
        const operations = [], transaction = { oncomplete: null, onerror: null, onabort: null, error: null }, before = new Map(names.map(name => [name, new Map(data.stores.get(name).rows)]));
        let writes = false;
        // A request made in another request's onsuccess runs in the same transaction, after it.
        const queue = run => { const pending = request(); operations.push(() => { pending.result = run(); pending.onsuccess?.(); }); return pending; };
        transaction.objectStore = name => {
          const store = data.stores.get(name ?? names[0]);
          if (!store || !names.includes(name ?? names[0])) throw new Error(`NotFoundError: ${name}`);
          return {
            getAll: () => queue(() => [...store.rows.values()].map(copy)),
            get: key => queue(() => store.rows.has(key) ? copy(store.rows.get(key)) : undefined),
            put(value) { if (mode !== 'readwrite') throw new Error('ReadOnlyError'); writes = true; return queue(() => { store.rows.set(value[store.keyPath], copy(value)); return value[store.keyPath]; }); },
            delete(key) { if (mode !== 'readwrite') throw new Error('ReadOnlyError'); return queue(() => { store.rows.delete(key); }); },
          };
        };
        later(() => {
          for (let index = 0; index < operations.length; index++) operations[index]();
          // A full device aborts the whole write transaction and keeps the old rows of every store in it.
          if (writes && quota) { quota = false; for (const [name, rows] of before) data.stores.get(name).rows = rows; transaction.error = { name: 'QuotaExceededError' }; transaction.onabort?.(); return; }
          transaction.oncomplete?.();
        });
        return transaction;
      },
    };
    data.connections.add(db);
    return db;
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
      let told = false, waiting = false;
      const attempt = () => {
        if (failOpen) { failOpen = false; pending.onerror?.(); return; }
        const created = !databases.has(name), current = databases.get(name);
        // Asking for a lower version than the database has fails, as in a browser.
        if (!created && version && version < current.version) { pending.error = { name: 'VersionError' }; pending.onerror?.(); return; }
        const upgrade = created || Boolean(version && version > current.version);
        // An upgrade waits for the other connections to close: they are told once, and the request is blocked while any stays open.
        if (upgrade && !created && current.connections.size) {
          if (!told) { told = true; for (const other of [...current.connections]) other.onversionchange?.({ oldVersion: current.version, newVersion: version }); }
          if (current.connections.size) { if (!waiting) { waiting = true; pending.onblocked?.(); } current.blocked.push(() => later(attempt)); return; }
        }
        const before = created ? null : { version: current.version, stores: new Map(current.stores) };
        if (created) databases.set(name, { version: version || 1, stores: new Map(), connections: new Set(), blocked: [] });
        else if (upgrade) current.version = version;
        pending.result = connection(name);
        if (upgrade) {
          let aborted = false;
          pending.transaction = { abort() { aborted = true; } };
          pending.onupgradeneeded?.({ oldVersion: before?.version ?? 0, newVersion: databases.get(name).version });
          pending.transaction = null;
          if (aborted) {
            databases.get(name).connections.delete(pending.result);
            if (created) databases.delete(name); else Object.assign(current, before);
            pending.result = undefined; pending.error = { name: 'AbortError' }; pending.onerror?.();
            return;
          }
        }
        pending.onsuccess?.();
      };
      later(attempt);
      return pending;
    },
  };
}
