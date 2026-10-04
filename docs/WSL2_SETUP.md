# Setting up cursor-opencode-auth on WSL2

Step-by-step setup on WSL2, including fixes for corporate networks (Zscaler, proxies, and similar).

## Contents

- [Prerequisites](#prerequisites)
- [Known issues and fixes](#known-issues-and-fixes)
- [Installation](#installation)
- [OpenCode 2.0 setup](#opencode-20-setup)
- [OpenCode 1.x setup](#opencode-1x-setup)
- [Troubleshooting](#troubleshooting)

## Prerequisites

- WSL2 (Ubuntu or Debian recommended)
- A Cursor subscription
- Node.js 22 or newer inside WSL (`node --version`)

## Known issues and fixes

### IPv6 networking in WSL2 behind corporate SSL inspection

**Background.** In WSL2 with corporate SSL inspection (for example Zscaler), IPv6 can be enabled in the kernel but not work at all. Bun (which OpenCode runs on) and Node.js resolve both IPv6 and IPv4 addresses but may only try IPv6, which can hang indefinitely.

**Symptoms:**

- `bun install` or `npm install` hangs or times out
- `opencode run` hangs on startup
- the bridge fails to start or to connect

**Check whether this affects you:**

```bash
# Corporate SSL inspection certificate?
ls /etc/ssl/certs/ | grep -i zscaler

# Is IPv6 enabled? "0" means yes
sysctl net.ipv6.conf.all.disable_ipv6
```

**Fix: disable IPv6 in WSL2.**

```bash
echo 'net.ipv6.conf.all.disable_ipv6 = 1' | sudo tee -a /etc/sysctl.conf
echo 'net.ipv6.conf.default.disable_ipv6 = 1' | sudo tee -a /etc/sysctl.conf
sudo sysctl -p

# Verify: should print "net.ipv6.conf.all.disable_ipv6 = 1"
sysctl net.ipv6.conf.all.disable_ipv6
```

Apply this **before** installing OpenCode to avoid setup problems.

## Installation

### 1. Install Cursor CLI and log in

```bash
curl https://cursor.com/install -fsS | bash
exec $SHELL

agent --version
agent login        # browser-based login
agent status       # should show that you are logged in
```

Older installs name the command `cursor-agent`; if `agent` is not found, use that name, or set `CURSOR_AGENT_BIN` to its path for the plugin.

### 2. Install OpenCode

Follow the instructions on [opencode.ai](https://opencode.ai). For OpenCode 2.0 via npm:

```bash
npm install -g @opencode/cli
opencode --version
```

If `opencode --version` shows an old version, an earlier install (for example from Homebrew/Linuxbrew) is first on your `PATH`; remove it (`brew uninstall opencode`) and check `which opencode`.

### 3. Build cursor-opencode-auth

Clone it to a permanent location (not `/tmp`):

```bash
mkdir -p ~/projects && cd ~/projects
git clone https://github.com/Infiland/cursor-opencode-auth.git
cd cursor-opencode-auth
npm ci
npm run build
```

## OpenCode 2.0 setup

Create the plugin file (adjust the path to your checkout):

```bash
mkdir -p ~/.config/opencode/plugins
cat > ~/.config/opencode/plugins/cursor.ts << EOF
export { default } from "$HOME/projects/cursor-opencode-auth/packages/opencode-plugin-cursor/dist/index.js";
EOF
```

That is all: OpenCode 2.0 gets the `cursor` provider and the tools from the plugin; no bridge and no provider configuration are needed. Check it:

```bash
opencode models | grep cursor/
opencode run -m cursor/auto "say hello"
```

If you set up OpenCode 1.x before, remove the `provider.cursor` block from `~/.config/opencode/opencode.json`: OpenCode 2.0 would otherwise send Cursor requests to the 1.x bridge.

## OpenCode 1.x setup

### 1. Install the plugin

Create the same plugin file as for 2.0 (above).

### 2. Configure the provider

List the models with `agent --list-models`, then create or update `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "cursor": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Cursor",
      "options": {
        "baseURL": "http://127.0.0.1:8765/v1",
        "apiKey": "unused"
      },
      "models": {
        "auto": { "name": "Auto" },
        "gpt-5.2": { "name": "GPT-5.2" },
        "sonnet-4.5-thinking": { "name": "Claude 4.5 Sonnet (Thinking)" }
      }
    }
  }
}
```

Add any other IDs from `agent --list-models`.

### 3. The bridge

The plugin starts the bridge automatically when OpenCode starts. To run it yourself instead, create a launcher:

```bash
mkdir -p ~/.local/bin
cat > ~/.local/bin/cursor-bridge << 'EOF'
#!/usr/bin/env bash
exec node "$HOME/projects/cursor-opencode-auth/packages/cursor-openai-bridge/dist/cli.js" "$@"
EOF
chmod +x ~/.local/bin/cursor-bridge

# Make sure ~/.local/bin is on your PATH
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

Start it and check it:

```bash
cursor-bridge                               # listens on http://127.0.0.1:8765
curl http://127.0.0.1:8765/v1/models        # in another terminal
```

### 4. Verify

```bash
opencode run -m cursor/gpt-5.2 "say hello"
opencode run -m cursor/gpt-5.2 "What does README.md in this directory say?"
```

For the second prompt, Cursor reads the file with its own tools (in ask mode, read-only) and answers; OpenCode's tools are not involved.

### Running the bridge as a service

The bridge can run under systemd instead (WSL needs systemd enabled: `[boot]` `systemd=true` in `/etc/wsl.conf`, then `wsl --shutdown` from Windows):

```bash
sudo tee /etc/systemd/system/cursor-bridge.service << EOF
[Unit]
Description=Cursor OpenAI bridge
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$HOME
ExecStart=$HOME/.local/bin/cursor-bridge
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now cursor-bridge
```

The plugin finds a running bridge and uses it instead of starting its own.

## Troubleshooting

### Commands or the bridge hang

Usually the IPv6 issue above. Apply the fix and restart the bridge (or OpenCode).

### `opencode run` hangs in scripts but works in a terminal

OpenCode reads the message from stdin when stdin is not a terminal. Give it an empty stdin: `opencode run -m cursor/auto "say hello" < /dev/null`.

### Port 8765 is already in use (1.x)

Another bridge or service holds the port:

```bash
lsof -i :8765
```

Stop it, or run the bridge on another port and point `provider.cursor.options.baseURL` there:

```bash
cursor-bridge --port 8766          # or: CURSOR_BRIDGE_PORT=8766 cursor-bridge
```

For the plugin to use (and autostart) a bridge on another port, start OpenCode with `CURSOR_BRIDGE_PORT=8766` as well.

### "Cursor CLI is not authenticated"

Run `agent login` and finish the browser flow, or set `CURSOR_API_KEY` in the environment OpenCode runs in.

### No `cursor/` models, or Cursor requests fail

1. `agent --list-models` must work in the same shell you start OpenCode from.
2. OpenCode 2.0: only one copy of the plugin may be loaded (plugin file *or* a `plugins` entry), and no `provider.cursor` block may remain from 1.x.
3. OpenCode 1.x: check the bridge with `curl http://127.0.0.1:8765/v1/models`, and its log in `~/.local/share/opencode/cursor-openai-bridge.log`.
4. Look at OpenCode's logs: `ls -lh ~/.local/share/opencode/log/`, or run with `--print-logs --log-level debug`.

### Bridge settings

The bridge reads its settings from the environment, for example:

```bash
CURSOR_BRIDGE_MODE=plan cursor-bridge                       # ask (default), plan, or agent
CURSOR_BRIDGE_WORKSPACE=/path/to/project cursor-bridge      # project when the client sends none
CURSOR_BRIDGE_STRICT_MODEL=false cursor-bridge              # send "auto" as requested
```

`CURSOR_BRIDGE_FORCE=true` lets Cursor run commands without asking (it matters with `agent` mode); use it with care. The full list is in [USAGE.md](USAGE.md#bridge).

## Notes

- If you used another Cursor integration for OpenCode before, remove its plugin and provider configuration first, so that only one `cursor` provider is defined.
- The bridge listens on `127.0.0.1` only and does not expose your credentials. Cursor CLI can read your repository; restrict it with `~/.cursor/cli-config.json` or `<project>/.cursor/cli.json`. See [SECURITY.md](SECURITY.md).

Other questions: see the [README](../README.md) and [USAGE.md](USAGE.md), or open an issue on [GitHub](https://github.com/Infiland/cursor-opencode-auth/issues).
