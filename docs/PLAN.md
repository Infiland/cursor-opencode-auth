# Plan: Cursor <-> OpenCode Community Auth + Integration

## Goal

Make a community-maintained integration that lets OpenCode users leverage Cursor capabilities **without reverse-engineering Cursor**.

In practice, that means two supported, documented Cursor surfaces:

1. **Cursor CLI (`agent`)**
   - Auth: `agent login` (browser flow) or `CURSOR_API_KEY`
   - Models: `agent --list-models` / `agent models` / `--model <id>`
   - Modes: `--mode agent|plan|ask`
   - Non-interactive: `-p/--print` (+ `--output-format`)

2. **Cursor Cloud Agents API** (optional but valuable for async tasks)
   - Base: `https://api.cursor.com`
   - Endpoints: `/v0/agents`, `/v0/models`, `/v0/agents/{id}/conversation`, etc.
   - Auth: docs show Basic auth (`-u API_KEY:`) though OpenAPI spec also mentions Bearer; implement both.
   - Model list for cloud agents: `GET /v0/models`

This project focuses on giving OpenCode a *bridge* to Cursor, not replacing OpenCode’s internal agent loop.

## Non-goals

- Do not use private/undocumented Cursor APIs.
- Do not attempt to turn Cursor into a first-class OpenCode LLM provider unless it can be done with documented APIs *and* preserves OpenCode's tool loop semantics.

## Key constraints (docs-driven)

### Cursor Agent/CLI behavior

- Cursor Agent is itself an agentic loop (instructions + tools + user messages).
- Cursor CLI supports `--print`, but non-interactive mode can still execute tools.
- Cursor CLI permissions are controlled via `~/.cursor/cli-config.json` and `<project>/.cursor/cli.json` using tokens like `Shell(git)`, `Read(src/**)`, `Write(src/**)`.

### OpenCode behavior

- OpenCode’s strength is its own tool loop: `read/edit/write/bash/...` plus plugins and MCP.
- Plugins can add custom tools using `@opencode-ai/plugin`.
- MCP servers can add tools to OpenCode (and Cursor supports MCP too), which is a powerful interoperability point.

## Proposed architecture

### Component 1: OpenCode plugin (primary deliverable)

Package: `packages/opencode-plugin-cursor`

Responsibilities:

- Add OpenCode tools that invoke Cursor *in a controlled way*.
- Provide model discovery.
- Provide safe defaults that avoid hanging on interactive approvals.

Tools (initial):

1. `cursor_cli_models`
   - Runs `agent --list-models` and returns an array.
   - If CLI unavailable, returns a helpful error.

2. `cursor_cli_run`
   - Runs Cursor CLI in print mode for a single prompt.
   - Args:
     - `prompt` (string, required)
     - `mode` (`ask|plan|agent`, default `ask`)
     - `model` (string, optional)
     - `outputFormat` (`text|json`, default `text`)
     - `force` (boolean, default false) — use with caution
   - Safety:
     - default `mode=ask` and `force=false`
     - recommend Cursor CLI permission config if `force=true`

Tools (phase 2):

3. `cursor_cli_patch`
   - Runs Cursor CLI in an *isolated git worktree*, captures the diff, then applies it via OpenCode’s `patch` tool.
   - Why:
     - avoids Cursor directly modifying the primary working tree
     - allows OpenCode to own the applied patch, improving diff visibility and undo/redo semantics
   - Requirements:
     - must be in a git repo
     - must decide how to handle existing uncommitted changes (see below)

4. `cursor_cloud_run`
   - Uses Cursor Cloud Agents API to launch an async agent on a GitHub/GitLab remote.
   - Poll status and return summary + conversation.
   - Does not apply changes locally by default.

5. `cursor_cloud_apply`
   - Given a finished agent, fetch agent branch from origin and optionally apply as patch.
   - Risky; should be opt-in with OpenCode permission prompts.

### Component 2 (optional): MCP server

Because both Cursor and OpenCode support MCP, an MCP server can make this integration portable.

Package (future): `packages/mcp-cursor`

- Expose tools similar to the OpenCode plugin, but via MCP.
- Transport: `stdio` first (local), then possibly SSE/HTTP.
- Auth: environment-based (`CURSOR_API_KEY`).

This lets:

- Cursor use Cursor-API-aware tools (meta, automation) in a consistent way.
- OpenCode use the same tools without requiring an OpenCode-specific plugin.

## Model support strategy

"Support all Cursor models" is only feasible via **Cursor CLI** because:

- Cursor docs explicitly include `--list-models` and `--model <model>` in CLI.
- Cloud Agents API exposes only a subset (Max Mode compatible) via `/v0/models`.

Implementation plan:

- Source of truth for local model list: `agent --list-models`.
- Allow passing any `--model` value even if it is not in the list (Cursor may add models faster than our tooling updates).
- For Cloud Agents:
  - `cursor_cloud_models` calls `GET /v0/models`.
  - accept `model` as free-form string; let API validate.

## Auth strategy

### Cursor CLI

