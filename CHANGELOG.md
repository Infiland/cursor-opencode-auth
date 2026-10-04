# Changelog

## 0.3.0 (unreleased)

### Added

- **OpenCode 2.0 support.** The plugin registers a `cursor` provider that runs Cursor CLI in-process (an AI SDK language model), so OpenCode 2.0 needs no bridge and no provider configuration. Models are discovered with `agent --list-models`, cached on disk and refreshed in the background. The tools are registered in the `cursor` tool namespace.
- OpenCode 2.0 options: `models`, `providerID`, `name`, `contextLimit`, `outputLimit`, `provider: false`, `tools: false`, plus the run settings `mode`, `force`, `approveMcps`, `trust`, `timeoutMs`, `toolActivity`, `agentBin`. A `server.js` entry lets OpenCode 2.0 load the package from a local directory (`"plugins": [{ "package": "/path/to/opencode-plugin-cursor", "options": { ... } }]`).
- Haiku, Gemini Flash and GPT Luna models are tagged with OpenCode's model family, so OpenCode 2.0 uses them for session titles.
- Cursor's thinking is streamed as reasoning, and each tool Cursor uses appears as a `[cursor] ...` reasoning line (`toolActivity: "off"` / `CURSOR_BRIDGE_TOOL_ACTIVITY=off` to hide them).
- Token usage is reported (including cached tokens); the bridge honours `stream_options.include_usage`.
- Bridge: `GET /v1/models/{id}`, `CURSOR_BRIDGE_TRUST`, `CURSOR_BRIDGE_TOOL_ACTIVITY`, `CURSOR_BRIDGE_MAX_BODY_BYTES`, `CURSOR_BRIDGE_ALLOWED_HOSTS`, command-line flags (`--host`, `--port`, `--workspace`, `--mode`, `--version`, `--help`), SSE keep-alives, and a clean shutdown that stops running Cursor processes.
- `cursor_cli_patch`: `apply: true` applies the patch with `git apply`.
- `cursor_bridge_restart`, and `cursor_bridge_status` reports a bridge older than the plugin.
- Test suites for both packages (against a fake Cursor CLI) and GitHub Actions CI.

### Changed

- Failures are classified: a missing login (401), an unknown model (404) and a usage limit (429, `insufficient_quota`) are reported clearly and are not retried by OpenCode; other Cursor CLI failures are 424 instead of 500.
- The prompt is passed to Cursor CLI on stdin instead of the command line (no argument-length limit, not visible in process listings).
- Cursor CLI runs with `--trust` by default, so headless runs do not stop at the workspace-trust prompt.
- `cursor_cli_patch` with `allowDirty: true` starts from a snapshot of your uncommitted changes (it used `HEAD` before), so the patch applies on top of them. Diffs ignore user git settings (pager, colours, external diff tools, prefixes) and include binary changes.
- The `cursor_cloud_*` tools read `CURSOR_API_KEY`, `CURSOR_API_AUTH_STYLE` and `CURSOR_API_BASE_URL` only from the environment; the `apiKey`, `authStyle` and `baseURL` arguments are gone, so a model cannot send your key elsewhere. Image attachments are checked to be real images of at most 10 MB.
- The bridge only accepts requests whose `Host`/`Origin` is a loopback name or its bind address (blocks DNS rebinding and cross-site requests), compares API keys in constant time, and limits request bodies.
- The plugin's default export is now `{ id, server, setup }` for both OpenCode generations; plugin files should use `export { default } from ".../dist/index.js"`. The named `CursorPlugin` export remains.
- Node.js 22 or newer is required.

### Fixed

- Aborted, cancelled or timed-out requests stop Cursor CLI and everything it started (the whole process group), and requests no longer hang when a child process keeps the output pipes open.
- Streaming with `--stream-partial-output` no longer duplicates or garbles text.
- The plugin starts one bridge even when several projects open at once, restarts an outdated bridge only if it started it, and stops only processes it can identify as the bridge.
- An API-key-protected bridge accepts the key when the provider's `apiKey` header and the plugin's header arrive merged; the plugin now sets the header with the SDK's spelling so it replaces the `apiKey` one.
- Boolean environment variables accept only explicit values (`true/false`, `1/0`, `yes/no`, `on/off`).

### Removed

- The automatic rewriting of plugin files to show a version in `/status`.
- `pnpm-lock.yaml` (the repository uses npm), and the repository-level `opencode.jsonc`, which made OpenCode 2.0 route Cursor through the bridge when run inside this repository; the 1.x example is `examples/opencode/opencode-1.x.jsonc`.

## 0.2.0

- `stream-json` output for `cursor_cli_run` and `cursor_cli_patch`, with a summary of Cursor's tool calls.
- `cursor_cli_mcp_list` and `cursor_cli_mcp_tools`.
- Documentation of the bridge's limitations.

## 0.1.x

- Initial OpenCode plugin (`cursor_cli_*`, `cursor_cloud_*` and `cursor_bridge_*` tools) and the OpenAI-compatible bridge.
