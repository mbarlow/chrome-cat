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
