// Domain memory: per-domain rollups and search across the whole space.
// domain row: { domain, summary, pageCount, updatedAt,
//               paths: [{ path, pathDepth, summary, captureIds[] }] }

import { openDB, tx, reqValue } from "./db.js";
import { listCapturesByDomain } from "./captures.js";
import { tokenize } from "../shared/text.js";

export async function getDomain(domain) {
  const db = await openDB();
  return tx(db, "domains", "readonly", (s) => reqValue(s.get(domain)));
}

export async function listDomains() {
  const db = await openDB();
  return tx(db, "domains", "readonly", (s) => reqValue(s.getAll()));
}

export async function putDomain(row) {
  const db = await openDB();
  await tx(db, "domains", "readwrite", (s) => { s.put(row); });
  return row;
}

// Rebuild a domain's path tree from its captures; keep/replace the rollup summary.
export async function refreshDomain(domain, rollupSummary = null) {
  const captures = await listCapturesByDomain(domain);
  const byPath = new Map();
  for (const c of captures) {
    const entry = byPath.get(c.path) || { path: c.path, pathDepth: c.pathDepth, summary: "", captureIds: [] };
    entry.captureIds.push(c.id);
    if (c.summary) entry.summary = c.summary; // latest capture's summary wins per path
    byPath.set(c.path, entry);
  }
  const prev = await getDomain(domain);
  const row = {
    domain,
    summary: rollupSummary ?? prev?.summary ?? "",
    pageCount: captures.length,
    updatedAt: Date.now(),
    paths: [...byPath.values()].sort((a, b) => a.pathDepth - b.pathDepth || a.path.localeCompare(b.path))
  };
  return putDomain(row);
}

// Search domain + path + capture summaries. Plain TF scoring over tokens —
// small corpus, no index needed. Returns [{ type, domain, path?, captureId?, score, text }].
export async function searchMemory(query, limit = 20) {
  const terms = tokenize(query);
  if (!terms.length) return [];
  const results = [];
  const score = (text) => {
    const toks = tokenize(text);
    if (!toks.length) return 0;
    let hits = 0;
    for (const t of terms) hits += toks.filter((x) => x === t || x.startsWith(t)).length;
    return hits / Math.sqrt(toks.length);
  };
  for (const d of await listDomains()) {
    const ds = score(`${d.domain} ${d.summary}`);
    if (ds > 0) results.push({ type: "domain", domain: d.domain, score: ds, text: d.summary });
    for (const p of d.paths || []) {
      const ps = score(`${p.path} ${p.summary}`);
      if (ps > 0) {
        results.push({
          type: "path", domain: d.domain, path: p.path,
          captureId: p.captureIds[p.captureIds.length - 1],
          score: ps, text: p.summary
        });
      }
    }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}
