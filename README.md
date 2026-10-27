# AGY Local API + Memory Search

OpenAI-compatible local HTTP bridge for the AGY CLI, with a local searchable archive of conversations and an MCP server that lets AGY search that archive as a tool.

## Requirements

- Node.js 22.5+ (tested with Node 24.21.0; uses built-in `node:sqlite` and `process.loadEnvFile`).
- The AGY CLI installed and signed in. By default, the API expects it at `~/.local/bin/agy`.
- No third-party npm dependencies are required.
- SQLite FTS5 must be available in the Node SQLite build.

## Quick setup

1. Clone or download this repository and open a terminal in the `agy-local-api` folder.
2. Create your local configuration file from the public template:

   macOS / Linux:

   ```bash
   cp .env.example .env
   ```

   Windows PowerShell:

   ```powershell
   Copy-Item .env.example .env
   ```

3. Open `.env` and change only the settings you need. The defaults work for a local API when AGY is installed at `~/.local/bin/agy`. Keep `HOST=127.0.0.1` for local-only access.
4. Start the API:

   ```bash
   npm start
   ```

No `npm install` is needed: the project uses Node.js built-in modules. Check the server at `http://127.0.0.1:8788/health`.

The `.env` file is private and ignored by Git. Commit `.env.example`, never `.env`. The application loads `.env` from its own project directory; existing shell environment variables take precedence over values in `.env`.

## Environment settings

| Variable | Default | Purpose |
|---|---:|---|
| `HOST` | `127.0.0.1` | Local bind address. Keep local unless you have secured remote access. |
| `PORT` | `8788` | HTTP API port. |
| `AGY_BIN` | `~/.local/bin/agy` | Optional absolute path to the AGY CLI; blank uses the default. |
| `AGY_API_KEY` | blank | Optional Bearer token. Blank disables API-key authentication; use only on localhost in that case. |
| `AGY_TIMEOUT_MS` | `300000` | Maximum request duration in milliseconds. |
| `AGY_MAX_CONCURRENT` | `1` | Maximum requests processed at once. |
| `AGY_MAX_QUEUE` | `10` | Maximum waiting requests. |
| `AGY_MAX_SESSION_WORKERS` | `1` | Maximum warm CLI sessions. |
| `AGY_SESSION_IDLE_MS` | `300000` | Idle time before a warm session is retired, in milliseconds. |
| `AGY_MEMORY_DIR` | project `memory/` folder | Optional absolute path for memory storage; blank uses the project's `memory/` folder. |

Default API address: `http://127.0.0.1:8788`.

## Memory archive layout

By default the archive lives under agy-local-api/memory/:

```text
memory/
  index.sqlite
  raw/
    YYYY/
      MM/
        DD/
          <conversation-id>.jsonl
```

The SQLite index stores messages and a full-text FTS5 index. Raw JSONL is retained as a dated source archive. Set AGY_MEMORY_DIR to move the archive elsewhere.

Requests to POST /v1/chat/completions automatically archive the latest user message and the assistant answer. Send a stable session_id in each request to group turns from the same chat; without it, each API request may be stored as a separate conversation depending on the AGY response ID.

## Memory HTTP endpoints

- GET /v1/memory/stats — index and archive counts.
- GET /v1/memory/dates — dates containing archived messages.
- POST /v1/memory/search — global full-text search; body supports query, queries, after, before, role, search_type, and limit.
- POST /v1/memory/grep — literal substring search.
- POST /v1/memory/read — read a matching message plus nearby messages using message_id.
- POST /v1/memory/ingest — import a conversation using conversation_id and messages.

If AGY_API_KEY is set, include Authorization: Bearer YOUR_KEY on these endpoints. The default listener is loopback-only.

Example search:

```bash
curl -s http://127.0.0.1:8788/v1/memory/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"local server command","queries":["nohup node","port 8788"],"limit":8}'
```

## Register memory tools for AGY

The MCP server exposes these local tools:

- memory_search — keyword/FTS search; the tool description instructs AGY to infer search terms instead of searching the user's question verbatim.
- memory_grep — exact substring search.
- memory_read — retrieve a matching message and nearby context.
- memory_list_dates — list indexed dates.
- memory_stats — inspect index counts and paths.
- memory_ingest — explicitly import supplied conversation records.

Register it once with the AGY CLI:

```bash
agy mcp add --type stdio agy-memory "$(command -v node)" "$PWD/memory-mcp.mjs"
agy mcp list
```

Run the command from inside the cloned `agy-local-api` folder so `$PWD` resolves to the right location. If Node is not on the expected PATH for AGY, replace `$(command -v node)` with the absolute output of `which node`. The MCP process uses the same AGY_MEMORY_DIR environment variable as the HTTP API only if it is set in the environment inherited by AGY.

Restart any active AGY CLI session after registering the server so it reloads the MCP tool list. The headless CLI also needs narrow per-tool permission grants. The setup uses mcp(memory_search), mcp(memory_grep), mcp(memory_read), mcp(memory_list_dates), mcp(memory_stats), and mcp(memory_ingest) in ~/.gemini/antigravity-cli/settings.json; it does not enable the broad --dangerously-skip-permissions flag.

## Import existing conversations

New API calls are archived automatically, but historical ChatGPT/AGY conversations are not magically available to this service. Export or provide them, then import through POST /v1/memory/ingest or MCP tool memory_ingest. The index is only as complete as the data ingested into it.

## OpenAI SDK example

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:8788/v1",
  apiKey: "local",
});

const result = await client.chat.completions.create({
  model: "gemini-3.8-flash-medium",
  messages: [{ role: "user", content: "Hello from my local project" }],
});

console.log(result.choices[0].message.content);
```

## Notes and limitations

- Search, grep, indexing and message retrieval run locally and do not make LLM calls. AGY's reasoning/tool selection and final answer still consume model tokens.
- Search is full-text (FTS5) plus literal fallback. Semantic/vector search and a local embedding model are not included in this first implementation.
- AGY must call the registered MCP tools for tool-driven search. The HTTP chat bridge itself does not yet implement OpenAI tools/function-calling payloads.
- The API listens on 127.0.0.1 by default and is not exposed to other devices.
