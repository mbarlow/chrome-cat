// Minimal on purpose (chrome-packetlens rule): the MV3 worker can sleep
// mid-interaction, so all real work — capture, OCR, IndexedDB, LLM sessions,
// crawling — lives in the side panel, which stays alive while open.

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
