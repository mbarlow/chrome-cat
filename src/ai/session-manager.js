// Chat session lifecycle. One live session, scoped to a capture or series;
// scope switches destroy and rebuild (Nano's context is small — stale page
// context is worse than a cold start). Rebuilds silently past the quota line.

import { createAiSession, streamPrompt, sessionUsage } from "./language-model.js";
import { buildSystemPrompt, buildQuestionPrompt, buildGeneralPrompt } from "./prompts.js";
import { Router } from "./router.js";
import { selectExcerpts } from "./retrieval.js";
import { QUOTA_REBUILD_AT, MAX_CONTEXT_LINKS, getSettings } from "../shared/constants.js";
import { normalizeUrl } from "../shared/url.js";

// The page-grounded answer gave up; worth a second, general-knowledge pass.
const NOT_ON_PAGE = /\b(does(n't| not) (say|mention|state|specify|include|contain|provide|indicate|list)|(is |are )?not (mentioned|stated|specified|provided|included|available|listed|given|found)|no (mention|indication|information|details?)|(cannot|can't|unable to|could not|couldn't) (find|locate|determine|tell|see))\b/i;

export class ChatSessionManager {
  constructor() {
    this.scope = null;      // { type, capture } | { type, series, captures }
    this.session = null;
    this._creating = null;
    this.recentTurns = [];  // carried across a quota rebuild
    this.router = new Router();
  }

  // Which path answers this question: "text" | "vision" | "links" | "general".
  route(question) {
    return this.router.route(question, { previous: this.recentTurns.at(-1)?.question });
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

  // Ask a question on a text route. onChunk(fullSoFar) streams the answer.
  // Returns { answer, trimmed } — trimmed=true when the session was rebuilt.
  async ask(question, { route = "text", onChunk, onDownload } = {}) {
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
    // History/bookmark chunks are one-liners — carry more of them.
    let prompt;
    if (route === "general") {
      prompt = buildGeneralPrompt(question);
    } else {
      const excerpts = selectExcerpts(retrievalQuery, this._captures(), this.scope.excerptK);
      prompt = buildQuestionPrompt(question, excerpts, route === "links" ? this._links() : []);
    }
    let answer = await streamPrompt(session, prompt, (full) => onChunk?.(full));
    if (route !== "general" && NOT_ON_PAGE.test(answer) && !/\(general knowledge\)/i.test(answer)) {
      answer = await this._generalFollowUp(question, answer, onChunk);
    }
    this.remember(question, answer);
    return { answer, trimmed };
  }

  // Throwaway session so the chat session's context stays page-grounded.
  async _generalFollowUp(question, pageAnswer, onChunk) {
    const head = `${pageAnswer.trim()}\n\n`;
    const session = await createAiSession();
    try {
      const extra = await streamPrompt(session, buildGeneralPrompt(question), (full) => onChunk?.(head + full));
      return head + extra;
    } catch {
      return pageAnswer;
    } finally {
      try { session.destroy?.(); } catch { /* ignore */ }
    }
  }

  // Record a turn answered outside this session (e.g. vision) so follow-ups
  // on either path see it.
  remember(question, answer) {
    this.recentTurns.push({ question, answer });
    if (this.recentTurns.length > 4) this.recentTurns.shift();
  }
}
