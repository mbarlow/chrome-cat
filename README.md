# chrome-chat

Chat with any page — locally. A Chrome side-panel extension that scans the
current page into letter-size image tiles, OCRs them, stores everything in
IndexedDB, and lets you converse about the content using Chrome's built-in
model (Gemini Nano). Follow a page's links to build a browsable series and
chat across the whole set. Nothing leaves the machine.

## How it works

1. **Scan** — the page is scrolled viewport-by-viewport and captured with
   `captureVisibleTab`, stitched on an OffscreenCanvas, and sliced into
   letter-aspect (8.5×11) PNG tiles. Fixed/sticky headers are hidden after the
   first frame so they appear exactly once. DOM text and links are extracted
   in the same pass as ground truth.
2. **OCR** — each tile runs through a vendored Tesseract.js worker,
   sequentially, fully offline. Tiles, OCR text, and DOM text all land in
   IndexedDB (`chrome-chat` database) — inspect or export them from the
   artifacts tab.
3. **Chat** — after a scan, ask questions. A summary is generated per capture;
   each question (plus the previous turn, so follow-ups stay on topic)
   retrieves the most relevant text chunks (TF-IDF, plain JS) and streams an
   answer from the local model. Page facts stay grounded in captured content;
   general-knowledge answers are labeled "(general knowledge)". Questions
   about links get the page's stored URLs; visual questions ("any images?",
   "what does the chart show?") are answered by feeding the scan tiles to the
   multimodal model. The system prompt is editable in settings.
4. **Follow links** — type `/follow` (or hit the button). A dedicated
   unfocused window walks the page's links one by one, running the same
   scan → OCR → summarize pipeline per page into a **series**. Step through
   pages with ◀ ▶, or hit `all` to chat across the whole series.
5. **Memory** — every capture is indexed by domain and path depth, with
   local-model summaries per page and per domain. The memory tab searches the
   whole space.

## Requirements

- Chrome 138+ desktop. The built-in model (Gemini Nano) downloads on first
  use — check `chrome://on-device-internals` if it stalls.
- Scanning the current tab works with `activeTab`; crawling asks for the
  optional all-sites permission at runtime.

## Install

```
make vendor   # fetch pinned Tesseract.js files into vendor/ (committed)
make icons    # regenerate PNGs from icons/icon.svg (needs rsvg-convert)
make install  # prints the load-unpacked steps
```

Load unpacked from the repo root at `chrome://extensions/` (Developer mode).

## Architecture

- Vanilla JS ES modules, no build step, no bundler. The one exception:
  `vendor/tesseract/tesseract.min.js` is a UMD script loaded before the module
  graph (Tesseract.js has no ESM dist).
- The MV3 service worker does exactly one thing: open the side panel on
  toolbar click. Everything else — capture, OCR, DB, LLM sessions, crawling —
  runs in the side panel, which stays alive while open (the worker doesn't).
- Page code is injected on demand via `chrome.scripting`; there are no
  declared content scripts.
- The crawler uses a dedicated unfocused window because `captureVisibleTab`
  only captures a window's *active* tab — a background tab in your window
  can't be captured without stealing focus.
- `wasm-unsafe-eval` CSP + `workerBlobURL: false` is what lets Tesseract's
  wasm worker run under MV3.

```
src/
  background/   service worker (panel-on-click, nothing else)
  capture/      injected page functions, scroll-and-stitch scanner,
                letter-tile slicer, capture pipeline orchestrator
  ocr/          Tesseract engine (lazy singleton worker, serialized queue)
  ai/           LanguageModel wrapper, chat session manager, prompts,
                summarizer, TF-IDF retrieval
  crawl/        link-following crawler (dedicated window)
  db/           IndexedDB: captures, tiles (blobs), series, chats, domains
  sidepanel/    shell + chat / artifacts / memory / settings views
vendor/         pinned Tesseract.js + wasm cores + eng traineddata
```

## Storage

Everything is local IndexedDB. Tiles are stored as PNG blobs — a big crawl can
reach tens of MB. The settings tab shows usage and has a clear-all.

## Privacy

No network calls at runtime. No analytics. The model runs on-device. `make
vendor` is the only thing that ever touches a CDN, at build time, pinned.
