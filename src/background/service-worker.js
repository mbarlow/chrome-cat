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

chrome.omnibox.onInputEntered.addListener((text, disposition) => {
  // Open the panel FIRST — the user-gesture token decays across awaits, and
  // sidePanel.open() without a gesture throws. Scope follows via the pending
  // key (the panel picks it up on load or via storage.onChanged).
  chrome.windows.getLastFocused()
    .then((w) => chrome.sidePanel.open({ windowId: w.id }))
    .catch((e) => console.warn("[cc] sidePanel.open:", e?.message || e));
  handleOmniboxEnter(text, disposition).catch((e) => console.warn("[cc] omnibox:", e?.message || e));
});

async function handleOmniboxEnter(text, disposition) {
  // Picked suggestion row -> "capture:<id>". Plain enter (the default
  // suggestion) -> raw query: resolve it to the top memory hit so enter
  // without arrowing down still lands on the page.
  let captureId = null;
  const m = text.match(/^capture:(\d+)$/);
  if (m) {
    captureId = Number(m[1]);
  } else {
    const results = await searchMemory(text, 1).catch(() => []);
    captureId = results[0]?.captureId ?? null;
  }

  if (!captureId) {
    await chrome.storage.session.set({ pendingScope: { type: "memory", query: text } });
    return;
  }

  await chrome.storage.session.set({ pendingScope: { type: "capture", captureId } });
  const capture = await getCapture(captureId).catch(() => null);
  if (!capture?.url) return;
  if (disposition === "currentTab") {
    await chrome.tabs.update({ url: capture.url });
  } else {
    await chrome.tabs.create({ url: capture.url, active: disposition !== "newBackgroundTab" });
  }
}
