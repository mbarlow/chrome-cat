// Still minimal (chrome-packetlens rule): heavy work lives in the side
// panel. The worker owns only what MUST be event-driven — panel behavior
// and omnibox search. Handoff to the panel goes through
// chrome.storage.session ("pending" keys the panel picks up on open).

import { searchMemory } from "../db/memory.js";
import { getCapture } from "../db/captures.js";

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

// ---- omnibox: "cc <query>" searches the capture memory; picking a result
// navigates to that page AND scopes the chat to its capture ----

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

chrome.omnibox.onInputEntered.addListener(async (text, disposition) => {
  const m = text.match(/^capture:(\d+)$/);
  if (!m) {
    // Plain text entered — memory-wide chat with the query staged.
    await chrome.storage.session.set({ pendingScope: { type: "memory", query: text } });
  } else {
    const captureId = Number(m[1]);
    await chrome.storage.session.set({ pendingScope: { type: "capture", captureId } });
    const capture = await getCapture(captureId).catch(() => null);
    if (capture?.url) {
      if (disposition === "currentTab") {
        await chrome.tabs.update({ url: capture.url });
      } else {
        await chrome.tabs.create({ url: capture.url, active: disposition !== "newBackgroundTab" });
      }
    }
  }
  const win = await chrome.windows.getLastFocused();
  try { await chrome.sidePanel.open({ windowId: win.id }); } catch { /* open manually */ }
});
