// Header model status: checking → downloading → loading → ready, with a
// progress bar and one action button. Ready is only claimed after a real
// probe answer, so placeholder backends surface here instead of in chat.

import { getAiAvailability, createAiSession, probeModel } from "../ai/language-model.js";

const POLL_MS = 3000;

export function createModelStatus({ dot, text, bar, fill, button, onPhase }) {
  let run = 0;
  let pollTimer = null;
  let downloading = false;
  let available = false;

  function render(cls, label, { pct = null, busy = false, action = null } = {}) {
    dot.className = `dot ${cls}`;
    text.textContent = label;
    text.title = label;
    bar.hidden = pct === null && !busy;
    bar.classList.toggle("indeterminate", busy && pct === null);
    fill.style.width = pct === null ? "" : `${pct}%`;
    button.hidden = !action;
    button.textContent = action || "";
  }

  function poll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(refresh, POLL_MS);
  }

  async function refresh() {
    clearTimeout(pollTimer);
    const id = ++run;
    if (!downloading) render("", "checking model…");
    const { state, reason } = await getAiAvailability();
    if (id !== run) return state;
    available = state === "available";

    if (state === "downloadable") {
      render("warn", "model not downloaded (~3 GB)", { action: "download" });
    } else if (state === "downloading") {
      if (!downloading) render("warn", "model downloading in the background…", { busy: true });
      poll();
    } else if (state === "available") {
      render("warn", "loading model into memory…", { busy: true });
      onPhase?.("loading");
      const probe = await probeModel();
      if (id !== run) return state;
      if (probe.ok) render("ok", "model ready");
      else render("bad", probe.reason, { action: "re-check" });
      onPhase?.(probe.ok ? "ready" : "failed");
      return probe.ok ? state : "unavailable";
    } else if (state === "unavailable") {
      render("bad", "model unavailable on this device", { action: "re-check" });
    } else {
      render("bad", reason || "LanguageModel missing (Chrome 138+ required)", { action: "re-check" });
    }
    return state;
  }

  // Progress from any LanguageModel.create() monitor. 100% means downloaded,
  // not loaded — the model still has to unpack and load before answering.
  // Chrome emits 0%/100% even for a cached model, so ignore it once available.
  function showDownload(pct) {
    if (available) return;
    run++;
    downloading = pct < 100;
    if (pct < 100) render("warn", `downloading model… ${pct}%`, { pct });
    else {
      render("warn", "download done — loading model…", { busy: true });
      poll();
    }
  }

  // Download needs a user gesture, so it only starts from the button.
  async function download() {
    downloading = true;
    showDownload(0);
    try {
      const session = await createAiSession({ onDownload: showDownload });
      session.destroy?.();
    } catch (err) {
      render("bad", `download failed: ${err?.message || err}`, { action: "re-check" });
      return;
    } finally {
      downloading = false;
    }
    refresh();
  }

  button.addEventListener("click", () => {
    if (button.textContent === "download") download();
    else refresh();
  });

  return { refresh, showDownload };
}
