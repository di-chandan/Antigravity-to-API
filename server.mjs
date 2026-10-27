import "./load-env.mjs";
import http from "node:http";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { archiveTurn, ingestConversation, searchMemory, grepMemory, readMemory, listMemoryDates, memoryStats, conversationHistory } from "./memory-store.mjs";

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 8788);
const AGY_BIN = process.env.AGY_BIN || path.join(os.homedir(), ".local", "bin", "agy");
const API_KEY = process.env.AGY_API_KEY || "";
const TIMEOUT_MS = Number(process.env.AGY_TIMEOUT_MS || 300000);
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_CONCURRENT = Number(process.env.AGY_MAX_CONCURRENT || 1);
const MAX_QUEUE = Number(process.env.AGY_MAX_QUEUE || 10);
let active = 0;
const requestQueue = [];

function acquireSlot() {
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve();
  }
  if (requestQueue.length >= MAX_QUEUE) {
    return Promise.reject(Object.assign(new Error("AGY request queue is full; retry later"), { status: 429, localLimit: true }));
  }
  return new Promise(resolve => requestQueue.push(resolve)).then(() => { active++; });
}

function releaseSlot() {
  active = Math.max(0, active - 1);
  const next = requestQueue.shift();
  if (next) next();
}

const MODELS = [
  { id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
  { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
  { id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)" },
  { id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)" },
  { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" }
];

function json(res, status, data, extraHeaders = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    ...extraHeaders
  });
  res.end(JSON.stringify(data));
}

function openAIError(message, type = "invalid_request_error", code = null) {
  return { error: { message, type, param: null, code } };
}

function authorized(req) {
  if (!API_KEY) return true;
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(token);
  const b = Buffer.from(API_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    req.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Request body exceeds 2 MB limit"), { status: 413 }));
        req.destroy();
        return;
      }
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); }
      catch { reject(Object.assign(new Error("Request body must be valid JSON"), { status: 400 })); }
    });
    req.on("error", reject);
  });
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(part => {
      if (part?.type === "text") return part.text || "";
      if (part?.type === "image_url") return "[Image input is not supported by this AGY CLI bridge]";
      return "";
    }).filter(Boolean).join("\n");
  }
  return "";
}

function makePrompt(messages, priorHistory = []) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw Object.assign(new Error("'messages' must be a non-empty array"), { status: 400 });
  }
  // Keep system/developer instructions first. Then add archived turns, then this request's
  // conversational messages. Otherwise a repeated Postman system message can appear after
  // the history and confuse the model about which turn it should answer.
  const instructions = messages.filter(m => ["system", "developer"].includes(String(m?.role || "").toLowerCase()));
  const currentConversation = messages.filter(m => !["system", "developer"].includes(String(m?.role || "").toLowerCase()));
  const combinedMessages = [...instructions, ...priorHistory, ...currentConversation];
  return combinedMessages.map(m => {
    const role = String(m?.role || "user").toUpperCase();
    const content = messageText(m?.content);
    return `[${role}]\n${content}`;
  }).join("\n\n") + "\n\n[MEMORY TOOL POLICY]\nWhen the user asks about something they said, decided, ran, shared, or discussed in a past conversation, use the agy-memory MCP tools before answering. Do not pass the original question verbatim as the only search query. Infer the likely facts they want, create several short alternative search terms, synonyms, and identifiers, call memory_search, refine search if needed, and use memory_read to verify the exact source and nearby context. For exact code, commands, or error text, use memory_grep. Only provide recalled facts supported by retrieved messages; if no matching evidence is found, say so rather than guessing. Keep retrieval narrow and do not dump whole conversations into context. For unrelated questions that do not require past-conversation recall, do not search memory.\n\n[ASSISTANT]\nRespond to the conversation above. Follow the system instructions and answer the latest user message.";
}

function runAgy(model, prompt) {
  return new Promise((resolve, reject) => {
    const args = ["--model", model, "--sandbox", "-p", prompt, "--output-format", "json"];
    const child = spawn(AGY_BIN, args, { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
      finish(new Error("AGY request timed out"));
    }, TIMEOUT_MS);
    function finish(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(value);
    }
    child.stdout.on("data", chunk => { stdout += chunk.toString(); });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.on("error", err => finish(new Error(`Could not start AGY CLI at ${AGY_BIN}: ${err.message}`)));
    child.on("close", code => {
      if (code !== 0) return finish(new Error((stderr.trim() || stdout.trim() || `AGY exited with code ${code}`).slice(-5000)));
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      let result = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const candidate = JSON.parse(lines[i]);
          if (candidate && typeof candidate === "object" && ("response" in candidate || "status" in candidate)) {
            result = candidate;
            break;
          }
        } catch {}
      }
      if (!result) return finish(new Error("AGY returned no parseable JSON response: " + stdout.slice(-1500)));
      if (result.status && result.status !== "SUCCESS") return finish(new Error(`AGY status: ${result.status}`));
      finish(null, result);
    });
  });
}

