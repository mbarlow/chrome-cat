// Still minimal (chrome-packetlens rule): heavy work lives in the side
// panel. The worker owns only what MUST be event-driven — panel behavior,
// the context menu, and omnibox search. Handoff to the panel goes through
// chrome.storage.session ("pending" keys the panel picks up on open).

import { searchMemory } from "../db/memory.js";

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.contextMenus.create({
    id: "cc-selection",
    title: "Chat about this selection",
    contexts: ["selection"]
  });
});

// ---- right-click a selection -> panel opens with it staged ----

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "cc-selection") return;
  await chrome.storage.session.set({
    pendingSelection: { text: (info.selectionText || "").slice(0, 500), url: tab?.url || "", ts: Date.now() }
  });
  if (tab?.windowId != null) {
    try { await chrome.sidePanel.open({ windowId: tab.windowId }); } catch { /* needs gesture */ }
  }
});

// ---- omnibox: "cc <query>" searches the capture memory ----

chrome.omnibox.setDefaultSuggestion({
  description: "Search your chrome-chat memory"
});

chrome.omnibox.onInputChanged.addListener(async (text, suggest) => {
  if (!text.trim()) return suggest([]);
  try {
    const results = await searchMemory(text, 6);
    suggest(results.filter((r) => r.captureId).map((r) => ({
      content: `capture:${r.captureId}`,
      description: `${r.domain}${r.path || ""} — ${(r.text || "").slice(0, 80).replace(/[<>&"]/g, " ")}`
    })));
  } catch {
    suggest([]);
  }
});

chrome.omnibox.onInputEntered.addListener(async (text) => {
  const m = text.match(/^capture:(\d+)$/);
  const pendingScope = m
    ? { type: "capture", captureId: Number(m[1]) }
    : { type: "memory", query: text };
  await chrome.storage.session.set({ pendingScope });
  const win = await chrome.windows.getLastFocused();
  try { await chrome.sidePanel.open({ windowId: win.id }); } catch { /* open manually */ }
});
