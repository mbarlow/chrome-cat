// Scroll-and-capture loop. Runs in the side panel; page code is injected per
// step. Produces raw viewport frames + DOM ground truth for the stitcher.

import { MAX_VIEWPORTS, SETTLE_MS, CAPTURE_RETRY_MS } from "../shared/constants.js";
import {
  pageGetMetrics, pageScrollToY, pageHideFixed, pageRestore, pageExtractDom
} from "./page-script.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function inject(tabId, func, args = []) {
  const [result] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return result?.result;
}

async function captureFrame(windowId) {
  try {
    return await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  } catch (err) {
    await sleep(CAPTURE_RETRY_MS); // quota edge: one retry
    return chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  }
}

// Returns { metrics, dom, frames: [{ y, dataUrl }] }. onProgress(done, total).
export async function scanPage(tabId, windowId, { onProgress } = {}) {
  const metrics = await inject(tabId, pageGetMetrics);
  if (!metrics) throw new Error("Could not read page metrics — page may block injection.");
  const dom = await inject(tabId, pageExtractDom);

  const vh = metrics.viewportH;
  const total = Math.min(Math.max(1, Math.ceil(metrics.scrollHeight / vh)), MAX_VIEWPORTS);
  const frames = [];
  try {
    for (let i = 0; i < total; i++) {
      const target = Math.min(i * vh, metrics.scrollHeight - vh);
      const actualY = await inject(tabId, pageScrollToY, [Math.max(0, target)]);
      if (i === 1) await inject(tabId, pageHideFixed); // frame 0 keeps the header, once
      await sleep(SETTLE_MS);
      const dataUrl = await captureFrame(windowId);
      // Clamped scroll near the bottom: skip exact-duplicate positions.
      if (!frames.length || frames[frames.length - 1].y !== actualY) {
        frames.push({ y: actualY, dataUrl });
      }
      onProgress?.(i + 1, total);
    }
  } finally {
    await inject(tabId, pageRestore).catch(() => {});
  }
  return { metrics, dom, frames };
}
