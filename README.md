# cursor-opencode-auth

<img width="858" height="608" alt="image" src="https://github.com/user-attachments/assets/75a004ce-661f-4999-93d0-b45b9f9db6d0" />

Community integration between Cursor and OpenCode.

This repo is intentionally built around *documented* Cursor surfaces:

- Cursor CLI (`agent`) + its auth (`agent login` or `CURSOR_API_KEY`) and model list (`--list-models`)
- Cursor Cloud Agents API (`https://api.cursor.com/v0/...`) for async remote agents

It does **not** attempt to reverse-engineer private Cursor endpoints.

[![Star History Chart](https://api.star-history.com/svg?repos=Infiland/cursor-opencode-auth&type=Date)](https://star-history.com/#Infiland/cursor-opencode-auth&Date)

## What this enables

- Use Cursor's model lineup (via Cursor CLI) *from inside* OpenCode as a callable tool.
- Use Cursor models as an OpenCode provider (via a local OpenAI-compatible bridge) so OpenCode prompts consume Cursor usage.
- Optionally delegate longer tasks to Cursor Cloud Agents and pull back the results.

Important distinction:

- **Plugin tools** (`cursor_cli_*`, `cursor_cloud_*`) let OpenCode *call* Cursor.
- **Provider** (`cursor/<model>`) lets OpenCode *use Cursor as the model*.

## Installation

> **WSL2 Users**: See [docs/WSL2_SETUP.md](docs/WSL2_SETUP.md) for detailed WSL2-specific setup instructions, including fixes for common issues like IPv6 networking problems in corporate environments.

### Method 1 (recommended): paste this into OpenCode

Copy/paste this whole block as a prompt in OpenCode:

```text
Install the Cursor provider + tools from /path/to/cursor-opencode-auth.

Requirements:
- Use the existing local checkout at /path/to/cursor-opencode-auth (do not re-clone).
- Ensure Cursor CLI is installed (agent). If not installed, install via: curl https://cursor.com/install -fsS | bash
- Ensure Cursor CLI is authenticated. If not, tell me to run: agent login

Steps:
1) Build the repo:
   - npm install
   - npm --workspaces run build

2) Install the OpenCode plugin (dev shim):
   - Create ~/.config/opencode/plugins/cursor-opencode-auth.ts exporting CursorPlugin from:
     /path/to/cursor-opencode-auth/packages/opencode-plugin-cursor/dist/index.js

3) Configure OpenCode to expose a provider named "cursor" that points at the local bridge:
   - Update ~/.config/opencode/opencode.json to include:
     provider.cursor.npm = "@ai-sdk/openai-compatible"
     provider.cursor.options.baseURL = "http://127.0.0.1:8765/v1"
     provider.cursor.options.apiKey = "unused"
   - Populate provider.cursor.models by running: agent --list-models

4) Verify:
   - opencode models cursor
   - In OpenCode, switch model to cursor/gpt-5.2 (or any Cursor model ID) and send a test prompt.

If the provider cannot connect, use the plugin tool cursor_bridge_start and retry.
```

### Method 2: manual installation

1) Install Cursor CLI and log in:

```bash
curl https://cursor.com/install -fsS | bash
agent login
agent --list-models
```

2) Build this repo:

```bash
cd /path/to/cursor-opencode-auth
npm install
npm --workspaces run build
```

3) Install the OpenCode plugin (dev shim):

Create `~/.config/opencode/plugins/cursor-opencode-auth.ts`:

```ts
// Uses your local checkout (v0.2.0+) instead of a cached npm install.
export { CursorPlugin } from "/path/to/cursor-opencode-auth/packages/opencode-plugin-cursor/dist/index.js";
```

After the plugin loads once, it will automatically create/rename a versioned plugin entry
so `/status` can show the version (you may need to restart OpenCode once).

Important: if you previously installed the npm plugin via `opencode.json` (e.g. `"plugin": ["opencode-plugin-cursor"]`), remove it to avoid loading **two** versions of the plugin.

If you prefer installing from npm instead of a local checkout, pin the version in your OpenCode config (after publishing):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-plugin-cursor@0.2.0"]
}
```

4) Add the Cursor provider to `~/.config/opencode/opencode.json`:

- Base URL: `http://127.0.0.1:8765/v1`
- Models: use the IDs from `agent --list-models` (examples: `auto`, `gpt-5.2`, `sonnet-4.5-thinking`, ...)

5) Restart OpenCode and verify:

```bash
opencode models cursor
opencode run -m cursor/gpt-5.2 "say hello"
```

