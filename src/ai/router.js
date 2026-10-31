// Decide which path answers a question: page text, a look at the scan tiles,
// the page's links, or general knowledge. The model classifies with a
// constrained one-word reply; keyword rules are the fallback when it can't.

import { createAiSession, assertRealOutput } from "./language-model.js";

export const ROUTES = ["text", "vision", "links", "general"];

const VISION_WORDS = /\b(images?|pictures?|photos?|photographs?|paintings?|painted|artworks?|portraits?|illustrations?|drawings?|screenshots?|charts?|graphs?|diagrams?|logos?|icons?|layout|visual(ly)?|colou?rs?|design|looks? like|recogni[sz]e|pictured|(can|do) you see|what do you see)\b/i;
const LINK_WORDS = /\b(links?|urls?|sources?|href|cite|citation|address(es)?)\b/i;

const SYSTEM =
  "You route questions about a web page the user scanned. Reply with exactly one word:\n" +
  "text — answered by what the page says (facts, names, summary, its wording)\n" +
  "vision — needs to look at the page: images, paintings, photos, who painted or made " +
  "something shown, layout, colors, design, what something looks like\n" +
  "links — asks for the page's links, URLs or sources\n" +
  "general — world knowledge that has nothing to do with this page";

const EXAMPLES = [
  ["what is this page about?", "text"],
  ["who painted the portrait?", "vision"],
  ["what color is the header?", "vision"],
  ["list the links", "links"],
  ["how tall is mount everest?", "general"],
  ["when does the store open?", "text"]
];

export function routeByKeywords(question) {
  if (VISION_WORDS.test(question)) return "vision";
  if (LINK_WORDS.test(question)) return "links";
  return "text";
}

export class Router {
  constructor() {
    this.base = null;
  }

  async _session() {
    if (!this.base) {
      this.base = createAiSession({ systemPrompt: SYSTEM }).then(async (s) => {
        await s.append?.(EXAMPLES.flatMap(([q, r]) => [
          { role: "user", content: q }, { role: "assistant", content: r }
        ]));
        return s;
      }).catch((err) => { this.base = null; throw err; });
    }
    const base = await this.base;
    return base.clone ? { s: await base.clone(), own: true } : { s: base, own: false };
  }

  // previous: the prior question, so "when was that made?" inherits its topic.
  async route(question, { previous } = {}) {
    let session;
    try {
      session = await this._session();
      const prompt = previous ? `Previous question: ${previous}\nQuestion: ${question}` : question;
      const out = assertRealOutput(await session.s.prompt(prompt, {
        responseConstraint: { type: "string", enum: ROUTES }
      }));
      const route = String(out).replace(/"/g, "").trim();
      return ROUTES.includes(route) ? route : routeByKeywords(question);
    } catch {
      return routeByKeywords(question);
    } finally {
      if (session?.own) try { session.s.destroy?.(); } catch { /* ignore */ }
    }
  }

  destroy() {
    this.base?.then((s) => s.destroy?.()).catch(() => {});
    this.base = null;
  }
}
