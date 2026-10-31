// Functions injected into the page via chrome.scripting.executeScript({func}).
// Each must be fully self-contained — chrome serializes the function body, so
// no imports, no module-scope references. Cross-injection state rides on
// window.__cc / data attributes.

export function pageGetMetrics() {
  const doc = document.documentElement;
  window.__cc = window.__cc || {};
  window.__cc.scrollY = window.scrollY;
  window.__cc.scrollBehavior = doc.style.scrollBehavior;
  doc.style.scrollBehavior = "auto";
  if (!document.querySelector("style[data-cc-style]")) {
    const st = document.createElement("style");
    st.setAttribute("data-cc-style", "1");
    st.textContent = "::-webkit-scrollbar{display:none!important}";
    document.head.appendChild(st);
  }
  return {
    scrollHeight: Math.max(doc.scrollHeight, document.body?.scrollHeight || 0),
    viewportH: window.innerHeight,
    viewportW: window.innerWidth,
    dpr: window.devicePixelRatio || 1,
    title: document.title,
    url: location.href
  };
}

export function pageScrollToY(y) {
  window.scrollTo(0, y);
  return window.scrollY;
}

// Hide fixed/sticky elements so headers/navs appear only in frame 0 and never
// duplicate across frames (duplicated chrome poisons OCR text).
export function pageHideFixed() {
  let n = 0;
  for (const el of document.querySelectorAll("body *")) {
    if (el.hasAttribute("data-cc-hidden")) continue;
    const pos = getComputedStyle(el).position;
    if (pos === "fixed" || pos === "sticky") {
      el.setAttribute("data-cc-hidden", el.style.visibility || "__unset__");
      el.style.visibility = "hidden";
      n++;
    }
  }
  return n;
}

export function pageRestore() {
  for (const el of document.querySelectorAll("[data-cc-hidden]")) {
    const prev = el.getAttribute("data-cc-hidden");
    el.style.visibility = prev === "__unset__" ? "" : prev;
    el.removeAttribute("data-cc-hidden");
  }
  document.querySelector("style[data-cc-style]")?.remove();
  const doc = document.documentElement;
  if (window.__cc) {
    doc.style.scrollBehavior = window.__cc.scrollBehavior || "";
    window.scrollTo(0, window.__cc.scrollY || 0);
    delete window.__cc;
  }
  return true;
}

// DOM ground truth: full text, deduped http(s) links, and what the HTML says
// about its images (alt, title, aria-label, figcaption, descriptive filename).
export function pageExtractDom() {
  const seen = new Set();
  const links = [];
  const here = location.href.split("#")[0];
  for (const a of document.querySelectorAll("a[href]")) {
    const href = a.href;
    if (!/^https?:\/\//.test(href)) continue;
    const clean = href.split("#")[0];
    if (!clean || clean === here || seen.has(clean)) continue;
    seen.add(clean);
    links.push({ href: clean, text: (a.innerText || "").trim().slice(0, 120) });
  }
  const images = [];
  for (const img of document.querySelectorAll("img")) {
    const r = img.getBoundingClientRect();
    if (r.width < 48 || r.height < 48) continue;
    let file = "";
    try {
      const u = new URL(img.currentSrc || img.src);
      const name = decodeURIComponent(u.pathname.split("/").pop() || "").replace(/\.[a-z0-9]+$/i, "");
      if (/^https?:$/.test(u.protocol) && /[a-z]{3,}[-_ ][a-z]{3,}/i.test(name)) file = name.replace(/[-_]+/g, " ");
    } catch { /* unparseable src */ }
    const parts = [img.alt, img.title, img.getAttribute("aria-label"),
      img.closest("figure")?.querySelector("figcaption")?.innerText, file]
      .map((s) => (s || "").trim()).filter(Boolean);
    const desc = [...new Set(parts)].join(" — ").slice(0, 200);
    if (desc && !images.includes(desc)) images.push(desc);
    if (images.length >= 20) break;
  }
  return { text: document.body?.innerText || "", links, images };
}

// Scroll to and highlight a passage of page text. Matching ignores case and
// whitespace and may span elements; falls back to the passage's first 60
// chars. Returns whether it was found.
export function pageHighlight(passage) {
  const skip = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement && !skip.test(n.parentElement.tagName)
      ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT)
  });
  let flat = "";
  const map = [];
  for (let n; (n = walker.nextNode());) {
    const t = n.nodeValue;
    for (let i = 0; i < t.length; i++) {
      const c = /\s/.test(t[i]) ? " " : t[i].toLowerCase();
      if (c === " " && (flat.endsWith(" ") || !flat)) continue;
      flat += c;
      map.push([n, i]);
    }
    if (!flat.endsWith(" ")) { flat += " "; map.push([n, t.length]); }
  }
  const target = String(passage).replace(/\s+/g, " ").trim().toLowerCase();
  let at = flat.indexOf(target);
  let len = target.length;
  if (at < 0) {
    len = Math.min(60, target.length);
    at = flat.indexOf(target.slice(0, len));
  }
  if (at < 0 || !len) return false;
  const [sn, so] = map[at];
  const [en, eo] = map[at + len - 1];
  const range = document.createRange();
  range.setStart(sn, so);
  range.setEnd(en, Math.min(eo + 1, en.nodeValue.length));
  if (window.CSS?.highlights && window.Highlight) {
    if (!document.querySelector("style[data-cc-highlight]")) {
      const st = document.createElement("style");
      st.setAttribute("data-cc-highlight", "1");
      st.textContent = "::highlight(chrome-cat){background:#ffe066;color:#111}";
      document.head.appendChild(st);
    }
    CSS.highlights.set("chrome-cat", new Highlight(range));
  }
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  sn.parentElement?.scrollIntoView({ block: "center", behavior: "smooth" });
  return true;
}

