// All prompt text in one place.

export const CHAT_SYSTEM_BASE =
  "You are a local assistant chatting about captured web pages. " +
  "Answer only from the page content provided in each message. " +
  "If the answer is not in the provided content, say so plainly. " +
  "Be concise. Never invent URLs, numbers, or quotes.";

// scope: { type: "capture", capture } | { type: "series", series, captures[] }
export function buildSystemPrompt(scope) {
  if (scope.type === "capture") {
    const c = scope.capture;
    return `${CHAT_SYSTEM_BASE}\n\nCurrent page: "${c.title}" (${c.url}), captured ${new Date(c.ts).toISOString().slice(0, 16)}.` +
      (c.summary ? `\nPage summary: ${c.summary}` : "");
  }
  const lines = scope.captures.map((c, i) =>
    `${i + 1}. "${c.title}" — ${c.url}${c.summary ? ` — ${firstSentence(c.summary)}` : ""}`);
  return `${CHAT_SYSTEM_BASE}\n\nYou are chatting about a series of ${scope.captures.length} captured pages:\n${lines.join("\n")}`;
}

export function buildQuestionPrompt(question, excerpts) {
  if (!excerpts.length) return question;
  const body = excerpts.map((e) =>
    e.label ? `[${e.label}]\n${e.text}` : e.text).join("\n\n---\n\n");
  return `[Relevant page excerpts]\n${body}\n\n[Question]\n${question}`;
}

export function buildSummaryPrompt(title, url, text) {
  return `Summarize this web page in at most 4 sentences, then list 5 keywords.\n` +
    `Format:\nSUMMARY: <sentences>\nKEYWORDS: <comma-separated>\n\n` +
    `Page: "${title}" (${url})\n\nContent:\n${text}`;
}

export function buildRollupPrompt(domain, pageSummaries) {
  return `These are summaries of pages captured from the site ${domain}. ` +
    `Write a 2-3 sentence rollup of what this site/section covers.\n\n` +
    pageSummaries.map((s, i) => `${i + 1}. ${s}`).join("\n");
}

export function firstSentence(s) {
  const m = String(s || "").match(/^.*?[.!?](\s|$)/);
  return (m ? m[0] : String(s || "").slice(0, 140)).trim();
}
