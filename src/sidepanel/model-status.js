// Header model status: checking → downloading → loading → ready, with a
// progress bar and one action button. Ready is only claimed after a real
// probe answer, so placeholder backends surface here instead of in chat.

import { getAiAvailability, createAiSession, probeModel } from "../ai/language-model.js";

const POLL_MS = 3000;
const STALL_MS = 60_000;

export function createModelStatus({ dot, text, bar, fill, button, onPhase }) {
  let run = 0;
  let pollTimer = null;
  let downloading = false;
  let available = false;
  let progressTimer = null;
  let lastProgress = null;
  let lastPercent = null;
  let actionName = null;

  function clearProgress() {
    clearTimeout(progressTimer);
    progressTimer = null;
    lastProgress = lastPercent = null;
  }

  function renderDownload() {
    const stalled = Date.now() - lastProgress >= STALL_MS;
    const label = lastPercent === null
      ? "Gemini Nano: Chrome reports downloading…"
      : lastPercent < 100 ? `downloading Gemini Nano… ${lastPercent}%`
        : "download done — loading Gemini Nano…";
    render("warn", stalled ? "Gemini Nano: no progress reported for 60 seconds" : label, {
      pct: lastPercent !== null && lastPercent < 100 ? lastPercent : null,
      busy: !stalled,
      action: stalled ? "diagnostics" : downloading ? null : "show progress"
    });
  }

  function trackProgress(pct = null) {
    if (lastProgress === null || (pct !== null && (lastPercent === null || pct > lastPercent))) {
      lastProgress = Date.now();
      clearTimeout(progressTimer);
      progressTimer = setTimeout(renderDownload, STALL_MS);
    }
    if (pct !== null) lastPercent = pct;
    renderDownload();
  }

  function render(cls, label, { pct = null, busy = false, action = null } = {}) {
    dot.className = `dot ${cls}`;
    text.textContent = label;
    text.title = label;
    bar.hidden = pct === null && !busy;
    bar.classList.toggle("indeterminate", busy && pct === null);
    fill.style.width = pct === null ? "" : `${pct}%`;
    button.hidden = !action;
    button.textContent = action || "";
    actionName = action;
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
    if (state !== "downloading") clearProgress();

    if (state === "downloadable") {
      render("warn", "Gemini Nano needs a download", { action: "download" });
    } else if (state === "downloading") {
      trackProgress();
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
    trackProgress(pct);
    if (pct >= 100) {
      poll();
    }
  }

  // Download needs a user gesture, so it only starts from the button.
  async function download() {
    if (downloading) return;
    clearTimeout(pollTimer);
    downloading = true;
    // Don't invent 0%: show a percentage only after Chrome reports one.
    trackProgress();
    try {
      const session = await createAiSession({ onDownload: showDownload });
      session.destroy?.();
    } catch (err) {
      clearProgress();
      render("bad", `download failed: ${err?.message || err}`, { action: "re-check" });
      return;
    } finally {
      downloading = false;
    }
    refresh();
  }

  button.addEventListener("click", () => {
    if (actionName === "diagnostics") chrome.tabs.create({ url: "chrome://on-device-internals/" });
    else if (actionName === "download" || actionName === "show progress") download();
    else refresh();
  });

  window.addEventListener("pagehide", () => {
    run++;
    clearTimeout(pollTimer);
    clearProgress();
  });

  return { refresh, showDownload };
}
