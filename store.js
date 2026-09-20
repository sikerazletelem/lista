// Helyi tár (IndexedDB). A szinkronréteg (adapter) később erre épül:
// minden rekord: { id, block, text, done, updatedAt, deleted }
// A törlés jelölő (deleted), hogy később a másik eszközön is eltűnjön.
const Store = (() => {
  const DB_NAME = "hid-lista", STORE = "items";
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }
  function tx(mode, fn) {
    return open().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const out = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }));
  }

  return {
    all: () => tx("readonly", (s) => s.getAll()),
    put: (item) => tx("readwrite", (s) => s.put(item)),
    putMany: (items) => tx("readwrite", (s) => { items.forEach((i) => s.put(i)); }),
  };
})();
