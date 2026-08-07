// Captures + their tile blobs.
//
// capture: { id, url, domain, path, pathSegments[], pathDepth, title, ts,
//            status: "capturing"|"ocr"|"summarizing"|"ready"|"error",
//            domText, domChunks[], ocrText, summary, links[], tileCount,
//            seriesId|null, viewport:{w,h,dpr}, error|null }
// tile:    { id, captureId, seq, blob, w, h, ocrText, ocrConfidence }

import { openDB, tx, reqValue } from "./db.js";
import { parseUrl, normalizeUrl } from "../shared/url.js";

export async function createCapture({ url, title, viewport, seriesId = null }) {
  const db = await openDB();
  const norm = normalizeUrl(url);
  const capture = {
    ...parseUrl(norm),
    url: norm,
    title: title || norm,
    ts: Date.now(),
    status: "capturing",
    domText: "",
    domChunks: [],
    ocrText: "",
    summary: "",
    links: [],
    tileCount: 0,
    seriesId,
    viewport,
    error: null
  };
  capture.id = await tx(db, "captures", "readwrite", (s) => reqValue(s.add(capture)));
  return capture;
}

export async function updateCapture(id, patch) {
  const db = await openDB();
  const cur = await tx(db, "captures", "readonly", (s) => reqValue(s.get(id)));
  if (!cur) return null;
  const next = { ...cur, ...patch };
  await tx(db, "captures", "readwrite", (s) => { s.put(next); });
  return next;
}

export async function getCapture(id) {
  const db = await openDB();
  return tx(db, "captures", "readonly", (s) => reqValue(s.get(id)));
}

// Newest first.
export async function listCaptures(limit = 200) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction("captures", "readonly");
    const out = [];
    const cur = t.objectStore("captures").index("byTs").openCursor(null, "prev");
    cur.onsuccess = () => {
      const c = cur.result;
      if (c && out.length < limit) { out.push(c.value); c.continue(); }
      else resolve(out);
    };
    cur.onerror = () => reject(cur.error);
  });
}

export async function getCaptureByUrl(url) {
  const db = await openDB();
  return tx(db, "captures", "readonly", (s) => reqValue(s.index("byUrl").get(normalizeUrl(url))));
}

export async function listCapturesByDomain(domain) {
  const db = await openDB();
  return tx(db, "captures", "readonly", (s) =>
    reqValue(s.index("byDomain").getAll(domain)));
}

export async function addTile(tile) {
  const db = await openDB();
  tile.id = await tx(db, "tiles", "readwrite", (s) => reqValue(s.add(tile)));
  return tile;
}

export async function updateTile(tile) {
  const db = await openDB();
  await tx(db, "tiles", "readwrite", (s) => { s.put(tile); });
  return tile;
}

// First tile only — thumbnails shouldn't load every blob.
export async function getFirstTile(captureId) {
  const db = await openDB();
  return tx(db, "tiles", "readonly", (s) => reqValue(s.index("byCapture").get([captureId, 0])));
}

// Ordered by seq (compound index key).
export async function getTiles(captureId) {
  const db = await openDB();
  return tx(db, "tiles", "readonly", (s) =>
    reqValue(s.index("byCapture").getAll(IDBKeyRange.bound([captureId, 0], [captureId, Infinity]))));
}

export async function deleteCapture(id) {
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const t = db.transaction("tiles", "readwrite");
    const cur = t.objectStore("tiles").index("byCapture")
      .openCursor(IDBKeyRange.bound([id, 0], [id, Infinity]));
    cur.onsuccess = () => {
      const c = cur.result;
      if (c) { c.delete(); c.continue(); } else resolve();
    };
    cur.onerror = () => reject(cur.error);
  });
  await tx(db, "captures", "readwrite", (s) => { s.delete(id); });
}
