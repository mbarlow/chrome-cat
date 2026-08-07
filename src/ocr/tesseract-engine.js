// Tesseract.js engine: one lazy worker for the whole panel session, jobs
// serialized through a promise queue (one tile at a time), terminated after
// idle. Uses the UMD `Tesseract` global loaded by sidepanel.html — the one
// non-module script in the repo.
//
// workerBlobURL:false is CRITICAL — MV3 CSP forbids blob: workers, so the
// worker must load straight from the extension origin.

import { OCR_IDLE_MS } from "../shared/constants.js";

let workerPromise = null;
let idleTimer = null;
let queue = Promise.resolve();
let currentLogger = null; // mutable ref so one worker serves many jobs' progress

function vendorUrl(p) {
  return chrome.runtime.getURL(`vendor/tesseract/${p}`);
}

function getWorker() {
  if (workerPromise) return workerPromise;
  if (typeof Tesseract === "undefined") {
    return Promise.reject(new Error("Tesseract global missing — vendor/tesseract not loaded."));
  }
  workerPromise = Tesseract.createWorker("eng", 1, {
    workerPath: vendorUrl("worker.min.js"),
    corePath: vendorUrl("tesseract-core-simd-lstm.wasm.js"),
    langPath: vendorUrl("lang"),
    workerBlobURL: false,
    gzip: true,
    logger: (m) => currentLogger?.(m)
  }).catch((err) => {
    workerPromise = null;
    throw err;
  });
  return workerPromise;
}

function scheduleIdleTeardown() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(terminate, OCR_IDLE_MS);
}

export async function terminate() {
  clearTimeout(idleTimer);
  const p = workerPromise;
  workerPromise = null;
  if (p) {
    try { (await p).terminate(); } catch { /* already dead */ }
  }
}

// Recognize one tile blob. onProgress(fraction 0..1) for this tile.
// Jobs queue FIFO; a failed job doesn't poison the queue.
export function ocrTile(blob, onProgress) {
  const job = queue.then(async () => {
    const worker = await getWorker();
    currentLogger = (m) => {
      if (m.status === "recognizing text") onProgress?.(m.progress ?? 0);
    };
    try {
      const { data } = await worker.recognize(blob);
      return { text: data.text || "", confidence: data.confidence ?? 0 };
    } finally {
      currentLogger = null;
      scheduleIdleTeardown();
    }
  });
  queue = job.catch(() => {});
  return job;
}

window.addEventListener("pagehide", () => { terminate(); });
