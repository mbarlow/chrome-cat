// OCR saved tiles; automatic mode concentrates work on visual content when
// the DOM already supplies readable text. Full mode also covers CSS imagery.
import { ocrTile } from './tesseract-engine.js';
import { ocrRegions } from './regions.js';
import { getTiles, updateTile, updateCapture } from '../db/captures.js';

export async function recognizeCapture(capture, { mode = 'full', onProgress, signal } = {}) {
  const started = performance.now();
  const tiles = await getTiles(capture.id);
  const full = mode === 'full' || (capture.domText || '').trim().length < 200;
  const jobs = [];
  let areaCount = 0;
  let offsetY = 0;
  for (const tile of tiles) {
    const regions = full ? [{ left: 0, top: 0, width: tile.w, height: tile.contentH ?? tile.h }]
      : ocrRegions(tile, capture.visualRegions, capture.viewport.w, offsetY);
    offsetY += tile.h;
    areaCount += regions.length;
    if (regions.length) jobs.push({ tile, regions });
  }
  const results = new Map(tiles.map(t => [t.id, { text: [], confidence: [], errors: [] }]));
  const errors = [];
  onProgress?.(0, jobs.length);
  for (let i = 0; i < jobs.length; i++) {
    signal?.throwIfAborted();
    const { tile, regions } = jobs[i];
    const result = results.get(tile.id);
    try {
      // Decode each tile once, rather than once per photo (hundreds on a
      // news homepage). White-mask DOM areas, keeping image positions intact.
      const blob = full ? tile.blob : await imageAreas(tile.blob, regions);
      const { text, confidence } = await ocrTile(blob,
        frac => onProgress?.(i + frac, jobs.length));
      if (text.trim()) result.text.push(text.trim());
      result.confidence.push(confidence);
    } catch (error) {
      const message = `Tile ${tile.seq + 1}: ${error?.message || error}`;
      errors.push(message); result.errors.push(message);
    }
    onProgress?.(i + 1, jobs.length);
  }
  signal?.throwIfAborted();
  for (const tile of tiles) {
    const r = results.get(tile.id);
    if (!r.errors.length || r.text.length) tile.ocrText = r.text.join('\n\n');
    tile.ocrConfidence = r.confidence.length ? r.confidence.reduce((a,b)=>a+b,0) / r.confidence.length : 0;
    tile.ocrStatus = r.errors.length ? 'error' : r.confidence.length ? 'complete' : 'skipped';
    await updateTile(tile);
  }
  // Error messages are diagnostics, never model evidence.
  return updateCapture(capture.id, {
    ocrDurationMs: Math.round(performance.now() - started),
    ocrText: tiles.map(t => t.ocrText).filter(Boolean).join('\n\n'),
    ocrMode: full ? 'full' : 'auto', ocrJobs: jobs.length, ocrAreas: areaCount,
    ocrStatus: errors.length ? 'partial' : jobs.length ? 'complete' : 'skipped', ocrErrors: errors
  });
}

async function imageAreas(blob, regions) {
  const left = Math.min(...regions.map(r => r.left));
  const top = Math.min(...regions.map(r => r.top));
  const right = Math.max(...regions.map(r => r.left + r.width));
  const bottom = Math.max(...regions.map(r => r.top + r.height));
  const canvas = new OffscreenCanvas(right - left, bottom - top);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  const bitmap = await createImageBitmap(blob);
  try {
    for (const r of regions) ctx.drawImage(bitmap, r.left, r.top, r.width, r.height,
      r.left - left, r.top - top, r.width, r.height);
    return await canvas.convertToBlob({ type: 'image/png' });
  } finally { bitmap.close(); }
}
