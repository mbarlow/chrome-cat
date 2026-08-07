// Full capture pipeline: scan → stitch → persist → OCR → summarize.
// Shared by the Scan button (active tab) and the crawler (crawl-window tab).
// onPhase(phase, done, total) — phases: "scan" | "stitch" | "ocr" | "summary".

import { scanPage } from "./scanner.js";
import { stitchAndSlice } from "./stitcher.js";
import { ocrTile } from "../ocr/tesseract-engine.js";
import { summarizeCapture } from "../ai/summarizer.js";
import { refreshDomain } from "../db/memory.js";
import * as captures from "../db/captures.js";
import { chunkText } from "../shared/text.js";

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
      domChunks: chunkText(dom.text),
      links: dom.links
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

    await refreshDomain(updated.domain);
    return updated;
  } catch (err) {
    await captures.updateCapture(capture.id, {
      status: "error", error: String(err?.message || err)
    });
    throw err;
  }
}
