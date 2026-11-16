// Scroll-and-capture loop. Runs in the side panel; page code is injected per
// step. Produces raw viewport frames + DOM ground truth for the stitcher.

import { MAX_VIEWPORTS, SETTLE_MS, CAPTURE_RETRY_MS } from "../shared/constants.js";
import {
  pageGetMetrics, pageScrollToY, pageHideFixed, pageRestore, pageExtractDom, pageVisualState
} from "./page-script.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function inject(tabId, func, args = []) {
  const [result] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return result?.result;
}

let lastCaptureAt = 0;
async function captureFrame(windowId, tabId, url, signal) {
  await sleep(Math.max(0, 550 - (performance.now() - lastCaptureAt)));
  const check = async () => {
    signal?.throwIfAborted();
    const [active] = await chrome.tabs.query({ active: true, windowId });
    if (active?.id !== tabId || active.url?.split("#")[0] !== url.split("#")[0]) {
      throw new Error("Scan stopped because the page or active tab changed. Return to the page and scan again.");
    }
  };
  await check();
  lastCaptureAt = performance.now();
  const capture = async () => {
    const state = await inject(tabId, pageVisualState);
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
    return { dataUrl, state };
  };
  try {
    return await capture();
  } catch (err) {
    await sleep(CAPTURE_RETRY_MS); // quota edge: one retry
    await check();
    lastCaptureAt = performance.now();
    return capture();
  }
}

// Returns { metrics, dom, frames: [{ y, dataUrl }] }. onProgress(done, total).
export async function scanPage(tabId, windowId, { onProgress, signal } = {}) {
  const metrics = await inject(tabId, pageGetMetrics);
  if (!metrics) throw new Error("Could not read page metrics — page may block injection.");
  let dom;

  const vh = metrics.viewportH;
  const total = Math.min(Math.max(1, Math.ceil(metrics.scrollHeight / vh)), MAX_VIEWPORTS);
  const frames = [];
  try {
    onProgress?.(0, total);
    for (let i = 0; i < total; i++) {
      signal?.throwIfAborted();
      const target = Math.min(i * vh, metrics.scrollHeight - vh);
      await inject(tabId, pageScrollToY, [Math.max(0, target)]);
      if (i === 1) await inject(tabId, pageHideFixed); // frame 0 keeps the header, once
      await sleep(SETTLE_MS);
      const { dataUrl, state } = await captureFrame(windowId, tabId, metrics.url, signal);
      if (state.w !== metrics.viewportW || state.h !== metrics.viewportH) {
        throw new Error("Page resized during the scan. Keep the window size steady and try again.");
      }
      const actualY = state.y;
      // Clamped scroll near the bottom: skip exact-duplicate positions.
      if (!frames.length || frames[frames.length - 1].y !== actualY) {
        frames.push({ y: actualY, dataUrl, visualRegions: state.regions });
      }
      onProgress?.(i + 1, total);
    }
  } finally {
    await inject(tabId, pageRestore).catch(() => {});
  }
  signal?.throwIfAborted();
  dom = await inject(tabId, pageExtractDom);
  dom.visualRegions = frames.flatMap(f => f.visualRegions);
  return { metrics, dom, frames };
}
