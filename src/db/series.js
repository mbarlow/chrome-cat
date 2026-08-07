// Series: an ordered run of captures produced by following links.
// { id, name, rootUrl, domain, captureIds[], ts,
//   status: "running"|"done"|"cancelled"|"error",
//   progress: { done, total, currentUrl, errors: [{url, error}] } }

import { openDB, tx, reqValue } from "./db.js";
import { parseUrl } from "../shared/url.js";

export async function createSeries({ name, rootUrl, captureIds = [] }) {
  const db = await openDB();
  const series = {
    name: name || rootUrl,
    rootUrl,
    domain: parseUrl(rootUrl).domain,
    captureIds,
    ts: Date.now(),
    status: "running",
    progress: { done: 0, total: 0, currentUrl: "", errors: [] }
  };
  series.id = await tx(db, "series", "readwrite", (s) => reqValue(s.add(series)));
  return series;
}

export async function updateSeries(id, patch) {
  const db = await openDB();
  const cur = await tx(db, "series", "readonly", (s) => reqValue(s.get(id)));
  if (!cur) return null;
  const next = { ...cur, ...patch };
  await tx(db, "series", "readwrite", (s) => { s.put(next); });
  return next;
}

export async function getSeries(id) {
  const db = await openDB();
  return tx(db, "series", "readonly", (s) => reqValue(s.get(id)));
}

// Newest first.
export async function listSeries(limit = 100) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction("series", "readonly");
    const out = [];
    const cur = t.objectStore("series").index("byTs").openCursor(null, "prev");
    cur.onsuccess = () => {
      const c = cur.result;
      if (c && out.length < limit) { out.push(c.value); c.continue(); }
      else resolve(out);
    };
    cur.onerror = () => reject(cur.error);
  });
}
