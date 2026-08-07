// Chat session lifecycle. One live session, scoped to a capture or series;
// scope switches destroy and rebuild (Nano's context is small — stale page
// context is worse than a cold start). Rebuilds silently past the quota line.

import { createAiSession, streamPrompt, sessionUsage } from "./language-model.js";
import { buildSystemPrompt, buildQuestionPrompt } from "./prompts.js";
import { topChunks, scopeChunks } from "./retrieval.js";
import { QUOTA_REBUILD_AT } from "../shared/constants.js";

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
    const systemPrompt = buildSystemPrompt(this.scope);
    this._creating = createAiSession({ systemPrompt, onDownload })
      .then((s) => { this.session = s; this._creating = null; return s; })
      .catch((err) => { this._creating = null; throw err; });
    return this._creating;
  }

  _captures() {
    return this.scope.type === "capture" ? [this.scope.capture] : this.scope.captures;
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

    const excerpts = topChunks(question, scopeChunks(this._captures()));
    const prompt = buildQuestionPrompt(question, excerpts);
    const answer = await streamPrompt(session, prompt, (full) => onChunk?.(full));
    this.recentTurns.push({ question, answer });
    if (this.recentTurns.length > 4) this.recentTurns.shift();
    return { answer, trimmed };
  }
}
