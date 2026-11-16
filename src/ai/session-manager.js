// Chat session lifecycle. One live session, scoped to a capture or series;
// scope switches destroy and rebuild (Nano's context is small — stale page
// context is worse than a cold start). Rebuilds silently past the quota line.

import { createAiSession, streamPrompt, sessionUsage } from "./language-model.js";
import { buildSystemPrompt, buildQuestionPrompt, buildGeneralPrompt, buildTablePrompt, TABLE_SCHEMA } from "./prompts.js";
import { findSources } from "./sources.js";
import { assertRealOutput } from "./language-model.js";
import { Router } from "./router.js";
import { retrievalQuestion } from "./conversation-context.js";
import { selectExcerpts, topChunks } from "./retrieval.js";
import { QUOTA_REBUILD_AT, MAX_CONTEXT_LINKS, MAX_TABLE_ROWS, getSettings } from "../shared/constants.js";
import { normalizeUrl } from "../shared/url.js";

export class ChatSessionManager {
  constructor() {
    this.generation = 0;
    this.scope = null;      // { type, capture } | { type, series, captures }
    this.session = null;
    this._creating = null;
    this.recentTurns = [];  // carried across a quota rebuild
    this.router = new Router();
  }

  // Which path answers this question: "text" | "vision" | "links" | "general".
  route(question) {
    return this.router.route(question, { turns: this.recentTurns, title: this.scope?.capture?.title || this.scope?.type });
  }

  setScope(scope) {
    this.scope = scope;
    this.recentTurns = [];
    this.destroy();
  }

  destroy() {
    this.generation++;
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
    const generation = this.generation;
    const scope = this.scope;
    const pending = (async () => {
      const settings = await getSettings();
      const systemPrompt = buildSystemPrompt(scope, settings.systemPrompt || undefined);
      const session = await createAiSession({ systemPrompt, onDownload });
      if (this.generation !== generation) {
        session.destroy?.();
        throw new DOMException("Chat scope changed.", "AbortError");
      }
      this.session = session;
      return session;
    })();
    this._creating = pending;
    try { return await pending; }
    finally { if (this._creating === pending) this._creating = null; }
  }

  _captures() {
    return this.scope.type === "capture" ? [this.scope.capture] : this.scope.captures;
  }

  hasScope() {
    return !!this.scope;
  }

  // Stored page links, deduped across the scope, capped. Only fed to the
  // model when the question asks for links — they cost quota otherwise.
  _links(question) {
    const seen = new Set();
    const out = [];
    for (const c of this._captures()) {
      for (const l of c.links || []) {
        const key = normalizeUrl(l.href);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(l);
      }
    }
    const ranked = topChunks(question, out.map(l => ({ text: `${l.context || ""} ${l.text} ${l.href}`, url: l.href })), MAX_CONTEXT_LINKS);
    const byHref = new Map(out.map(l => [l.href, l]));
    return ranked.length ? ranked.map(r => byHref.get(r.url)) : out.slice(0, MAX_CONTEXT_LINKS);
  }

  // Ask a question on a text route. onChunk(fullSoFar) streams the answer.
  // Returns { answer, trimmed, sources } — trimmed=true when the session was
  // rebuilt; sources are the page passages the answer rests on.
  async ask(question, { route = "text", onChunk, onDownload } = {}) {
    if (!this.scope) throw new Error("No scope — scan a page first.");
    let trimmed = false;

    const u = this.usage();
    if (u && u.quota && u.used / u.quota > QUOTA_REBUILD_AT) {
      this.destroy();
      trimmed = true;
    }

    const generation = this.generation;
    const session = await this._ensureSession({ onDownload });

    const retrievalQuery = retrievalQuestion(question, this.recentTurns);
    let prompt;
    let excerpts = [];
    if (route === "general") {
      prompt = buildGeneralPrompt(question, this.recentTurns);
    } else {
      excerpts = selectExcerpts(retrievalQuery, this._captures(), this.scope.excerptK);
      prompt = buildQuestionPrompt(question, excerpts, route === "links" ? this._links(retrievalQuery) : [], this.recentTurns);
    }
    const answer = await streamPrompt(session, prompt, (full) => onChunk?.(full));
    if (generation !== this.generation) throw new DOMException("Chat scope changed.", "AbortError");
    const sources = route === "general" ? [] : findSources(answer, excerpts);
    this.remember(question, answer);
    return { answer, trimmed, sources };
  }

  // Extract a table for the question from the scope's text. Throwaway
  // session: a JSON reply would only clutter the chat context.
  // Returns { columns, rows, sources }.
  async table(question) {
    if (!this.scope) throw new Error("No scope — scan a page first.");
    const generation = this.generation;
    const excerpts = selectExcerpts(retrievalQuestion(question, this.recentTurns), this._captures(), Math.max(6, this.scope.excerptK || 0));
    const session = await createAiSession();
    try {
      const out = assertRealOutput(await session.prompt(buildTablePrompt(question, excerpts, this.recentTurns),
        { responseConstraint: TABLE_SCHEMA }));
      if (generation !== this.generation) throw new DOMException("Chat scope changed.", "AbortError");
      const { columns = [], rows = [] } = JSON.parse(out);
      const width = columns.length;
      const clean = rows.slice(0, MAX_TABLE_ROWS)
        .map((r) => Array.from({ length: width }, (_, i) => String(r[i] ?? "").trim()))
        .filter((r) => r.some(Boolean));
      if (!width || !clean.length) throw new Error("no table-shaped data found for that");
      const table = { columns: columns.map(String), rows: clean };
      this.remember(question, `(table: ${table.columns.join(", ")} — ${clean.length} rows)`);
      return { ...table, sources: findSources(clean.flat().join(" "), excerpts) };
    } finally {
      try { session.destroy?.(); } catch { /* ignore */ }
    }
  }

  // Restore completed exchanges, not the generated summary at the start.
  restoreHistory(messages) {
    this.recentTurns = [];
    let question = null;
    for (const message of messages) {
      if (message.role === "user") question = message.content;
      else if (message.role === "assistant" && question !== null) {
        this.remember(question, message.content); question = null;
      }
    }
  }

  // Record a turn answered outside this session (e.g. vision) so follow-ups
  // on either path see it.
  remember(question, answer) {
    this.recentTurns.push({ question, answer });
    if (this.recentTurns.length > 4) this.recentTurns.shift();
  }
}