If the provider can’t connect, run `cursor_bridge_start` inside OpenCode (or start the bridge manually):

```bash
node /path/to/cursor-opencode-auth/packages/cursor-openai-bridge/dist/cli.js
```

Bridge knobs (optional env vars):

- `CURSOR_BRIDGE_WORKSPACE`: workspace dir for Cursor CLI (defaults to the bridge process `cwd`)
- `CURSOR_BRIDGE_MODE`: `ask` | `plan` | `agent` (default: `ask`)
- `CURSOR_BRIDGE_STRICT_MODEL`: `true` | `false` (default: `true`)
- `CURSOR_BRIDGE_FORCE`: `true` | `false` (default: `false`)
- `CURSOR_BRIDGE_APPROVE_MCPS`: `true` | `false` (default: `false`)

## Status

Docs:

- `docs/PLAN.md` (architecture + roadmap)
- `docs/USAGE.md` (how to install + use)
- `docs/WSL2_SETUP.md` (WSL2-specific setup guide with troubleshooting)
- `docs/SECURITY.md` (risks + mitigations)

The OpenCode plugin adds tools:

- `cursor_cli_status` (shows Cursor CLI auth status)
- `cursor_cli_models` (lists Cursor CLI models)
- `cursor_cli_run` (runs Cursor CLI in `--print` mode; supports `stream-json` output for full tool call visibility)
- `cursor_cli_patch` (runs Cursor CLI in an isolated git worktree and returns a patch)
- `cursor_cli_mcp_list` (lists MCP servers configured in Cursor CLI)
- `cursor_cli_mcp_tools` (lists tools from a specific Cursor MCP server)
- `cursor_cloud_*` tools (launch and manage Cursor Cloud Agents via `https://api.cursor.com/v0/...`)

## Repo layout

- `packages/opencode-plugin-cursor/` - OpenCode plugin package
- `packages/opencode-plugin-cursor/src/tools/` - tool definitions (`cursor_cli_*`, `cursor_cloud_*`, `cursor_bridge_*`)
- `packages/opencode-plugin-cursor/src/lib/` - shared helpers (bridge process mgmt, Cursor API client, etc.)
- `packages/cursor-openai-bridge/` - local OpenAI-compatible server backed by Cursor CLI
- `packages/cursor-openai-bridge/src/lib/` - bridge internals (config, HTTP helpers, Cursor CLI wrapper)
- `docs/PLAN.md` - architecture + build plan
- `examples/` - sample Cursor + OpenCode config

## Using the tools

- `cursor_cli_run`: one-off Cursor CLI response (defaults to Cursor `ask` mode)
- `cursor_cli_patch`: run Cursor in an isolated git worktree and return a diff inside `<patch>...</patch>` (apply with OpenCode `patch`)
- `cursor_cloud_*`: manage Cursor Cloud Agents via `https://api.cursor.com/v0/...` (requires `CURSOR_API_KEY`)

## Known limitations

### Bridge-as-provider creates nested agent loops

Cursor CLI is a full coding agent (it reads files, calls tools, writes code), not a model. When you use `cursor/<model>` as an OpenCode provider, OpenCode sends a prompt to the bridge, which runs Cursor's own agent loop, then returns only the final text. This means:

- Two agent loops run with no coordination (OpenCode's loop wrapping Cursor's loop).
- Cursor's internal tool calls (file reads, edits, shell commands) are invisible to OpenCode.
- OpenCode treats Cursor's agent output as a "model response," which is a semantic mismatch.

**Recommended:** Use the CLI tools (`cursor_cli_run` with `outputFormat: "stream-json"`, or `cursor_cli_patch`) instead of the provider for full visibility into what Cursor did. The provider approach works for simple question-answering but loses important context for coding tasks.

### OpenCode does not support plugin-registered providers

OpenCode's plugin API supports registering tools and event hooks, but not custom model providers. Providers must be configured via `opencode.json` with an AI SDK package (e.g., `@ai-sdk/openai-compatible`). This is why the bridge server exists as a workaround. A proper integration would require OpenCode to add `provider()` registration to its plugin API (see [OpenCode plugin docs](https://opencode.ai/docs/plugins/)).

## Safety notes

- Cursor CLI in print mode can still read your repo. Treat it as trusted code execution.
- To safely allow/deny tool use in Cursor CLI, configure `~/.cursor/cli-config.json` or `<project>/.cursor/cli.json` (see Cursor docs: CLI Permissions).
- Cursor Cloud Agents are remote and auto-run commands; only use on repos you can safely run in the cloud.
