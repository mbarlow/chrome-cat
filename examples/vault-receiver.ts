// chrome-chat webhook receiver — lands every send as a markdown file.
//
//   bun run examples/vault-receiver.ts
//
// Env:
//   INBOX_DIR  where files land (default ./inbox — point it at your vault)
//   PORT       default 8787
//
// Then in the extension: settings → webhooks → add
//   name: vault   url: http://localhost:8787/inbox
// and in chat: "send the summary to vault"

const DIR = process.env.INBOX_DIR ?? "./inbox";
const PORT = Number(process.env.PORT ?? 8787);

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "untitled";

Bun.serve({
  port: PORT,
  async fetch(req) {
    if (req.method !== "POST") {
      return new Response("chrome-chat receiver — POST me", { status: 200 });
    }
    const m = await req.json();
    const stamp = new Date(m.ts ?? Date.now()).toISOString().slice(0, 16).replace(/[:T]/g, "-");
    const file = `${DIR}/${stamp}-${slug(m.title)}.md`;
    await Bun.write(
      file,
      `# ${m.title}\n\n> source: ${m.url}\n> kind: ${m.kind}\n> received: ${new Date().toISOString()}\n\n${m.content}\n`
    );
    console.log(`✓ ${file}`);
    return new Response("ok");
  }
});

console.log(`chrome-chat receiver on http://localhost:${PORT} → ${DIR}/`);
