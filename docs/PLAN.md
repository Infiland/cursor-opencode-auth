# Design and roadmap

## Goal

Let OpenCode users use their Cursor subscription, through documented Cursor surfaces only:

1. **Cursor CLI (`agent`)**: login with `agent login` or `CURSOR_API_KEY`; `--list-models` and `--model`; modes `agent`, `plan`, `ask`; headless runs with `--print` and `--output-format text|json|stream-json`.
2. **Cursor Cloud Agents API** (`https://api.cursor.com/v0/...`): asynchronous remote agents.

Non-goals: private or undocumented Cursor APIs, and anything that bypasses Cursor's terms or login.

## The core constraint

Cursor CLI is an agent, not a bare model: every run is Cursor's own agent loop with its own tools, and it takes one prompt and returns one answer. Anything that presents Cursor as an OpenCode "model" therefore:

- flattens the conversation into a single prompt per request;
- cannot let Cursor call OpenCode's tools, and does not show Cursor's own tool calls to OpenCode as tool calls;
- costs a full Cursor run per request.

The integration accepts this and makes it predictable: read-only `ask` mode by default, Cursor's tool use reported as reasoning, clear errors, and no automatic retries of runs that cannot succeed.

## Architecture

```
OpenCode 2.0 ──setup()──▶ opencode-plugin-cursor ──▶ CursorLanguageModel ──▶ agent --print … (prompt on stdin)
                          (provider "cursor" + tools in the "cursor" namespace)

OpenCode 1.x ──server()─▶ opencode-plugin-cursor: tools, bridge lifecycle, X-Cursor-Workspace header
OpenCode 1.x ──HTTP─────▶ cursor-openai-bridge (/v1/chat/completions) ──▶ agent --print …
```

**`cursor-openai-bridge`** is both the HTTP bridge and the shared Cursor CLI layer:

- `process.ts`: runs Cursor in its own process group, kills the whole group on abort or timeout, and never hangs on grandchildren that keep pipes open.
- `streamJson.ts`: parses `stream-json` output, including `--stream-partial-output` (deltas are streamed; buffered duplicates and the final repeat of already-streamed text are skipped).
- `prompt.ts`: flattens an OpenAI-style transcript into one prompt.
- `cursorCli.ts`: argument building, model list parsing, and failure classification (`auth`, `usage_limit`, `rate_limit`, `model`, `failed`) mapped to HTTP statuses that clients do not retry blindly.
- `server.ts`: the OpenAI-compatible server (loopback only by default, Host/Origin checks, optional API key, body limit, SSE with keep-alives).

**`opencode-plugin-cursor`** has one module for both OpenCode generations: the default export carries `server` (1.x) and `setup` (2.0).

- **OpenCode 2.0** (`src/v2/`): `setup` registers a provider whose package is `aisdk:` plus the file URL of `provider.js`. OpenCode's AI SDK loader imports it and calls `createCursor(settings)`; `CursorLanguageModel` implements `LanguageModelV3` by running Cursor CLI per request. Models come from `agent --list-models` (cached on disk, refreshed in the background, then `provider.reload()`). The tools are the 1.x tool definitions, registered through `tool.transform` with JSON Schema inputs in the `cursor` namespace.
- **OpenCode 1.x** (`src/v1.ts`): tools, bridge lifecycle (start, health with version check, stop only bridges it can identify), and a `chat.headers` hook that tells the shared bridge which project a request belongs to.

## Decisions

- **Ask mode by default.** A provider should not change files behind OpenCode's back; `agent` mode is opt-in.
- **Prompt on stdin.** Keeps large prompts off the command line (size limits, process listings).
- **Early failures are request errors.** The 2.0 model waits up to 3 s for Cursor's first output, so a missing login, an unknown model or a usage limit rejects the request with a non-retryable error instead of failing mid-stream. Later failures end the stream with an error part.
- **Statuses that avoid retry storms.** Login problems (401), unknown models (404) and usage limits (429 with `insufficient_quota`) are not retried by OpenCode; only rate limits are.
- **Tool activity as reasoning.** `[cursor] read: src/index.ts` lines show what Cursor did without pretending OpenCode ran those tools.
- **Small-model hints.** Haiku, Gemini Flash (Lite) and GPT Luna models get OpenCode's matching `family`, so 2.0 uses them for session titles.
- **Credentials from the environment only.** Cloud Agents tools never take keys or API addresses as tool arguments.

## Testing

Both packages are tested with `node:test` against `test-support/fake-agent.cjs`, a stand-in Cursor CLI whose behaviour is selected by markers in the prompt (`[[scenario:auth]]`, `[[scenario:limit]]`, `[[scenario:stall]]`, ...). The 2.0 plugin is tested against fake provider and tool editors that mirror OpenCode's drafts; it was also checked end to end with OpenCode 2.0.22.

## Roadmap

- **Publish to npm**, so OpenCode can install the plugin by name (`"plugins": ["opencode-plugin-cursor"]` in 2.0). The bridge package must be published first.
- **Conversation continuity.** Map OpenCode sessions to Cursor chats (`agent --resume`) and send only new messages, saving tokens; needs care when users edit or revert messages.
- **OpenCode 1.x provider without config.** Register the `cursor` provider from the plugin's `config` hook instead of a hand-written `opencode.json` block.
- **Approvals in OpenCode 2.0.** Ask before running Cursor tools once OpenCode's plugin API supports permission requests from plugin tools.
- **MCP server.** Offer the same tools to any MCP client.
