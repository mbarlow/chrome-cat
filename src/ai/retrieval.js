// Per-question retrieval: TF × log-IDF over stored chunks, plain JS.
// Corpus = the current scope's chunks (one page, or every page in a series).

import { tokenize } from "../shared/text.js";
import { TOP_CHUNKS } from "../shared/constants.js";

// chunks: [{ text, label?, url?, title? }] -> top-k, same shape plus score
export function topChunks(question, chunks, k = TOP_CHUNKS) {
  const qTerms = [...new Set(tokenize(question))];
  if (!qTerms.length || !chunks.length) return [];

  const docs = chunks.map((c) => {
    const toks = tokenize(c.text);
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    return { ...c, tf, len: toks.length || 1 };
  });

  const N = docs.length;
  const idf = new Map(qTerms.map((t) => {
    const df = docs.filter((d) => d.tf.has(t)).length;
    return [t, Math.log(1 + N / (1 + df))];
  }));

  return docs
    .map((d) => ({
      text: d.text,
      label: d.label,
      url: d.url,
      title: d.title,
      score: qTerms.reduce((s, t) => s + ((d.tf.get(t) || 0) / d.len) * idf.get(t), 0)
    }))
    .filter((d) => d.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

// Excerpt selection for a question. When TF-IDF scores nothing — whole-page
// asks like "summarize" or "tl;dr" share no tokens with the content — fall
// back to the lead chunks: the top of the page is the right default context.
export function selectExcerpts(retrievalQuery, captures, k = TOP_CHUNKS) {
  const chunks = scopeChunks(captures);
  const top = topChunks(retrievalQuery, chunks, k);
  return top.length ? top : chunks.slice(0, k);
}

// Build the scope's chunk corpus from capture rows (DOM chunks preferred,
// OCR text as fallback for pages where the DOM was empty, e.g. canvas apps).
export function scopeChunks(captures) {
  const out = [];
  for (const c of captures) {
    const meta = { label: captures.length > 1 ? c.title : null, url: c.url, title: c.title };
    if (c.domChunks?.length) {
      for (const text of c.domChunks) out.push({ text, ...meta });
    } else if (c.ocrText) {
      for (const text of c.ocrText.split(/\n\n--- page \d+ ---\n\n/).filter(Boolean)) {
        out.push({ text, ...meta });
      }
    }
  }
  return out;
}
