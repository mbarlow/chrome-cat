// End-to-end test against the real on-device model: loads the unpacked
// extension into Google Chrome with a copy of its Gemini Nano install, scans
// a local fixture page, and talks to the side panel through its own UI.
// Run via `make e2e`. Failures are labelled TOOLING (harness, browser, scan)
// or MODEL (an answer missed); model checks are retried E2E_RETRIES times.

import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPlaywright } from "./playwright.mjs";

const EXT = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURE = join(EXT, "tools/e2e");
const CHROME = process.env.CHROME || "/opt/google/chrome/chrome";
const CHROME_DIR = process.env.CHROME_PROFILE_DIR || join(homedir(), ".config/google-chrome");
const MODEL_DIR = join(CHROME_DIR, "OptGuideOnDeviceModel");
const RETRIES = Number(process.env.E2E_RETRIES ?? 1);
const OUT = process.env.E2E_OUT || mkdtempSync(join(tmpdir(), "chrome-cat-e2e-out-"));
const ANSWER_MS = 120_000;

class ToolingError extends Error {}

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s]`, ...a);

function preflight() {
  if (!existsSync(CHROME)) throw new ToolingError(`Google Chrome not found at ${CHROME} (set CHROME=)`);
  if (!existsSync(MODEL_DIR)) {
    throw new ToolingError(`no Gemini Nano install at ${MODEL_DIR} — open the panel in Chrome once and hit download`);
  }
}

// Fresh profile carrying Chrome's model copy (reflinked where the FS allows)
// and Local State, which records the model as installed.
function makeProfile(dir) {
  const profile = join(dir, "profile");
  mkdirSync(profile);
  execFileSync("cp", ["-r", "--reflink=auto", MODEL_DIR, profile]);
  execFileSync("cp", [join(CHROME_DIR, "Local State"), profile]);
  return profile;
}

// The extension under test, with <all_urls> granted at install: the optional
// grant needs a permission prompt, and captureVisibleTab needs the grant.
function makeExtension(dir) {
  const ext = join(dir, "ext");
  cpSync(EXT, ext, { recursive: true, filter: (src) => !/\/\.git(\/|$)/.test(src) });
  const manifest = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
  manifest.host_permissions.push("<all_urls>");
  writeFileSync(join(ext, "manifest.json"), JSON.stringify(manifest, null, 2));
  return ext;
}

function serveFixture() {
  const types = { ".html": "text/html", ".svg": "image/svg+xml" };
  const server = createServer((req, res) => {
    const name = req.url === "/" ? "index.html" : req.url.slice(1).split("?")[0];
    const file = join(FIXTURE, name);
    if (!file.startsWith(FIXTURE) || !existsSync(file)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

// Each check asks one question; expect.text must match the answer, and
// expect.route (when set) must match the bubble's data-route.
const CHECKS = [
  { name: "page fact", ask: "what is the cat's name?", text: /biscuit/i, route: "text" },
  { name: "image metadata", ask: "who painted the picture on this page?", text: /eyck/i, route: "vision" },
  { name: "follow-up", ask: "when was that painting made?", text: /1434/ },
  { name: "links", ask: "what links are there?", text: /tickets|example\.com/i, route: "links" },
  { name: "general knowledge", ask: "what is the capital of France?", text: /paris/i, route: "general" },
  { name: "page gap → general", ask: "what is the gallery's phone number?", text: /general knowledge/i }
];

async function run() {
  preflight();
  const { chromium } = loadPlaywright();
  const work = mkdtempSync(join(tmpdir(), "chrome-cat-e2e-"));
  const profile = makeProfile(work);
  const ext = makeExtension(work);
  const server = await serveFixture();
  const url = `http://127.0.0.1:${server.address().port}/`;
  const results = [];
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(profile, {
      executablePath: CHROME,
      headless: false,
      viewport: null,
      ignoreDefaultArgs: ["--disable-extensions", "--disable-component-extensions-with-background-pages"],
      args: ["--enable-unsafe-extension-debugging", "--no-first-run", "--window-size=1280,1000"]
    });
    // Branded Chrome ignores --load-extension; CDP loads it instead.
    const cdp = await ctx.browser().newBrowserCDPSession();
    const { id } = await cdp.send("Extensions.loadUnpacked", { path: ext }).catch((e) => {
      throw new ToolingError(`Extensions.loadUnpacked failed: ${e.message}`);
    });
    log("extension", id, "| fixture", url);

    const panel = ctx.pages()[0] || await ctx.newPage();
    const errors = [];
    panel.on("pageerror", (e) => errors.push(String(e)));
    await panel.goto(`chrome-extension://${id}/src/sidepanel/sidepanel.html`);

    // Test seam: the panel runs in a tab, so point its active-tab lookups at
    // the fixture's window.
    await panel.evaluate(async (u) => {
      const w = await chrome.windows.create({ url: u, focused: false, width: 1280, height: 1000 });
      const query = chrome.tabs.query.bind(chrome.tabs);
      // Record downloads so checks can read them back (Playwright renames files).
      const download = chrome.downloads.download.bind(chrome.downloads);
      window.__downloads = [];
      chrome.downloads.download = async (opts) => {
        window.__downloads.push({ ...opts, body: await fetch(opts.url).then((r) => r.text()).catch(() => null) });
        return download(opts);
      };
      chrome.tabs.query = (q, ...rest) =>
        (q?.currentWindow || q?.lastFocusedWindow) && q?.active
          ? query({ active: true, windowId: w.id }, ...rest)
          : query(q, ...rest);
    }, url);

    const status = () => panel.textContent("#aiStatus");
    const ready = await poll(async () => /ready|placeholder|unavailable|missing|failed/.test(await status()), 120_000);
    const s = await status();
    log("model:", s);
    if (!ready || !/ready/.test(s)) throw new ToolingError(`model not ready: "${s}"`);

    await panel.evaluate(() => {
      window.__status = [];
      new MutationObserver(() => window.__status.push(aiStatus.textContent))
        .observe(aiStatus, { childList: true, characterData: true, subtree: true });
    });

    await panel.click("#scanBtn");
    await panel.waitForTimeout(500);
    if (!await poll(() => panel.isEnabled("#scanBtn"), 180_000)) throw new ToolingError("scan timed out");
    const scope = (await panel.textContent(".scopebar")).replace(/\s+/g, " ").trim();
    log("scan:", scope);
    if (!/ready/.test(scope)) {
      throw new ToolingError(`scan did not finish: ${scope} (toast: "${await panel.textContent("#toast")}")`);
    }

    for (const c of CHECKS) {
      let r;
      for (let attempt = 0; attempt <= RETRIES; attempt++) {
        r = await ask(panel, c);
        if (r.ok) break;
      }
      results.push(r);
      log(r.ok ? "PASS " : "MODEL", c.name, `[${r.route || "-"}]`, `“${c.ask}”`, r.attempts > 1 ? `(attempt ${r.attempts})` : "");
      log("      ", r.answer.replace(/\s+/g, " ").slice(0, 300));
    }

    const md = await panel.$$eval(".msg.assistant", (els) => els.filter((e) => e.textContent.includes("**")).length);
    results.push({ name: "markdown rendered", ok: md === 0, kind: "tooling", answer: `${md} bubbles with raw **` });
    const flicker = await panel.evaluate(() => window.__status);
    results.push({ name: "status steady", ok: flicker.length === 0, kind: "tooling", answer: JSON.stringify(flicker) });
    const site = ctx.pages().find((p) => p.url().startsWith(url));
    if (!site) throw new ToolingError("fixture page not found among tabs");
    results.push(await sources(panel, site));
    results.push(await table(panel));
    results.push(await region(panel, site));
    results.push(await resummarize(panel));
    results.push({ name: "no page errors", ok: errors.length === 0, kind: "tooling", answer: errors.join(" | ") });
    await panel.screenshot({ path: join(OUT, "panel.png") });
    results.push(await cleanup(panel));

    for (const r of results.slice(CHECKS.length)) log(r.ok ? "PASS " : "TOOL ", r.name, r.ok ? "" : `— ${r.answer}`);
    log("screenshot:", join(OUT, "panel.png"));
  } finally {
    await ctx?.close().catch(() => {});
    server.close();
    rmSync(work, { recursive: true, force: true });
  }
  return results;
}

