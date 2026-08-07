// Central knobs. Anything a user might want to tune lives in settings
// (chrome.storage.local) with these as defaults.

export const DB_NAME = "chrome-chat";
export const DB_VERSION = 1;

// Capture
export const MAX_VIEWPORTS = 25;      // cap runaway/infinite-scroll pages
export const SETTLE_MS = 600;         // covers captureVisibleTab 2/sec quota + lazy-load paint
export const CAPTURE_RETRY_MS = 700;  // one retry after a quota throw
export const TILE_W = 1600;           // stitch downscale width (~188dpi at 8.5in)
export const TILE_H = Math.round((TILE_W * 11) / 8.5); // 2071 — letter aspect

// OCR
export const OCR_IDLE_MS = 60_000;    // terminate the Tesseract worker after idle

// Chat / retrieval
export const CHUNK_CHARS = 800;       // DOM-text chunk size for retrieval
export const TOP_CHUNKS = 3;          // excerpts per question
export const QUOTA_REBUILD_AT = 0.8;  // rebuild session past this inputQuota fraction
export const SUMMARY_INPUT_CHARS = 4000; // text fed to the summarizer

// Crawl
export const CRAWL_TIMEOUT_MS = 25_000;
export const CRAWL_SETTLE_MS = 1200;  // SPA hydration after tab "complete"
export const DEFAULT_MAX_LINKS = 20;

// chrome.storage.local keys
export const STORAGE_KEYS = {
  maxLinks: "cc.maxLinks",
  sameDomainOnly: "cc.sameDomainOnly"
};

export async function getSettings() {
  const raw = await chrome.storage.local.get(Object.values(STORAGE_KEYS));
  return {
    maxLinks: raw[STORAGE_KEYS.maxLinks] ?? DEFAULT_MAX_LINKS,
    sameDomainOnly: raw[STORAGE_KEYS.sameDomainOnly] ?? true
  };
}

export async function saveSettings({ maxLinks, sameDomainOnly }) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.maxLinks]: maxLinks,
    [STORAGE_KEYS.sameDomainOnly]: sameDomainOnly
  });
}
