// Extracted tables: CSV / JSON / markdown forms and downloads under
// Downloads/chrome-cat/<domain>/.

import { slug, stamp } from "./send.js";

const csvCell = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function toCsv({ columns, rows }) {
  return [columns, ...rows].map((r) => r.map((v) => csvCell(String(v))).join(",")).join("\n") + "\n";
}

// Rows as objects keyed by column name.
export function toJson({ columns, rows }) {
  return JSON.stringify(rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]]))), null, 2) + "\n";
}

export function toMarkdownTable({ columns, rows }) {
  const cell = (v) => String(v).replace(/\|/g, "\\|").replace(/\n/g, " ");
  const line = (r) => `| ${r.map(cell).join(" | ")} |`;
  return [line(columns), line(columns.map(() => "---")), ...rows.map(line)].join("\n");
}

// format: "csv" | "json". Returns the download path under Downloads/.
export async function downloadTable(table, format, { domain = "page", title = "table" } = {}) {
  const body = format === "json" ? toJson(table) : toCsv(table);
  const type = format === "json" ? "application/json" : "text/csv";
  const filename = `chrome-cat/${domain}/table-${slug(title)}-${stamp()}.${format}`;
  const url = URL.createObjectURL(new Blob([body], { type }));
  try {
    await chrome.downloads.download({ url, filename });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
  return filename;
}
