// IndexedDB core (chrome-xray pattern): memoized openDB + tx/reqValue helpers.
// Five stores — tiles hold the blobs so capture rows stay light for search.

import { DB_NAME, DB_VERSION } from "../shared/constants.js";

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("domains")) {
        db.createObjectStore("domains", { keyPath: "domain" });
      }
      if (!db.objectStoreNames.contains("captures")) {
        const s = db.createObjectStore("captures", { keyPath: "id", autoIncrement: true });
        s.createIndex("byDomain", "domain");
        s.createIndex("byDomainPath", ["domain", "path"]);
        s.createIndex("byDomainDepth", ["domain", "pathDepth"]);
        s.createIndex("byUrl", "url");
        s.createIndex("byTs", "ts");
      }
      if (!db.objectStoreNames.contains("tiles")) {
        const s = db.createObjectStore("tiles", { keyPath: "id", autoIncrement: true });
        s.createIndex("byCapture", ["captureId", "seq"]);
      }
      if (!db.objectStoreNames.contains("series")) {
        const s = db.createObjectStore("series", { keyPath: "id", autoIncrement: true });
        s.createIndex("byTs", "ts");
      }
      if (!db.objectStoreNames.contains("chats")) {
        const s = db.createObjectStore("chats", { keyPath: "id", autoIncrement: true });
        s.createIndex("byScope", ["scopeType", "scopeId"]);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const holder = fn(t.objectStore(store));
    t.oncomplete = () => resolve(holder ? holder.__value : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export function reqValue(request) {
  const holder = { __value: undefined };
  request.onsuccess = () => { holder.__value = request.result; };
  return holder;
}

// Wipe everything (settings view).
export async function clearAll() {
  const db = await openDB();
  for (const name of ["domains", "captures", "tiles", "series", "chats"]) {
    await tx(db, name, "readwrite", (s) => { s.clear(); });
  }
}
