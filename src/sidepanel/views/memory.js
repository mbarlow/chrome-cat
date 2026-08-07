// Memory view: search the domain memory space (domain → path → capture
// summaries) and browse the hierarchy. Clicking a result scopes the chat.

import { searchMemory, listDomains } from "../../db/memory.js";
import { escapeHtml } from "../../shared/text.js";

export function createMemoryView(root, ctx) {
  root.innerHTML = `
    <div class="label">start a chat with</div>
    <div class="actions">
      <button class="primary" id="chatAll">everything captured</button>
      <button id="chatToday">today's history</button>
      <button id="chatWeek">last 7 days</button>
      <button id="chatBookmarks">bookmarks</button>
    </div>
    <input type="text" id="q" placeholder="search captured domains, paths, summaries…" />
    <div id="results" style="margin-top:8px"></div>
    <div class="label">domains</div>
    <div id="tree"></div>
  `;
  const startChat = (scope) => {
    ctx.setScope(scope);
    ctx.showView("chat");
  };
  const DAY = 86_400_000;
  root.querySelector("#chatAll").addEventListener("click", () => startChat({ type: "memory" }));
  root.querySelector("#chatToday").addEventListener("click", () =>
    startChat({ type: "history", sinceMs: DAY, label: "today" }));
  root.querySelector("#chatWeek").addEventListener("click", () =>
    startChat({ type: "history", sinceMs: 7 * DAY, label: "last 7 days" }));
  root.querySelector("#chatBookmarks").addEventListener("click", () => startChat({ type: "bookmarks" }));

  const $ = (id) => root.querySelector(`#${id}`);

  function openCapture(captureId) {
    ctx.setScope({ type: "capture", captureId });
    ctx.showView("chat");
  }

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

  let debounce = null;
  $("q").addEventListener("input", (e) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => renderResults(e.target.value), 200);
  });

  document.querySelector('#tabs [data-tab="memory"]').addEventListener("click", renderTree);
  renderTree();

  return { refresh: renderTree };
}
