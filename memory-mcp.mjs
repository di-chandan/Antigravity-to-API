#!/usr/bin/env node
import "./load-env.mjs";
import readline from "node:readline";
import { searchMemory, grepMemory, readMemory, listMemoryDates, ingestConversation, memoryStats } from "./memory-store.mjs";

const TOOLS = [
  {
    name: "memory_search",
    description: "Search the user's entire archived conversation memory. IMPORTANT: do not blindly search the user's question verbatim. First infer what information they are trying to recall, then generate several short, varied search queries: key concepts, likely terms, synonyms, technical identifiers, commands, or paraphrases. Start broad; use results to refine with another call if needed. This search is local and consumes no LLM tokens itself. Returns small snippets with message_id, timestamp, conversation_id, and source_path. Use memory_read to verify exact wording and context.",
    inputSchema: { type: "object", properties: {
      query: { type: "string", description: "One concise search query derived from the user's intent, not necessarily the original question." },
      queries: { type: "array", items: { type: "string" }, description: "Optional alternative search terms, synonyms, or likely phrasings. Use 2-5 diverse queries for vague questions." },
      after: { type: "string", description: "Optional ISO timestamp lower bound." },
      before: { type: "string", description: "Optional ISO timestamp upper bound." },
      role: { type: "string", enum: ["user", "assistant", "system"], description: "Optional role filter." },
      search_type: { type: "string", enum: ["hybrid", "exact"], description: "hybrid for keyword/FTS search with fallback; exact for phrase search." },
      limit: { type: "integer", minimum: 1, maximum: 25, description: "Maximum results, default 8." }
    }, required: ["query"] }
  },
  {
    name: "memory_grep",
    description: "Literal substring search across all archived messages. Best for exact commands, code, error text, names, or phrases. Runs locally without LLM tokens. Use when you have a likely exact string.",
    inputSchema: { type: "object", properties: {
      pattern: { type: "string", description: "Literal text to find." },
      case_sensitive: { type: "boolean" },
      after: { type: "string" }, before: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 50 }
    }, required: ["pattern"] }
  },
  {
    name: "memory_read",
    description: "Read one matching archived message and nearby messages from the same conversation. Use this to verify exact facts before answering. Local retrieval; no LLM call.",
    inputSchema: { type: "object", properties: {
      message_id: { type: "string" },
      before: { type: "integer", minimum: 0, maximum: 10 },
      after: { type: "integer", minimum: 0, maximum: 10 }
    }, required: ["message_id"] }
  },
  {
    name: "memory_list_dates",
    description: "List dates containing archived messages and total indexed count. Use when the user references a date or when narrowing a search by time. Local retrieval; no LLM call.",
    inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 366 } } }
  },
  {
    name: "memory_stats",
    description: "Show archive/index location and indexed message/conversation counts. Local retrieval; no LLM call.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "memory_ingest",
    description: "Import a conversation or message batch into the searchable local archive. Use only when the user explicitly asks to import or archive supplied conversation data. Duplicate message IDs are ignored.",
    inputSchema: { type: "object", properties: {
      conversation_id: { type: "string" },
      model: { type: "string" },
      origin: { type: "string" },
      messages: { type: "array", items: { type: "object", properties: {
        id: { type: "string" }, message_id: { type: "string" }, timestamp: { type: "string" },
        created_at: { type: "string" }, role: { type: "string" }, content: {}, model: { type: "string" }
      }, required: ["role", "content"] } }
    }, required: ["messages"] }
  }
];

function respond(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"); }
function fail(id, code, message) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n"); }
async function callTool(name, args) {
  switch (name) {
    case "memory_search": return searchMemory(args);
    case "memory_grep": return grepMemory(args);
    case "memory_read": return readMemory(args);
    case "memory_list_dates": return listMemoryDates(args);
    case "memory_stats": return memoryStats();
    case "memory_ingest": return ingestConversation(args);
    default: throw new Error("Unknown tool: " + name);
  }
}
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async line => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg || msg.jsonrpc !== "2.0") return;
  if (msg.method === "notifications/initialized" || msg.method?.startsWith("notifications/")) return;
  if (msg.method === "initialize") {
    return respond(msg.id, { protocolVersion: msg.params?.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "agy-memory-search", version: "1.0.0" } });
  }
  if (msg.method === "ping") return respond(msg.id, {});
  if (msg.method === "tools/list") return respond(msg.id, { tools: TOOLS });
  if (msg.method === "tools/call") {
    const name = msg.params?.name;
    try {
      const data = await callTool(name, msg.params?.arguments || {});
      return respond(msg.id, { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data, isError: false });
    } catch (err) {
      return respond(msg.id, { content: [{ type: "text", text: err.message || String(err) }], isError: true });
    }
  }
  if (msg.id !== undefined) fail(msg.id, -32601, "Method not found: " + msg.method);
});
rl.on("close", () => process.exit(0));
