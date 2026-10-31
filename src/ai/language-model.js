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
// onDownload(pct). Must follow a user gesture. sampling { temperature, topK }
// is applied only where the build exposes LanguageModel.params().
export async function createAiSession({ systemPrompt, languages = ["en"], onDownload, sampling } = {}) {
  if (typeof LanguageModel === "undefined") {
    throw new Error("LanguageModel global is not available.");
  }
  const tuned = sampling && await LanguageModel.params?.().catch(() => null) ? sampling : {};
  return LanguageModel.create({
    ...tuned,
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

// Open-source Chromium builds (e.g. Arch's) ship a placeholder on-device
// backend: it "answers" with its own config lines plus the echoed prompt.
const STUB_OUTPUT = /^(CPU|GPU) backend|Fastest inference|TopK: \d+, Temp:/;

export const STUB_MESSAGE =
  "this browser build has a placeholder model, not Gemini Nano — use Google Chrome";

export function isStubOutput(text) {
  return STUB_OUTPUT.test(String(text ?? ""));
}

// Throws when text came from the placeholder backend; returns it otherwise.
export function assertRealOutput(text) {
  if (isStubOutput(text)) throw new Error(STUB_MESSAGE);
  return text;
}

// Create a throwaway session and ask for one word. Resolves { ok, reason? }.
// Doubles as the warm-up that loads the model into memory.
export async function probeModel() {
  const session = await createAiSession();
  try {
    assertRealOutput(await session.prompt("Reply with the single word: ready"));
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  } finally {
    try { session.destroy?.(); } catch { /* ignore */ }
  }
}

// Stream a prompt; onChunk(fullSoFar, delta) as text arrives. Stub output is
// caught on the first chunk, before it reaches the chat bubble.
export async function streamPrompt(session, prompt, onChunk) {
  const stream = session.promptStreaming(prompt);
  let full = "";
  for await (const chunk of stream) {
    full += chunk;
    assertRealOutput(full);
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