// Let the user drag a box (or click an image) on the page; Esc cancels.
// Resolves { x, y, w, h, vw, vh, notes } in CSS px — notes are the alt/title/
// figcaption text of images the box mostly covers, or mostly sits inside —
// or null.
export function pageSelectRegion() {
  return new Promise((resolve) => {
    const ov = document.createElement("div");
    Object.assign(ov.style, {
      position: "fixed", inset: "0", zIndex: "2147483647", cursor: "crosshair",
      background: "rgba(12,15,20,0.25)"
    });
    const box = document.createElement("div");
    Object.assign(box.style, {
      position: "fixed", border: "2px solid #5ad1c5", background: "rgba(90,209,197,0.15)",
      display: "none", pointerEvents: "none"
    });
    ov.appendChild(box);
    document.documentElement.appendChild(ov);
    let x0 = null;
    let y0 = null;

    const notesIn = (r) => {
      const out = [];
      for (const img of document.querySelectorAll("img")) {
        const b = img.getBoundingClientRect();
        const ix = Math.max(0, Math.min(b.right, r.x + r.w) - Math.max(b.left, r.x));
        const iy = Math.max(0, Math.min(b.bottom, r.y + r.h) - Math.max(b.top, r.y));
        if (!b.width || ix * iy < 0.5 * Math.min(b.width * b.height, r.w * r.h)) continue;
        const parts = [img.alt, img.title, img.getAttribute("aria-label"),
          img.closest("figure")?.querySelector("figcaption")?.innerText]
          .map((s) => (s || "").trim()).filter(Boolean);
        const d = [...new Set(parts)].join(" — ").slice(0, 200);
        if (d && !out.includes(d)) out.push(d);
      }
      return out;
    };
    const finish = (r) => {
      ov.remove();
      removeEventListener("keydown", onKey, true);
      // Two frames so the overlay is gone from the next screenshot; the timer
      // covers background tabs, where frames don't run.
      let sent = false;
      const send = () => {
        if (sent) return;
        sent = true;
        resolve(r && { ...r, vw: innerWidth, vh: innerHeight, notes: notesIn(r) });
      };
      requestAnimationFrame(() => requestAnimationFrame(send));
      setTimeout(send, 120);
    };
    const onKey = (e) => { if (e.key === "Escape") finish(null); };
    addEventListener("keydown", onKey, true);

    ov.addEventListener("mousedown", (e) => {
      x0 = e.clientX;
      y0 = e.clientY;
      box.style.display = "block";
      e.preventDefault();
    });
    ov.addEventListener("mousemove", (e) => {
      if (x0 === null) return;
      Object.assign(box.style, {
        left: `${Math.min(x0, e.clientX)}px`, top: `${Math.min(y0, e.clientY)}px`,
        width: `${Math.abs(e.clientX - x0)}px`, height: `${Math.abs(e.clientY - y0)}px`
      });
    });
    ov.addEventListener("mouseup", (e) => {
      if (x0 === null) return;
      const r = { x: Math.min(x0, e.clientX), y: Math.min(y0, e.clientY),
        w: Math.abs(e.clientX - x0), h: Math.abs(e.clientY - y0) };
      if (r.w >= 12 && r.h >= 12) { finish(r); return; }
      // A click: take the image-like element under the cursor, if any.
      ov.style.pointerEvents = "none";
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest("img, svg, canvas, video, picture");
      ov.style.pointerEvents = "";
      if (!el) { x0 = null; box.style.display = "none"; return; }
      const b = el.getBoundingClientRect();
      const x = Math.max(0, b.left);
      const y = Math.max(0, b.top);
      finish({ x, y, w: Math.min(innerWidth, b.right) - x, h: Math.min(innerHeight, b.bottom) - y });
    });
  });
}
