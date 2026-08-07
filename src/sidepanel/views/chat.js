// Chat view: scan/crawl controls, series strip, streaming chat scoped to the
// current capture or series. "/follow" in the composer triggers the crawler.

import { capturePage } from "../../capture/pipeline.js";
import { hasAllUrls, requestAllUrls } from "../../capture/permissions.js";
import { runCrawl, selectLinks } from "../../crawl/crawler.js";
import { getCapture } from "../../db/captures.js";
import { getSeries } from "../../db/series.js";
import { getOrCreateChat, appendMessage } from "../../db/chats.js";
import { getSettings } from "../../shared/constants.js";
import { escapeHtml } from "../../shared/text.js";

const PHASE_LABEL = {
  scan: "capturing frames",
  stitch: "slicing tiles",
  ocr: "OCR",
  summary: "summarizing"
};

export function createChatView(root, ctx) {
  root.innerHTML = `
    <div class="scopebar" id="scopebar"><span class="muted">No page scanned yet — hit Scan on any page.</span></div>
    <div class="strip" id="strip" hidden>
      <button class="mini" id="prevBtn">◀</button>
      <span class="pos" id="stripPos"></span>
      <span class="t" id="stripTitle"></span>
      <button class="mini" id="allBtn" title="Chat across the whole series">all</button>
      <button class="mini" id="nextBtn">▶</button>
    </div>
    <div class="actions">
      <button class="primary" id="scanBtn">Scan page</button>
      <button id="followBtn" disabled>Follow links</button>
      <button id="cancelBtn" class="danger" hidden>Cancel</button>
    </div>
    <div class="progress" id="progress" hidden>
      <span id="progressText"></span>
      <div class="track"><div class="fill" id="progressFill"></div></div>
    </div>
    <div class="msgs" id="msgs"></div>
    <div class="composer">
      <textarea id="input" placeholder="Ask about this page… (/follow crawls its links)"></textarea>
      <button class="primary" id="sendBtn">▶</button>
    </div>
    <div class="usage" id="usage"></div>
  `;

  const $ = (id) => root.querySelector(`#${id}`);
  const view = {
    capture: null,   // current capture row (capture scope)
    series: null,    // series row when navigating a series
    captures: [],    // series member rows (series scope)
    crawlControl: null,
    busy: false
  };

  // ---- rendering ----

  function setBusy(b) {
    view.busy = b;
    $("scanBtn").disabled = b;
    $("followBtn").disabled = b || !view.capture || view.capture.status !== "ready" || !view.capture.links?.length;
    $("sendBtn").disabled = b;
  }

  function progress(label, done, total) {
    const el = $("progress");
    el.hidden = false;
    $("progressText").textContent = `${label} — ${Math.floor(done)}/${total}`;
    $("progressFill").style.width = `${Math.min(100, (done / Math.max(1, total)) * 100)}%`;
  }
  const hideProgress = () => { $("progress").hidden = true; };
  const onPhase = (phase, done, total) => progress(PHASE_LABEL[phase] || phase, done, total);

  function renderScopebar() {
    const bar = $("scopebar");
    const scope = ctx.getScope();
    if (!scope) {
      bar.innerHTML = `<span class="muted">No page scanned yet — hit Scan on any page.</span>`;
      return;
    }
    if (scope.type === "capture" && view.capture) {
      const c = view.capture;
      bar.innerHTML = `<div class="title">${escapeHtml(c.title)}</div><div class="url">${escapeHtml(c.url)} · ${c.tileCount} tiles · ${c.status}</div>`;
    } else if (scope.type === "series" && view.series) {
      bar.innerHTML = `<div class="title">series: ${escapeHtml(view.series.name)}</div><div class="url">${view.captures.length} pages from ${escapeHtml(view.series.domain)}</div>`;
    }
  }

  function renderStrip() {
    const strip = $("strip");
    const scope = ctx.getScope();
    if (scope?.type === "series" && view.series) {
      strip.hidden = false;
      $("stripPos").textContent = `all ${view.captures.length}`;
      $("stripTitle").textContent = "whole series";
      $("prevBtn").disabled = $("nextBtn").disabled = false;
      return;
    }
    if (scope?.type === "capture" && view.capture?.seriesId && view.series) {
      const ids = view.series.captureIds;
      const i = ids.indexOf(view.capture.id);
      strip.hidden = false;
      $("stripPos").textContent = `${i + 1}/${ids.length}`;
      $("stripTitle").textContent = view.capture.title;
      $("prevBtn").disabled = i <= 0;
      $("nextBtn").disabled = i >= ids.length - 1;
      return;
    }
    strip.hidden = true;
  }

  function msgEl(role, content) {
    const div = document.createElement("div");
    div.className = `msg ${role}`;
    div.textContent = content;
    $("msgs").appendChild(div);
    $("msgs").scrollTop = $("msgs").scrollHeight;
    return div;
  }

  async function renderHistory() {
    $("msgs").replaceChildren();
    const scope = ctx.getScope();
    if (!scope) return;
    const id = scope.type === "capture" ? scope.captureId : scope.seriesId;
    const chat = await getOrCreateChat(scope.type, id);
    for (const m of chat.messages) msgEl(m.role, m.content);
  }

  function renderUsage() {
    const u = ctx.session.usage();
    $("usage").textContent = u ? `context ${u.used}/${u.quota}` : "";
  }

  // ---- scope loading ----

  async function loadScope() {
    const scope = ctx.getScope();
    view.capture = view.series = null;
    view.captures = [];
    if (scope?.type === "capture") {
      view.capture = await getCapture(scope.captureId);
      if (view.capture?.seriesId) view.series = await getSeries(view.capture.seriesId);
      if (view.capture) {
        ctx.session.setScope({ type: "capture", capture: view.capture });
      }
    } else if (scope?.type === "series") {
      view.series = await getSeries(scope.seriesId);
      if (view.series) {
        view.captures = (await Promise.all(view.series.captureIds.map(getCapture))).filter(Boolean);
        ctx.session.setScope({ type: "series", series: view.series, captures: view.captures });
      }
    }
    renderScopebar();
    renderStrip();
    renderUsage();
    setBusy(view.busy);
    await renderHistory();
  }

  ctx.onScopeChange(loadScope);

  // ---- scan ----

  async function scan() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/^https?:/.test(tab.url || "")) {
      ctx.toast("Can't scan this page (needs http/https).");
      return;
    }
    // Ask for <all_urls> once, inside the gesture; activeTab may already cover
    // the current tab, so a denial isn't fatal here.
    if (!(await hasAllUrls())) await requestAllUrls().catch(() => {});
    setBusy(true);
    try {
      const capture = await capturePage(tab.id, tab.windowId, { onPhase });
      ctx.setScope({ type: "capture", captureId: capture.id });
      ctx.toast(`Scanned: ${capture.tileCount} tiles.`);
    } catch (err) {
      ctx.toast(`Scan failed: ${err?.message || err}`);
    } finally {
      hideProgress();
      setBusy(false);
    }
  }

  // ---- crawl ----

  async function followLinks() {
    const capture = view.capture;
    if (!capture || capture.status !== "ready") {
      ctx.toast("Scan a page first, then follow its links.");
      return;
    }
    if (!(await hasAllUrls())) {
      const granted = await requestAllUrls().catch(() => false);
      if (!granted) {
        ctx.toast("Crawling needs the all-sites permission.");
        return;
      }
    }
    const settings = await getSettings();
    const links = selectLinks(capture, {
      sameDomainOnly: settings.sameDomainOnly,
      maxLinks: settings.maxLinks
    });
    if (!links.length) {
      ctx.toast("No crawlable links on this page (check same-domain setting).");
      return;
    }
    msgEl("note", `following ${links.length} links from ${capture.domain}…`);
    view.crawlControl = { cancelled: false };
    $("cancelBtn").hidden = false;
    setBusy(true);
    try {
      const series = await runCrawl(capture, links, view.crawlControl, {
        onProgress: (p) => progress(`crawl ${p.currentUrl || ""}`, p.done, p.total),
        onPhase
      });
      const errs = series.progress.errors.length;
      msgEl("note", `series ${series.status}: ${series.captureIds.length} pages${errs ? `, ${errs} failed` : ""}`);
      ctx.setScope({ type: "series", seriesId: series.id });
    } catch (err) {
      ctx.toast(`Crawl failed: ${err?.message || err}`);
    } finally {
      $("cancelBtn").hidden = true;
      view.crawlControl = null;
      hideProgress();
      setBusy(false);
    }
  }

  // ---- series navigation ----

  function step(delta) {
    if (!view.series) return;
    const ids = view.series.captureIds;
    const scope = ctx.getScope();
    if (scope.type === "series") {
      // stepping out of "all" mode lands on the first/last page
      const i = delta > 0 ? 0 : ids.length - 1;
      ctx.setScope({ type: "capture", captureId: ids[i] });
      return;
    }
    const i = ids.indexOf(scope.captureId) + delta;
    if (i >= 0 && i < ids.length) ctx.setScope({ type: "capture", captureId: ids[i] });
  }

  // ---- send ----

  async function send() {
    const input = $("input");
    const question = input.value.trim();
    if (!question || view.busy) return;
    input.value = "";

    if (/^\/follow\b/i.test(question) || /^follow (the )?links\b/i.test(question)) {
      await followLinks();
      return;
    }

    const scope = ctx.getScope();
    if (!scope) {
      ctx.toast("Scan a page first.");
      return;
    }
    const scopeId = scope.type === "capture" ? scope.captureId : scope.seriesId;
    msgEl("user", question);
    await appendMessage(scope.type, scopeId, { role: "user", content: question });

    const bubble = msgEl("assistant", "…");
    setBusy(true);
    try {
      const { answer, trimmed } = await ctx.session.ask(question, {
        onChunk: (full) => {
          bubble.textContent = full;
          $("msgs").scrollTop = $("msgs").scrollHeight;
        },
        onDownload: ctx.showDownload
      });
      if (trimmed) msgEl("note", "context trimmed — session rebuilt");
      await appendMessage(scope.type, scopeId, { role: "assistant", content: answer });
    } catch (err) {
      bubble.textContent = `⚠ ${err?.message || err}`;
      bubble.classList.add("note");
    } finally {
      renderUsage();
      setBusy(false);
    }
  }

  // ---- wiring ----
  $("scanBtn").addEventListener("click", scan);
  $("followBtn").addEventListener("click", followLinks);
  $("cancelBtn").addEventListener("click", () => {
    if (view.crawlControl) view.crawlControl.cancelled = true;
    ctx.toast("Cancelling after current page…");
  });
  $("prevBtn").addEventListener("click", () => step(-1));
  $("nextBtn").addEventListener("click", () => step(1));
  $("allBtn").addEventListener("click", () => {
    if (view.series) ctx.setScope({ type: "series", seriesId: view.series.id });
  });
  $("sendBtn").addEventListener("click", send);
  $("input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  return { refresh: loadScope };
}
