// Minimal PDF writer — tiles in, letter-size PDF out. No library: a PDF
// with one JPEG per page is ~40 lines of structure (DCTDecode embeds the
// JPEG bytes verbatim). Tiles are sliced at 8.5×11 aspect by design, so
// each fills its 612×792pt page exactly.

const LETTER_W = 612;
const LETTER_H = 792;

const enc = new TextEncoder();

// tileBlobs: PNG blobs in page order. Returns a PDF Blob.
export async function buildPdf(tileBlobs) {
  if (!tileBlobs.length) throw new Error("no tiles to build a PDF from");

  // Re-encode PNG -> JPEG (white-backed; JPEG has no alpha).
  const images = [];
  for (const blob of tileBlobs) {
    const bmp = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const cx = canvas.getContext("2d");
    cx.fillStyle = "#ffffff";
    cx.fillRect(0, 0, canvas.width, canvas.height);
    cx.drawImage(bmp, 0, 0);
    bmp.close();
    const jpeg = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
    images.push({ bytes: new Uint8Array(await jpeg.arrayBuffer()), w: canvas.width, h: canvas.height });
  }

  const parts = [];
  let offset = 0;
  const offsets = [];
  const push = (bytes) => { parts.push(bytes); offset += bytes.length; };
  const pushStr = (s) => push(enc.encode(s));
  const beginObj = (num) => { offsets[num] = offset; pushStr(`${num} 0 obj\n`); };

  pushStr("%PDF-1.4\n%âãÏÓ\n");

  // Objects: 1 catalog, 2 pages tree, then per page i: page 3+3i,
  // content 4+3i, image 5+3i.
  const n = images.length;
  const pageRefs = images.map((_, i) => `${3 + 3 * i} 0 R`).join(" ");

  beginObj(1);
  pushStr("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  beginObj(2);
  pushStr(`<< /Type /Pages /Kids [${pageRefs}] /Count ${n} >>\nendobj\n`);

  images.forEach((img, i) => {
    const pageNum = 3 + 3 * i;
    const contentNum = pageNum + 1;
    const imageNum = pageNum + 2;

    beginObj(pageNum);
    pushStr(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${LETTER_W} ${LETTER_H}] ` +
      `/Resources << /XObject << /Im ${imageNum} 0 R >> >> /Contents ${contentNum} 0 R >>\nendobj\n`
    );

    const content = `q ${LETTER_W} 0 0 ${LETTER_H} 0 0 cm /Im Do Q`;
    beginObj(contentNum);
    pushStr(`<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);

    beginObj(imageNum);
    pushStr(
      `<< /Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.bytes.length} >>\nstream\n`
    );
    push(img.bytes);
    pushStr("\nendstream\nendobj\n");
  });

  const count = 3 + 3 * n; // objects 1..count-1... plus the free entry 0
  const xrefStart = offset;
  pushStr(`xref\n0 ${count}\n`);
  pushStr("0000000000 65535 f \n");
  for (let i = 1; i < count; i++) {
    pushStr(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
  }
  pushStr(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);

  return new Blob(parts, { type: "application/pdf" });
}
