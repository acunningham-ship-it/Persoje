import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { ChatMessage } from "../models/openrouter.ts";
import type { UsageReport } from "../core/events.ts";

export const DEFAULT_DB_PATH = join(homedir(), ".local", "share", "persoje", "sessions.db");

export interface SessionMeta {
  id: string;
  createdAt: number;
  updatedAt: number;
  cwd: string;
  model: string;
  title: string;
  messageCount: number;
  totalCost: number;
}

export class SessionStore {
  private db: Database;

  constructor(dbPath = DEFAULT_DB_PATH) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        cwd TEXT NOT NULL,
        model TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_calls TEXT,
        tool_call_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
      CREATE TABLE IF NOT EXISTS usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cached_tokens INTEGER NOT NULL,
        cost REAL NOT NULL,
        duration_ms INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  create(cwd: string, model: string): string {
    const id = `${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    this.db
      .prepare("INSERT INTO sessions (id, created_at, updated_at, cwd, model) VALUES (?, ?, ?, ?, ?)")
      .run(id, now, now, cwd, model);
    return id;
  }

  appendMessage(sessionId: string, msg: ChatMessage): void {
    const toolCalls = "tool_calls" in msg && msg.tool_calls ? JSON.stringify(msg.tool_calls) : null;
    const toolCallId = "tool_call_id" in msg ? msg.tool_call_id : null;
    this.db
      .prepare(
        "INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(sessionId, msg.role, msg.content ?? "", toolCalls, toolCallId, Date.now());
    this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(Date.now(), sessionId);
  }

  /** First user message becomes the session title (truncated). */
  maybeSetTitle(sessionId: string, text: string): void {
    this.db
      .prepare("UPDATE sessions SET title = ? WHERE id = ? AND title = ''")
      .run(text.slice(0, 80), sessionId);
  }

  loadMessages(sessionId: string): ChatMessage[] {
    const rows = this.db
      .prepare("SELECT role, content, tool_calls, tool_call_id FROM messages WHERE session_id = ? ORDER BY id")
      .all(sessionId) as Array<{ role: string; content: string; tool_calls: string | null; tool_call_id: string | null }>;
    return rows.map((r) => {
      if (r.role === "tool") return { role: "tool", content: r.content, tool_call_id: r.tool_call_id ?? "" };
      if (r.role === "assistant")
        return {
          role: "assistant",
          content: r.content,
          ...(r.tool_calls ? { tool_calls: JSON.parse(r.tool_calls) } : {}),
        };
      return { role: r.role as "user" | "system", content: r.content } as ChatMessage;
    });
  }

  recordUsage(sessionId: string, u: UsageReport): void {
    this.db
      .prepare(
        "INSERT INTO usage (session_id, model, input_tokens, output_tokens, cached_tokens, cost, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(sessionId, u.model, u.inputTokens, u.outputTokens, u.cachedTokens, u.cost, u.durationMs, Date.now());
  }

  list(cwd?: string, limit = 20): SessionMeta[] {
    const where = cwd ? "WHERE s.cwd = ?" : "";
    const rows = this.db
      .prepare(
        `SELECT s.id, s.created_at, s.updated_at, s.cwd, s.model, s.title,
                (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count,
                COALESCE((SELECT SUM(cost) FROM usage u WHERE u.session_id = s.id), 0) AS total_cost
         FROM sessions s ${where} ORDER BY s.updated_at DESC LIMIT ?`,
      )
      .all(...(cwd ? [cwd, limit] : [limit])) as any[];
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      cwd: r.cwd,
      model: r.model,
      title: r.title,
      messageCount: r.message_count,
      totalCost: r.total_cost,
    }));
  }

  get(sessionId: string): SessionMeta | null {
    const metas = this.list();
    return metas.find((m) => m.id === sessionId) ?? null;
  }

  close(): void {
    this.db.close();
  }
}
