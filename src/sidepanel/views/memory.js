// Memory view: one search box over four sources — captured pages (domain
// tree + summary search), today's history, last 7 days, bookmarks. History
// and bookmark items list newest-first; clicking one navigates the current
// tab, scans if never captured, and scopes the chat (ctx.openAndScan).

import { searchMemory, listDomains } from "../../db/memory.js";
import { historyCaptures, bookmarkCaptures } from "../../sources/browser.js";
import { escapeHtml } from "../../shared/text.js";

const DAY = 86_400_000;

const SOURCES = {
  captured: { label: "captured" },
  today: { label: "today", sinceMs: DAY },
  week: { label: "last 7 days", sinceMs: 7 * DAY },
  bookmarks: { label: "bookmarks" }
};

export function createMemoryView(root, ctx) {
  root.innerHTML = `
    <div class="seg" id="srcSeg" style="margin-bottom:8px">
      <button data-src="captured" class="active">captured</button>
      <button data-src="today">today</button>
      <button data-src="week">7 days</button>
      <button data-src="bookmarks">bookmarks</button>
    </div>
    <div class="actions">
      <button class="mini" id="chatSource">chat with all of these</button>
    </div>
    <input type="text" id="q" placeholder="search…" />
    <div id="results" style="margin-top:8px"></div>
    <div id="itemList" style="margin-top:8px"></div>
    <div class="label" id="domLabel">domains</div>
    <div id="tree"></div>
  `;

  const $ = (id) => root.querySelector(`#${id}`);
  const view = { source: "captured", items: [] };

  function openCapture(captureId) {
    ctx.setScope({ type: "capture", captureId });
    ctx.showView("chat");
  }

  // ---- captured source (summary search + domain tree) ----

  async function renderResults(query) {
    const box = $("results");
    box.replaceChildren();
    if (!query.trim()) return;
    const results = await searchMemory(query);
    if (!results.length) {
      box.innerHTML = `<div class="muted">no matches</div>`;
      return;
    }
    for (const r of results) {
      const div = document.createElement("div");
      div.className = "result";
      div.innerHTML = `
        <div class="head"><span class="kind">${r.type}</span>
        <span>${escapeHtml(r.domain)}${escapeHtml(r.path || "")}</span></div>
        <div class="snippet">${escapeHtml((r.text || "").slice(0, 160))}</div>`;
      if (r.captureId) div.addEventListener("click", () => openCapture(r.captureId));
      box.appendChild(div);
    }
  }

  async function renderTree() {
    const tree = $("tree");
    tree.replaceChildren();
    const domains = (await listDomains()).sort((a, b) => b.updatedAt - a.updatedAt);
    if (!domains.length) {
      tree.innerHTML = `<div class="muted">nothing captured yet</div>`;
      return;
    }
    for (const d of domains) {
      const block = document.createElement("div");
      block.className = "domain-block";
      block.innerHTML = `
        <div class="dhead">${escapeHtml(d.domain)} <span class="muted">· ${d.pageCount} pages</span></div>
        ${d.summary ? `<div class="snippet muted">${escapeHtml(d.summary.slice(0, 200))}</div>` : ""}`;
      for (const p of d.paths || []) {
        const row = document.createElement("div");
        row.className = "path";
        row.textContent = `${"  ".repeat(Math.max(0, p.pathDepth - 1))}${p.path} (${p.captureIds.length})`;
        row.addEventListener("click", () => openCapture(p.captureIds[p.captureIds.length - 1]));
        block.appendChild(row);
      }
      tree.appendChild(block);
    }
  }

  // ---- history / bookmarks sources (newest-first item list) ----

  function renderItems() {
    const q = $("q").value.trim().toLowerCase();
    const list = $("itemList");
    list.replaceChildren();
    const filtered = view.items
      .filter((it) => !q || `${it.title} ${it.url}`.toLowerCase().includes(q))
      .slice(0, 100);
    if (!filtered.length) {
      list.innerHTML = `<div class="muted">no items</div>`;
      return;
    }
    for (const it of filtered) {
      const div = document.createElement("div");
      div.className = "result";
      div.innerHTML = `
        <div class="head"><span>${escapeHtml(it.title)}</span>${it.summary ? ` <span class="kind">scanned</span>` : ""}</div>
        <div class="snippet">${escapeHtml(it.url)} · ${new Date(it.ts).toLocaleString()}</div>`;
      div.addEventListener("click", () => ctx.openAndScan(it.url));
      list.appendChild(div);
    }
  }

  // ---- source switching ----

  async function loadSource() {
    const captured = view.source === "captured";
    $("domLabel").hidden = !captured;
    $("tree").hidden = !captured;
    $("itemList").replaceChildren();
    $("results").replaceChildren();
    if (captured) {
      await renderTree();
      await renderResults($("q").value);
      return;
    }
    view.items = view.source === "bookmarks"
      ? await bookmarkCaptures()
      : await historyCaptures(SOURCES[view.source].sinceMs);
    renderItems();
  }

  for (const btn of root.querySelectorAll("#srcSeg button")) {
    btn.addEventListener("click", () => {
      view.source = btn.dataset.src;
      for (const b of root.querySelectorAll("#srcSeg button")) {
        b.classList.toggle("active", b === btn);
      }
      loadSource();
    });
  }

  $("chatSource").addEventListener("click", () => {
    const scope = view.source === "captured" ? { type: "memory" }
      : view.source === "bookmarks" ? { type: "bookmarks" }
      : { type: "history", sinceMs: SOURCES[view.source].sinceMs, label: SOURCES[view.source].label };
    ctx.setScope(scope);
    ctx.showView("chat");
  });

  let debounce = null;
  $("q").addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      view.source === "captured" ? renderResults($("q").value) : renderItems();
    }, 200);
  });

  document.querySelector('#tabs [data-tab="memory"]').addEventListener("click", loadSource);
  loadSource();

  return { refresh: loadSource };
}
