// Minimal, escape-first markdown for model answers: code, bold, italic,
// http(s) links, headings and bullets. Line breaks are left to pre-wrap.

import { escapeHtml } from "./text.js";

function inline(s) {
  return s
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

function line(l) {
  const heading = l.match(/^#{1,6}\s+(.*)$/);
  if (heading) return `<strong>${inline(heading[1])}</strong>`;
  const bullet = l.match(/^(\s*)[*-]\s+(.*)$/);
  if (bullet) return `${bullet[1]}• ${inline(bullet[2])}`;
  return inline(l);
}

// Returns safe HTML. Unclosed fences (mid-stream) render as code to the end.
export function renderMarkdown(text) {
  return escapeHtml(text)
    .split(/^```[^\n]*\n?/m)
    .map((part, i) => (i % 2
      ? `<pre><code>${part.replace(/\n$/, "")}</code></pre>`
      : part.split("\n").map(line).join("\n")))
    .join("");
}
