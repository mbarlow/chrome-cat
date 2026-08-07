// Browser-native chat sources: history and bookmarks, shaped as pseudo-
// captures so every downstream layer (retrieval, prompts, navigation, send)
// works unchanged. Items are title/url-light — except URLs the user has
// actually scanned, which get their capture's summary cross-referenced in.

import { parseUrl } from "../shared/url.js";
import { getCaptureByUrl } from "../db/captures.js";

const HISTORY_MAX = 150;
const BOOKMARKS_MAX = 300;

function pseudoCapture({ title, url, line, ts }) {
  const t = title || url;
  return {
    ...parseUrl(url),
    url,
    title: t,
    ts: ts || Date.now(),
    status: "ready",
    summary: "",
    domText: "",
    domChunks: [line],
    ocrText: "",
    links: [{ href: url, text: t }], // makes "open the <x> page" work here too
    tileCount: 0
  };
}

// Attach scanned content where we have it (capped — IDB lookups are cheap
// but not free, and only the first N items realistically reach the model).
async function crossRef(items, cap = 40) {
  await Promise.all(items.slice(0, cap).map(async (it) => {
    const c = await getCaptureByUrl(it.url).catch(() => null);
    if (c?.summary) {
      it.summary = c.summary;
      it.domChunks = [`${it.domChunks[0]}\nScanned summary: ${c.summary}`];
    }
  }));
  return items;
}

export async function historyCaptures(sinceMs, max = HISTORY_MAX) {
  const entries = await chrome.history.search({
    text: "",
    startTime: Date.now() - sinceMs,
    maxResults: max
  });
  const items = entries
    .filter((e) => /^https?:/.test(e.url || ""))
    .map((e) => pseudoCapture({
      title: e.title,
      url: e.url,
      ts: e.lastVisitTime,
      line: `${e.title || e.url} — ${e.url} — visited ${e.visitCount}x, last ${new Date(e.lastVisitTime).toLocaleString()}`
    }))
    .sort((a, b) => b.ts - a.ts);
  return crossRef(items);
}

// Flatten the bookmark tree; folderPath rides along in the chunk line.
export async function bookmarkCaptures(max = BOOKMARKS_MAX) {
  const tree = await chrome.bookmarks.getTree();
  const items = [];
  const walk = (nodes, path) => {
    for (const n of nodes) {
      if (n.url) {
        if (/^https?:/.test(n.url) && items.length < max) {
          items.push(pseudoCapture({
            title: n.title,
            url: n.url,
            ts: n.dateAdded,
            line: `${n.title || n.url} — ${n.url} — folder: ${path || "/"}`
          }));
        }
      } else if (n.children) {
        walk(n.children, path ? `${path}/${n.title}` : n.title);
      }
    }
  };
  walk(tree, "");
  items.sort((a, b) => b.ts - a.ts);
  return crossRef(items);
}

// All non-root folders with readable paths, for the smart-bookmark picker.
export async function listBookmarkFolders(max = 50) {
  const tree = await chrome.bookmarks.getTree();
  const folders = [];
  const walk = (nodes, path) => {
    for (const n of nodes) {
      if (n.url || !n.children) continue;
      const p = path ? `${path}/${n.title}` : n.title;
      if (n.title && folders.length < max) folders.push({ id: n.id, path: p });
      walk(n.children, p);
    }
  };
  walk(tree, "");
  return folders;
}
