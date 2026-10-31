// Vision answers: feed stored page-scan tiles to the multimodal Prompt API
// (chrome-snapshot inspector pattern). Fresh session per question, destroyed
// in finally — the text chat session's quota stays untouched. "Who made this"
// questions are cross-checked by two independent samples before answering.

import { assertRealOutput } from "./language-model.js";
import { describeImages } from "./prompts.js";

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

const IDENTIFY = /\b(who (painted|made|drew|created|took|designed)|recogni[sz]e|identify|which (painting|artwork|work)|what (painting|artwork|work of art)|name of (the|this|that) (painting|artwork|piece))\b/i;

const ID_SCHEMA = {
  type: "object",
  properties: { title: { type: "string" }, artist: { type: "string" } },
  required: ["title", "artist"]
};

const artistKey = (a) => String(a || "").toLowerCase().replace(/[^a-z\s]/g, "").trim().split(/\s+/).pop() || "";
const known = (a) => artistKey(a) && !/^(unknown|none|na|unclear)$/.test(artistKey(a));

// Ask two clones of the image-primed session to name the work independently.
// Agreement is stated; disagreement becomes an explicit hedge.
async function crossCheck(base) {
  const ask = async () => {
    const s = await base.clone();
    try {
      const out = await s.prompt(
        "Identify the most prominent artwork or subject in the page images. Reply as JSON " +
        'with "title" and "artist"; use "unknown" for anything you cannot tell.',
        { responseConstraint: ID_SCHEMA });
      return JSON.parse(assertRealOutput(out));
    } finally {
      try { s.destroy?.(); } catch { /* ignore */ }
    }
  };
  const [a, b] = await Promise.all([ask(), ask()]);
  const guesses = `${a.title} / ${a.artist} · ${b.title} / ${b.artist}`;
  if (known(a.artist) && artistKey(a.artist) === artistKey(b.artist)) {
    return { check: "agreed", guesses, hint: `[Checked twice: this looks like "${a.title}" by ${a.artist}.]\n` };
  }
  if (!known(a.artist) && !known(b.artist)) {
    return { check: "unknown", guesses, hint: "[You could not identify who made it; say so plainly and describe what you see.]\n" };
  }
  return {
    check: "disagreed",
    guesses,
    hint: `[Two independent looks disagreed (${a.artist || "unknown"} vs ${b.artist || "unknown"}); ` +
      "say you are not sure who made it, offer those as possibilities, and describe what you see.]\n"
  };
}

// blobs: tile PNGs, top of page first. history: recent { question, answer }
// turns, replayed so follow-ups stay consistent. notes: the page's own image
// descriptions (alt text, captions). Returns { answer, check } where check is
// the cross-check outcome ("agreed" | "disagreed" | "unknown") or null, and
// guesses lists what the two samples named.
export async function answerAboutTiles(question, blobs, { history = [], notes = [], onDownload } = {}) {
  const { state, reason } = await getVisionAvailability();
  if (state === "missing" || state === "unavailable") {
    throw new Error(reason || "this model build doesn't accept image input");
  }
  const session = await LanguageModel.create({
    ...IMAGE_OPTIONS,
    initialPrompts: history.flatMap((t) => [
      { role: "user", content: t.question },
      { role: "assistant", content: t.answer }
    ]),
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
    const intro = (bitmaps.length === 1
      ? "This image is a scan of a web page. Answer from what you can see in it."
      : `These ${bitmaps.length} images are sequential scans of one web page, top to bottom. ` +
        "Answer from what you can see in them.") +
      (notes.length ? `\n\n${describeImages(notes)}\nTrust these descriptions over your own guesses.` : "");
    const pageContent = [{ type: "text", value: intro }, ...bitmaps.map((bm) => ({ type: "image", value: bm }))];

    if (!session.append || !session.clone) {
      const content = [...pageContent, { type: "text", value: question }];
      return { answer: assertRealOutput(await session.prompt([{ role: "user", content }])), check: null };
    }
    await session.append([{ role: "user", content: pageContent }]);
    const { check = null, guesses = "", hint = "" } = IDENTIFY.test(question)
      ? await crossCheck(session).catch(() => ({})) : {};
    return { answer: assertRealOutput(await session.prompt(hint + question)), check, guesses };
  } finally {
    for (const bm of bitmaps) bm.close();
    try { session.destroy?.(); } catch { /* ignore */ }
  }
}
