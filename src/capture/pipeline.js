// Full capture pipeline: scan → stitch → persist → OCR → summarize.
// Shared by the Scan button (active tab) and the crawler (crawl-window tab).
// onPhase(phase, done, total) — phases: "scan" | "stitch" | "ocr" | "summary".

import { scanPage } from "./scanner.js";
import { stitchAndSlice } from "./stitcher.js";
import { recognizeCapture } from "../ocr/capture-ocr.js";
import { getSettings } from "../shared/constants.js";
import { summarizeCapture } from "../ai/summarizer.js";
import { refreshDomain } from "../db/memory.js";
import * as captures from "../db/captures.js";
import { getOrCreateChat, appendMessage } from "../db/chats.js";
import { chunkText } from "../shared/text.js";
import { describeImages } from "../ai/prompts.js";

// Model output arrives as "SUMMARY: ... KEYWORDS: ..." — strip the scaffold
// for the chat opener.
export function summaryMessage(summary) {
  const m = String(summary).match(/SUMMARY:\s*([\s\S]*?)(?:\n\s*KEYWORDS:\s*([\s\S]*))?$/i);
  if (!m) return String(summary).trim();
  const body = m[1].trim();
  const kw = m[2]?.trim().replace(/\s*\n\s*/g, " ");
  return kw ? `${body}\n\n· ${kw}` : body;
}

// Seed a fresh capture's chat with its summary so the thread opens with
// something to react to. Empty threads only — rescans don't re-announce.
async function seedChat(capture) {
  if (!capture.summary) return;
  const chat = await getOrCreateChat("capture", capture.id);
  if (chat.messages.length) return;
  await appendMessage("capture", capture.id, {
    role: "assistant",
    content: summaryMessage(capture.summary)
  });
}

export async function capturePage(tabId, windowId, { seriesId = null, onPhase, ocrMode, signal } = {}) {
  const started = performance.now();
  const timings = {};
  if (!ocrMode) ocrMode = (await getSettings()).ocrMode;
  let stage = performance.now();
  const { metrics, dom, frames } = await scanPage(tabId, windowId, {
    signal, onProgress: (d, t) => onPhase?.("scan", d, t)
  });

  timings.scanMs = Math.round(performance.now() - stage);
  const capture = await captures.createCapture({
    url: metrics.url,
    title: metrics.title,
    viewport: { w: metrics.viewportW, h: metrics.viewportH, dpr: metrics.dpr },
    seriesId
  });

  try {
    signal?.throwIfAborted();
    stage = performance.now();
    onPhase?.("stitch", 0, 1);
    const { tiles } = await stitchAndSlice(frames, metrics, {
      onProgress: (d, t) => onPhase?.("stitch", d, t)
    });

    timings.stitchMs = Math.round(performance.now() - stage);
    stage = performance.now();
    for (const t of tiles) {
      await captures.addTile({
        captureId: capture.id, seq: t.seq, blob: t.blob, w: t.w, h: t.h, contentH: t.contentH,
        ocrText: "", ocrConfidence: 0
      });
    }
    let updated = await captures.updateCapture(capture.id, {
      status: "ocr",
      tileCount: tiles.length,
      domText: dom.text,
      mainText: dom.mainText,
      domMetadata: dom.metadata || [],
      visualRegions: dom.visualRegions || [],
      scanTruncated: Math.max(metrics.scrollHeight, dom.scrollHeight || 0) > frames.at(-1).y + metrics.viewportH,
      domChunks: [...chunkText(dom.text), describeImages(dom.images)].filter(Boolean),
      links: dom.links,
      images: dom.images || []
    });

    timings.persistMs = Math.round(performance.now() - stage);
    stage = performance.now();
    updated = await recognizeCapture(updated, { mode: ocrMode, signal,
      onProgress: (d, t) => onPhase?.("ocr", d, t) });
    timings.ocrMs = Math.round(performance.now() - stage);
    signal?.throwIfAborted();
    stage = performance.now();
    updated = await captures.updateCapture(capture.id, { status: "summarizing" });
    onPhase?.("summary", 0, 1);
    const summary = await summarizeCapture(updated); // "" when Nano unavailable
    timings.summaryMs = Math.round(performance.now() - stage);
    signal?.throwIfAborted();
    timings.totalMs = Math.round(performance.now() - started);
    updated = await captures.updateCapture(capture.id, { summary, timings, status: "ready" });
    onPhase?.("summary", 1, 1);

    await seedChat(updated);
    await refreshDomain(updated.domain);
    return updated;
  } catch (err) {
    await captures.updateCapture(capture.id, {
      status: err?.name === "AbortError" ? "cancelled" : "error", error: String(err?.message || err)
    });
    throw err;
  }
}
