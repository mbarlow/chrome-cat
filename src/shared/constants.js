// Central knobs. Anything a user might want to tune lives in settings
// (chrome.storage.local) with these as defaults.

export const DB_NAME = "chrome-chat"; // pre-rename name kept — changing it orphans existing captures
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
export const MAX_TABLE_ROWS = 50;     // extraction cap per table
export const QUOTA_REBUILD_AT = 0.8;  // rebuild session past this inputQuota fraction
export const SUMMARY_INPUT_CHARS = 4000; // text fed to the summarizer

// Crawl
export const CRAWL_TIMEOUT_MS = 25_000;
export const CRAWL_SETTLE_MS = 1200;  // SPA hydration after tab "complete"
export const DEFAULT_MAX_LINKS = 20;

export const MAX_CONTEXT_LINKS = 30;  // [Page links] block cap per question
export const MAX_VISION_TILES = 3;    // tiles fed to a multimodal question (quota)

export const WEBHOOK_TIMEOUT_MS = 10_000;

// chrome.storage.local keys
export const STORAGE_KEYS = {
  maxLinks: "cc.maxLinks",
  sameDomainOnly: "cc.sameDomainOnly",
  systemPrompt: "cc.systemPrompt",
  webhooks: "cc.webhooks" // [{ name, url }]
};

export async function getSettings() {
  const raw = await chrome.storage.local.get(Object.values(STORAGE_KEYS));
  return {
    maxLinks: raw[STORAGE_KEYS.maxLinks] ?? DEFAULT_MAX_LINKS,
    sameDomainOnly: raw[STORAGE_KEYS.sameDomainOnly] ?? true,
    systemPrompt: raw[STORAGE_KEYS.systemPrompt] ?? null, // null -> DEFAULT_SYSTEM_BASE
    webhooks: raw[STORAGE_KEYS.webhooks] ?? []
  };
}

// Partial update: only keys present in the patch are written.
export async function saveSettings(patch) {
  const out = {};
  if (patch.maxLinks !== undefined) out[STORAGE_KEYS.maxLinks] = patch.maxLinks;
  if (patch.sameDomainOnly !== undefined) out[STORAGE_KEYS.sameDomainOnly] = patch.sameDomainOnly;
  if (patch.systemPrompt !== undefined) out[STORAGE_KEYS.systemPrompt] = patch.systemPrompt;
  if (patch.webhooks !== undefined) out[STORAGE_KEYS.webhooks] = patch.webhooks;
  await chrome.storage.local.set(out);
}

export async function resetSystemPrompt() {
  await chrome.storage.local.remove(STORAGE_KEYS.systemPrompt);
}