// Track attempts across retries on the check object itself.
async function ask(panel, check) {
  check.attempts = (check.attempts || 0) + 1;
  const before = await panel.locator(".msg.assistant").count();
  await panel.fill("#input", check.ask);
  await panel.press("#input", "Enter");
  await panel.waitForTimeout(300);
  const done = await poll(async () =>
    await panel.isEnabled("#scanBtn") && (await panel.locator(".msg.assistant").count()) > before, ANSWER_MS);
  if (!done) throw new ToolingError(`no answer to "${check.ask}" within ${ANSWER_MS / 1000}s`);
  const last = panel.locator(".msg.assistant").last();
  const answer = await last.textContent();
  const route = [await last.getAttribute("data-route"), await last.getAttribute("data-check")].filter(Boolean).join("/");
  const title = await last.getAttribute("title");
  if (title) log("      ", title);
  const ok = check.text.test(answer) && (!check.route || route.split("/")[0] === check.route);
  return { name: check.name, ok, kind: "model", answer, route, attempts: check.attempts };
}

// The "cat's name" answer must carry a source chip that, clicked, selects
// the passage on the live page.
async function sources(panel, site) {
  const name = "source highlight";
  const chip = panel.locator(".msg.assistant .src", { hasText: /biscuit/i }).first();
  if (!await chip.count()) return { name, ok: false, kind: "model", answer: "no source chip mentioning Biscuit" };
  await site.evaluate(() => { getSelection().removeAllRanges(); scrollTo(0, 0); });
  await chip.click();
  const selected = await poll(async () => /biscuit/i.test(await site.evaluate(() => getSelection().toString())), 10_000);
  const text = await site.evaluate(() => getSelection().toString());
  return { name, ok: selected, kind: "tooling", answer: `selected: "${text}"` };
}

