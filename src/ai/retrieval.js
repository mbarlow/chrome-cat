// Per-question retrieval: TF × log-IDF over stored chunks, plain JS.
// Corpus = the current scope's chunks (one page, or every page in a series).

import { tokenize, chunkText } from "../shared/text.js";
import { DOM_METADATA_HEAD } from "./prompts.js";
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
      kind: d.kind,
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
  if (/\b(summari[sz]e|summary|tl;?dr|key facts)\b|what is (this|the) page about/i.test(retrievalQuery)) {
    const leads = captures.flatMap(c => chunkText(c.mainText || c.domText || c.ocrText || "").slice(0, k)
      .map(text => ({ text, url: c.url, title: c.title, label: captures.length > 1 ? c.title : null })));
    if (leads.length) return leads.slice(0, k);
  }
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
    }
    for (const text of chunkText((c.domMetadata || []).join("\n"), 1200)) {
      out.push({ text: `${DOM_METADATA_HEAD}\n${text}`, ...meta, kind: "metadata" });
    }
    // Image-only facts must remain searchable even on a page rich in DOM text.
    // Suppress near-duplicate OCR chunks so they don't crowd out DOM evidence.
    const domTerms = new Set(tokenize(c.domText));
    for (const text of chunkText(c.ocrText || "")) {
      const terms = [...new Set(tokenize(text))];
      const novel = terms.filter(t => !domTerms.has(t));
      if (!c.domChunks?.length || novel.length >= 1) {
        out.push({ text, ...meta, kind: "ocr" });
      }
    }
  }
  return out;
}
