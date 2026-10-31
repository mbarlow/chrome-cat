// Outbound sinks: get chat output and artifacts where they're needed.
// Same doctrine as navigation — the model never executes these; anchored
// intent + deterministic dispatch. Composer URLs are the doors the apps
// already ship (Gmail/Calendar prefill); clipboard is the universal adapter
// for everything else (Docs renders to canvas — injection is a dead end).

import { getOrCreateChat } from "../db/chats.js";
import { getTiles } from "../db/captures.js";
import { buildPdf } from "./pdf.js";
import { WEBHOOK_TIMEOUT_MS } from "../shared/constants.js";

// Composer URLs cap around 8k; leave room for encoding overhead.
const URL_BODY_CAP = 5500;

const enc = encodeURIComponent;

// ---- intent parsing ----

const SEND_START =
  /^\/?(?:email|mail|send|post|push|copy|save|download|calendar|event|new doc|doc|pdf|read|speak|say|stop)\b|^\/?(?:make|create)\b.*\b(?:pdf|docs?|calendar|event)\b/i;

// question -> { sink, kind, question } | null. sink may be null ("send this
// to vault") — dispatch resolves it against the named webhooks, or lists
// the options.
export function parseSendCommand(question) {
  // A trailing "?" is a question for the model ("email addresses on the
  // page?"), not a command.
  if (/\?\s*$/.test(question)) return null;
  if (!SEND_START.test(question)) return null;
  let sink = null;
  if (/^\/?stop\b/i.test(question)) sink = "tts-stop";
  else if (/^\/?(read|speak|say)\b/i.test(question)) sink = "tts";
  else if (/(gmail|e-?mail|^\/?mail\b)/i.test(question)) sink = "email";
  else if (/(calendar|event)/i.test(question)) sink = "calendar";
  else if (/\bdocs?\b/i.test(question)) sink = "doc";
  else if (/^\/?copy\b|clipboard/i.test(question)) sink = "copy";
  else if (/markdown|\bmd\b|^\/?(save|download)\b/i.test(question)) sink = "markdown";
  // pdf composes: "save as pdf" downloads it, "email the pdf version"
  // downloads + opens the draft to drag it into.
  const pdf = /\bpdf\b/i.test(question);
  return { sink, kind: parsePayloadKind(question), question, pdf };
}

// "send the summary to vault" -> the webhook named "vault".
export function matchWebhook(question, webhooks) {
  const q = question.toLowerCase();
  return webhooks.find((w) =>
    new RegExp(`\\b${w.name.toLowerCase().replace(/[^a-z0-9]+/g, "\\W*")}\\b`).test(q)) || null;
}

export function parsePayloadKind(question) {
  if (/\bsummar/i.test(question)) return "summary";
  if (/\bocr\b/i.test(question)) return "ocr";
  if (/\bdom\b|page text/i.test(question)) return "dom";
  if (/\b(chat|transcript|conversation|thread)\b/i.test(question)) return "chat";
  if (/\blinks?\b/i.test(question)) return "links";
  return "last"; // last assistant answer
}

// ---- payload assembly ----

export function slug(s) {
  return String(s || "page").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
}

export function stamp(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 16).replace(/[:T]/g, "-");
}

// scope: { type, id } for the chat transcript; captures: resolved rows.
export async function buildPayload(kind, scope, captures) {
  const first = captures[0];
  const title = captures.length > 1 ? `${first.title} (+${captures.length - 1} more pages)` : first.title;
  let text = "";
  if (kind === "summary") {
    text = captures.map((c) => (captures.length > 1 ? `## ${c.title}\n${c.summary}` : c.summary))
      .filter(Boolean).join("\n\n") || "(no summary yet)";
  } else if (kind === "ocr") {
    text = captures.map((c) => c.ocrText).filter(Boolean).join("\n\n===\n\n") || "(no OCR text)";
  } else if (kind === "dom") {
    text = captures.map((c) => c.domText).filter(Boolean).join("\n\n===\n\n") || "(no DOM text)";
  } else if (kind === "links") {
    text = captures.flatMap((c) => c.links || [])
      .map((l) => (l.text ? `- ${l.text} — ${l.href}` : `- ${l.href}`)).join("\n") || "(no links)";
  } else if (kind === "chat") {
    const chat = await getOrCreateChat(scope.type, scope.id);
    text = chat.messages.map((m) => {
      const who = m.role === "user" ? "You" : "Chrome Cat";
      const when = m.ts ? ` · ${new Date(m.ts).toLocaleString()}` : "";
      return `**${who}**${when}\n\n${m.content}`;
    }).join("\n\n---\n\n") || "(empty chat)";
  } else {
    const chat = await getOrCreateChat(scope.type, scope.id);
    const last = [...chat.messages].reverse().find((m) => m.role === "assistant");
    text = last?.content || first.summary || "(nothing to send yet)";
  }
  const heading = kind === "chat" ? `Chat: ${title}` : title;
  return {
    title,
    kind,
    url: first.url,
    text,
    header: `# ${heading}\n\n> source: ${first.url}\n> captured: ${new Date(first.ts).toISOString()}\n\n`
  };
}

// ---- sinks ----
// Each returns a human note for the chat bubble.

export async function toEmail(payload) {
  const { body, truncated } = await capForUrl(payload);
  await chrome.tabs.create({
    url: `https://mail.google.com/mail/?view=cm&fs=1&su=${enc(payload.title)}&body=${enc(body)}`
  });
  return `opened Gmail compose${truncated ? " (body truncated — full text on clipboard)" : ""}`;
}

