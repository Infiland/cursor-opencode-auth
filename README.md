# cursor-opencode-auth

<img width="858" height="608" alt="image" src="https://github.com/user-attachments/assets/75a004ce-661f-4999-93d0-b45b9f9db6d0" />

Use your Cursor subscription from [OpenCode](https://opencode.ai). Cursor models show up as an OpenCode provider (`cursor/<model>`), and OpenCode gets tools for handing work to Cursor CLI or Cursor Cloud Agents.

This project uses only *documented* Cursor surfaces:

- Cursor CLI (`agent`), its login (`agent login` or `CURSOR_API_KEY`) and its model list (`agent --list-models`)
- the Cursor Cloud Agents API (`https://api.cursor.com/v0/...`)

It does **not** reverse-engineer private Cursor endpoints.

[![Star History Chart](https://api.star-history.com/svg?repos=Infiland/cursor-opencode-auth&type=Date)](https://star-history.com/#Infiland/cursor-opencode-auth&Date)

## What you get

|                                     | OpenCode 2.0 (recommended)                                           | OpenCode 1.x                                                        |
| ----------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **Provider** (`cursor/<model>`)     | Built in: the plugin registers it and runs Cursor CLI in-process     | Through a local OpenAI-compatible bridge, which the plugin starts   |
| **Model list**                      | Discovered from `agent --list-models` and cached                     | Listed by you in `opencode.json`                                    |
| **Tools** (`cursor_cli_*`, `cursor_cloud_*`) | Yes, in the `cursor` tool namespace                         | Yes, plus `cursor_bridge_*`                                         |

Every request to a `cursor/...` model runs Cursor CLI headlessly (`agent --print`) in your project, in read-only **ask** mode by default. Cursor reads your code with its own tools; its answer streams back into OpenCode, together with a one-line note for each tool Cursor used (shown as reasoning). Cursor cannot call OpenCode's tools. See [Known limitations](#known-limitations).

## Requirements

- Cursor CLI, logged in:

  ```bash
  curl https://cursor.com/install -fsS | bash
  agent login            # or: export CURSOR_API_KEY=...
  agent --list-models    # check that it works
  ```

- OpenCode 2.0 (or 1.x)
- Node.js 22+ and npm, to build this repository

## Install

The packages are not published to npm yet, so install from a checkout:

```bash
git clone https://github.com/Infiland/cursor-opencode-auth.git
cd cursor-opencode-auth
npm ci
npm run build
```

### OpenCode 2.0

Load the plugin in **one** of these two ways (not both):

- **Plugin file.** Create `~/.config/opencode/plugins/cursor.ts`:

  ```ts
  export { default } from "/abs/path/to/cursor-opencode-auth/packages/opencode-plugin-cursor/dist/index.js";
  ```

- **Config entry**, which can also take [options](#configuration). In `~/.config/opencode/opencode.jsonc`:

  ```jsonc
  {
    "plugins": [
      {
        "package": "/abs/path/to/cursor-opencode-auth/packages/opencode-plugin-cursor",
        "options": { "mode": "ask" }
      }
    ]
  }
  ```

Then check that the models are there and try one:

```bash
opencode models | grep cursor/
opencode run -m cursor/auto "Summarize this repository"
```

No bridge and no provider block are needed. On the very first start only `cursor/auto` is listed until `agent --list-models` finishes in the background; after that the list is cached.

> **Upgrading from OpenCode 1.x?** Remove the `provider.cursor` block from your OpenCode config. OpenCode 2.0 still reads it, and it would send Cursor requests to the 1.x bridge (which nothing starts under 2.0) instead of the built-in provider.

Session titles: OpenCode 2.0 writes a title for each new session with a small model. When Cursor lists a Haiku, Gemini Flash or GPT Luna model, the plugin marks it so OpenCode picks it; otherwise the title costs a run of the session's model. To choose yourself, set `"agents": { "title": { "model": "cursor/<model>" } }`, or turn titles off with `"agents": { "title": { "disabled": true } }`.

### OpenCode 1.x

1. Create the same plugin file, `~/.config/opencode/plugins/cursor.ts` (see above).
2. Add the provider to `~/.config/opencode/opencode.json`, with model IDs from `agent --list-models`:

   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "provider": {
       "cursor": {
         "npm": "@ai-sdk/openai-compatible",
         "name": "Cursor",
         "options": { "baseURL": "http://127.0.0.1:8765/v1", "apiKey": "unused" },
         "models": {
           "auto": { "name": "Auto" },
           "gpt-5.2": { "name": "GPT-5.2" }
         }
       }
     }
   }
   ```

3. Restart OpenCode and try `opencode run -m cursor/auto "say hello"`.

The plugin starts the bridge on `127.0.0.1:8765` when OpenCode starts (or use the `cursor_bridge_start` tool, or run `node packages/cursor-openai-bridge/dist/cli.js` yourself). One bridge serves every open project; the plugin tells it which project each request comes from.

WSL2 users: see [docs/WSL2_SETUP.md](docs/WSL2_SETUP.md).

## Configuration

Plugin options go in the 2.0 config entry above, or in a 1.x tuple: `"plugin": [["/abs/path/to/packages/opencode-plugin-cursor", { ... }]]`. Most have an environment variable too; options win.

| Option | Environment variable | Default | |
| --- | --- | --- | --- |
| `mode` | `CURSOR_BRIDGE_MODE` | `ask` | How Cursor runs for model requests: `ask` (read-only), `plan`, or `agent` (may edit files and run commands) |
| `force` | `CURSOR_BRIDGE_FORCE` | `false` | Pass `--force`: run commands without asking unless your Cursor permissions deny them |
| `approveMcps` | `CURSOR_BRIDGE_APPROVE_MCPS` | `false` | Pass `--approve-mcps` |
| `trust` | `CURSOR_BRIDGE_TRUST` | `true` | Pass `--trust`, so headless runs do not stop at Cursor's workspace-trust prompt |
| `timeoutMs` | `CURSOR_BRIDGE_TIMEOUT_MS` | `300000` | Per-request limit; `0` turns it off |
| `toolActivity` | `CURSOR_BRIDGE_TOOL_ACTIVITY` | `reasoning` | Show Cursor's tool calls as reasoning, or `off` |
| `agentBin` | `CURSOR_AGENT_BIN` | `agent` | Cursor CLI executable |
| `models` | | all listed models | Register only these model IDs (2.0) |
| `providerID` | | `cursor` | Provider ID; models are `<providerID>/<model>` |
| `name` | | `Cursor` | Provider display name |
| `contextLimit`, `outputLimit` | | `200000`, `32000` | Token limits reported to OpenCode (2.0) |
| `provider` | | `true` | `false`: tools only, no provider (2.0) |
| `tools` | | `true` | `false`: provider only, no tools (2.0) |
| `autostart` | `CURSOR_BRIDGE_AUTOSTART` | `true` | Start the bridge when it is not running (1.x) |
| `bridgeURL` | `CURSOR_BRIDGE_HOST`, `CURSOR_BRIDGE_PORT` | `http://127.0.0.1:8765` | Where the bridge is (1.x) |

In OpenCode 2.0 you can also override what the plugin registers under `providers.cursor` in your config (names, limits, `settings`); your config is applied after the plugin. The bridge has more settings of its own; see [docs/USAGE.md](docs/USAGE.md#bridge).

## Tools

| Tool | What it does |
| --- | --- |
| `cursor_cli_status` | Cursor CLI login status (`agent status`) |
| `cursor_cli_models` | Models Cursor CLI offers (`refresh: true` skips the cache) |
| `cursor_cli_run` | Run Cursor CLI on a prompt and return its answer (ask mode unless `mode` says otherwise; `outputFormat: "stream-json"` adds a summary of Cursor's tool calls) |
| `cursor_cli_patch` | Let Cursor work in a temporary git worktree and return its changes as a diff; `apply: true` applies it, `allowDirty: true` starts from your uncommitted changes |
| `cursor_cli_mcp_list`, `cursor_cli_mcp_tools` | Inspect the MCP servers configured in Cursor CLI |
| `cursor_cloud_*` | Cursor Cloud Agents: `models`, `launch_agent`, `agent`, `agents`, `conversation`, `followup`, `stop`, `delete`, `me`, `repositories` (needs `CURSOR_API_KEY`) |
| `cursor_bridge_*` | Bridge `status`, `start`, `stop`, `restart` (OpenCode 1.x) |

In OpenCode 2.0 the tools live in the `cursor` namespace (code mode calls them as `tools.cursor.cli_run(...)`), and their names stay `cursor_cli_run` and so on.

## Safety

- Cursor CLI runs on your machine with your permissions. Restrict it with `~/.cursor/cli-config.json` or `<project>/.cursor/cli.json`; see [examples/cursor/cli.json](examples/cursor/cli.json) for a read-only setup.
- `cursor_cli_patch` runs Cursor with `--force` inside a throwaway worktree. Your files change only with `apply: true`, but Cursor can still run commands there.
- OpenCode 1.x can ask before each Cursor tool runs: `"permission": { "cursor_cli_*": "ask", "cursor_cloud_*": "ask" }`.
- OpenCode 2.0 cannot ask before plugin tools run yet. Hide the tools you do not want, e.g. `"permission": { "cursor_cloud_*": "deny" }`, or set the plugin option `tools: false`.
- Cloud Agents run remotely and execute commands; only use them on repositories where that is acceptable.

More in [docs/SECURITY.md](docs/SECURITY.md).

## Known limitations

- **Cursor is an agent, not a bare model.** A `cursor/...` request runs Cursor's own agent loop inside OpenCode's. Cursor works with its own tools (in ask mode: read and search only), so OpenCode's tool calls, permissions and edit tracking do not apply to what Cursor does. Prefer `mode: "ask"` (the default) and let OpenCode make the edits, or use `cursor_cli_patch` for reviewable changes.
- **Each request starts from scratch.** Cursor receives the conversation as one prompt per request, so long sessions resend everything and there is no prompt caching between turns.
- **Text only.** Images and file attachments are replaced by a placeholder.
- **Usage.** Every request, including title generation and retries, is a full Cursor run and counts against your Cursor plan. Failures that cannot succeed on retry (no login, unknown model, usage limit) are reported to OpenCode as non-retryable.

## Repository layout

- `packages/opencode-plugin-cursor/`: the OpenCode plugin
  - `src/v2/`: OpenCode 2.0 provider (an AI SDK language model that runs Cursor CLI) and tool adapter
  - `src/v1.ts`: OpenCode 1.x entry (tools and bridge management)
  - `src/tools/`: `cursor_cli_*`, `cursor_cloud_*` and `cursor_bridge_*` tools
- `packages/cursor-openai-bridge/`: OpenAI-compatible HTTP server backed by Cursor CLI, plus the Cursor CLI helpers the plugin shares
- `test-support/fake-agent.cjs`: stand-in Cursor CLI for the test suites
- `docs/`: [usage](docs/USAGE.md), [security](docs/SECURITY.md), [design](docs/PLAN.md), [WSL2](docs/WSL2_SETUP.md)
- `examples/`: sample OpenCode and Cursor CLI configuration

Development: `npm test` builds and runs both test suites; see [CONTRIBUTING.md](CONTRIBUTING.md).
