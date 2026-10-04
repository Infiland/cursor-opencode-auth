# Security notes

This project uses only *documented* Cursor surfaces:

- Cursor CLI (`agent`)
- the Cursor Cloud Agents API (`https://api.cursor.com/v0/...`)

It does not reverse-engineer private Cursor endpoints, and it never handles your Cursor credentials: Cursor CLI keeps its own login, and the Cloud Agents tools read `CURSOR_API_KEY` from the environment.

## Cursor as the model

A request to a `cursor/...` model runs Cursor CLI in your project directory with the conversation as its prompt.

- **Read access.** Even in the default `ask` mode, Cursor reads files in the project to answer. Everything in the conversation and whatever Cursor reads goes to Cursor's servers, as with any use of Cursor.
- **Workspace trust.** The plugin passes `--trust` so headless runs do not stop at Cursor's trust prompt. Set `trust: false` (or `CURSOR_BRIDGE_TRUST=false`) if you rely on that prompt; runs in untrusted directories will then fail instead.
- **Edits and commands.** `mode: "agent"` lets Cursor change files and run commands on its own, outside OpenCode's permissions and undo; `force: true` removes Cursor's own confirmation for commands. Both are off by default.
- **Prompt injection.** Text in your repository or in tool output can try to steer Cursor like any model. Keep Cursor read-only for untrusted code.

Restrict Cursor CLI itself with `~/.cursor/cli-config.json` or `<project>/.cursor/cli.json`, for example denying `Read(.env*)`, `Write(**/*)` and dangerous shell commands; see [examples/cursor/cli.json](../examples/cursor/cli.json).

## Plugin tools

- OpenCode plugins run with your user's permissions. Install plugins you trust.
- OpenCode 1.x can require approval per tool (`"permission": { "cursor_cli_*": "ask" }`). OpenCode 2.0 cannot prompt for plugin tools yet; hide tools with `deny` rules or the `tools: false` option.
- `cursor_cli_run` uses ask mode unless the caller passes `mode`/`force`. A model that can call this tool can ask for `mode: "agent"` and `force: true`, so gate or hide it if that matters to you.
- The `cursor_cloud_*` tools take credentials and the API address only from the environment (`CURSOR_API_KEY`, `CURSOR_API_AUTH_STYLE`, `CURSOR_API_BASE_URL`), never from tool arguments, so a model cannot send your key elsewhere. Image attachments must be real PNG, JPEG, GIF or WebP files of at most 10 MB.

## cursor_cli_patch

`cursor_cli_patch`:

1. refuses to run on uncommitted changes unless `allowDirty: true`; then it snapshots them into a temporary commit object (your index, branches and stash are not touched);
2. creates a temporary, detached `git worktree` and runs Cursor there with `--force`;
3. returns the diff, and applies it to your working tree only with `apply: true`;
4. removes the worktree and temporary files (unless `keepTemp: true`).

Cursor cannot edit your working tree this way, but it can still run commands inside the temporary worktree, with your permissions.

## The bridge (OpenCode 1.x)

The bridge runs Cursor CLI for anyone who can reach it, so it is locked down by default:

- It listens on `127.0.0.1` only. Binding it to other interfaces exposes your Cursor account and file access to that network; set `CURSOR_BRIDGE_API_KEY` if you do.
- It rejects requests whose `Host` or `Origin` header is not a loopback name or the bind address, so web pages cannot drive it (CSRF, DNS rebinding). Add names with `CURSOR_BRIDGE_ALLOWED_HOSTS`.
- With `CURSOR_BRIDGE_API_KEY` set, every request except a minimal `/health` needs `Authorization: Bearer <key>` (compared in constant time). Set the same variable for OpenCode so the plugin sends it.
- Request bodies are limited (`CURSOR_BRIDGE_MAX_BODY_BYTES`, 32 MB by default), and the prompt is passed on stdin, never on the command line, so it does not show up in process listings.
- The `X-Cursor-Workspace` header picks the directory Cursor runs in. It must name an existing absolute directory; any client that can reach the bridge can choose it, which is one more reason to keep the bridge on loopback.
- The plugin stops only bridges it can identify: the process reported by the bridge's own `/health`, or the recorded pid after checking its command line.

## Cloud Agents

Cloud Agents run in a remote environment with internet access and execute commands automatically.

- Use them only on repositories where remote execution is acceptable.
- Do not put secrets in prompts; use Cursor's Cloud Agent secrets settings instead of committing `.env` files.
