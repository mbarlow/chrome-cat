// Outbound sinks: get chat output and artifacts where they're needed.
// Same doctrine as navigation — the model never executes these; anchored
// intent + deterministic dispatch. Composer URLs are the doors the apps
// already ship (Gmail/Calendar prefill); clipboard is the universal adapter
// for everything else (Docs renders to canvas — injection is a dead end).

import { getOrCreateChat } from "../db/chats.js";

// Composer URLs cap around 8k; leave room for encoding overhead.
const URL_BODY_CAP = 5500;

const enc = encodeURIComponent;

// ---- intent parsing ----

const SEND_START = /^\/?(?:email|mail|send|copy|save|download|calendar|event|new doc|doc)\b/i;

// question -> { sink, kind } | null. sink may be null ("send this" with no
// destination) — caller lists the options.
export function parseSendCommand(question) {
  // A trailing "?" is a question for the model ("email addresses on the
  // page?"), not a command.
  if (/\?\s*$/.test(question)) return null;
  if (!SEND_START.test(question)) return null;
  let sink = null;
  if (/(gmail|e-?mail|^\/?mail\b)/i.test(question)) sink = "email";
  else if (/(calendar|event)/i.test(question)) sink = "calendar";
  else if (/\bdocs?\b/i.test(question)) sink = "doc";
  else if (/^\/?copy\b|clipboard/i.test(question)) sink = "copy";
  else if (/markdown|\bmd\b|^\/?(save|download)\b/i.test(question)) sink = "markdown";
  return { sink, kind: parsePayloadKind(question) };
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

function slug(s) {
  return String(s || "page").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
}

function stamp(ts = Date.now()) {
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
    text = chat.messages.map((m) => `**${m.role}:** ${m.content}`).join("\n\n") || "(empty chat)";
  } else {
    const chat = await getOrCreateChat(scope.type, scope.id);
    const last = [...chat.messages].reverse().find((m) => m.role === "assistant");
    text = last?.content || first.summary || "(nothing to send yet)";
  }
  return {
    title,
    url: first.url,
    text,
    header: `# ${title}\n\n> source: ${first.url}\n> captured: ${new Date(first.ts).toISOString()}\n\n`
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
  const filename = `chrome-chat/${domain}/${slug(captures[0].title)}-${stamp()}.md`;
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

const SINKS = {
  email: (p) => toEmail(p),
  calendar: (p) => toCalendar(p),
  doc: (p) => toDoc(p),
  copy: (p) => toClipboard(p),
  markdown: (p, captures) => toMarkdown(p, captures)
};

export const SINK_HELP =
  "where to? try: email / calendar / doc / copy / save as markdown — " +
  "with: the summary, the ocr, the dom text, the links, the chat, or the last answer";

// Full dispatch. Returns the note to show, or throws.
export async function dispatchSend({ sink, kind }, scope, captures) {
  if (!sink) return SINK_HELP;
  const payload = await buildPayload(kind, scope, captures);
  return SINKS[sink](payload, captures);
}
