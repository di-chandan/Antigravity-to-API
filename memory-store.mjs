import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MEMORY_ROOT = process.env.AGY_MEMORY_DIR || path.join(HERE, "memory");
export const RAW_ROOT = path.join(MEMORY_ROOT, "raw");
const DB_PATH = path.join(MEMORY_ROOT, "index.sqlite");

fs.mkdirSync(RAW_ROOT, { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS messages (
    message_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    date_key TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    source_path TEXT NOT NULL,
    model TEXT,
    origin TEXT NOT NULL DEFAULT 'api'
  );
  CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
  CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, timestamp);
  CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(date_key);
  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    message_id UNINDEXED,
    content,
    role UNINDEXED,
    conversation_id UNINDEXED,
    timestamp UNINDEXED,
    tokenize='unicode61 remove_diacritics 2'
  );
`);

const insertMessage = db.prepare(`
  INSERT OR IGNORE INTO messages
    (message_id, conversation_id, timestamp, date_key, role, content, source_path, model, origin)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertFts = db.prepare(`
  INSERT INTO messages_fts (message_id, content, role, conversation_id, timestamp)
  VALUES (?, ?, ?, ?, ?)
`);
const getMessage = db.prepare("SELECT * FROM messages WHERE message_id = ?");
const getConversationHistory = db.prepare(`
  SELECT * FROM messages WHERE conversation_id = ?
  ORDER BY timestamp DESC LIMIT ?
`);
const getContextBefore = db.prepare(`
  SELECT * FROM messages WHERE conversation_id = ? AND timestamp <= ?
  ORDER BY timestamp DESC LIMIT ?
`);
const getContextAfter = db.prepare(`
  SELECT * FROM messages WHERE conversation_id = ? AND timestamp > ?
  ORDER BY timestamp ASC LIMIT ?
`);

function safeDateKey(timestamp) {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) throw new Error("Invalid timestamp");
  return d.toISOString().slice(0, 10);
}
function safeId(value) {
  return String(value || "").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || crypto.randomUUID();
}
function archivePath(dateKey, conversationId) {
  const [year, month, day] = dateKey.split("-");
  const dir = path.join(RAW_ROOT, year, month, day);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${safeId(conversationId)}.jsonl`);
}
function appendArchive(file, record) {
  fs.appendFileSync(file, JSON.stringify(record) + "\n", { encoding: "utf8", mode: 0o600 });
}
function addOne({ conversation_id, timestamp, role, content, model = null, origin = "api", message_id = null }) {
  if (!String(content ?? "").trim()) return null;
  const ts = new Date(timestamp || Date.now()).toISOString();
  const dateKey = safeDateKey(ts);
  const convId = String(conversation_id || "imported").slice(0, 200);
  const id = message_id || crypto.randomUUID();
  const file = archivePath(dateKey, convId);
  const record = { message_id: id, conversation_id: convId, timestamp: ts, role: String(role || "user"), content: String(content), model, origin };
  const result = insertMessage.run(id, convId, ts, dateKey, record.role, record.content, path.relative(MEMORY_ROOT, file), model, origin);
  if (Number(result.changes) > 0) {
    insertFts.run(id, record.content, record.role, convId, ts);
    appendArchive(file, record);
  }
  return id;
}

export function archiveTurn({ conversationId, userContent, assistantContent, model, timestamp = new Date().toISOString() }) {
  const conv = String(conversationId || `turn-${crypto.randomUUID()}`);
  const ids = [];
  if (userContent) ids.push(addOne({ conversation_id: conv, timestamp, role: "user", content: userContent, model, origin: "api" }));
  if (assistantContent) ids.push(addOne({ conversation_id: conv, timestamp: new Date(new Date(timestamp).getTime() + 1).toISOString(), role: "assistant", content: assistantContent, model, origin: "api" }));
  return ids.filter(Boolean);
}

export function ingestConversation({ conversation_id, messages, model = null, origin = "import" }) {
  if (!Array.isArray(messages) || messages.length === 0) throw new Error("messages must be a non-empty array");
  const conv = String(conversation_id || `import-${crypto.randomUUID()}`);
  const ids = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] || {};
    const content = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map(p => p?.text || "").join("\n") : JSON.stringify(m.content ?? "");
    const timestamp = m.timestamp || m.created_at || new Date(Date.now() + i).toISOString();
    const id = addOne({ conversation_id: conv, timestamp, role: m.role || "user", content, model: m.model || model, origin, message_id: m.message_id || m.id || null });
    if (id) ids.push(id);
  }
  return { conversation_id: conv, indexed_messages: ids.length, message_ids: ids };
}

function normalizeQuery(query) {
  return String(query || "").trim().slice(0, 1000);
}
function ftsExpression(query) {
  const terms = (query.match(/[\p{L}\p{N}_./:@+-]+/gu) || []).filter(x => x.length > 1).slice(0, 18);
  if (!terms.length) return "";
  // OR is deliberately used so vague natural-language questions can still find partial matches.
  return terms.map(t => `"${t.replaceAll('"', '""')}"`).join(" OR ");
}
function toPlain(row) {
  return row ? { message_id: row.message_id, conversation_id: row.conversation_id, timestamp: row.timestamp, date: row.date_key, role: row.role, content: row.content, source_path: row.source_path, model: row.model, origin: row.origin } : null;
}

