// All prompt text in one place.

// Two-tier grounding: page facts stay grounded in captured content, but
// general-knowledge questions may use the model's own knowledge, labeled.
export const DEFAULT_SYSTEM_BASE =
  "You are a local assistant chatting about captured web pages. " +
  "Prefer answering from the page content provided in each message, and only " +
  "cite URLs, numbers, or quotes that appear there. " +
  "If the question is general knowledge the page does not cover, answer from " +
  "your own knowledge and begin that answer with \"(general knowledge)\". " +
  "If you can do neither, say so plainly. Be concise.";

// scope: { type: "capture", capture } | { type: "series", series, captures[] }
//        | { type: "memory", captures[] }
// base: the (possibly user-edited) system prompt from settings.
export function buildSystemPrompt(scope, base = DEFAULT_SYSTEM_BASE) {
  if (scope.type === "capture") {
    const c = scope.capture;
    return `${base}\n\nCurrent page: "${c.title}" (${c.url}), captured ${new Date(c.ts).toISOString().slice(0, 16)}.` +
      (c.summary ? `\nPage summary: ${c.summary}` : "");
  }
  if (scope.type === "history") {
    return `${base}\n\nYou are chatting about the user's browser history (${scope.label || "recent"}): ` +
      `${scope.captures.length} pages. Excerpts carry title, url, and visit info; pages the user ` +
      "scanned also carry a summary. Answer from the excerpts provided per question.";
  }
  if (scope.type === "bookmarks") {
    return `${base}\n\nYou are chatting about the user's bookmarks: ${scope.captures.length} entries. ` +
      "Excerpts carry title, url, and folder. Answer from the excerpts provided per question.";
  }
  if (scope.type === "memory") {
    const byDomain = new Map();
    for (const c of scope.captures) byDomain.set(c.domain, (byDomain.get(c.domain) || 0) + 1);
    const domains = [...byDomain.entries()].map(([d, n]) => `${d} (${n})`).join(", ");
    return `${base}\n\nYou are chatting about the user's entire capture memory: ` +
      `${scope.captures.length} pages across ${byDomain.size} domains: ${domains}. ` +
      "Excerpts are labeled with their page title.";
  }
  const lines = scope.captures.map((c, i) =>
    `${i + 1}. "${c.title}" — ${c.url}${c.summary ? ` — ${firstSentence(c.summary)}` : ""}`);
  return `${base}\n\nYou are chatting about a series of ${scope.captures.length} captured pages:\n${lines.join("\n")}`;
}

export function buildQuestionPrompt(question, excerpts, links = []) {
  const parts = [];
  if (excerpts.length) {
    const body = excerpts.map((e) =>
      e.label ? `[${e.label}]\n${e.text}` : e.text).join("\n\n---\n\n");
    parts.push(`[Relevant page excerpts]\n${body}`);
  }
  if (links.length) {
    const body = links.map((l) =>
      l.text ? `- ${l.text} — ${l.href}` : `- ${l.href}`).join("\n");
    parts.push(`[Page links]\n${body}`);
  }
  if (!parts.length) return question;
  return `${parts.join("\n\n")}\n\n[Question]\n${question}`;
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
