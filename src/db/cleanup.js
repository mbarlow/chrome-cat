// One-shot repair: drop summaries and chat replies that came from a
// placeholder model backend (open-source Chromium builds) before detection.

import { openDB, tx, reqValue } from "./db.js";
import { isStubOutput } from "../ai/language-model.js";

// Returns { summaries, messages } — how many were removed.
export async function purgeStubOutput() {
  const db = await openDB();
  const removed = { summaries: 0, messages: 0 };
  const captures = await tx(db, "captures", "readonly", (s) => reqValue(s.getAll()));
  const dirty = captures.filter((c) => isStubOutput(c.summary));
  if (dirty.length) {
    await tx(db, "captures", "readwrite", (s) => {
      for (const c of dirty) s.put({ ...c, summary: "" });
    });
    removed.summaries = dirty.length;
  }
  const chats = await tx(db, "chats", "readonly", (s) => reqValue(s.getAll()));
  const fixed = [];
  for (const chat of chats) {
    const messages = chat.messages.filter((m) => !(m.role === "assistant" && isStubOutput(m.content)));
    if (messages.length === chat.messages.length) continue;
    removed.messages += chat.messages.length - messages.length;
    fixed.push({ ...chat, messages });
  }
  if (fixed.length) {
    await tx(db, "chats", "readwrite", (s) => { for (const c of fixed) s.put(c); });
  }
  return removed;
}
