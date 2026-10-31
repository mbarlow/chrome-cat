// Chat view: scan/crawl controls, series strip, streaming chat scoped to the
// current capture or series. "/follow" in the composer triggers the crawler.

import { capturePage } from "../../capture/pipeline.js";
import { hasAllUrls, requestAllUrls } from "../../capture/permissions.js";
import { runCrawl, selectLinks } from "../../crawl/crawler.js";
import { getCapture, getTiles, getFirstTile, listCaptures, getCaptureByUrl } from "../../db/captures.js";
import { getSeries } from "../../db/series.js";
import { getOrCreateChat, appendMessage } from "../../db/chats.js";
import { answerAboutTiles } from "../../ai/vision.js";
import { parseSendCommand, parsePayloadKind, dispatchSend } from "../../actions/send.js";
import { smartBookmark } from "../../actions/bookmark.js";
import { historyCaptures, bookmarkCaptures } from "../../sources/browser.js";
import { getSettings, MAX_VISION_TILES, CRAWL_TIMEOUT_MS, CRAWL_SETTLE_MS } from "../../shared/constants.js";
import { escapeHtml, tokenize, plural } from "../../shared/text.js";
import { renderMarkdown } from "../../shared/markdown.js";
import { normalizeUrl } from "../../shared/url.js";

const VISION_INTENT = /\b(images?|pictures?|photos?|photographs?|paintings?|painted|artworks?|portraits?|illustrations?|drawings?|screenshots?|charts?|graphs?|diagrams?|logos?|icons?|layout|visual(ly)?|colou?rs?|design|looks? like|recogni[sz]e|pictured|(can|do) you see|what do you see)\b/i;

// One chat thread per scope; memory/history/bookmarks each share thread id 0.
function scopeIdOf(scope) {
  if (scope.type === "capture") return scope.captureId;
  if (scope.type === "series") return scope.seriesId;
  return 0;
}