export async function toCalendar(payload) {
  const { body, truncated } = await capForUrl(payload);
  await chrome.tabs.create({
    url: `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${enc(payload.title)}&details=${enc(body)}`
  });
  return `opened Calendar event draft${truncated ? " (details truncated — full text on clipboard)" : ""}`;
}

// Docs has no body prefill and the editor is canvas — body goes to the
// clipboard, one Ctrl+V lands it.
export async function toDoc(payload) {
  await navigator.clipboard.writeText(payload.header + payload.text);
  await chrome.tabs.create({
    url: `https://docs.google.com/document/create?title=${enc(payload.title)}`
  });
  return "opened a new Doc — body is on your clipboard, Ctrl+V to land it";
}

export async function toClipboard(payload) {
  await navigator.clipboard.writeText(payload.text);
  return `copied ${payload.text.length.toLocaleString()} chars`;
}

export async function toMarkdown(payload, captures) {
  const domain = captures[0].domain || "page";
  const prefix = payload.kind === "chat" ? "chat-" : "";
  const filename = `chrome-cat/${domain}/${prefix}${slug(captures[0].title)}-${stamp()}.md`;
  const url = URL.createObjectURL(new Blob([payload.header + payload.text], { type: "text/markdown" }));
  try {
    await chrome.downloads.download({ url, filename });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
  return `saved ${filename}`;
}

async function capForUrl(payload) {
  const source = `${payload.text}\n\n— ${payload.url}`;
  if (source.length <= URL_BODY_CAP) return { body: source, truncated: false };
  await navigator.clipboard.writeText(payload.header + payload.text).catch(() => {});
  return { body: `${source.slice(0, URL_BODY_CAP)}…\n\n— ${payload.url}`, truncated: true };
}

// POST to a named webhook — the local-mesh sink. Localhost is a first-class
// host permission; remote hooks need the runtime <all_urls> grant.
export async function toWebhook(payload, hook, kind) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const res = await fetch(hook.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ctl.signal,
      body: JSON.stringify({
        source: "chrome-chat",
        kind,
        title: payload.title,
        url: payload.url,
        ts: Date.now(),
        content: payload.text
      })
    });
    if (!res.ok) throw new Error(`${hook.name} answered ${res.status}`);
    return `sent ${kind} to ${hook.name}`;
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`${hook.name} timed out after ${WEBHOOK_TIMEOUT_MS / 1000}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ---- tts: "read it to me" ----

export function toSpeech(payload) {
  chrome.tts.stop();
  chrome.tts.speak(payload.text.slice(0, 8000), { rate: 1.05, enqueue: false });
  return `reading aloud (${Math.min(payload.text.length, 8000).toLocaleString()} chars) — say "stop" to stop`;
}

const SINKS = {
  email: (p) => toEmail(p),
  calendar: (p) => toCalendar(p),
  doc: (p) => toDoc(p),
  copy: (p) => toClipboard(p),
  markdown: (p, captures) => toMarkdown(p, captures),
  tts: (p) => toSpeech(p)
};

// ---- pdf: assemble the letter-aspect tiles, page per tile ----

async function downloadPdf(payload, captures) {
  const tileSets = await Promise.all(captures.map((c) => getTiles(c.id)));
  const blobs = tileSets.flat().map((t) => t.blob);
  if (!blobs.length) throw new Error("no scan tiles in this scope — rescan the page");
  const pdfBlob = await buildPdf(blobs);
  const domain = captures[0].domain || "page";
  const filename = `chrome-cat/${domain}/${slug(captures[0].title)}-${stamp()}.pdf`;
  const url = URL.createObjectURL(pdfBlob);
  try {
    await chrome.downloads.download({ url, filename });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
  return { filename, pages: blobs.length };
}

export async function toPdf(payload, captures) {
  const { filename, pages } = await downloadPdf(payload, captures);
  return `saved ${filename} (${pages} pages)`;
}

// No API can attach a file to Gmail compose — the draft opens prefilled and
// the fresh PDF sits at the top of Downloads, one drag away.
export async function toEmailPdf(payload, captures) {
  const { filename, pages } = await downloadPdf(payload, captures);
  const body =
    `${payload.text.slice(0, 1500)}\n\n` +
    `[PDF scan: ${pages} pages — saved to Downloads/${filename}. Drag it into this draft to attach.]\n\n— ${payload.url}`;
  await chrome.tabs.create({
    url: `https://mail.google.com/mail/?view=cm&fs=1&su=${enc(payload.title)}&body=${enc(body)}`
  });
  return `saved ${filename} (${pages} pages) and opened Gmail — drag the PDF from Downloads into the draft`;
}

export function sinkHelp(webhooks = []) {
  const hooks = webhooks.length ? ` / ${webhooks.map((w) => w.name).join(" / ")}` : "";
  return `where to? try: email / calendar / doc / copy / save as markdown${hooks} — ` +
    "with: the summary, the ocr, the dom text, the links, the chat, or the last answer";
}

// Full dispatch. Returns the note to show, or throws.
export async function dispatchSend({ sink, kind, question, pdf }, scope, captures, webhooks = []) {
  if (sink === "tts-stop") {
    chrome.tts.stop();
    return "stopped";
  }
  const payload = await buildPayload(pdf && kind === "last" ? "summary" : kind, scope, captures);
  if (pdf) {
    return sink === "email" ? toEmailPdf(payload, captures) : toPdf(payload, captures);
  }
  if (!sink) {
    const hook = matchWebhook(question || "", webhooks);
    if (!hook) return sinkHelp(webhooks);
    return toWebhook(payload, hook, kind);
  }
  return SINKS[sink](payload, captures);
}
