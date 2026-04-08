# Usage

## Prereqs

1) Install Cursor CLI (`agent`):

```bash
curl https://cursor.com/install -fsS | bash
```

2) Authenticate Cursor CLI:

- Interactive: `agent login`
- Or set an API key for automation:

```bash
export CURSOR_API_KEY=key_...
```

## Install the plugin into OpenCode

### Option A (local dev): global plugin file

Create a file in `~/.config/opencode/plugins/` that exports `CursorPlugin`.

Example (local checkout):

```ts
// ~/.config/opencode/plugins/cursor.ts
// Uses your local checkout (v0.2.0+) instead of a cached npm install.
export { CursorPlugin } from "/abs/path/to/cursor-opencode-auth/packages/opencode-plugin-cursor/dist/index.js";
```

After the plugin loads once, it will automatically create/rename a versioned plugin entry
so `/status` can show the version (you may need to restart OpenCode once).

Restart OpenCode.

## Use Cursor as an OpenCode provider (Cursor usage/quota)

OpenCode providers are HTTP-based. Cursor does not expose a public “chat completions” API for your subscription, so this repo ships a **local bridge** that turns Cursor CLI (`agent`) into an OpenAI-compatible endpoint.

### 1) Start the bridge

The bridge listens on `http://127.0.0.1:8765` by default.

By default the bridge:

- Runs Cursor CLI in **ask mode** (passes `--mode ask`) so it behaves like a normal model provider and avoids Cursor's internal agent loop (fewer underlying model requests).
- Does **not** pass `--force` or `--approve-mcps` unless explicitly enabled.
- Pins requests to the **last explicitly selected model** to avoid accidental `auto`/fallback calls (`CURSOR_BRIDGE_STRICT_MODEL=true`).

Environment variables (optional):

- `CURSOR_BRIDGE_WORKSPACE`: workspace dir for Cursor CLI (defaults to the bridge process `cwd`)
- `CURSOR_BRIDGE_MODE`: `ask` | `plan` | `agent` (default: `ask`)
- `CURSOR_BRIDGE_STRICT_MODEL`: `true` | `false` (default: `true`)
- `CURSOR_BRIDGE_FORCE`: `true` | `false` (default: `false`)
- `CURSOR_BRIDGE_APPROVE_MCPS`: `true` | `false` (default: `false`)

Option A: start it from OpenCode (recommended)

- `cursor_bridge_start`

Option B: start it in a terminal

```bash
node <path-to-repo>/packages/cursor-openai-bridge/dist/cli.js
```

### 2) Configure the `cursor` provider

Add this to your OpenCode config (`~/.config/opencode/opencode.json` or a project `opencode.jsonc`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "cursor": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Cursor (Local Bridge)",
      "options": {
        "baseURL": "http://127.0.0.1:8765/v1",
        "apiKey": "unused"
      },
      "models": {
        "auto": { "name": "Auto" }
      }
    }
  }
}
```

Then pick a model like `cursor/auto` or `cursor/gpt-5.2`.

### Option B (npm): opencode.json

After publishing `opencode-plugin-cursor` to npm:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-plugin-cursor@0.2.0"]
}
```

## Recommended safety config

In `opencode.json`, require approval before invoking Cursor:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "cursor_cli_*": "ask",
    "cursor_cloud_*": "ask"
  }
}
```

In `<project>/.cursor/cli.json`, restrict what Cursor CLI can do (example is read-only):

```json
{
  "version": 1,
  "editor": { "vimMode": false },
  "permissions": {
    "allow": ["Read(**/*)", "Shell(ls)", "Shell(git)"],
    "deny": ["Read(.env*)", "Write(**/*)", "Shell(rm)", "Shell(curl)", "Shell(wget)"]
  }
}
```

## Using it in OpenCode

### 1) Check Cursor auth

Ask OpenCode to call:

- `cursor_cli_status`

### 2) List Cursor models

- `cursor_cli_models`

### 3) Run Cursor for a one-off answer

- `cursor_cli_run` with `mode=ask` (default)

### 4) Generate a patch safely (recommended)

1) Call `cursor_cli_patch` with your prompt.
2) Take the diff inside `<patch>...</patch>` and apply it with OpenCode’s `patch` tool.

This avoids letting Cursor edit your primary working tree directly.

## Cursor Cloud Agents (optional)

Use:

- `cursor_cloud_models`
- `cursor_cloud_launch_agent`
- `cursor_cloud_agent`
- `cursor_cloud_conversation`
- `cursor_cloud_followup`

These require a Cursor API key (`CURSOR_API_KEY`) and access to the Cloud Agents feature.
