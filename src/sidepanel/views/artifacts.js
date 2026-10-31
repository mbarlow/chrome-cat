// Artifacts view: browse stored captures, view tiles + their OCR text,
// export tiles/texts/JSON. Blob URLs are revoked on every re-render.

import { listCaptures, getTiles, updateCapture } from "../../db/captures.js";
import { summarizeCapture } from "../../ai/summarizer.js";
import { normalizeUrl } from "../../shared/url.js";

export function createArtifactsView(root, ctx) {
  root.innerHTML = `
    <div class="label">capture</div>
    <select id="capSelect"></select>
    <div class="rail" id="rail"></div>
    <div class="artgrid">
      <div class="tileview" id="tileview"></div>
      <div class="detail">
        <div class="seg">
          <button id="segOcr" class="active">tile OCR</button>
          <button id="segFullOcr">full OCR</button>
          <button id="segDom">DOM text</button>
        </div>
        <div class="textwrap">
          <div class="textpane" id="textpane"></div>
          <button class="mini copybtn" id="copyPane" title="Copy this text to clipboard">⧉</button>
        </div>
        <div class="label">export</div>
        <div class="actions">
          <button id="expTile">tile .png</button>
          <button id="expOcr">ocr .txt</button>
          <button id="expDom">dom .txt</button>
          <button id="expJson">capture .json</button>
        </div>
        <div class="label">summary</div>
        <div class="actions">
          <button id="resummarize" title="Ask the model for a fresh summary of this capture">re-summarize</button>
        </div>
      </div>
    </div>
  `;

  const $ = (id) => root.querySelector(`#${id}`);
  const view = { captures: [], capture: null, tiles: [], tileIdx: 0, mode: "ocr", urls: [] };

  function revoke() {
    for (const u of view.urls) URL.revokeObjectURL(u);
    view.urls = [];
  }

  function blobUrl(blob) {
    const u = URL.createObjectURL(blob);
    view.urls.push(u);
    return u;
  }

  function download(name, blob) {
    const a = document.createElement("a");
    a.href = blobUrl(blob);
    a.download = name;
    a.click();
  }

  function slug(c) {
    return `${c.domain}${c.path}`.replace(/[^a-z0-9.-]+/gi, "_").slice(0, 60);
  }

  function renderText() {
    const c = view.capture;
    const pane = $("textpane");
    if (!c) { pane.textContent = ""; return; }
    if (view.mode === "dom") pane.textContent = c.domText || "(no DOM text)";
    else if (view.mode === "fullocr") pane.textContent = c.ocrText || "(no OCR text yet)";
    else pane.textContent = view.tiles[view.tileIdx]?.ocrText || "(no OCR text for this tile)";
  }

  function renderTiles() {
    const rail = $("rail");
    const tv = $("tileview");
    rail.replaceChildren();
    tv.replaceChildren();
    view.tiles.forEach((t, i) => {
      const img = document.createElement("img");
      img.src = blobUrl(t.blob);
      img.title = `tile ${i + 1} · conf ${Math.round(t.ocrConfidence)}`;
      img.classList.toggle("sel", i === view.tileIdx);
      img.addEventListener("click", () => {
        view.tileIdx = i;
        renderTiles();
        renderText();
      });
      rail.appendChild(img);
    });
    const cur = view.tiles[view.tileIdx];
    if (cur) {
      const img = document.createElement("img");
      img.src = blobUrl(cur.blob);
      tv.appendChild(img);
    }
  }

  async function selectCapture(id) {
    revoke();
    view.capture = view.captures.find((c) => c.id === Number(id)) || null;
    view.tiles = view.capture ? await getTiles(view.capture.id) : [];
    view.tileIdx = 0;
    renderTiles();
    renderText();
  }

  async function refresh() {
    view.captures = await listCaptures();
    const sel = $("capSelect");
    sel.replaceChildren();
    if (!view.captures.length) {
      sel.append(new Option("no captures yet — scan a page", ""));
      revoke();
      view.capture = null;
      view.tiles = [];
      renderTiles();
      renderText();
      return;
    }
    for (const c of view.captures) {
      const when = new Date(c.ts).toLocaleString();
      const tag = c.seriesId ? `[s${c.seriesId}] ` : "";
      sel.append(new Option(`${tag}${c.title} — ${when}`, c.id));
    }
    const scope = ctx.getScope();
    const preferred = scope?.type === "capture" ? scope.captureId : view.captures[0].id;
    sel.value = String(view.captures.some((c) => c.id === preferred) ? preferred : view.captures[0].id);
    await selectCapture(sel.value);
  }

  function setMode(mode) {
    view.mode = mode;
    $("segOcr").classList.toggle("active", mode === "ocr");
    $("segFullOcr").classList.toggle("active", mode === "fullocr");
    $("segDom").classList.toggle("active", mode === "dom");
    renderText();
  }

  // User-picked (not programmatic) selection acts like an omnibox hit:
  // navigate the current tab to the page and scope the chat to it.
  $("copyPane").addEventListener("click", async () => {
    const text = $("textpane").textContent;
    if (!text.trim() || text.startsWith("(no ")) {
      ctx.toast("Nothing to copy.");
      return;
    }
    await navigator.clipboard.writeText(text);
    ctx.toast(`Copied ${text.length.toLocaleString()} chars.`);
  });

  $("capSelect").addEventListener("change", async (e) => {
    await selectCapture(e.target.value);
    if (!view.capture) return;
    ctx.setScope({ type: "capture", captureId: view.capture.id });
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id != null && normalizeUrl(tab.url || "") !== view.capture.url) {
      await chrome.tabs.update(tab.id, { url: view.capture.url }).catch(() => {});
    }
  });
  $("segOcr").addEventListener("click", () => setMode("ocr"));
  $("segFullOcr").addEventListener("click", () => setMode("fullocr"));
  $("segDom").addEventListener("click", () => setMode("dom"));

  $("expTile").addEventListener("click", () => {
    const t = view.tiles[view.tileIdx];
    if (t) download(`${slug(view.capture)}_tile${t.seq + 1}.png`, t.blob);
  });
  $("expOcr").addEventListener("click", () => {
    if (view.capture) download(`${slug(view.capture)}_ocr.txt`, new Blob([view.capture.ocrText], { type: "text/plain" }));
  });
  $("expDom").addEventListener("click", () => {
    if (view.capture) download(`${slug(view.capture)}_dom.txt`, new Blob([view.capture.domText], { type: "text/plain" }));
  });
  $("expJson").addEventListener("click", () => {
    if (!view.capture) return;
    const { domChunks, ...rest } = view.capture; // blobs live in tiles; chunks are derivable
    download(`${slug(view.capture)}.json`, new Blob([JSON.stringify(rest, null, 2)], { type: "application/json" }));
  });

  $("resummarize").addEventListener("click", async () => {
    const c = view.capture;
    if (!c) return;
    const btn = $("resummarize");
    btn.disabled = true;
    btn.textContent = "summarizing…";
    try {
      const summary = await summarizeCapture(c);
      if (!summary) {
        ctx.toast("Couldn't summarize — check the model status.");
        return;
      }
      view.capture = await updateCapture(c.id, { summary });
      ctx.toast("Summary updated.");
      const scope = ctx.getScope();
      if (scope?.type === "capture" && scope.captureId === c.id) ctx.setScope({ ...scope });
    } finally {
      btn.disabled = false;
      btn.textContent = "re-summarize";
    }
  });

  // Re-list whenever the tab becomes visible or a scan changes scope.
  ctx.onScopeChange(() => { if (root.classList.contains("active")) refresh(); });
  document.querySelector('#tabs [data-tab="artifacts"]').addEventListener("click", refresh);

  return { refresh };
}
