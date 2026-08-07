// Thin wrapper around Chrome's built-in LanguageModel (Gemini Nano) Prompt API.
// Copied from chrome-packetlens — all direct API contact isolated here.
// Feature-detect everything; never assume availability.

const TEXT_OPTIONS = {
  expectedInputs: [{ type: "text", languages: ["en"] }],
  expectedOutputs: [{ type: "text", languages: ["en"] }]
};

// { state, reason? }; state: "missing" | "unavailable" | "downloadable"
//                            | "downloading" | "available"
export async function getAiAvailability(options = TEXT_OPTIONS) {
  if (typeof LanguageModel === "undefined") {
    return { state: "missing", reason: "LanguageModel global is not available. Requires Chrome 138+ on a supported desktop OS." };
  }
  try {
    const availability = await LanguageModel.availability(options);
    return { state: availability };
  } catch (err) {
    return { state: "missing", reason: String(err?.message || err) };
  }
}

// Create a session. First call may trigger model download; report progress via
// onDownload(pct). Must follow a user gesture.
export async function createAiSession({ systemPrompt, languages = ["en"], onDownload } = {}) {
  if (typeof LanguageModel === "undefined") {
    throw new Error("LanguageModel global is not available.");
  }
  return LanguageModel.create({
    expectedInputs: [{ type: "text", languages }],
    expectedOutputs: [{ type: "text", languages }],
    initialPrompts: systemPrompt ? [{ role: "system", content: systemPrompt }] : [],
    monitor(m) {
      m.addEventListener("downloadprogress", (e) => {
        const pct = Math.max(0, Math.min(100, Math.round((e.loaded ?? 0) * 100)));
        onDownload?.(pct);
      });
    }
  });
}

// Stream a prompt; onChunk(fullSoFar, delta) as text arrives.
export async function streamPrompt(session, prompt, onChunk) {
  const stream = session.promptStreaming(prompt);
  let full = "";
  for await (const chunk of stream) {
    full += chunk;
    onChunk?.(full, chunk);
  }
  return full;
}

// Best-effort token accounting; not all builds expose these.
export function sessionUsage(session) {
  if (!session) return null;
  const used = session.inputUsage;
  const quota = session.inputQuota;
  if (typeof used !== "number" || typeof quota !== "number") return null;
  return { used, quota };
}
