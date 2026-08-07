// Sidepanel bootstrap: AI pill, tabs, shared ctx, view wiring (chrome-xray
// router pattern). Scope = what the chat is about: one capture or a series.

import { getAiAvailability } from "../ai/language-model.js";
import { ChatSessionManager } from "../ai/session-manager.js";
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

// ---- AI availability pill ----
const aiDot = document.getElementById("aiDot");
const aiStatus = document.getElementById("aiStatus");

async function refreshAi() {
  aiDot.className = "dot";
  aiStatus.textContent = "checking model…";
  const { state: s, reason } = await getAiAvailability();
  const map = {
    available: ["ok", "model ready"],
    downloadable: ["warn", "model downloadable — first use will fetch it"],
    downloading: ["warn", "model downloading…"],
    unavailable: ["bad", "model unavailable on this device"],
    missing: ["bad", reason || "LanguageModel missing (Chrome 138+ required)"]
  };
  const [cls, text] = map[s] || ["bad", s];
  aiDot.classList.add(cls);
  aiStatus.textContent = text;
  aiStatus.title = reason || text;
  return s;
}

function showDownload(pct) {
  aiDot.className = "dot warn";
  aiStatus.textContent = `model downloading… ${pct}%`;
  if (pct >= 100) refreshAi();
}

document.getElementById("aiCheck").addEventListener("click", refreshAi);

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
