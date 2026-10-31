// Region asks and source jumps: both act on the live tab, not stored tiles.

import { pageSelectRegion, pageHighlight } from "./page-script.js";
import { normalizeUrl } from "../shared/url.js";

// Let the user pick a box on the tab, then crop it from a fresh screenshot at
// device resolution. Resolves { blob, w, h, notes, url } or null (cancelled).
export async function captureRegion(tab) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: pageSelectRegion });
  const r = res?.result;
  if (!r) return null;
  const shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  const bmp = await createImageBitmap(await (await fetch(shot)).blob());
  try {
    const sx = bmp.width / r.vw;
    const sy = bmp.height / r.vh;
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(r.w * sx)), Math.max(1, Math.round(r.h * sy)));
    canvas.getContext("2d").drawImage(bmp, r.x * sx, r.y * sy, r.w * sx, r.h * sy, 0, 0, canvas.width, canvas.height);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return { blob, w: canvas.width, h: canvas.height, notes: r.notes || [], url: tab.url };
  } finally {
    bmp.close();
  }
}

function waitComplete(tabId, ms = 15000) {
  return new Promise((resolve) => {
    const done = () => { chrome.tabs.onUpdated.removeListener(listen); clearTimeout(timer); resolve(); };
    const listen = (id, info) => { if (id === tabId && info.status === "complete") done(); };
    const timer = setTimeout(done, ms);
    chrome.tabs.onUpdated.addListener(listen);
    chrome.tabs.get(tabId).then((t) => { if (t.status === "complete") done(); }).catch(done);
  });
}

// Bring `url` up in the tab (navigating only if it isn't already there) and
// highlight `passage`. Returns whether the passage was found.
export async function showSource(tab, url, passage) {
  if (normalizeUrl(tab.url || "") !== normalizeUrl(url)) {
    await chrome.tabs.update(tab.id, { url });
    await waitComplete(tab.id);
  }
  await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
  const [res] = await chrome.scripting.executeScript({
    target: { tabId: tab.id }, func: pageHighlight, args: [passage]
  });
  return !!res?.result;
}
