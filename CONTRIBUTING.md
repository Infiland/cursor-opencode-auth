````
# Contributing to cursor-opencode-auth

Thank you for your interest in contributing to this project!   
This repository enables structured integration between Cursor and OpenCode using documented Cursor interfaces only.

We welcome contributions that improve stability, documentation, safety, and overall developer experience.

---

## Project Scope

This project integrates with:

- Cursor CLI (`agent`) and its authentication
- Cursor Cloud Agents API (`https://api.cursor.com/v0/...`)
- A local OpenAI-compatible bridge
- OpenCode plugin + provider system

Important:
- This project does **not** reverse-engineer private Cursor endpoints.
- Only documented Cursor surfaces should be used.
- Plugin tools and provider logic must remain clearly separated.

---

### Getting Started

### 1. Install Cursor CLI

```bash
curl https://cursor.com/install -fsS | bash
agent login
agent --list-models
````

### 2. Install Dependencies

```bash
npm install
npm --workspaces run build
```

### 3. (Optional) Start the Bridge

```bash
node packages/cursor-openai-bridge/dist/cli.js
```

---

## Branching Guidelines

Please create a new branch for your changes:

```bash
git checkout -b feature/short-description
```

Examples:

* `feature/cloud-agent-retry`
* `fix/bridge-port-error`
* `docs/improve-installation-guide`

Do not commit directly to `main`.

---

##  Before Submitting a Pull Request

Please ensure:

* `npm --workspaces run build` passes
* Cursor CLI authentication works (`agent --list-models`)
* The bridge responds at `http://127.0.0.1:8765/v1` (if applicable)
* Changes are scoped and minimal
* Documentation is updated if behavior changes

---

## Commit Message Format

Use conventional commit style:

```
feat: add cloud agent timeout handling
fix: handle CLI auth detection issue
docs: improve usage instructions
refactor: simplify bridge config loader
```

---

## Security Considerations

This project interacts with:

* Local code execution (Cursor CLI)
* Remote execution (Cursor Cloud Agents)

Be cautious about:

* Command execution risks
* Workspace exposure
* Environment variable leakage
* API key handling

If your contribution touches execution logic, clearly document risks.

See: `docs/SECURITY.md`

---

##  What Not to Contribute

* Reverse-engineered private APIs
* Hardcoded authentication bypasses
* Unsafe auto-execution features
* Changes that tightly couple OpenCode internals to Cursor internals

---

## Submitting a Pull Request

When opening a PR:

* Provide a clear summary
* Explain why the change is needed
* Describe testing steps
* Mention any security implications (if relevant)

Example PR title:

```
docs: add CONTRIBUTING.md
```

---

## Code of Conduct

Be respectful and constructive.
We aim to maintain a clean, safe, and technically precise integration layer between Cursor and OpenCode.

---

Thank you for contributing! 

```
