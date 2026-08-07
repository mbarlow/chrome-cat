// Stitch viewport frames into one tall canvas, downscale, slice into
// letter-aspect (8.5:11) PNG tiles. All OffscreenCanvas, side panel only.

import { TILE_W, TILE_H } from "../shared/constants.js";

async function toBitmap(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  return createImageBitmap(blob);
}

// frames: [{ y, dataUrl }] (fixed elements hidden after frame 0, so frames are
// position-pure — overlapping regions hold identical pixels and overdraw is safe).
// Returns { tiles: [{ blob, w, h, seq }], stitchedH }.
export async function stitchAndSlice(frames, metrics, { onProgress } = {}) {
  if (!frames.length) throw new Error("No frames to stitch.");
  const dpr = metrics.dpr || 1;
  const physW = Math.round(metrics.viewportW * dpr);
  const last = frames[frames.length - 1];
  const physH = Math.round((last.y + metrics.viewportH) * dpr);

  const stitch = new OffscreenCanvas(physW, physH);
  const sctx = stitch.getContext("2d");
  sctx.fillStyle = "#ffffff";
  sctx.fillRect(0, 0, physW, physH);
  for (const f of frames) {
    const bmp = await toBitmap(f.dataUrl);
    sctx.drawImage(bmp, 0, Math.round(f.y * dpr));
    bmp.close();
  }

  // Downscale once to TILE_W if wider — bounds memory/storage, still ~188dpi.
  let canvas = stitch;
  if (physW > TILE_W) {
    const h = Math.round((physH * TILE_W) / physW);
    const scaled = new OffscreenCanvas(TILE_W, h);
    scaled.getContext("2d").drawImage(stitch, 0, 0, TILE_W, h);
    canvas = scaled;
  }

  const w = canvas.width;
  const tileH = Math.round((w * TILE_H) / TILE_W); // letter aspect at actual width
  const count = Math.max(1, Math.ceil(canvas.height / tileH));
  const tiles = [];
  for (let i = 0; i < count; i++) {
    const slice = new OffscreenCanvas(w, tileH);
    const ctx = slice.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, tileH); // white-pads the final partial tile — good for OCR
    ctx.drawImage(canvas, 0, i * tileH, w, tileH, 0, 0, w, tileH);
    const blob = await slice.convertToBlob({ type: "image/png" });
    tiles.push({ blob, w, h: tileH, seq: i });
    onProgress?.(i + 1, count);
  }
  return { tiles, stitchedH: canvas.height };
}
