// Throwaway-session summarization (chrome-snapshot inspector pattern):
// create → prompt → destroy, so chat-session quota stays untouched.

import { createAiSession } from "./language-model.js";
import { buildSummaryPrompt, buildRollupPrompt } from "./prompts.js";
import { SUMMARY_INPUT_CHARS } from "../shared/constants.js";
import { refreshDomain } from "../db/memory.js";

async function oneShot(prompt, { onDownload } = {}) {
  const session = await createAiSession({ onDownload });
  try {
    return (await session.prompt(prompt)).trim();
  } finally {
    try { session.destroy?.(); } catch { /* ignore */ }
  }
}

// Prefer DOM text (cleaner than OCR). Returns "" when the model is unavailable —
// summaries are an enhancement, never a blocker.
export async function summarizeCapture(capture, { onDownload } = {}) {
  const text = (capture.domText || capture.ocrText || "").slice(0, SUMMARY_INPUT_CHARS);
  if (!text.trim()) return "";
  try {
    return await oneShot(buildSummaryPrompt(capture.title, capture.url, text), { onDownload });
  } catch {
    return "";
  }
}

// Domain rollup from its captures' summaries; refreshes the domain row either way.
export async function rollupDomain(domain, captures) {
  const summaries = captures.map((c) => c.summary).filter(Boolean).slice(0, 20);
  let rollup = null;
  if (summaries.length) {
    try {
      rollup = await oneShot(buildRollupPrompt(domain, summaries));
    } catch { /* keep previous rollup */ }
  }
  return refreshDomain(domain, rollup);
}
