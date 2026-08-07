// Headless smoke test: loads the unpacked extension, boots the side panel,
// and exercises the two riskiest integrations — the Tesseract wasm worker
// under MV3 CSP, and the IndexedDB layer. Run via `make smoke`.
// Needs a global playwright install (npm i -g playwright).

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";

// Resolve playwright from a local node_modules, the global root, or nvm —
// bare ESM imports can't see global installs.
const require = createRequire(import.meta.url);
function loadPlaywright() {
  const roots = [""];
  try { roots.push(execSync("npm root -g", { encoding: "utf8" }).trim()); } catch { /* no npm */ }
  const nvm = join(homedir(), ".config/nvm/versions/node");
  try { for (const v of readdirSync(nvm)) roots.push(join(nvm, v, "lib/node_modules")); } catch { /* no nvm */ }
  for (const r of roots) {
    try { return require(r ? join(r, "playwright") : "playwright"); } catch { /* next */ }
  }
  console.error("playwright not found — npm i -g playwright");
  process.exit(2);
}
const { chromium } = loadPlaywright();

const EXT = dirname(dirname(fileURLToPath(import.meta.url)));
// Unpacked extension IDs are deterministic: sha256(path) -> first 32 hex -> a-p.
const extId = [...createHash("sha256").update(EXT).digest("hex").slice(0, 32)]
  .map((c) => String.fromCharCode("a".charCodeAt(0) + parseInt(c, 16))).join("");

const profile = mkdtempSync(join(tmpdir(), "chrome-chat-smoke-"));
const ctx = await chromium.launchPersistentContext(profile, {
  headless: false, // --headless=new below does the real work; extensions need this combo
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--headless=new"]
});

let failed = false;
try {
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`chrome-extension://${extId}/src/sidepanel/sidepanel.html`);
  await page.waitForTimeout(2000);

  const brand = await page.textContent(".brand");
  const tess = await page.evaluate(() => typeof Tesseract);
  console.log("panel:", brand, "| Tesseract global:", tess);

  for (const t of ["artifacts", "memory", "settings", "chat"]) {
    await page.click(`#tabs [data-tab="${t}"]`);
    await page.waitForTimeout(300);
  }

  const ocr = await page.evaluate(async () => {
    const mod = await import("../ocr/tesseract-engine.js");
    const c = new OffscreenCanvas(600, 120);
    const x = c.getContext("2d");
    x.fillStyle = "#fff"; x.fillRect(0, 0, 600, 120);
    x.fillStyle = "#000"; x.font = "42px sans-serif";
    x.fillText("HELLO CHROME CHAT", 20, 70);
    const blob = await c.convertToBlob({ type: "image/png" });
    const r = await mod.ocrTile(blob);
    return { text: r.text.trim(), confidence: Math.round(r.confidence) };
  });
  console.log("OCR:", JSON.stringify(ocr));

  const idb = await page.evaluate(async () => {
    const caps = await import("../db/captures.js");
    const c = await caps.createCapture({ url: "https://example.com/a/b", title: "t", viewport: { w: 1, h: 1, dpr: 1 } });
    await caps.addTile({ captureId: c.id, seq: 0, blob: new Blob(["x"]), w: 1, h: 1, ocrText: "", ocrConfidence: 0 });
    return { domain: c.domain, pathDepth: c.pathDepth, tiles: (await caps.getTiles(c.id)).length };
  });
  console.log("IDB:", JSON.stringify(idb));

  if (errors.length) console.log("console errors:", errors);
  failed = errors.length > 0 || !ocr.text.includes("HELLO") || idb.tiles !== 1;
} finally {
  await ctx.close();
  rmSync(profile, { recursive: true, force: true });
}
console.log(failed ? "SMOKE FAIL" : "SMOKE OK");
process.exit(failed ? 1 : 0);
