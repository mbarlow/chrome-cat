// Chat threads, one per scope. Messages embedded — append + put.
// { id, scopeType: "capture"|"series", scopeId, ts, messages: [{role, content, ts}] }

import { openDB, tx, reqValue } from "./db.js";

export async function getOrCreateChat(scopeType, scopeId) {
  const db = await openDB();
  const existing = await tx(db, "chats", "readonly", (s) =>
    reqValue(s.index("byScope").get([scopeType, scopeId])));
  if (existing) return existing;
  const chat = { scopeType, scopeId, ts: Date.now(), messages: [] };
  chat.id = await tx(db, "chats", "readwrite", (s) => reqValue(s.add(chat)));
  return chat;
}

export async function appendMessage(scopeType, scopeId, message) {
  const db = await openDB();
  const chat = await getOrCreateChat(scopeType, scopeId);
  chat.messages.push({ ...message, ts: Date.now() });
  await tx(db, "chats", "readwrite", (s) => { s.put(chat); });
  return chat;
}
