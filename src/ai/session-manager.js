// Chat session lifecycle. One live session, scoped to a capture or series;
// scope switches destroy and rebuild (Nano's context is small — stale page
// context is worse than a cold start). Rebuilds silently past the quota line.

import { createAiSession, streamPrompt, sessionUsage } from "./language-model.js";
import { buildSystemPrompt, buildQuestionPrompt } from "./prompts.js";
import { selectExcerpts } from "./retrieval.js";
import { QUOTA_REBUILD_AT, MAX_CONTEXT_LINKS, getSettings } from "../shared/constants.js";
import { normalizeUrl } from "../shared/url.js";

const LINK_INTENT = /\b(links?|urls?|sources?|href|cite|citation|address(es)?)\b/i;

export class ChatSessionManager {
  constructor() {
    this.scope = null;      // { type, capture } | { type, series, captures }
    this.session = null;
    this._creating = null;
    this.recentTurns = [];  // carried across a quota rebuild
  }

  setScope(scope) {
    this.scope = scope;
    this.recentTurns = [];
    this.destroy();
  }

  destroy() {
    try { this.session?.destroy?.(); } catch { /* ignore */ }
    this.session = null;
    this._creating = null;
  }

  usage() {
    return sessionUsage(this.session);
  }

  async _ensureSession({ onDownload } = {}) {
    if (this.session) return this.session;
    if (this._creating) return this._creating;
    const settings = await getSettings();
    const systemPrompt = buildSystemPrompt(this.scope, settings.systemPrompt || undefined);
    this._creating = createAiSession({ systemPrompt, onDownload })
      .then((s) => { this.session = s; this._creating = null; return s; })
      .catch((err) => { this._creating = null; throw err; });
    return this._creating;
  }

  _captures() {
    return this.scope.type === "capture" ? [this.scope.capture] : this.scope.captures;
  }

  hasScope() {
    return !!this.scope;
  }

  // Stored page links, deduped across the scope, capped. Only fed to the
  // model when the question asks for links — they cost quota otherwise.
  _links() {
    const seen = new Set();
    const out = [];
    for (const c of this._captures()) {
      for (const l of c.links || []) {
        const key = normalizeUrl(l.href);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(l);
        if (out.length >= MAX_CONTEXT_LINKS) return out;
      }
    }
    return out;
  }

  // Ask a question. onChunk(fullSoFar) streams the answer.
  // Returns { answer, trimmed } — trimmed=true when the session was rebuilt.
  async ask(question, { onChunk, onDownload } = {}) {
    if (!this.scope) throw new Error("No scope — scan a page first.");
    let trimmed = false;

    const u = this.usage();
    if (u && u.quota && u.used / u.quota > QUOTA_REBUILD_AT) {
      this.destroy();
      trimmed = true;
    }

    const session = await this._ensureSession({ onDownload });

    // After a rebuild, replay the last 2 turns so the thread stays coherent.
    if (trimmed && this.recentTurns.length) {
      for (const turn of this.recentTurns.slice(-2)) {
        try {
          await session.append?.([
            { role: "user", content: turn.question },
            { role: "assistant", content: turn.answer }
          ]);
        } catch { /* append unsupported — context loss is acceptable */ }
      }
    }

    // Fold the previous question into retrieval so bare follow-ups
    // ("anything interesting about it?") still land on the right chunks.
    const prev = this.recentTurns[this.recentTurns.length - 1];
    const retrievalQuery = prev ? `${prev.question} ${question}` : question;
    const excerpts = selectExcerpts(retrievalQuery, this._captures());
    const links = LINK_INTENT.test(question) ? this._links() : [];
    const prompt = buildQuestionPrompt(question, excerpts, links);
    const answer = await streamPrompt(session, prompt, (full) => onChunk?.(full));
    this.recentTurns.push({ question, answer });
    if (this.recentTurns.length > 4) this.recentTurns.shift();
    return { answer, trimmed };
  }
}
