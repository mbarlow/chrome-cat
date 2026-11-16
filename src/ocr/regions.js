// Map page CSS rectangles to saved tile pixels. Merge intersecting areas so
// overlapping SVG/image elements don't cause duplicate OCR jobs.
export function ocrRegions(tile, regions, viewportW, offsetY = tile.seq * tile.h) {
  const scale = tile.w / viewportW;
  const boxes = [];
  for (const r of regions || []) {
    const x = Math.max(0, Math.floor(r.x * scale) - 4);
    const y = Math.max(0, Math.floor(r.y * scale - offsetY) - 4);
    const right = Math.min(tile.w, Math.ceil((r.x + r.w) * scale) + 4);
    const bottom = Math.min(tile.contentH ?? tile.h, Math.ceil((r.y + r.h) * scale - offsetY) + 4);
    if (right <= x || bottom <= y) continue;
    let box = { left: x, top: y, width: right - x, height: bottom - y };
    for (let i = 0; i < boxes.length;) {
      const b = boxes[i];
      if (box.left <= b.left + b.width && box.left + box.width >= b.left &&
          box.top <= b.top + b.height && box.top + box.height >= b.top) {
        const left = Math.min(box.left, b.left), top = Math.min(box.top, b.top);
        box = { left, top, width: Math.max(box.left + box.width, b.left + b.width) - left,
          height: Math.max(box.top + box.height, b.top + b.height) - top };
        boxes.splice(i, 1); i = 0;
      } else i++;
    }
    boxes.push(box);
  }
  return boxes;
}