// "table of ticket prices" must route to table with the three prices, and
// ⤓ csv must produce a file with them (removed afterwards).
async function table(panel) {
  const name = "table extraction";
  const before = await panel.locator(".msg.assistant").count();
  await panel.fill("#input", "make a table of the ticket prices");
  await panel.press("#input", "Enter");
  await panel.waitForTimeout(300);
  await poll(async () => await panel.isEnabled("#scanBtn") && (await panel.locator(".msg.assistant").count()) > before, ANSWER_MS);
  const last = panel.locator(".msg.assistant").last();
  const route = await last.getAttribute("data-route");
  const cells = await last.locator("table.datatable").innerText().catch(() => "");
  const prices = ["12", "6", "9"].every((p) => cells.includes(p));
  log(`       [${route}] table:`, cells.replace(/\s+/g, " ").slice(0, 160));
  if (route !== "table" || !prices) return { name, ok: false, kind: "model", answer: `route=${route}, cells="${cells.slice(0, 120)}"` };
  await last.locator('button[data-fmt="csv"]').click();
  await poll(() => panel.evaluate(() => window.__downloads.some((d) => d.filename.endsWith(".csv"))), 10_000);
  const csv = await panel.evaluate(() => window.__downloads.find((d) => d.filename.endsWith(".csv")));
  const ok = !!csv?.body && ["12", "6", "9"].every((p) => csv.body.includes(p));
  return { name, ok, kind: "tooling", answer: csv ? `${csv.filename}: ${JSON.stringify(csv.body)}` : "no csv download" };
}

// ⌗ region → drag over the portrait → "who painted this?" must answer from
// the region (data-route=region) using the image's alt text.
async function region(panel, site) {
  const name = "region ask";
  await site.evaluate(() => document.querySelector("img").scrollIntoView({ block: "center" }));
  const b = await site.locator("img").boundingBox();
  await panel.click("#regionBtn");
  // Synthetic input only reaches a window that is actually shown.
  await site.bringToFront();
  const overlay = await poll(() => site.evaluate(() =>
    getComputedStyle(document.elementFromPoint(innerWidth / 2, innerHeight / 2)).cursor === "crosshair"), 10_000, 100);
  if (!overlay) return { name, ok: false, kind: "tooling", answer: "region overlay never appeared" };
  await site.evaluate(() => {
    window.__ev = [];
    for (const t of ["mousedown", "mouseup"]) {
      addEventListener(t, (e) => window.__ev.push(`${t}@${e.clientX},${e.clientY}`), true);
    }
  });
  // Drag across the image's visible part: tiled windows can be shorter than
  // the image, and the overlay only sees in-viewport presses.
  const vh = await site.evaluate(() => innerHeight);
  const top = Math.max(b.y, 0) + 2;
  const bottom = Math.min(b.y + b.height, vh) - 2;
  await site.mouse.move(b.x + 2, top);
  await site.mouse.down();
  await site.mouse.move(b.x + b.width / 2, (top + bottom) / 2, { steps: 5 });
  await site.mouse.move(b.x + b.width - 2, bottom, { steps: 5 });
  await site.mouse.up();
  if (!await poll(() => panel.isVisible("#attach"), 10_000)) {
    const state = await site.evaluate(() => ({
      events: window.__ev,
      overlay: [...document.documentElement.children].some((e) => e.style?.cursor === "crosshair"),
      focused: document.hasFocus(), visible: document.visibilityState
    }));
    return { name, ok: false, kind: "tooling", answer: `no region attached (toast: "${await panel.textContent("#toast")}", page: ${JSON.stringify(state)})` };
  }
  log("      ", await panel.textContent("#attachText"));
  const r = await ask(panel, { name, ask: "who painted this?", text: /eyck/i, route: "region" });
  log(`       [${r.route}]`, r.answer.replace(/\s+/g, " ").slice(0, 200));
  const saved = await panel.evaluate(async () => {
    const db = await import("../db/captures.js");
    const chats = await import("../db/chats.js");
    const [c] = await db.listCaptures(1);
    const chat = await chats.getOrCreateChat("capture", c.id);
    return chat.messages.slice(-2).map((m) => `${m.role}: ${m.content.slice(0, 40)}`);
  });
  log("       saved:", JSON.stringify(saved));
  if (!saved.some((m) => m.startsWith("user: who painted this?"))) {
    r.ok = false;
    r.kind = "tooling";
    r.answer = `region exchange not saved to the chat (last: ${JSON.stringify(saved)})`;
  }
  await panel.locator(".msg.tablemsg").last().scrollIntoViewIfNeeded();
  await panel.screenshot({ path: join(OUT, "region.png") });
  await panel.click("#attachClear");
  return r;
}

