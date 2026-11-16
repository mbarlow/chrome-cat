// Settings: model status, all-sites grant, crawl caps, storage usage, wipe.

import { hasAllUrls, requestAllUrls } from "../../capture/permissions.js";
import { getSettings, saveSettings, resetSystemPrompt } from "../../shared/constants.js";
import { DEFAULT_SYSTEM_BASE } from "../../ai/prompts.js";
import { clearAll } from "../../db/db.js";
import { terminate } from "../../ocr/tesseract-engine.js";
import { inputStatus, installInput } from "../../voice/input.js";
import { speak, stopSpeech } from "../../voice/speech.js";

export function createSettingsView(root, ctx) {
  root.innerHTML = `
    <div class="label">model</div>
    <div class="setrow">
      <label>Chrome built-in model (Gemini Nano)</label>
      <button id="modelHelp" class="mini">on-device internals</button>
    </div>
    <div class="label">voice conversation</div>
    <div class="setrow">
      <label for="voiceEnabled">Enable voice mode and spoken replies</label>
      <input type="checkbox" id="voiceEnabled" />
    </div>
    <div class="setrow">
      <label for="voiceName">Cat's voice</label>
      <select id="voiceName"><option value="F2">Female</option><option value="M2">Male</option></select>
      <button id="voicePreview" class="mini">Preview</button>
      <button id="voicePreviewStop" class="mini">Stop</button>
    </div>
    <p class="muted voice-help">English only. Speech stays on this device. Start conversation in Chat to listen,
      answer, and listen again. The microphone pauses while the cat speaks. Typing is always available.</p>
    <div class="setrow">
      <label>Local English voice input</label>
      <button id="voiceSetup" class="mini">Set up</button>
    </div>
    <p id="voiceSetupStatus" class="muted voice-help" role="status"></p>
    <p id="voicePreviewStatus" class="muted voice-help" role="status"></p>
    <div class="label">permissions</div>
    <div class="setrow">
      <label id="permLabel">all-sites access (needed for crawling)</label>
      <button id="permBtn" class="mini">grant</button>
    </div>
    <div class="label">chat system prompt</div>
    <textarea id="sysPrompt" rows="6" spellcheck="false"></textarea>
    <div class="setrow" style="margin-top:6px">
      <label class="muted" id="sysPromptState"></label>
      <button id="sysPromptSave" class="mini">save</button>
      <button id="sysPromptReset" class="mini">reset to default</button>
    </div>
    <div class="label">crawl</div>
    <div class="setrow">
      <label for="maxLinks">max links per crawl</label>
      <input type="number" id="maxLinks" min="1" max="100" />
    </div>
    <div class="setrow">
      <label for="sameDomain">same-domain links only</label>
      <input type="checkbox" id="sameDomain" />
    </div>
    <div class="label">webhooks</div>
    <div class="muted" style="font-size:11px;margin-bottom:6px">
      "send the summary to &lt;name&gt;" POSTs JSON {title, url, kind, content}.
      localhost works out of the box; remote URLs need the all-sites grant.
    </div>
    <div id="hookList"></div>
    <div class="setrow">
      <input type="text" id="hookName" placeholder="name (e.g. vault)" style="flex:1" />
      <input type="text" id="hookUrl" placeholder="http://localhost:8787/inbox" style="flex:2" />
      <button id="hookAdd" class="mini">add</button>
    </div>
    <div class="label">storage</div>
    <div class="setrow"><label id="storageLabel">…</label></div>
    <div class="setrow">
      <label>delete all captures, tiles, series, chats</label>
      <button id="wipeBtn" class="mini danger">clear all</button>
    </div>
  `;

  const $ = (id) => root.querySelector(`#${id}`);

  async function refresh() {
    const granted = await hasAllUrls();
    $("permLabel").textContent = granted
      ? "all-sites access: granted"
      : "all-sites access (needed for crawling)";
    $("permBtn").hidden = granted;

    const s = await getSettings();
    $("maxLinks").value = s.maxLinks;
    $("sameDomain").checked = s.sameDomainOnly;
    $("voiceEnabled").checked = s.voiceEnabled;
    $("voiceName").value = s.voiceName;
    $("sysPrompt").value = s.systemPrompt ?? DEFAULT_SYSTEM_BASE;
    $("sysPromptState").textContent = s.systemPrompt ? "custom" : "default";
    renderHooks(s.webhooks);

    if (navigator.storage?.estimate) {
      const { usage = 0, quota = 0 } = await navigator.storage.estimate();
      const mb = (n) => (n / 1048576).toFixed(1);
      $("storageLabel").textContent = `using ${mb(usage)} MB of ${mb(quota)} MB`;
    } else {
      $("storageLabel").textContent = "storage estimate unavailable";
    }
  }

  async function persist() {
    await saveSettings({
      maxLinks: Math.max(1, Math.min(100, Number($("maxLinks").value) || 20)),
      sameDomainOnly: $("sameDomain").checked
    });
    ctx.toast("Settings saved.");
  }

  function renderHooks(webhooks) {
    const list = $("hookList");
    list.replaceChildren();
    for (const [i, w] of webhooks.entries()) {
      const row = document.createElement("div");
      row.className = "setrow";
      const label = document.createElement("label");
      label.textContent = `${w.name} → ${w.url}`;
      label.style.wordBreak = "break-all";
      const del = document.createElement("button");
      del.className = "mini danger";
      del.textContent = "×";
      del.addEventListener("click", async () => {
        const next = webhooks.filter((_, j) => j !== i);
        await saveSettings({ webhooks: next });
        renderHooks(next);
      });
      row.append(label, del);
      list.append(row);
    }
  }

  $("hookAdd").addEventListener("click", async () => {
    const name = $("hookName").value.trim();
    const url = $("hookUrl").value.trim();
    if (!name || !/^https?:\/\//.test(url)) {
      ctx.toast("Webhook needs a name and an http(s) URL.");
      return;
    }
    const { webhooks } = await getSettings();
    if (webhooks.some((w) => w.name.toLowerCase() === name.toLowerCase())) {
      ctx.toast(`Webhook "${name}" already exists.`);
      return;
    }
    const next = [...webhooks, { name, url }];
    await saveSettings({ webhooks: next });
    $("hookName").value = $("hookUrl").value = "";
    renderHooks(next);
    ctx.toast(`Webhook "${name}" added — try: send the summary to ${name}`);
  });

  $("modelHelp").addEventListener("click", () => {
    chrome.tabs.create({ url: "chrome://on-device-internals" });
  });
  $("permBtn").addEventListener("click", async () => {
    await requestAllUrls().catch(() => {});
    refresh();
  });
  $("maxLinks").addEventListener("change", persist);
  $("sameDomain").addEventListener("change", persist);
  $("voiceEnabled").addEventListener("change", async () => {
    stopSpeech();
    await saveSettings({ voiceEnabled: $("voiceEnabled").checked });
  });
  $("voiceName").addEventListener("change", async () => {
    stopSpeech();
    await saveSettings({ voiceName: $("voiceName").value });
  });
  $("voicePreview").addEventListener("click", async () => {
    $("voicePreview").disabled = true;
    try {
      await speak("Hello! I'm Chrome Cat. What would you like to know about this page?", $("voiceName").value,
        text => { $("voicePreviewStatus").textContent = text; });
      $("voicePreviewStatus").textContent = "Preview finished.";
    } catch (error) {
      $("voicePreviewStatus").textContent = error.name === "AbortError" ? "Preview stopped." : error.message;
    } finally { $("voicePreview").disabled = false; }
  });
  $("voicePreviewStop").addEventListener("click", stopSpeech);
  $("voiceSetup").addEventListener("click", async () => {
    $("voiceSetup").disabled = true;
    const status = $("voiceSetupStatus");
    status.textContent = "Checking local English recognition…";
    try {
      const available = await inputStatus();
      if (available === "unavailable") throw new Error("Local English recognition isn't supported here. Update Chrome; typing with spoken replies still works.");
      if (available !== "available") {
        status.textContent = "Downloading Chrome's English language pack. This needs an internet connection once…";
        if (!await installInput()) throw new Error("Language pack download did not finish. Try Set up again.");
      }
      status.textContent = "Local voice input is ready. Return to Chat and press Start conversation.";
    } catch (error) { status.textContent = error.message; }
    finally { $("voiceSetup").disabled = false; }
  });

  // Applies on the next session build — destroy the live one so the change
  // takes effect on the next question, not the next scope switch.
  async function applySysPrompt(value) {
    if (value === null || value.trim() === "" || value.trim() === DEFAULT_SYSTEM_BASE) {
      await resetSystemPrompt();
    } else {
      await saveSettings({ systemPrompt: value.trim() });
    }
    ctx.session.destroy();
    await refresh();
    ctx.toast("System prompt updated — applies to the next question.");
  }
  $("sysPromptSave").addEventListener("click", () => applySysPrompt($("sysPrompt").value));
  $("sysPromptReset").addEventListener("click", () => applySysPrompt(null));
  $("wipeBtn").addEventListener("click", async () => {
    if (!confirm("Delete ALL stored captures, tiles, series, and chats?")) return;
    await terminate();
    await clearAll();
    ctx.session.destroy();
    ctx.setScope(null);
    ctx.toast("All local data cleared.");
    refresh();
  });

  document.querySelector('#tabs [data-tab="settings"]').addEventListener("click", refresh);
  refresh();

  return { refresh };
}
