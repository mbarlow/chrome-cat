// Text utilities: chunking for retrieval, tokenizing for search, HTML escaping.

import { CHUNK_CHARS } from "./constants.js";

const STOPWORDS = new Set(
  ("a an and are as at be by for from has have how i in is it its of on or " +
   "that the this to was we what when where which who will with you your").split(" ")
);

// Split on paragraph boundaries, pack into ~CHUNK_CHARS blocks.
export function chunkText(text, size = CHUNK_CHARS) {
  const paras = String(text || "").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let buf = "";
  for (const p of paras) {
    if (buf && buf.length + p.length + 2 > size) {
      chunks.push(buf);
      buf = "";
    }
    buf = buf ? `${buf}\n\n${p}` : p;
    // A single huge paragraph gets hard-split.
    while (buf.length > size * 1.5) {
      chunks.push(buf.slice(0, size));
      buf = buf.slice(size);
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

export function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
