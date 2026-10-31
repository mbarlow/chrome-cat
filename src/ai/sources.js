// Ground an answer in page text: pick the excerpt sentences that share the
// most terms with it. Deterministic — the small model isn't asked to cite.

import { tokenize } from "../shared/text.js";
import { IMAGE_CHUNK_HEAD } from "./prompts.js";

const MIN_SHARED = 2;

function sentences(text) {
  return String(text)
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 20 && s.length <= 400);
}

// excerpts: [{ text, url, title }] → up to max [{ url, title, passage }].
export function findSources(answer, excerpts, max = 2) {
  const want = new Set(tokenize(answer));
  if (!want.size) return [];
  const scored = [];
  for (const e of excerpts) {
    if (!e.url || e.text.startsWith(IMAGE_CHUNK_HEAD)) continue;
    for (const passage of sentences(e.text)) {
      const toks = new Set(tokenize(passage));
      let shared = 0;
      for (const t of toks) if (want.has(t)) shared++;
      if (shared >= MIN_SHARED) scored.push({ url: e.url, title: e.title, passage, score: shared / Math.sqrt(toks.size) });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const out = [];
  for (const s of scored) {
    if (out.some((o) => o.passage === s.passage)) continue;
    out.push({ url: s.url, title: s.title, passage: s.passage });
    if (out.length >= max) break;
  }
  return out;
}
