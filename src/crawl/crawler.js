// Link-following crawler. captureVisibleTab only captures a window's ACTIVE
// tab, so a background tab in the user's window can't work — instead we open
// one dedicated unfocused window (NOT minimized: capture fails on minimized
// windows), reuse its single tab per link, and close it in finally.

import { capturePage } from "../capture/pipeline.js";
import { rollupDomain } from "../ai/summarizer.js";
import * as seriesDb from "../db/series.js";
import * as capturesDb from "../db/captures.js";
import { normalizeUrl, sameDomain } from "../shared/url.js";
import { CRAWL_TIMEOUT_MS, CRAWL_SETTLE_MS } from "../shared/constants.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Attach BEFORE navigating — a cached page can complete before a late
// listener attaches, and checking tab.status up front would see the OLD
// page's "complete" and resolve early.
function waitForComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      err ? reject(err) : resolve();
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };
    const timer = setTimeout(() => finish(new Error(`Load timeout after ${timeoutMs}ms`)), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

export function selectLinks(capture, { sameDomainOnly, maxLinks, exclude = new Set() }) {
  const seen = new Set(exclude);
  seen.add(capture.url);
  return capture.links
    .filter((l) => !sameDomainOnly || sameDomain(l.href, capture.url))
    .filter((l) => {
      const n = normalizeUrl(l.href);
      if (seen.has(n)) return false;
      seen.add(n);
      return true;
    })
    .slice(0, maxLinks);
}

// Crawl the given links into a new series rooted at `capture`.
// control: { cancelled: boolean } — flip to stop after the current page.
// onProgress(progress), onPhase(phase, done, total) for the current page.
export async function runCrawl(capture, links, control, { onProgress, onPhase } = {}) {
  const series = await seriesDb.createSeries({
    name: capture.title,
    rootUrl: capture.url,
    captureIds: [capture.id]
  });
  await capturesDb.updateCapture(capture.id, { seriesId: series.id });

  const progress = { done: 0, total: links.length, currentUrl: "", errors: [] };
  await seriesDb.updateSeries(series.id, { progress });

  let win = null;
  let finalStatus = "done";
  try {
    win = await chrome.windows.create({
      url: "about:blank", focused: false, type: "normal",
      width: 1100, height: 1400, left: 40, top: 40
    });
    const tabId = win.tabs[0].id;
    const windowId = win.id;

    // User closing the crawl window = cancel.
    const onRemoved = (id) => { if (id === windowId) control.cancelled = true; };
    chrome.windows.onRemoved.addListener(onRemoved);

    try {
      for (const link of links) {
        if (control.cancelled) { finalStatus = "cancelled"; break; }
        progress.currentUrl = link.href;
        onProgress?.({ ...progress });
        try {
          const loaded = waitForComplete(tabId, CRAWL_TIMEOUT_MS);
          await chrome.tabs.update(tabId, { url: link.href });
          await loaded;
          await sleep(CRAWL_SETTLE_MS); // SPA hydration
          const pageCapture = await capturePage(tabId, windowId, {
            seriesId: series.id, onPhase
          });
          series.captureIds.push(pageCapture.id);
        } catch (err) {
          progress.errors.push({ url: link.href, error: String(err?.message || err) });
        }
        progress.done++;
        await seriesDb.updateSeries(series.id, {
          captureIds: series.captureIds, progress: { ...progress }
        });
        onProgress?.({ ...progress });
      }
    } finally {
      chrome.windows.onRemoved.removeListener(onRemoved);
    }
  } catch (err) {
    finalStatus = "error";
    progress.errors.push({ url: "(window)", error: String(err?.message || err) });
  } finally {
    if (win?.id != null) {
      try { await chrome.windows.remove(win.id); } catch { /* already closed */ }
    }
  }

  const updated = await seriesDb.updateSeries(series.id, {
    status: control.cancelled ? "cancelled" : finalStatus,
    progress: { ...progress, currentUrl: "" }
  });

  const members = await Promise.all(updated.captureIds.map((id) => capturesDb.getCapture(id)));
  await rollupDomain(updated.domain, members.filter(Boolean));
  return updated;
}
