# chrome-chat

Chat with any page. Locally.

A Chrome side-panel extension. Scans the page you're on into letter-size
image tiles, OCRs them, stores everything in IndexedDB, and puts Chrome's
built-in model (Gemini Nano) in front of it. No server. No API key. Nothing
leaves the machine.

## The loop

Scan the page.
Ask it questions.
Tell it to follow the links.

Each capture becomes part of a domain memory you can search and step through.
The model is the conversationalist. The extension is the hands.

## What a scan produces

- **Tiles** — the page scrolled, stitched on canvas, sliced at 8.5×11 aspect.
  Fixed headers hidden after frame one, so they appear exactly once.
- **OCR text** — every tile through a vendored Tesseract.js worker,
  sequentially, offline.
- **DOM text + links** — extracted in the same pass as ground truth.

All three land in IndexedDB. The artifacts tab views and exports them.

## What the chat can do

- **Answer from the page.** Each question retrieves the most relevant chunks
  (TF-IDF, plain JS) plus the previous turn, so follow-ups stay on topic.
  Page facts stay grounded in captured content. General-knowledge answers are
  labeled "(general knowledge)".
- **Cite real links.** Link questions get the page's stored URLs, never
  invented ones.
- **Look at the page.** Visual questions ("any images?", "what does the chart
  show?") feed the scan tiles to the multimodal model.
- **Act.** "open the pricing page" matches the stored links, opens the tab,
  scans it, and re-scopes the chat to it. Deterministic code does the
  matching — the model never picks a URL.
- **Crawl.** `/follow` walks the page's links in a dedicated background
  window, one by one, building a series. Step through it with ◀ ▶ or chat
  across the whole set with `all`.
- **Send it somewhere.** "email the summary" opens Gmail compose, prefilled.
  "calendar event for this" drafts the event. "new doc with the ocr" creates
  the Doc with the body on your clipboard — Docs has no URL prefill, so
  clipboard is the adapter. "copy that" and "save the chat as markdown"
  (lands in `Downloads/chrome-chat/<domain>/`) cover everything else.
  Payloads: the summary, the ocr, the dom text, the links, the chat, or the
  last answer.
- **Feed your local mesh.** Name a webhook in settings ("vault" →
  `http://localhost:8787/inbox`), then "send the summary to vault" POSTs
  `{source, kind, title, url, ts, content}` as JSON. Localhost needs no
  extra permission; remote URLs use the all-sites grant. A ten-line receiver
  turns this into an Obsidian inbox, a message bus, anything — see the
  quickstart below.
- **PDF from the scans.** "save as pdf" assembles the letter-aspect tiles
  into a real PDF, one page per tile — pixel-true, built by hand, no
  library. It composes: "email the pdf version" saves the PDF and opens the
  Gmail draft with the summary; you drag the file in (no API can attach to
  compose — that last drag is the platform's boundary, not ours). Works on
  a single page or a whole series.

- **Chat with everything.** The memory tab's "chat with everything" button
  scopes the chat to your entire capture history — retrieval runs across all
  pages, excerpts labeled by title. Ask questions that span domains.
- **Read it aloud.** "read it to me", "read the summary" — `chrome.tts`
  speaks it. "stop" stops.

- **Chat with your history or bookmarks.** Memory tab → "today's history",
  "last 7 days", or "bookmarks". Items are title/url-light — but any URL
  you've scanned gets its capture summary cross-referenced in, so the more
  you scan, the smarter these chats get. "open the rust article" navigates
  from here too.
- **`/bookmark`** files the current page into your existing bookmark tree:
  the local model picks the folder (constrained to real folder ids), keyword
  overlap picks when the model can't, and a `chrome-chat` folder catches the
  rest. Dupes are reported, never re-created.

One more way in — the **omnibox**: type `cc <query>` in the address bar.
Suggestions come from your capture memory; picking one navigates to that
page and opens the panel with its chat scoped. Plain enter drops you into
memory-wide chat with the query staged.

The system prompt is editable in settings. It's your assistant; tune it.

## The cat

A monochrome pixel cat lives in the header and reflects what the extension
is doing: sits and swishes when idle, crouches while scanning, head-bobs
while the model streams, stands and bats at things during crawls and sends.
Left alone it blinks, occasionally swats, stretches, pounces — and falls
asleep after 45s.

The whole mascot is `src/mascot/mascot.json`: ASCII pixel frames, per-state
fps, behavior weights, sleep timeout. Edit strings, reload, new cat. The
engine (`src/mascot/mascot.js`) just plays whatever the JSON defines —
swap the file to swap the mascot.

## Requirements

Chrome 138+ desktop.
Gemini Nano downloads on first use — `chrome://on-device-internals` if stuck.
Current-tab scans use `activeTab`; crawling asks for all-sites at runtime.

## Install

```
make vendor   # fetch pinned Tesseract.js into vendor/ (committed)
make icons    # regenerate PNGs from icons/icon.svg (needs rsvg-convert)
make smoke    # headless boot + OCR + IDB check (needs global playwright)
```

Load unpacked from the repo root at `chrome://extensions/`, Developer mode on.

## Webhook receiver quickstart

Five minutes from zero to page-summaries landing in a folder.

```
curl -fsSL https://bun.sh/install | bash     # 1. get bun (skip if installed)
git clone git@github.com:mbarlow/chrome-chat # 2. clone
cd chrome-chat && make vendor && make icons  # 3. build assets
                                             # 4. load unpacked (see Install)
bun run examples/vault-receiver.ts           # 5. start the receiver
```

Then in the side panel:

```
settings → webhooks → add:  vault  http://localhost:8787/inbox
chat → scan a page → "send the summary to vault"
```

Every send lands as a markdown file in `./inbox/` — set `INBOX_DIR` to your
Obsidian vault's inbox and the browser feeds your notes. The receiver is 30
lines; swap `Bun.write` for anything: message bus, database, another API.

## Architecture

Vanilla ES modules. No build step. No framework.
One exception: `vendor/tesseract/tesseract.min.js` is UMD — Tesseract.js has
no ESM dist.

The MV3 service worker does one thing: open the panel on toolbar click.
Everything else runs in the side panel, because the worker sleeps and the
panel doesn't. Page code is injected on demand via `chrome.scripting` — no
declared content scripts.

Two constraints shaped the design:

- `captureVisibleTab` only captures a window's *active* tab. So the crawler
  gets its own unfocused window instead of a background tab in yours.
- MV3 CSP forbids blob workers. So Tesseract runs with
  `workerBlobURL: false` from the extension origin, under `wasm-unsafe-eval`.

```
src/
  background/   service worker: panel-on-click, nothing else
  capture/      injected page functions, scroll-and-stitch scanner,
                letter-tile slicer, pipeline orchestrator
  ocr/          Tesseract engine: lazy singleton worker, serialized queue
  ai/           LanguageModel wrapper, chat sessions, prompts, summarizer,
                TF-IDF retrieval, vision
  crawl/        link crawler (dedicated window)
  db/           IndexedDB: captures, tiles, series, chats, domains
  sidepanel/    chat / artifacts / memory / settings views
vendor/         pinned Tesseract.js + wasm cores + eng traineddata
tools/          make smoke — headless extension boot + OCR + IDB test
```

## Storage

Everything is local IndexedDB. Tiles are PNG blobs; a big crawl reaches tens
of MB. Settings shows usage and has clear-all.

## Privacy

No network at runtime.
No analytics.
The model runs on-device. `make vendor` is the only thing that touches a CDN
— at build time, pinned.
