// Smart bookmark: file the current page where it belongs in the user's
// existing folder tree. Judgment call -> Nano with a constrained pick;
// fallback -> deterministic token overlap; last resort -> a "chrome-chat"
// folder. Dupes are reported, never re-created.

import { listBookmarkFolders } from "../sources/browser.js";
import { tokenize } from "../shared/text.js";

async function pickFolderWithModel(capture, folders) {
  if (typeof LanguageModel === "undefined") return null;
  if ((await LanguageModel.availability()) !== "available") return null;
  const session = await LanguageModel.create();
  try {
    const list = folders.map((f) => `${f.id}: ${f.path}`).join("\n");
    const out = await session.prompt(
      `Pick the best existing bookmark folder for this page. Reply with the folder id only.\n\n` +
      `Page: "${capture.title}" (${capture.url})\n` +
      (capture.summary ? `Summary: ${capture.summary}\n` : "") +
      `\nFolders:\n${list}`,
      { responseConstraint: { type: "string", enum: folders.map((f) => f.id) } }
    );
    const id = String(out).replace(/"/g, "").trim();
    return folders.find((f) => f.id === id) || null;
  } catch {
    return null;
  } finally {
    try { session.destroy?.(); } catch { /* ignore */ }
  }
}

function pickFolderByScore(capture, folders) {
  const terms = new Set(tokenize(`${capture.title} ${capture.domain} ${capture.summary}`));
  let best = null;
  let bestScore = 0;
  for (const f of folders) {
    const toks = tokenize(f.path);
    let s = 0;
    for (const t of toks) if (terms.has(t)) s++;
    if (s > bestScore) { bestScore = s; best = f; }
  }
  return best;
}

async function ensureDefaultFolder() {
  const existing = (await chrome.bookmarks.search({ title: "chrome-chat" }))
    .find((n) => !n.url);
  if (existing) return { id: existing.id, path: "chrome-chat" };
  const created = await chrome.bookmarks.create({ parentId: "2", title: "chrome-chat" }); // Other Bookmarks
  return { id: created.id, path: "chrome-chat" };
}

// Returns a human note for the chat.
export async function smartBookmark(capture) {
  const dupes = await chrome.bookmarks.search({ url: capture.url });
  if (dupes.length) return `already bookmarked as "${dupes[0].title}"`;
  const folders = await listBookmarkFolders();
  let folder = folders.length ? await pickFolderWithModel(capture, folders) : null;
  let how = "model-filed";
  if (!folder) {
    folder = pickFolderByScore(capture, folders);
    how = "keyword-filed";
  }
  if (!folder) {
    folder = await ensureDefaultFolder();
    how = "filed";
  }
  await chrome.bookmarks.create({ parentId: folder.id, title: capture.title, url: capture.url });
  return `${how} in ${folder.path}`;
}