const sessionWorkers = new Map();
const MAX_SESSION_WORKERS = Math.max(1, Number(process.env.AGY_MAX_SESSION_WORKERS || 1));
const SESSION_IDLE_MS = Math.max(60_000, Number(process.env.AGY_SESSION_IDLE_MS || 5 * 60_000));

function compactUsage(current = {}, previous = {}) {
  const keys = ["input_tokens", "output_tokens", "thinking_tokens", "cache_read_tokens", "total_tokens"];
  const delta = {};
  for (const key of keys) {
    const n = Number(current[key] || 0) - Number(previous[key] || 0);
    delta[key] = Math.max(0, n);
  }
  return delta;
}

class AgySessionWorker {
  constructor(model) {
    this.model = model;
    this.createdAt = Date.now();
    this.lastUsed = Date.now();
    this.busy = false;
    this.dead = false;
    this.buffer = "";
    this.stderr = "";
    this.lastUsage = {};
    this.lastDuration = 0;
    this.pending = null;
    const args = ["--model", model, "--sandbox", "--disable-slash-commands", "--input-format", "stream-json", "--output-format", "stream-json"];
    this.child = spawn(AGY_BIN, args, { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.on("data", chunk => this._onStdout(chunk.toString()));
    this.child.stderr.on("data", chunk => {
      this.stderr = (this.stderr + chunk.toString()).slice(-8000);
    });
    this.child.on("error", err => this._fail(new Error(`Could not start AGY CLI at ${AGY_BIN}: ${err.message}`)));
    this.child.on("close", code => {
      this.dead = true;
      if (this.pending) this._fail(new Error((this.stderr.trim() || `AGY stream process exited with code ${code}`).slice(-5000)));
    });
  }

  _onStdout(text) {
    this.buffer += text;
    let newline;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.event === "step_update" && event.step_update?.step_type === "agent_response") {
        const delta = event.step_update.text_delta;
        if (delta && this.pending?.onText) {
          try { this.pending.onText(String(delta)); } catch {}
        }
      }
      if (event.event === "result" && event.result && this.pending) {
        const result = { ...event.result, usage: event.result.usage ? { ...event.result.usage } : undefined };
        const current = this.pending;
        clearTimeout(current.timer);
        result.usage = compactUsage(result.usage || {}, this.lastUsage);
        this.lastUsage = event.result.usage || this.lastUsage;
        const duration = Number(event.result.duration_seconds || 0);
        result.duration_seconds = Math.max(0, duration - this.lastDuration);
        this.lastDuration = duration;
        this.pending = null;
        this.busy = false;
        this.lastUsed = Date.now();
        if (result.status && result.status !== "SUCCESS") current.reject(new Error(result.error || `AGY status: ${result.status}`));
        else current.resolve(result);
      }
    }
  }

  _fail(err) {
    this.dead = true;
    if (!this.pending) return;
    const current = this.pending;
    clearTimeout(current.timer);
    this.pending = null;
    this.busy = false;
    current.reject(err);
  }

  run(prompt, { onText } = {}) {
    if (this.dead || this.child.killed) return Promise.reject(new Error("AGY session worker is not available"));
    if (this.busy) return Promise.reject(new Error("AGY session worker already has an active turn"));
    this.busy = true;
    this.lastUsed = Date.now();
    return new Promise((resolve, reject) => {
      const current = { resolve, reject, onText, timer: null };
      current.timer = setTimeout(() => {
        this.child.kill("SIGTERM");
        setTimeout(() => this.child.kill("SIGKILL"), 3000).unref();
        this._fail(new Error("AGY session turn timed out"));
      }, TIMEOUT_MS);
      this.pending = current;
      const payload = JSON.stringify({ event: "user", message: { content: prompt } }) + "\n";
      this.child.stdin.write(payload, err => {
        if (err) this._fail(new Error(`Could not send prompt to AGY session: ${err.message}`));
      });
    });
  }

  close() {
    if (this.dead) return;
    this.dead = true;
    try { this.child.stdin.end(); } catch {}
    const child = this.child;
    const timer = setTimeout(() => child.kill("SIGKILL"), 1500);
    timer.unref();
  }
}