// Artifacts → re-summarize must replace the stored summary with model text.
async function resummarize(panel) {
  const name = "re-summarize";
  await panel.click('#tabs [data-tab="artifacts"]');
  const btn = panel.locator("#resummarize");
  if (!await btn.count()) return { name, ok: false, kind: "tooling", answer: "no #resummarize button" };
  await panel.evaluate(async () => {
    const db = await import("../db/captures.js");
    const [c] = await db.listCaptures(1);
    await db.updateCapture(c.id, { summary: "" });
  });
  await btn.click();
  await poll(() => btn.isEnabled(), ANSWER_MS);
  const summary = await panel.evaluate(async () => {
    const db = await import("../db/captures.js");
    return (await db.listCaptures(1))[0].summary;
  });
  await panel.click('#tabs [data-tab="chat"]');
  return { name, ok: /harbor|gallery|museum/i.test(summary), kind: "model", answer: summary.slice(0, 160) };
}

// Seed placeholder-backend output, reload the panel, expect it purged.
async function cleanup(panel) {
  const stub = "CPU backendFastest inferenceTopK: 64, Temp: 1System: x End.";
  await panel.evaluate(async (text) => {
    const db = await import("../db/captures.js");
    const chats = await import("../db/chats.js");
    const [c] = await db.listCaptures(1);
    await db.updateCapture(c.id, { summary: text });
    await chats.appendMessage("capture", c.id, { role: "assistant", content: text });
  }, stub);
  await panel.reload();
  await panel.waitForTimeout(2000);
  const left = await panel.evaluate(async (text) => {
    const db = await import("../db/captures.js");
    const chats = await import("../db/chats.js");
    const [c] = await db.listCaptures(1);
    const chat = await chats.getOrCreateChat("capture", c.id);
    return Number(c.summary === text) + chat.messages.filter((m) => m.content === text).length;
  }, stub);
  return { name: "placeholder cleanup", ok: left === 0, kind: "tooling", answer: `${left} stub rows left` };
}

async function poll(fn, ms, every = 500) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, every))) {
    if (await fn().catch(() => false)) return true;
  }
  return false;
}

mkdirSync(OUT, { recursive: true });
try {
  const results = await run();
  const failed = results.filter((r) => !r.ok);
  const by = (k) => failed.filter((r) => r.kind === k).map((r) => r.name);
  console.log(`\n${results.length - failed.length}/${results.length} passed` +
    (by("model").length ? ` · MODEL: ${by("model").join(", ")}` : "") +
    (by("tooling").length ? ` · TOOLING: ${by("tooling").join(", ")}` : ""));
  console.log(failed.length ? "E2E FAIL" : "E2E OK");
  process.exit(failed.length ? 1 : 0);
} catch (err) {
  console.log(`\nTOOLING: ${err.message}`);
  if (!(err instanceof ToolingError)) console.log(err.stack);
  console.log("E2E FAIL (tooling)");
  process.exit(2);
}
