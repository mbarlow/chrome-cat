// Full capture pipeline: scan → stitch → persist → OCR → summarize.
// Shared by the Scan button (active tab) and the crawler (crawl-window tab).
// onPhase(phase, done, total) — phases: "scan" | "stitch" | "ocr" | "summary".

import { scanPage } from "./scanner.js";
import { stitchAndSlice } from "./stitcher.js";
import { ocrTile } from "../ocr/tesseract-engine.js";
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

export async function capturePage(tabId, windowId, { seriesId = null, onPhase } = {}) {
  const { metrics, dom, frames } = await scanPage(tabId, windowId, {
    onProgress: (d, t) => onPhase?.("scan", d, t)
  });

  const capture = await captures.createCapture({
    url: metrics.url,
    title: metrics.title,
    viewport: { w: metrics.viewportW, h: metrics.viewportH, dpr: metrics.dpr },
    seriesId
  });

  try {
    const { tiles } = await stitchAndSlice(frames, metrics, {
      onProgress: (d, t) => onPhase?.("stitch", d, t)
    });

    const tileRows = [];
    for (const t of tiles) {
      tileRows.push(await captures.addTile({
        captureId: capture.id, seq: t.seq, blob: t.blob, w: t.w, h: t.h,
        ocrText: "", ocrConfidence: 0
      }));
    }
    await captures.updateCapture(capture.id, {
      status: "ocr",
      tileCount: tiles.length,
      domText: dom.text,
      domChunks: [...chunkText(dom.text), describeImages(dom.images)].filter(Boolean),
      links: dom.links,
      images: dom.images || []
    });

    // Sequential OCR, one tile at a time.
    const ocrParts = [];
    for (let i = 0; i < tileRows.length; i++) {
      const row = tileRows[i];
      try {
        const { text, confidence } = await ocrTile(row.blob, (frac) =>
          onPhase?.("ocr", i + frac, tileRows.length));
        row.ocrText = text;
        row.ocrConfidence = confidence;
        await captures.updateTile(row);
        ocrParts.push(text);
      } catch (err) {
        ocrParts.push(`[OCR failed: ${err?.message || err}]`);
      }
      onPhase?.("ocr", i + 1, tileRows.length);
    }
    const ocrText = ocrParts
      .map((p, i) => (i === 0 ? p : `\n\n--- page ${i + 1} ---\n\n${p}`))
      .join("");

    let updated = await captures.updateCapture(capture.id, { ocrText, status: "summarizing" });

    onPhase?.("summary", 0, 1);
    const summary = await summarizeCapture(updated); // "" when Nano unavailable
    updated = await captures.updateCapture(capture.id, { summary, status: "ready" });
    onPhase?.("summary", 1, 1);

    await seedChat(updated);
    await refreshDomain(updated.domain);
    return updated;
  } catch (err) {
    await captures.updateCapture(capture.id, {
      status: "error", error: String(err?.message || err)
    });
    throw err;
  }
}
