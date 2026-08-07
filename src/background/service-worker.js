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
  description: "Search your Chrome Cat memory"
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
  openPanelWithGesture();
  handleOmniboxEnter(text, disposition).catch((e) => console.warn("[cc] omnibox:", e?.message || e));
});

// sidePanel.open() demands a user gesture, and the gesture does NOT survive
// promise chains (.then loses it — verified in the field). It DOES propagate
// into chrome API callbacks. So: synchronous attempt with WINDOW_ID_CURRENT
// first, callback-form tabs.query as the fallback. If both refuse, the
// pending scope still stages — the toolbar click picks it up.
function openPanelWithGesture() {
  const fallback = () => {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      const tab = tabs?.[0];
      if (!tab) return;
      chrome.sidePanel.open({ windowId: tab.windowId }).catch((e) =>
        console.warn("[cc] sidePanel.open (callback):", e?.message || e));
    });
  };
  try {
    chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT })
      .then(undefined, fallback);
  } catch {
    fallback();
  }
}

async function handleOmniboxEnter(text, disposition) {
  console.log("[cc] omnibox enter:", text, disposition);
  // Picked suggestion row -> "capture:<id>". Plain enter (the default
  // suggestion) -> raw query: resolve to the best memory hit THAT HAS A
  // CAPTURE — domain rollup rows score highest on domain-name queries but
  // carry no captureId, and must not eat the navigation.
  let captureId = null;
  const m = text.match(/^capture:(\d+)$/);
  if (m) {
    captureId = Number(m[1]);
  } else {
    const results = await searchMemory(text, 6).catch(() => []);
    captureId = results.find((r) => r.captureId)?.captureId ?? null;
  }
  console.log("[cc] resolved captureId:", captureId);

  if (!captureId) {
    await chrome.storage.session.set({ pendingScope: { type: "memory", query: text } });
    return;
  }

  await chrome.storage.session.set({ pendingScope: { type: "capture", captureId } });
  const capture = await getCapture(captureId).catch((e) => {
    console.warn("[cc] getCapture:", e?.message || e);
    return null;
  });
  console.log("[cc] capture url:", capture?.url);
  if (!capture?.url) return;
  if (disposition === "currentTab") {
    // tabs.update without a tabId means "current window's active tab" — a
    // service worker has no current window, so resolve the tab explicitly.
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    console.log("[cc] active tab:", tab?.id, tab?.url);
    if (tab?.id != null) await chrome.tabs.update(tab.id, { url: capture.url });
    else await chrome.tabs.create({ url: capture.url });
  } else {
    await chrome.tabs.create({ url: capture.url, active: disposition !== "newBackgroundTab" });
  }
  console.log("[cc] navigated ->", capture.url);
}
