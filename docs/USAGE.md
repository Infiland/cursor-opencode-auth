# Usage

Installation is covered in the [README](../README.md#install). This page covers day-to-day use, the bridge, and troubleshooting.

## Prerequisites

1. Install Cursor CLI (`agent`):

   ```bash
   curl https://cursor.com/install -fsS | bash
   ```

2. Log in, either interactively or with an API key for automation:

   ```bash
   agent login
   # or
   export CURSOR_API_KEY=key_...
   ```

3. Check: `agent status` and `agent --list-models`.

## Cursor as the model

Pick a `cursor/<model>` model in OpenCode (or `opencode run -m cursor/<model> "..."`). Each request:

1. flattens the conversation (system prompt, messages, earlier tool calls and results) into one prompt;
2. runs `agent --print --output-format stream-json --stream-partial-output --mode ask --trust --workspace <project> --model <model>` with the prompt on stdin, in the project directory;
3. streams Cursor's answer back as text, its thinking as reasoning, and a line such as `[cursor] read: src/index.ts` for each tool Cursor used.

Cursor works with its own tools. In `ask` mode (the default) those are read-only; with `mode: "agent"` (and `force: true` for commands), Cursor edits files and runs commands itself, outside OpenCode's permission system and undo history. Keep `ask` unless you want that.

### OpenCode 2.0

- **Models.** The plugin registers every model `agent --list-models` reports. The list is cached in `$XDG_CACHE_HOME/opencode-plugin-cursor/models.json` (default `~/.cache/...`) and refreshed in the background at startup; OpenCode picks up changes without a restart. To pin the list, set the `models` option.
- **Project.** Cursor runs in the directory of the OpenCode session's location.
- **Overrides.** Your `providers.cursor` config is applied after the plugin, so you can rename models or change limits there, for example:

  ```jsonc
  {
    "providers": {
      "cursor": {
        "models": { "gpt-5.2": { "name": "GPT-5.2 via Cursor", "limit": { "context": 272000 } } }
      }
    }
  }
  ```

- **Session titles.** See the [README](../README.md#opencode-20): pick a cheap model with `agents.title.model`, or disable titles.
- **Keep-alive.** Leave OpenCode's `warming` setting off for Cursor: every keep-alive would be a full Cursor run, and Cursor runs share no prompt cache.

### OpenCode 1.x

OpenCode talks to the [bridge](#bridge) as an OpenAI-compatible provider. The plugin starts the bridge when OpenCode starts (unless `autostart` is `false`) and adds an `X-Cursor-Workspace` header to every `cursor` request, so a single bridge serves all your projects. Models are the ones you list under `provider.cursor.models`; `cursor_cli_models` prints the IDs.

### Errors

| What you see | Cause | Fix |
| --- | --- | --- |
| `Cursor CLI is not authenticated` (HTTP 401) | No login or API key | `agent login`, or set `CURSOR_API_KEY` |
| `Cursor usage limit reached (quota exceeded)` (HTTP 429) | Your Cursor plan's limit | Wait for the reset or change plan; not retried |
| `Cursor rate limit` (HTTP 429) | Too many requests | Retried by OpenCode after a pause |
| `Cursor CLI rejected model "..."` (HTTP 404) | Unknown model ID | `agent --list-models` |
| `Command not found: agent` | Cursor CLI is not on `PATH` | Install Cursor CLI, or set `CURSOR_AGENT_BIN` |
| `Cursor CLI timed out` | Run took longer than `timeoutMs` | Raise `timeoutMs` (or `0` for no limit) |

## Tools

Ask OpenCode to use them, e.g. "use cursor_cli_run to ask Cursor how the auth flow works".

- `cursor_cli_status`: login status.
- `cursor_cli_models`: model IDs (`refresh: true` skips the cache).
- `cursor_cli_run`: one Cursor run. Arguments: `prompt`, `mode` (`ask` by default), `model`, `outputFormat` (`text`, `json`, or `stream-json` for a summary of Cursor's tool calls), `force`, `timeoutMs`.
- `cursor_cli_patch`: let Cursor change a throwaway copy of the repository and get the result as a diff.
  1. Cursor runs with `--force` in a temporary `git worktree` (agent mode by default).
  2. The tool returns the changed files, a summary of Cursor's activity, and the diff inside `<patch>...</patch>`.
  3. `apply: true` applies the diff to your working tree with `git apply`; otherwise apply it yourself or with OpenCode.

  With uncommitted changes, the tool refuses unless you pass `allowDirty: true`; Cursor then starts from a snapshot of your current files (including untracked ones), so the patch applies on top of them. `keepTemp: true` keeps the worktree for inspection.
- `cursor_cli_mcp_list`, `cursor_cli_mcp_tools`: the MCP servers Cursor CLI has configured, and their tools.
- `cursor_cloud_*`: Cursor Cloud Agents (the `https://api.cursor.com/v0` API). Credentials come only from the environment: `CURSOR_API_KEY`, plus optionally `CURSOR_API_AUTH_STYLE` (`basic`, the default, or `bearer`) and `CURSOR_API_BASE_URL`. `cursor_cloud_launch_agent` can attach images (PNG, JPEG, GIF or WebP, up to 10 MB each).
- `cursor_bridge_status`, `cursor_bridge_start`, `cursor_bridge_stop`, `cursor_bridge_restart` (OpenCode 1.x): manage the bridge. `status` reports when a running bridge is older than the plugin; `restart` replaces it.

[examples/opencode/commands/cursor-patch.md](../examples/opencode/commands/cursor-patch.md) is a ready-made `/cursor-patch` command.

## Bridge

`cursor-openai-bridge` serves an OpenAI-compatible API backed by Cursor CLI. OpenCode 1.x needs it for the `cursor` provider; any OpenAI-compatible client can use it too.

```bash
node packages/cursor-openai-bridge/dist/cli.js [--host 127.0.0.1] [--port 8765] [--workspace DIR] [--mode ask|plan|agent]
```

Endpoints:

- `GET /health`: status (details only for authorized callers)
- `GET /v1/models`, `GET /v1/models/{id}`: Cursor CLI's models
- `POST /v1/chat/completions`: streaming (`stream: true`, with `stream_options.include_usage` honored) and non-streaming. The `X-Cursor-Workspace` header (an absolute directory, URI-encoded) selects the project for that request.

Settings (environment variables):

| Variable | Default | |
| --- | --- | --- |
| `CURSOR_BRIDGE_HOST` | `127.0.0.1` | Interface to bind |
| `CURSOR_BRIDGE_PORT` | `8765` | Port |
| `CURSOR_BRIDGE_API_KEY` | none | Require `Authorization: Bearer <key>` on every request except `/health` |
| `CURSOR_BRIDGE_ALLOWED_HOSTS` | none | Extra `Host` header names to accept, comma-separated (`*` accepts any); by default only loopback names and the bind address |
| `CURSOR_BRIDGE_WORKSPACE` | current directory | Project for requests without `X-Cursor-Workspace` |
| `CURSOR_BRIDGE_MODE` | `ask` | `ask`, `plan` or `agent` |
| `CURSOR_BRIDGE_FORCE` | `false` | Pass `--force` |
| `CURSOR_BRIDGE_APPROVE_MCPS` | `false` | Pass `--approve-mcps` |
| `CURSOR_BRIDGE_TRUST` | `true` | Pass `--trust` |
| `CURSOR_BRIDGE_DEFAULT_MODEL` | `auto` | Model for requests that name none |
| `CURSOR_BRIDGE_STRICT_MODEL` | `true` | Requests for `auto` (or no model) reuse the model last requested by name, so background requests do not switch models |
| `CURSOR_BRIDGE_TIMEOUT_MS` | `300000` | Per-request limit; `0` turns it off |
| `CURSOR_BRIDGE_TOOL_ACTIVITY` | `reasoning` | Report Cursor's tool calls as `reasoning_content`, or `off` |
| `CURSOR_BRIDGE_MAX_BODY_BYTES` | `33554432` | Largest accepted request body |
| `CURSOR_AGENT_BIN` | `agent` | Cursor CLI executable |

The bridge answers OpenAI-style errors with statuses chosen so that clients do not pile retries onto failures that cannot succeed: 401 for a missing login, 404 for an unknown model, 429 with `insufficient_quota` for a usage limit, 424 for other Cursor CLI failures. Requests that carry `tools` get a note telling Cursor that the client's tools are unavailable; Cursor never emits tool calls for the client.

## Safety configuration

OpenCode 1.x can ask before each Cursor tool runs:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "cursor_cli_*": "ask",
    "cursor_cloud_*": "ask"
  }
}
```

OpenCode 2.0 has no approval step for plugin tools yet; hide the ones you do not want instead:

```jsonc
{
  "permission": { "cursor_cloud_*": "deny" }
}
```

Limit what Cursor CLI itself may do in `<project>/.cursor/cli.json` (this example is read-only):

```json
{
  "version": 1,
  "permissions": {
    "allow": ["Read(**/*)", "Shell(ls)", "Shell(git)"],
    "deny": ["Read(.env*)", "Write(**/*)", "Shell(rm)", "Shell(curl)", "Shell(wget)"]
  }
}
```

A read-only Cursor configuration also stops `cursor_cli_patch` from producing changes; allow writes selectively (for example `Write(src/**)`) if you use it.

## Troubleshooting

- **No `cursor/` models in OpenCode 2.0.** Check that only one copy of the plugin is loaded (plugin file *or* config entry), and look for `loading plugin` and errors in `~/.local/share/opencode/log/`. `agent --list-models` must work in the same environment OpenCode runs in.
- **Requests go to `127.0.0.1:8765` under OpenCode 2.0.** A 1.x `provider.cursor` block is still in your config; remove it.
- **`Port 8765 is already in use` (1.x).** Another bridge or service holds the port. `cursor_bridge_status` shows whether it is a bridge; otherwise set `CURSOR_BRIDGE_PORT` and point `provider.cursor.options.baseURL` at the new port.
- **The bridge log.** A bridge started by the plugin logs to `~/.local/share/opencode/cursor-openai-bridge.log` (or `$XDG_DATA_HOME/opencode/...`).
- **`opencode run` waits forever in a script.** OpenCode reads the message from stdin when stdin is not a terminal. Run it with `< /dev/null` (or pipe the prompt in) when calling it from scripts or CI.