export function searchMemory({ query, queries = [], after, before, role, search_type = "hybrid", limit = 8 } = {}) {
  const allQueries = [...new Set([query, ...(Array.isArray(queries) ? queries : [])].map(normalizeQuery).filter(Boolean))].slice(0, 8);
  if (!allQueries.length) throw new Error("Provide query or queries");
  const cap = Math.max(1, Math.min(Number(limit) || 8, 25));
  const found = new Map();
  const searchStmt = db.prepare(`
    SELECT m.*, bm25(messages_fts) AS score
    FROM messages_fts f JOIN messages m ON m.message_id = f.message_id
    WHERE messages_fts MATCH ?
      AND (? IS NULL OR m.timestamp >= ?)
      AND (? IS NULL OR m.timestamp <= ?)
      AND (? IS NULL OR m.role = ?)
    ORDER BY score ASC LIMIT ?
  `);
  for (const q of allQueries) {
    const expression = search_type === "exact" ? `"${q.replaceAll('"', '""')}"` : ftsExpression(q);
    if (expression) {
      try {
        const rows = searchStmt.all(expression, after || null, after || null, before || null, before || null, role || null, role || null, cap * 3);
        for (const row of rows) {
          const old = found.get(row.message_id);
          const rank = 1 / (1 + Math.max(0, Number(row.score) || 0));
          if (!old || rank > old._rank) found.set(row.message_id, { ...toPlain(row), _rank: rank, matched_queries: [q] });
          else if (!old.matched_queries.includes(q)) old.matched_queries.push(q);
        }
      } catch (err) {
        // Some punctuation-heavy queries are invalid FTS syntax; LIKE fallback below is safe.
      }
    }
    if (search_type === "exact" || found.size < cap) {
      const likeStmt = db.prepare(`
        SELECT * FROM messages m
        WHERE lower(m.content) LIKE lower(?)
          AND (? IS NULL OR m.timestamp >= ?)
          AND (? IS NULL OR m.timestamp <= ?)
          AND (? IS NULL OR m.role = ?)
        ORDER BY m.timestamp DESC LIMIT ?
      `);
      const needle = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
      try {
        const rows = likeStmt.all(needle, after || null, after || null, before || null, before || null, role || null, role || null, cap * 2);
        for (const row of rows) if (!found.has(row.message_id)) found.set(row.message_id, { ...toPlain(row), _rank: 0.5, matched_queries: [q] });
      } catch {}
    }
  }
  const results = [...found.values()].sort((a, b) => b._rank - a._rank || b.timestamp.localeCompare(a.timestamp)).slice(0, cap).map(({ _rank, ...r }) => ({ ...r, score: Number(_rank.toFixed(3)), snippet: r.content.length > 900 ? r.content.slice(0, 900) + "…[truncated; use memory_read]" : r.content }));
  return { query: allQueries, count: results.length, results };
}

export function grepMemory({ pattern, case_sensitive = false, after, before, limit = 10 } = {}) {
  const q = String(pattern || "").trim().slice(0, 500);
  if (!q) throw new Error("pattern is required");
  const stmt = db.prepare(`
    SELECT * FROM messages
    WHERE ${case_sensitive ? "content LIKE ?" : "content LIKE ? COLLATE NOCASE"}
      AND (? IS NULL OR timestamp >= ?) AND (? IS NULL OR timestamp <= ?)
    ORDER BY timestamp DESC LIMIT ?
  `);
  const rows = stmt.all(`%${q.replace(/[\\%_]/g, "\\$&")}%`, after || null, after || null, before || null, before || null, Math.max(1, Math.min(Number(limit) || 10, 50)));
  return { pattern: q, count: rows.length, results: rows.map(toPlain) };
}

export function readMemory({ message_id, before = 2, after = 2 } = {}) {
  const row = getMessage.get(String(message_id || ""));
  if (!row) return { found: false, message_id };
  const beforeRows = getContextBefore.all(row.conversation_id, row.timestamp, Math.max(0, Math.min(Number(before) || 0, 10))).reverse();
  const afterRows = getContextAfter.all(row.conversation_id, row.timestamp, Math.max(0, Math.min(Number(after) || 0, 10)));
  const unique = new Map();
  for (const r of [...beforeRows, row, ...afterRows]) unique.set(r.message_id, toPlain(r));
  return { found: true, target: toPlain(row), context: [...unique.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp)) };
}

export function conversationHistory(conversationId, limit = 40) {
  const id = String(conversationId || "").trim();
  if (!id) return { conversation_id: id, messages: [] };
  const rows = getConversationHistory.all(id, Math.max(1, Math.min(Number(limit) || 40, 100))).reverse();
  return { conversation_id: id, messages: rows.map(r => ({ role: r.role, content: r.content, timestamp: r.timestamp, message_id: r.message_id })) };
}

export function listMemoryDates({ limit = 60 } = {}) {
  const rows = db.prepare("SELECT date_key, COUNT(*) AS messages FROM messages GROUP BY date_key ORDER BY date_key DESC LIMIT ?").all(Math.max(1, Math.min(Number(limit) || 60, 366)));
  const total = db.prepare("SELECT COUNT(*) AS count FROM messages").get().count;
  return { total_messages: total, dates: rows };
}

export function memoryStats() {
  return { root: MEMORY_ROOT, database: DB_PATH, total_messages: db.prepare("SELECT COUNT(*) AS count FROM messages").get().count, total_conversations: db.prepare("SELECT COUNT(DISTINCT conversation_id) AS count FROM messages").get().count };
}
