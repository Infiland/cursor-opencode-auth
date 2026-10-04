# Contributing to cursor-opencode-auth

Thank you for your interest in contributing!
This repository integrates Cursor with OpenCode using documented Cursor interfaces only.

We welcome contributions that improve stability, documentation, safety, and the developer experience.

---

## Project scope

This project integrates with:

- Cursor CLI (`agent`) and its authentication
- the Cursor Cloud Agents API (`https://api.cursor.com/v0/...`)
- OpenCode 2.0 (plugin-registered provider and tools) and OpenCode 1.x (plugin tools plus a local OpenAI-compatible bridge)

Important:

- This project does **not** reverse-engineer private Cursor endpoints.
- Only documented Cursor surfaces may be used.

---

## Getting started

You need Node.js 22 or newer.

```bash
git clone https://github.com/Infiland/cursor-opencode-auth.git
cd cursor-opencode-auth
npm ci
npm run build
npm test
```

`npm test` builds the bridge, then runs both packages' test suites. They do not need Cursor CLI or a Cursor account: they use `test-support/fake-agent.cjs`, a stand-in `agent` executable whose behaviour is selected by markers in the prompt (for example `[[scenario:auth]]` or `[[scenario:stall]]`).

Other scripts:

- `npm run typecheck`: type-check the sources and tests of both packages
- `npm test -w opencode-plugin-cursor` (or `-w cursor-openai-bridge`): one package's tests (build the bridge first)

To try your changes in OpenCode, point a plugin file at your checkout (see the [README](README.md#install)) and restart OpenCode after `npm run build`. With a real Cursor CLI installed and logged in, `agent --list-models` should work.

### Layout

- `packages/cursor-openai-bridge`: the bridge server and the Cursor CLI helpers shared with the plugin (process handling, `stream-json` parsing, prompt building, failure classification)
- `packages/opencode-plugin-cursor`: the plugin; `src/v2/` is the OpenCode 2.0 provider and tool adapter, `src/v1.ts` the OpenCode 1.x entry, `src/tools/` the tools

The plugin imports the bridge package, so changes to shared helpers affect both.

---

## Branches

Create a branch for your change:

```bash
git checkout -b feature/short-description
```

Examples: `feature/cloud-agent-retry`, `fix/bridge-port-error`, `docs/improve-installation-guide`.

Do not commit directly to `main`.

---

## Before submitting a pull request

- `npm run build`, `npm run typecheck` and `npm test` pass (CI runs them on Node.js 22 and 24)
- New behaviour has tests; Cursor CLI behaviour belongs in a fake-agent scenario
- Changes are scoped and minimal
- Documentation and `CHANGELOG.md` are updated if behaviour changes

---

## Commit messages

Use conventional commit style:

```
feat: add cloud agent timeout handling
fix: handle CLI auth detection issue
docs: improve usage instructions
refactor: simplify bridge config loader
```

---

## Releasing

Both packages share a version. The plugin depends on `cursor-openai-bridge`, so publish the bridge first, then the plugin.

---

## Security considerations

This project involves:

- local code execution (Cursor CLI)
- remote execution (Cursor Cloud Agents)

Be careful with command execution, which directories Cursor can work in, environment variables, and API keys. If your contribution touches execution logic, document the risks. See [docs/SECURITY.md](docs/SECURITY.md).

---

## What not to contribute

- Reverse-engineered private APIs
- Hard-coded authentication bypasses
- Unsafe auto-execution features
- Changes that tightly couple OpenCode internals to Cursor internals

---

## Submitting a pull request

- Give a clear summary
- Explain why the change is needed
- Describe how you tested it
- Mention any security implications

---

## Code of conduct

Be respectful and constructive. We aim to keep this a clean, safe, and technically precise integration between Cursor and OpenCode.

Thank you for contributing!