function getSessionWorker(sessionId, model) {
  let worker = sessionWorkers.get(sessionId);
  let fresh = false;
  if (worker && (worker.dead || worker.model !== model)) {
    worker.close();
    sessionWorkers.delete(sessionId);
    worker = null;
  }
  if (!worker) {
    if (sessionWorkers.size >= MAX_SESSION_WORKERS) {
      const evictable = [...sessionWorkers.entries()]
        .filter(([, w]) => !w.busy)
        .sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (evictable) {
        evictable[1].close();
        sessionWorkers.delete(evictable[0]);
      }
    }
    worker = new AgySessionWorker(model);
    sessionWorkers.set(sessionId, worker);
    fresh = true;
  }
  worker.lastUsed = Date.now();
  return { worker, fresh };
}

const sessionCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, worker] of sessionWorkers) {
    if (worker.dead || (!worker.busy && now - worker.lastUsed > SESSION_IDLE_MS)) {
      worker.close();
      sessionWorkers.delete(id);
    }
  }
}, 60_000);
sessionCleanupTimer.unref();

function sendSse(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-allow-methods": "GET, POST, OPTIONS"
    });
    return res.end();
  }
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, { ok: true, service: "agy-local-api", cli: AGY_BIN, active, queued: requestQueue.length, max_concurrent: MAX_CONCURRENT, max_queue: MAX_QUEUE, warm_sessions: sessionWorkers.size, max_session_workers: MAX_SESSION_WORKERS });
  }
  if (url.pathname.startsWith("/v1/memory/")) {
    if (!authorized(req)) return json(res, 401, openAIError("Invalid or missing API key", "authentication_error"));
    if (req.method === "GET" && url.pathname === "/v1/memory/stats") return json(res, 200, memoryStats());
    if (req.method === "GET" && url.pathname === "/v1/memory/dates") return json(res, 200, listMemoryDates({ limit: Number(url.searchParams.get("limit") || 60) }));
    if (req.method !== "POST") return json(res, 405, openAIError("Use POST for memory search/read/ingest endpoints"));
    let memoryBody;
    try { memoryBody = await readBody(req); } catch (err) { return json(res, err.status || 400, openAIError(err.message)); }
    try {
      if (url.pathname === "/v1/memory/search") return json(res, 200, searchMemory(memoryBody));
      if (url.pathname === "/v1/memory/grep") return json(res, 200, grepMemory(memoryBody));
      if (url.pathname === "/v1/memory/read") return json(res, 200, readMemory(memoryBody));
      if (url.pathname === "/v1/memory/ingest") return json(res, 200, ingestConversation(memoryBody));
      return json(res, 404, openAIError("Unknown memory endpoint", "invalid_request_error", "not_found"));
    } catch (err) { return json(res, 400, openAIError(err.message)); }
  }
  if (req.method === "GET" && url.pathname === "/v1/models") {
    if (!authorized(req)) return json(res, 401, openAIError("Invalid or missing API key", "authentication_error"));
    return json(res, 200, { object: "list", data: MODELS.map(m => ({ id: m.id, object: "model", created: 0, owned_by: "agy-cli", name: m.name })) });
  }
  if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
    return json(res, 404, openAIError("Not found. Use GET /v1/models or POST /v1/chat/completions", "invalid_request_error", "not_found"));
  }
  if (!authorized(req)) return json(res, 401, openAIError("Invalid or missing API key", "authentication_error"));
  let body;
  try { body = await readBody(req); }
  catch (err) { return json(res, err.status || 400, openAIError(err.message)); }

  const model = String(body.model || MODELS[0].id);
  if (!MODELS.some(m => m.id === model)) {
    return json(res, 400, openAIError(`Unknown model '${model}'. Check GET /v1/models for supported IDs.`));
  }
  const sessionId = String(body.session_id || body.conversation_id || crypto.randomUUID()).slice(0, 200);
  let priorHistory = [];
  const sessionProvided = Boolean(body.session_id || body.conversation_id);
  const incomingConversationMessages = Array.isArray(body.messages)
    ? body.messages.filter(m => !["system", "developer"].includes(String(m?.role || "").toLowerCase()))
    : [];
  // Restore archived turns whenever this is a session-managed request containing only the latest user turn,
  // even if the client also resends its system prompt. Full transcripts are left intact to avoid duplicates.
  if (sessionProvided && (!sessionWorkers.has(sessionId) || sessionWorkers.get(sessionId).dead || sessionWorkers.get(sessionId).model !== model) && incomingConversationMessages.length === 1 && incomingConversationMessages[0]?.role === "user") {
    try { priorHistory = conversationHistory(sessionId, 40).messages; }
    catch (historyError) { console.error("Session history load failed:", historyError.message); }
  }
  let prompt;
  try { prompt = makePrompt(body.messages, priorHistory); }
  catch (err) { return json(res, err.status || 400, openAIError(err.message)); }

  try {
    await acquireSlot();
  } catch (err) {
    return json(res, 429, openAIError(err.message, "rate_limit_error", "local_queue_full"), { "retry-after": "10" });
  }

  const started = Date.now();
  const id = "chatcmpl-" + crypto.randomUUID().replaceAll("-", "");
  const created = Math.floor(Date.now() / 1000);
  let streamHeadersSent = false;
  try {
    let worker = sessionWorkers.get(sessionId);
    if (worker && !worker.dead && worker.model === model) {
      const lastUserMessage = [...body.messages].reverse().find(m => String(m?.role || "").toLowerCase() === "user");
      if (!lastUserMessage) throw Object.assign(new Error("messages must include a user message"), { status: 400 });
      // Reuse the live AGY CLI conversation; send only the newest turn rather than replaying its history.
      prompt = `[USER]\n${messageText(lastUserMessage.content)}`;
    } else {
      ({ worker } = getSessionWorker(sessionId, model));
    }
    const stream = body.stream === true;
    if (stream) {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        "connection": "keep-alive",
        "access-control-allow-origin": "*"
      });
      streamHeadersSent = true;
      sendSse(res, { id, object: "chat.completion.chunk", created, model, session_id: sessionId, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
    }
    const streamText = stream ? chunk => {
      sendSse(res, { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] });
    } : undefined;
    let result = await worker.run(prompt, { onText: streamText });
    let content = String(result.response ?? "").trim();
    if (!content) {
      console.warn(`[${new Date().toISOString()}] Empty AGY response for session ${sessionId}; retrying once`);
      result = await worker.run("[IMPORTANT OUTPUT CHECK]\nYour previous attempt returned an empty response. Answer the latest user message now with a non-empty, concise answer. If context is insufficient, say so clearly.", { onText: streamText });
      content = String(result.response ?? "").trim();
    }
    if (!content) {
      console.error(`[${new Date().toISOString()}] Empty AGY response twice for session ${sessionId}; not archiving blank turn`);
      if (streamHeadersSent) {
        sendSse(res, { error: openAIError("The model returned an empty response twice. Retry the request.", "server_error", "empty_model_response").error });
        res.write("data: [DONE]\n\n");
        return res.end();
      }
      return json(res, 502, openAIError("The model returned an empty response twice. The blank turn was not saved; retry the request.", "server_error", "empty_model_response"));
    }
    try {
      const lastUserMessage = [...body.messages].reverse().find(m => m?.role === "user");
      const userText = lastUserMessage ? messageText(lastUserMessage.content) : "";
      archiveTurn({
        conversationId: sessionId,
        userContent: userText,
        assistantContent: content,
        model
      });
    } catch (memoryError) {
      console.error("Memory archive failed:", memoryError.message);
    }
    const usage = result.usage ? {
      prompt_tokens: Number(result.usage.input_tokens || 0),
      completion_tokens: Number(result.usage.output_tokens || 0),
      total_tokens: Number(result.usage.total_tokens || 0)
    } : undefined;

    if (streamHeadersSent) {
      sendSse(res, { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      res.write("data: [DONE]\n\n");
      return res.end();
    }

    const response = {
      session_id: sessionId,
      id, object: "chat.completion", created, model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      ...(usage ? { usage } : {}),
      x_agy: { conversation_id: result.conversation_id || null, duration_seconds: (Date.now() - started) / 1000, cli_duration_seconds: result.duration_seconds || null, num_turns: result.num_turns || 1, warm_session: Number(result.num_turns || 1) > 1 }
    };
    return json(res, 200, response);
  } catch (err) {
    const message = err.message || "AGY request failed";
    const limited = /\b429\b|RESOURCE_EXHAUSTED|rate.?limit|quota exceeded|too many requests/i.test(message);
    console.error(`[${new Date().toISOString()}] AGY request failed (${limited ? "upstream rate limit" : "upstream error"}): ${message.slice(-1500)}`);
    if (streamHeadersSent) {
      sendSse(res, { error: openAIError(message, "server_error", limited ? "upstream_rate_limit" : "agy_cli_error").error });
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    if (limited) {
      return json(res, 429, openAIError("AGY/provider rate limit detected. Pause requests and check your AGY model/account quota before retrying. Details are in server.log.", "rate_limit_error", "upstream_rate_limit"), { "retry-after": "30" });
    }
    return json(res, 502, openAIError(message, "server_error", "agy_cli_error"));
  } finally {
    releaseSlot();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`AGY OpenAI-compatible API listening at http://${HOST}:${PORT}`);
  console.log(`Using CLI: ${AGY_BIN}`);
  console.log(`Auth: ${API_KEY ? "API key required" : "disabled (localhost only)"}`);
});
server.on("error", err => {
  console.error("Server failed:", err.message);
  process.exitCode = 1;
});
