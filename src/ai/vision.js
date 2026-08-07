// Vision answers: feed stored page-scan tiles to the multimodal Prompt API
// (chrome-snapshot inspector pattern). Fresh session per question, destroyed
// in finally — the text chat session's quota stays untouched.

const IMAGE_OPTIONS = {
  expectedInputs: [{ type: "image" }, { type: "text", languages: ["en"] }],
  expectedOutputs: [{ type: "text", languages: ["en"] }]
};

export async function getVisionAvailability() {
  if (typeof LanguageModel === "undefined") {
    return { state: "missing", reason: "LanguageModel global is not available." };
  }
  try {
    return { state: await LanguageModel.availability(IMAGE_OPTIONS) };
  } catch (err) {
    return { state: "missing", reason: String(err?.message || err) };
  }
}

// blobs: tile PNGs, top of page first. Returns the model's answer text.
export async function answerAboutTiles(question, blobs, { onDownload } = {}) {
  const { state, reason } = await getVisionAvailability();
  if (state === "missing" || state === "unavailable") {
    throw new Error(reason || "this model build doesn't accept image input");
  }
  const session = await LanguageModel.create({
    ...IMAGE_OPTIONS,
    monitor(m) {
      m.addEventListener("downloadprogress", (e) => {
        const pct = Math.max(0, Math.min(100, Math.round((e.loaded ?? 0) * 100)));
        onDownload?.(pct);
      });
    }
  });
  const bitmaps = [];
  try {
    for (const b of blobs) bitmaps.push(await createImageBitmap(b));
    const content = [
      {
        type: "text",
        value:
          `These ${bitmaps.length} images are sequential scans of one web page, ` +
          `top to bottom. Answer from what you can see in them. ${question}`
      },
      ...bitmaps.map((bm) => ({ type: "image", value: bm }))
    ];
    return await session.prompt([{ role: "user", content }]);
  } finally {
    for (const bm of bitmaps) bm.close();
    try { session.destroy?.(); } catch { /* ignore */ }
  }
}
