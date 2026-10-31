// Sidepanel bootstrap: AI pill, tabs, shared ctx, view wiring (chrome-xray
// router pattern). Scope = what the chat is about: one capture or a series.

import { ChatSessionManager } from "../ai/session-manager.js";
import { createModelStatus } from "./model-status.js";
import { purgeStubOutput } from "../db/cleanup.js";
import { Mascot, loadMascotConfig } from "../mascot/mascot.js";
import { createChatView } from "./views/chat.js";
import { createArtifactsView } from "./views/artifacts.js";
import { createMemoryView } from "./views/memory.js";
import { createSettingsView } from "./views/settings.js";

const state = {
  scope: null, // { type: "capture", captureId } | { type: "series", seriesId }
  listeners: new Set()
};

const toastEl = document.getElementById("toast");
let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2500);
}

function setScope(scope) {
  state.scope = scope;
  for (const cb of state.listeners) cb(scope);
}

function showView(name) {
  for (const t of document.querySelectorAll("#tabs .tab")) {
    t.classList.toggle("active", t.dataset.tab === name);
  }
  for (const v of document.querySelectorAll(".view")) {
    v.classList.toggle("active", v.id === `view-${name}`);
  }
}

// ---- model status ----
const model = createModelStatus({
  dot: document.getElementById("aiDot"),
  text: document.getElementById("aiStatus"),
  bar: document.getElementById("aiBar"),
  fill: document.getElementById("aiFill"),
  button: document.getElementById("aiAction"),
  onPhase: (p) => ctx.cat(p === "loading" ? "working" : "idle")
});
const refreshAi = model.refresh;
const showDownload = model.showDownload;

// ---- tabs ----
for (const tab of document.querySelectorAll("#tabs .tab")) {
  tab.addEventListener("click", () => showView(tab.dataset.tab));
}

// ---- shared ctx ----
const ctx = {
  toast,
  setScope,
  getScope: () => state.scope,
  onScopeChange: (cb) => state.listeners.add(cb),
  session: new ChatSessionManager(),
  refreshAi,
  showDownload,
  showView,
  // Mascot loads async; cat() is safe to call before it's ready.
  mascot: null,
  cat: (s) => ctx.mascot?.setState(s)
};

loadMascotConfig()
  .then((cfg) => { ctx.mascot = new Mascot(document.getElementById("mascotCanvas"), cfg); })
  .catch((e) => console.warn("mascot disabled:", e?.message || e));

createChatView(document.getElementById("view-chat"), ctx);
createArtifactsView(document.getElementById("view-artifacts"), ctx);
createMemoryView(document.getElementById("view-memory"), ctx);
createSettingsView(document.getElementById("view-settings"), ctx);

// ---- worker handoff: omnibox jumps land in chrome.storage.session;
// pick them up on open and while open ----

async function applyPending() {
  const { pendingScope } = await chrome.storage.session.get("pendingScope");
  if (!pendingScope) return;
  await chrome.storage.session.remove("pendingScope");
  if (pendingScope.type === "capture") {
    setScope({ type: "capture", captureId: pendingScope.captureId });
  } else {
    setScope({ type: "memory" });
    if (pendingScope.query) ctx.prefill?.(pendingScope.query);
  }
  showView("chat");
}

chrome.storage.session.onChanged.addListener(() => { applyPending(); });

refreshAi();
applyPending();
purgeStubOutput()
  .then(({ summaries, messages }) => {
    if (summaries + messages) {
      toast(`Removed placeholder-model output: ${summaries} summaries, ${messages} replies.`);
    }
  })
  .catch((e) => console.warn("cleanup skipped:", e?.message || e));
