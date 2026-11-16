# chrome-cat

<p align="center"><img src="docs/mascot.gif" width="128" alt="the cat, swishing"></p>

Chat with any page. Locally. The cat helps.

A Chrome side panel that scans the page you're on into letter-size image
tiles, reads the DOM text and OCRs image areas with [Tesseract.js](https://github.com/naptha/tesseract.js)
(vendored, offline), and puts Chrome's built-in model
([Gemini Nano](https://developer.chrome.com/docs/ai/prompt-api)) in front of
the result. No server. No API key. Nothing leaves the machine.

<img width="1872" height="892" alt="image" src="https://github.com/user-attachments/assets/5d693098-1ab9-4cef-958f-d8b3be78172c" />


## Install

**From a release** (fastest):

1. Download the latest zip from [Releases](https://github.com/mbarlow/chrome-cat/releases) and unzip it
2. `chrome://extensions` → Developer mode → **Load unpacked** → the unzipped folder

**From source:**

```
git clone git@github.com:mbarlow/chrome-cat && cd chrome-cat
make vendor icons
```

Then load unpacked from the repo root.

Google Chrome 138+ desktop. Gemini Nano downloads on first use — hit
**download** in the panel header (`chrome://on-device-internals` if it stalls).
Distro Chromium builds (e.g. Arch) ship a placeholder model that only echoes
the prompt; the header flags it.

If the header keeps reporting a Gemini Nano download, press **show progress**.
After 60 seconds without a progress report, **diagnostics** opens
`chrome://on-device-internals`. Its Broker State shows the actual asset and
hardware status. A model stuck at 0% or `Pending Assets` is not ready for chat.
Check that you're using Google Chrome, not the separate Chromium profile.
The tiny-voca voice preview works independently of the chat model download.

## Use it

Hit **Scan page**, then talk:

| Say | Get |
|---|---|
| `what is this about?` | grounded answers from the scanned content |
| `what links are there?` | the page's real URLs, never invented |
| `open the pricing page` | navigates, scans, chat follows |
| `/follow` | crawls the page's links into a series — step it with ◀ ▶ |
| `email the summary` | Gmail compose, prefilled |
| `calendar event for this` | Calendar draft, prefilled |
| `save as pdf` | the scan tiles as a letter-size PDF, one page per tile |
| `email the pdf version` | saves the PDF + opens the draft — one drag attaches |
| `copy that` / `save the chat as markdown` | clipboard / `Downloads/chrome-cat/` |
| `send the summary to vault` | POST to a named webhook (settings) |
| `make a table of the prices` | a table from page text — ⤓ csv, ⤓ json, ⧉ copy |
| `/bookmark` | files the page into your bookmark folders, model-picked |
| `any images on the page?` | the model looks at the actual scan tiles |
| `read it to me` | speaks the answer |

**Scan modes** — **Auto OCR** is the default: keep the scan tiles, read page text
from the DOM, and OCR visible image/canvas/SVG/video/iframe areas once per tile.
Pages with very little DOM text automatically use full OCR. Choose **Full image
OCR** for text in CSS background images, tiny images, or unusual layouts.
Auto mode excludes visual elements smaller than 80 × 40 CSS pixels; their
available DOM labels are still captured. Scan details show elapsed time,
OCR coverage, failures, and whether the image capture hit the 25-viewport cap.

**Cancel** stops a scan and restores the page's scroll and fixed elements;
a running OCR job finishes before cancellation takes effect. Changing the
active tab, URL, or viewport during capture stops the scan. Leave the page
visible while scanning. Lazy-loaded content is read after the scroll pass.

**Artifacts → Run full OCR** reprocesses saved tiles without rescanning. OCR
failures are reported separately and retain previously recognized text. Both
DOM and OCR evidence are searchable; avatar usernames and HTML date labels
are included in DOM text inspection. Rescan older pages to collect these
new labels. Capturing a page does not establish its creation date.

**Memory tab** — chat with everything you've captured, today's history, the
last 7 days, or your bookmarks. Click any item to jump to it with the chat
scoped; pages you've scanned answer with real content.

**Omnibox** — type `cc <query>` in the address bar to search your whole
capture memory and jump straight to a page + its chat.

**Artifacts tab** — every scan's tiles, OCR text, and DOM text: view, copy,
export, re-summarize. The ⤓ button saves any chat as clean markdown.

**Sources** — answers grounded in the page carry ↗ chips under them; click
one to jump to the passage on the live page, highlighted.

**⌗ region** — drag a box on the page (or click an image) and ask about just
that, at full resolution. Labelled images inside it bring their alt text.
Every question uses the region until you hit ✕.

**How it answers** — the model routes each question to page text, a look
at the scan tiles, the page's links, a table, or general knowledge (keyword rules if
it can't). Image questions also get the page's alt text and captions.
"Who painted this" is asked twice independently; agreement is stated,
disagreement is hedged (hover the answer to see both guesses). When the
capture does not establish a page fact, the assistant is instructed to say so.
Unrelated general questions use a labelled general-knowledge answer. Missing
page facts no longer trigger an extra, context-free model call. Recent
exchanges are restored when reopening a chat and included in follow-up prompts.

The pixel cat in the header shows what's happening — idle, scanning,
replying, working. It lives in `src/mascot/mascot.json`; edit the frames,
get a new cat.

## Voice conversation

Voice mode is off by default. In **settings → voice conversation**:

1. Enable **voice mode and spoken replies**.
2. Choose **Female** or **Male** and use **Preview** to hear the cat.
3. Press **Set up** for local English voice input. Chrome may download an
   English speech-recognition pack once; this step needs internet access.
4. Press **Allow microphone**. A setup page opens in a normal browser tab;
   press its **Allow microphone** button and accept Chrome's prompt. The
   setup check releases the microphone immediately without recording audio.
5. Scan a page or select a memory scope, return to **chat**, and press
   **Start conversation**.

Chrome can dismiss microphone permission requests made inside a side panel.
If Chat reports that access needs setup, use its **Allow microphone** button.
If access was previously blocked, the setup page links to Chrome's microphone
settings so you can remove Chrome Cat from the blocked list and retry.

Speak a question and pause. Chrome Cat transcribes it locally, submits it
through the same chat flow, speaks the answer, and listens for your next
question. The transcript and replies remain in the normal chat history.
The microphone is stopped during thinking and playback to avoid feedback.

**Stop voice** stops listening and playback, including a voice still loading.
It also prevents a pending answer from being spoken; the text answer may
still finish. Switching tabs/scopes or closing the panel stops conversation.
After silence or a recognition error, press Start conversation to resume.
Typing `stop` also stops voice; use the Stop voice button to interrupt speech
while the microphone is paused.

Typing remains available. With voice mode on, typed questions also get spoken
replies; turn it off in settings for ordinary text chat. The existing
`read it to me` command uses the selected cat voice when voice mode is on and
the original Chrome TTS path when it is off.

Speech synthesis uses [tiny-voca](https://github.com/n4ze3m/tiny-voca), bundled
with ONNX Runtime Web, Pyodide, and dizione (about 53 MB of additional assets).
No text or audio is uploaded for voice mode. Input requires Chrome's
**on-device** Web Speech API and English language pack. If that feature is
unavailable in your Chrome installation, typed chat with spoken replies
still works; there is no cloud-recognition fallback. Both voices are English
only. Names and unusual spellings may be mispronounced.

Voice assets are included in the branch/package. To restore missing files,
run `make vendor-voice`. Downloads are pinned and checked against
`vendor/voice/sources.json`. `make voice-test` checks cancellation and
turn-taking and runs both real voices offline inside the extension's CSP;
its microphone transcript and chat-model response are simulated. Actual
microphone permission, input-device quality, and recognition accuracy need a
manual check on your machine.

## Webhook receiver in 60 seconds

```
bun run examples/vault-receiver.ts
```

Add `vault → http://localhost:8787/inbox` under settings → webhooks, then
`send the summary to vault`. Every send lands as a markdown file — point
`INBOX_DIR` at your Obsidian inbox and the browser feeds your notes.

## Notes

- Vanilla ES modules, no build step. `make help` for tasks, `make smoke`
  for the headless test, `make e2e` for the real thing: Google Chrome plus
  its Gemini Nano install (copied into a throwaway profile) scans
  `tools/e2e/` and chats through the panel. Failures are tagged TOOLING or
  MODEL; `E2E_RETRIES` (default 1) bounds model retries.
- Everything lives in local IndexedDB — settings shows usage and clears it.
- OCR and voice synthesis use packaged assets, with no runtime CDN requests.
  Chrome's built-in chat model and local speech-recognition pack may need an
  initial download. `make vendor` and `make vendor-voice` fetch pinned assets
  at build time.
- Pinned isn't trusted. Every vendored byte is checksummed in
  `vendor/tesseract/SHA256SUMS`; `make vendor`, `make smoke` and
  `make package` all verify before they proceed. If upstream changes under
  a pinned version, the build stops instead of shipping it.

## License

chrome-cat is [MIT](LICENSE).

`vendor/` is not. It ships Tesseract.js, its WebAssembly core, and Google's
`eng` trained model — all Apache-2.0, redistributed unmodified. The full
attribution list, the Apache text, and the upstream license banners live in
[`vendor/tesseract/NOTICE`](vendor/tesseract/NOTICE). Ship the zip, ship
those files with it — `make package` already does.

Voice dependencies and their license notices are listed in
[`vendor/voice/NOTICE`](vendor/voice/NOTICE). The tiny-voca code and weights are
Apache-2.0; the other bundled components retain their upstream licenses.

## Performance and experience review

[Measured results, screenshots, and limitations](docs/review-2026-11-16/report.md).
Reproduce the capture benchmark with `make profile`; run the UI and failure
checks with `make review`. Set `PROFILE_MODE=auto` or `full`, `PROFILE_RUNS=3`,
and `PROFILE_OUT=/tmp/chrome-cat-profile` as needed. For a live site:

```bash
PROFILE_URL=https://www.foxnews.com PROFILE_MODE=auto PROFILE_RUNS=1 make profile
```

The benchmark uses real Chromium screenshots, IndexedDB, and packaged
Tesseract WASM. It disables the chat model to isolate capture costs. The
review's model replies are simulated to verify prompt construction, streaming,
and history wiring; `make e2e` remains the separate real-model check.