const BOOKMARK_INTENT = /^\/?bookmark\b/i;
const NAV_INTENT = /^(?:\/open\s*|(?:can you |could you |please )*(?:open|go to|goto|visit|navigate to|take me to)\b)/i;
const PRONOUNS = new Set(["it", "that", "this", "them", "there"]);
const URL_RE = /https?:\/\/[^\s)"'\]]+/g;

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
      <button id="dlChatBtn" class="ghost" title="Save this chat as markdown">⤓ chat</button>
      <button id="cancelBtn" class="danger" hidden>Cancel</button>
    </div>
    <div class="progress" id="progress" hidden>
      <span id="progressText"></span>
      <div class="track"><div class="fill" id="progressFill"></div></div>
    </div>
    <div class="msgs" id="msgs"></div>
    <div class="composer">
      <textarea id="input" placeholder="Ask about this page… (/follow crawls links · 'open the pricing page' navigates + scans)"></textarea>
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
    busy: false,
    thumbUrl: null   // scopebar thumbnail blob URL, revoked on re-render
  };

  // ---- rendering ----

  function setBusy(b) {
    view.busy = b;
    $("scanBtn").disabled = b;
    $("followBtn").disabled = b || !view.capture || view.capture.status !== "ready" || !view.capture.links?.length;
    $("dlChatBtn").disabled = b || !ctx.getScope();
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

  async function renderScopebar() {
    const bar = $("scopebar");
    const scope = ctx.getScope();
    if (view.thumbUrl) {
      URL.revokeObjectURL(view.thumbUrl);
      view.thumbUrl = null;
    }
    if (!scope) {
      bar.innerHTML = `<span class="muted">No page scanned yet — hit Scan on any page.</span>`;
      return;
    }
    let text = "";
    if (scope.type === "capture" && view.capture) {
      const c = view.capture;
      text = `<div class="title">${escapeHtml(c.title)}</div><div class="url">${escapeHtml(c.url)} · ${plural(c.tileCount, "tile")} · ${c.status}</div>`;
    } else if (scope.type === "series" && view.series) {
      text = `<div class="title">series: ${escapeHtml(view.series.name)}</div><div class="url">${view.captures.length} pages from ${escapeHtml(view.series.domain)}</div>`;
    } else if (scope.type === "memory") {
      const domains = new Set(view.captures.map((c) => c.domain));
      text = `<div class="title">memory: everything captured</div><div class="url">${view.captures.length} pages across ${domains.size} domains</div>`;
    } else if (scope.type === "history") {
      text = `<div class="title">history: ${escapeHtml(scope.label || "recent")}</div><div class="url">${view.captures.length} pages from your browsing history</div>`;
    } else if (scope.type === "bookmarks") {
      text = `<div class="title">bookmarks</div><div class="url">${view.captures.length} bookmarked pages</div>`;
    }
    bar.innerHTML = `<div class="scopetext">${text}</div>`;

    // First-tile thumbnail for scopes that have real scans.
    const thumbSource = scope.type === "capture" ? view.capture
      : scope.type === "series" ? view.captures.find((c) => c.tileCount > 0)
      : null;
    if (!thumbSource) return;
    const tile = await getFirstTile(thumbSource.id).catch(() => null);
    if (!tile?.blob || ctx.getScope() !== scope) return; // scope moved on
    view.thumbUrl = URL.createObjectURL(tile.blob);
    const img = document.createElement("img");
    img.className = "thumb";
    img.src = view.thumbUrl;
    bar.prepend(img);
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

  function setAnswer(el, text) {
    el.innerHTML = renderMarkdown(text);
  }

  function msgEl(role, content) {
    const div = document.createElement("div");
    div.className = `msg ${role}`;
    if (role === "assistant") setAnswer(div, content);
    else div.textContent = content;
    $("msgs").appendChild(div);
    $("msgs").scrollTop = $("msgs").scrollHeight;
    return div;
  }

  async function renderHistory() {
    $("msgs").replaceChildren();
    const scope = ctx.getScope();
    if (!scope) return;
    const chat = await getOrCreateChat(scope.type, scopeIdOf(scope));
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
    } else if (scope?.type === "memory") {
      view.captures = (await listCaptures(100)).filter((c) => c.status === "ready");
      ctx.session.setScope({ type: "memory", captures: view.captures });
    } else if (scope?.type === "history") {
      view.captures = await historyCaptures(scope.sinceMs);
      ctx.session.setScope({ type: "history", captures: view.captures, label: scope.label, excerptK: 8 });
    } else if (scope?.type === "bookmarks") {
      view.captures = await bookmarkCaptures();
      ctx.session.setScope({ type: "bookmarks", captures: view.captures, excerptK: 8 });
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
    ctx.cat("scanning");
    try {
      const capture = await capturePage(tab.id, tab.windowId, { onPhase });
      ctx.setScope({ type: "capture", captureId: capture.id });
      ctx.toast(`Scanned: ${plural(capture.tileCount, "tile")}.`);
    } catch (err) {
      ctx.toast(`Scan failed: ${err?.message || err}`);
    } finally {
      hideProgress();
      setBusy(false);
      ctx.cat("idle");
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
    ctx.cat("working");
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
      ctx.cat("idle");
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

    if (BOOKMARK_INTENT.test(question) && !/\?\s*$/.test(question)) {
      await bookmarkCurrent(question);
      return;
    }

    const sendCmd = parseSendCommand(question);
    if (sendCmd) {
      await handleSend(question, sendCmd);
      return;
    }

    if (NAV_INTENT.test(question)) {
      await navigate(question);
      return;
    }

    const scope = ctx.getScope();
    if (!scope) {
      ctx.toast("Scan a page first.");
      return;
    }
    const scopeId = scopeIdOf(scope);
    msgEl("user", question);
    await appendMessage(scope.type, scopeId, { role: "user", content: question });

    const bubble = msgEl("assistant", "…");
    setBusy(true);
    ctx.cat("replying");
    try {
      // Visual questions look at the stored scan tiles (capture scope only —
      // a whole series of images won't fit the model's quota).
      if (VISION_INTENT.test(question) && scope.type === "capture") {
        const done = await askVision(question, scope, bubble);
        if (done) return;
      }
      const { answer, trimmed } = await ctx.session.ask(question, {
        onChunk: (full) => {
          setAnswer(bubble, full);
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
      ctx.cat("idle");
    }
  }

  // ---- "/bookmark": file the current scope page in the right folder ----

  async function bookmarkCurrent(question) {
    const scope = ctx.getScope();
    msgEl("user", question);
    if (scope?.type !== "capture" || !view.capture) {
      msgEl("note", "bookmark works on a scanned page — scan one or step to it first");
      return;
    }
    await appendMessage("capture", scope.captureId, { role: "user", content: question });
    setBusy(true);
    ctx.cat("working");
    try {
      const note = await smartBookmark(view.capture);
      msgEl("note", note);
      await appendMessage("capture", scope.captureId, { role: "assistant", content: `[bookmark] ${note}` });
    } catch (err) {
      msgEl("note", `bookmark failed: ${err?.message || err}`);
    } finally {
      setBusy(false);
      ctx.cat("idle");
    }
  }

  // ---- outbound: "email the summary", "copy that", "save as markdown" ----

  async function handleSend(question, cmd) {
    const scope = ctx.getScope();
    msgEl("user", question);
    if (!scope) {
      msgEl("note", "scan a page first — nothing to send yet");
      return;
    }
    const scopeId = scopeIdOf(scope);
    await appendMessage(scope.type, scopeId, { role: "user", content: question });
    await performSend(cmd, scope, scopeId);
  }

  // Dispatch only — caller has already recorded the user message.
  async function performSend(cmd, scope, scopeId) {
    const captures = view.captures.length ? view.captures : (view.capture ? [view.capture] : []);
    if (!captures.length) {
      msgEl("note", "current scope has no capture rows — rescan the page");
      return;
    }
    setBusy(true);
    ctx.cat("working");
    try {
      const { webhooks } = await getSettings();
      const note = await dispatchSend(cmd, { type: scope.type, id: scopeId }, captures, webhooks);
      msgEl("note", note);
      await appendMessage(scope.type, scopeId, { role: "assistant", content: `[${cmd.sink || "send"}] ${note}` });
    } catch (err) {
      msgEl("note", `send failed: ${err?.message || err}`);
    } finally {
      setBusy(false);
      ctx.cat("idle");
    }
  }

  // ---- navigation: "open the pricing page" acts, instead of the model
  // echoing a URL it can't click ----

  function scopeLinks() {
    const caps = view.captures.length ? view.captures : (view.capture ? [view.capture] : []);
    return caps.flatMap((c) => c.links || []);
  }

  function matchLink(target, links) {
    const terms = tokenize(target);
    if (!terms.length) return null;
    let best = null;
    let bestScore = 0;
    for (const l of links) {
      const hay = tokenize(`${l.text} ${l.href.replace(/[^a-z0-9]+/gi, " ")}`);
      let s = 0;
      for (const t of terms) if (hay.some((h) => h === t || h.startsWith(t))) s++;
      if (s > bestScore) { bestScore = s; best = l; }
    }
    return best;
  }

  // "open it" -> the URL from the last assistant message, if it's unambiguous.
  async function lastMentionedUrl() {
    const scope = ctx.getScope();
    if (!scope) return null;
    const chat = await getOrCreateChat(scope.type, scopeIdOf(scope));
    const lastAssistant = [...chat.messages].reverse().find((m) => m.role === "assistant");
    const urls = [...new Set(lastAssistant?.content.match(URL_RE) || [])];
    return urls.length === 1 ? urls[0] : null;
  }

  function waitTabComplete(tabId, timeoutMs) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const poll = setInterval(async () => {
        try {
          const t = await chrome.tabs.get(tabId);
          if (t.status === "complete") { clearInterval(poll); resolve(); }
          else if (Date.now() - t0 > timeoutMs) { clearInterval(poll); reject(new Error("load timeout")); }
        } catch (err) { clearInterval(poll); reject(err); }
      }, 400);
    });
  }

  async function navigate(question) {
    const target = question
      .replace(NAV_INTENT, "")
      .replace(/\b(please|the|a|an|page|link|site|website)\b/gi, " ")
      .trim();
    const scope = ctx.getScope();
    const scopeId = scope ? scopeIdOf(scope) : null;
    msgEl("user", question);
    if (scope) await appendMessage(scope.type, scopeId, { role: "user", content: question });

    let url = null;
    const explicit = target.match(URL_RE); // .match, not .test — /g regexes keep lastIndex state
    if (!target || PRONOUNS.has(target.toLowerCase())) {
      url = await lastMentionedUrl();
      if (!url) { msgEl("note", "couldn't tell which link you mean — name it"); return; }
    } else if (explicit) {
      url = explicit[0];
    } else {
      const link = matchLink(target, scopeLinks());
      if (!link) {
        // "open gmail and paste the summary" — composer apps aren't page
        // links; route to the matching sink instead of failing.
        const sink = /\bgmail|google mail\b/i.test(target) ? "email"
          : /\bcalendar\b/i.test(target) ? "calendar"
          : /\bdocs?\b/i.test(target) ? "doc" : null;
        if (sink && scope) {
          await performSend({ sink, kind: parsePayloadKind(question) }, scope, scopeId);
          return;
        }
        msgEl("note", `no stored link matches "${target}"`);
        return;
      }
      url = link.href;
    }

    setBusy(true);
    ctx.cat("working");
    try {
      const tab = await chrome.tabs.create({ url, active: true });
      msgEl("note", `opening ${url}`);
      await waitTabComplete(tab.id, CRAWL_TIMEOUT_MS);
      await new Promise((r) => setTimeout(r, CRAWL_SETTLE_MS));
      const capture = await capturePage(tab.id, tab.windowId, { onPhase });
      const reply = `Opened and scanned ${url} — chat is now scoped to it.`;
      await appendMessage("capture", capture.id, { role: "assistant", content: reply });
      ctx.setScope({ type: "capture", captureId: capture.id });
    } catch (err) {
      msgEl("note", `opened ${url}, but couldn't scan it (${err?.message || err}) — hit Scan page`);
    } finally {
      hideProgress();
      setBusy(false);
      ctx.cat("idle");
    }
  }

  // Returns true when the vision path answered; false = fall through to text.
  async function askVision(question, scope, bubble) {
    const tiles = await getTiles(scope.captureId);
    if (!tiles.length) return false;
    bubble.textContent = "👁 looking at the page…";
    try {
      const used = tiles.slice(0, MAX_VISION_TILES);
      const answer = await answerAboutTiles(question, used.map((t) => t.blob), {
        onDownload: ctx.showDownload
      });
      setAnswer(bubble, answer);
      if (tiles.length > used.length) {
        msgEl("note", `looked at the first ${used.length} of ${tiles.length} tiles`);
      }
      await appendMessage(scope.type, scope.captureId, { role: "assistant", content: answer });
      $("msgs").scrollTop = $("msgs").scrollHeight;
      return true;
    } catch (err) {
      msgEl("note", `visual look failed (${err?.message || err}) — answering from text`);
      bubble.textContent = "…";
      return false;
    }
  }

  // ---- wiring ----
  $("scanBtn").addEventListener("click", scan);
  $("followBtn").addEventListener("click", followLinks);
  $("dlChatBtn").addEventListener("click", async () => {
    const scope = ctx.getScope();
    if (!scope) {
      ctx.toast("No chat to save yet.");
      return;
    }
    await performSend({ sink: "markdown", kind: "chat" }, scope, scopeIdOf(scope));
  });
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
    ctx.mascot?.wake();
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  // Memory-list click: navigate the CURRENT tab, scan if we've never
  // captured this URL, scope the chat either way. Lives here because this
  // view owns the progress UI and busy state.
  ctx.openAndScan = async (url) => {
    ctx.showView("chat");
    const norm = normalizeUrl(url);
    const existing = await getCaptureByUrl(norm).catch(() => null);
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id != null && normalizeUrl(tab.url || "") !== norm) {
      await chrome.tabs.update(tab.id, { url: norm }).catch(() => {});
    }
    if (existing) {
      ctx.setScope({ type: "capture", captureId: existing.id });
      return;
    }
    if (!tab?.id) return;
    if (!(await hasAllUrls())) await requestAllUrls().catch(() => {});
    setBusy(true);
    ctx.cat("scanning");
    try {
      await waitTabComplete(tab.id, CRAWL_TIMEOUT_MS);
      await new Promise((r) => setTimeout(r, CRAWL_SETTLE_MS));
      const capture = await capturePage(tab.id, tab.windowId, { onPhase });
      ctx.setScope({ type: "capture", captureId: capture.id });
      ctx.toast(`Scanned: ${plural(capture.tileCount, "tile")}.`);
    } catch (err) {
      ctx.toast(`Couldn't scan it (${err?.message || err}) — hit Scan page once it loads.`);
    } finally {
      hideProgress();
      setBusy(false);
      ctx.cat("idle");
    }
  };

  // Omnibox handoff: stage text in the composer.
  ctx.prefill = (text) => {
    const input = $("input");
    input.value = text;
    input.focus();
    input.setSelectionRange(text.length, text.length);
  };

  return { refresh: loadScope };
}