- Preferred: `agent login` (browser flow) stores creds locally.
- Automation: `CURSOR_API_KEY` or `agent --api-key <key>`.

The OpenCode plugin should:

- Detect CLI presence.
- For `cursor_cli_run`, run `agent status` if failures indicate auth issues and return guidance.

### Cursor Cloud Agents API

- Use `CURSOR_API_KEY`.
- Implement both auth styles:
  - Basic: `Authorization: Basic base64("KEY:")`
  - Bearer: `Authorization: Bearer KEY`

## Safety & policy

- No ToS bypass: only documented surfaces.
- Avoid destructive defaults.
- Encourage:
  - OpenCode tool permissions (`permission` config) to require approval for `cursor_*` tools.
  - Cursor CLI permission config to limit Shell/Write.

## Recommended configuration snippets

### OpenCode: load plugin + gate it behind approvals

In `opencode.json` (project root):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-plugin-cursor"],
  "permission": {
    "cursor_cli_models": "ask",
    "cursor_cli_run": "ask"
  }
}
```

This ensures OpenCode asks before it invokes Cursor.

### Cursor CLI: restrict what the agent is allowed to do

In `<project>/.cursor/cli.json` (project-scoped):

```json
{
  "version": 1,
  "editor": { "vimMode": false },
  "permissions": {
    "allow": [
      "Read(**/*)",
      "Shell(ls)",
      "Shell(git)"
    ],
    "deny": [
      "Read(.env*)",
      "Write(**/*)",
      "Shell(rm)",
      "Shell(curl)",
      "Shell(wget)"
    ]
  }
}
```

This makes Cursor CLI effectively read-only for that project.

If you later want to allow safe edits for `cursor_cli_patch`, loosen `Write(...)` selectively (e.g. `Write(src/**)`), not `Write(**/*)`.

## Interop: share rules between Cursor and OpenCode

Cursor CLI applies:

- `.cursor/rules/*`
- `AGENTS.md` at project root
- `CLAUDE.md` at project root

OpenCode applies:

- `AGENTS.md` created by `/init`
- optional extra instruction files via `instructions` in `opencode.json`
- optional skills via `.opencode/skills/*/SKILL.md`

Recommendation:

- Put the “source of truth” guidance in `AGENTS.md` so both tools pick it up.
- Keep Cursor-specific automation in `.cursor/*` and OpenCode-specific automation in `.opencode/*`.

## Handling git state (for cursor_cli_patch)

Open question: how to generate/apply diffs when the user has uncommitted changes.

Options:

1. Require a clean working tree (recommended default)
   - simplest and safest
   - user can stash/commit before running

2. Auto-stash
   - stash + run + re-apply
   - risk of conflicts

3. Patch against current working tree snapshot
   - create a temp copy of the repo directory
   - expensive but most faithful

Plan: start with (1), add (2) behind a flag, and document tradeoffs.

## Developer workflow

### Phase 0: Scaffolding (this repo)

- Monorepo skeleton
- Plugin package skeleton
- Docs + examples

### Phase 1: Cursor CLI tools (MVP)

- Implement `cursor_cli_models`
- Implement `cursor_cli_run` with safe defaults
- Add unit tests with mocked `agent` binary
- Add docs for required Cursor CLI permissions and safe usage

### Phase 2: Patch-based integration

- Implement worktree sandboxing
- Diff extraction + OpenCode patch application
- Validate on:
  - clean repo
  - modified working tree (warn)
  - binary files

### Phase 3: Cloud Agents API support

- Implement `/v0/models` + `/v0/agents` flows
- Provide polling + error handling
- Optional: auto-fetch/apply branch

### Phase 4: MCP server (optional)

- Implement MCP stdio server
- Mirror tools for both Cursor + OpenCode

## Upstream dependencies

### OpenCode: plugin-registered providers

OpenCode's plugin API (`@opencode-ai/plugin`) supports `tool()` registration and event hooks, but **not provider registration**. Providers are configured via `opencode.json` with an AI SDK package (e.g., `@ai-sdk/openai-compatible`). This forces the bridge server workaround for the provider use case.

A proper integration would require OpenCode to add a `provider()` registration function to the plugin API, allowing plugins to register model providers directly. Until then, the bridge creates an agent-wrapping-agent architecture where Cursor CLI's full agent loop is opaque to OpenCode.

### Cursor CLI: stream-json as the primary integration format

Cursor CLI's `--output-format stream-json` produces rich NDJSON events (tool calls, assistant messages, session metadata). This project now uses `stream-json` in both the plugin tools and the bridge to:

- Surface Cursor's tool call activity in `cursor_cli_run` and `cursor_cli_patch`
- Extract clean assistant text in the bridge (filtering out tool call noise)

If Cursor changes the NDJSON event schema, the parsers in `lib/streamJson.ts` (both packages) will need updating.

## Success criteria

- From OpenCode, a user can:
  - list Cursor models
  - run a Cursor-backed response for a prompt
  - optionally produce a patch safely into their working tree

- No private API usage.
- Clear documentation on security implications.
