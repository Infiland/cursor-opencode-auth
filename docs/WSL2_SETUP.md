# Setting Up cursor-opencode-auth on WSL2

This guide provides step-by-step instructions for setting up cursor-opencode-auth on WSL2, with special considerations for corporate environments (Zscaler, proxies, etc.).

## Table of Contents

- [Prerequisites](#prerequisites)
- [Known Issues & Fixes](#known-issues--fixes)
- [Installation](#installation)
- [Configuration](#configuration)
- [Verification](#verification)
- [Troubleshooting](#troubleshooting)

## Prerequisites

- WSL2 (Ubuntu or Debian recommended)
- A Cursor Pro subscription
- Basic familiarity with the terminal

## Known Issues & Fixes

### IPv6 Networking Issues in WSL2 + Corporate Environments

**Background**: In WSL2 environments with corporate SSL inspection (e.g., Zscaler), IPv6 may be enabled at the kernel level but completely non-functional. Bun (which OpenCode is built on) and Node.js will resolve DNS to both IPv6 and IPv4 addresses but may only attempt IPv6 connections, which can black-hole and hang indefinitely.

**Symptoms**:
- `bun install` hangs indefinitely
- `opencode run` hangs on startup
- `npm install` takes extremely long or times out
- Bridge server fails to start or connect

**Check if this affects you**:

```bash
# Check for Zscaler or corporate SSL inspection certificate
ls /etc/ssl/certs/ | grep -i zscaler

# Check if IPv6 is enabled
sysctl net.ipv6.conf.all.disable_ipv6
# If output is "0", IPv6 is enabled
```

**Fix**: Disable IPv6 in WSL2

```bash
# Add IPv6 disable rules to sysctl
echo 'net.ipv6.conf.all.disable_ipv6 = 1' | sudo tee -a /etc/sysctl.conf
echo 'net.ipv6.conf.default.disable_ipv6 = 1' | sudo tee -a /etc/sysctl.conf

# Apply changes
sudo sysctl -p

# Verify
sysctl net.ipv6.conf.all.disable_ipv6
# Should output: net.ipv6.conf.all.disable_ipv6 = 1
```

**Important**: Apply this fix **before** installing Bun or OpenCode to avoid initial setup issues.

## Installation

### 1. Install Cursor CLI

```bash
curl https://cursor.com/install -fsS | bash
```

Restart your shell or run:

```bash
exec $SHELL
```

Verify installation:

```bash
cursor-agent --version
```

### 2. Authenticate with Cursor

```bash
cursor-agent login
```

Follow the browser-based authentication flow. Verify you're logged in:

```bash
cursor-agent status
```

### 3. Install Bun (if not already installed)

```bash
curl -fsSL https://bun.sh/install | bash
```

Restart your shell:

```bash
exec $SHELL
```

Verify:

```bash
bun --version
```

> **Note**: If `bun --version` hangs, you need to apply the IPv6 fix from the "Known Issues" section above.

### 4. Install OpenCode

```bash
bun install -g opencode-ai
```

Verify:

```bash
opencode --version
```

> **Important**: If you have an older version installed via Homebrew/Linuxbrew (v0.x), remove it first:
>
> ```bash
> brew uninstall opencode
> which opencode  # Should be ~/.bun/bin/opencode
> opencode --version  # Should be 1.x.x
> ```

### 5. Build cursor-opencode-auth

Clone and build this repository:

```bash
# Choose a permanent location (NOT /tmp)
cd ~/projects  # or your preferred location
git clone https://github.com/Infiland/cursor-opencode-auth.git
cd cursor-opencode-auth

# Build the project
npm install
npm --workspaces run build
```

## Configuration

### 1. Install the OpenCode Plugin

Create the plugin configuration file:

```bash
mkdir -p ~/.config/opencode/plugins
```

Create `~/.config/opencode/plugins/cursor-opencode-auth.ts` with the following content (adjust path to match your installation):

```typescript
// Uses your local checkout instead of a cached npm install
export { CursorPlugin } from "/home/YOUR_USERNAME/projects/cursor-opencode-auth/packages/opencode-plugin-cursor/dist/index.js";
```

Replace `/home/YOUR_USERNAME/projects/` with your actual path from step 5.

### 2. Configure OpenCode Provider

Get available Cursor models:

```bash
cursor-agent --list-models
```

Create or update `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [],
  "provider": {
    "cursor": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Cursor",
      "options": {
        "baseURL": "http://127.0.0.1:8765/v1",
        "apiKey": "unused"
      },
      "models": {
        "auto": { "name": "Auto (Cursor Default)" },
        "gpt-5.3-codex": { "name": "GPT-5.3 Codex" },
        "gpt-5.2": { "name": "GPT-5.2" },
        "gpt-5.2-codex": { "name": "GPT-5.2 Codex" },
        "opus-4.6-thinking": { "name": "Claude 4.6 Opus (Thinking)" },
        "sonnet-4.5-thinking": { "name": "Claude 4.5 Sonnet (Thinking)" },
        "opus-4.6": { "name": "Claude 4.6 Opus" }
      }
    }
  }
}
```

> **Note**: You can add more models from the `cursor-agent --list-models` output.

### 3. Create a Bridge Launcher Script (Optional but Recommended)

Create `~/.local/bin/cursor-bridge`:

```bash
mkdir -p ~/.local/bin
cat > ~/.local/bin/cursor-bridge << 'EOF'
#!/usr/bin/env node
// Cursor OpenAI Bridge Launcher
require('/home/YOUR_USERNAME/projects/cursor-opencode-auth/packages/cursor-openai-bridge/dist/cli.js');
EOF

chmod +x ~/.local/bin/cursor-bridge
```

Replace `/home/YOUR_USERNAME/projects/` with your actual path.

Ensure `~/.local/bin` is in your PATH:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

## Verification

### 1. Start the Bridge Server

```bash
cursor-bridge
```

Or if you didn't create the launcher script:

```bash
node ~/projects/cursor-opencode-auth/packages/cursor-openai-bridge/dist/cli.js
```

The bridge should start and listen on `http://127.0.0.1:8765`.

### 2. Test the Bridge

In another terminal:

```bash
curl http://127.0.0.1:8765/v1/models
```

You should see a JSON response with available models.

### 3. Test OpenCode

```bash
opencode run -m cursor/gpt-5.2 "say hello"
```

### 4. Test Tool Calling

```bash
opencode run -m cursor/gpt-5.2 "read the file ~/.config/opencode/opencode.json and tell me what's in it"
```

This should successfully read the file and return its contents, demonstrating that tool calling works.

## Troubleshooting

### Bridge won't start or hangs

**Cause**: IPv6 networking issues (see "Known Issues" section)

**Solution**: Apply the IPv6 fix and restart the bridge

### Port 8765 already in use

**Cause**: Another instance of the bridge or another service is using the port

**Solution**: Find and kill the process:

```bash
lsof -i :8765
kill -9 <PID>
```

Or configure the bridge to use a different port via environment variable (update your `opencode.json` accordingly):

```bash
PORT=8766 cursor-bridge
```

### `opencode run` hangs but `opencode debug config` works

**Cause**: Command is being run from a non-interactive shell without a TTY

**Solution**: Run from a regular terminal session, not from a script or non-TTY environment

### "No access token found" or authentication errors

**Cause**: Cursor CLI is not authenticated

**Solution**: Run `cursor-agent login` and complete the authentication flow

### Tool calls not working

**Cause**: Bridge is not running or OpenCode is not configured correctly

**Solution**: 
1. Verify bridge is running: `curl http://127.0.0.1:8765/v1/models`
2. Check OpenCode config: `opencode debug config`
3. Verify plugin is loaded correctly

### Old version of OpenCode (v0.x)

**Cause**: Stale Homebrew/Linuxbrew installation taking precedence

**Solution**:
```bash
brew uninstall opencode
which opencode  # Should be ~/.bun/bin/opencode
opencode --version  # Should be 1.x.x
```

### Permission denied when starting bridge

**Cause**: Script is not executable

**Solution**:
```bash
chmod +x ~/.local/bin/cursor-bridge
```

## Advanced Configuration

### Bridge Environment Variables

You can customize the bridge behavior with environment variables:

```bash
# Change Cursor CLI mode (ask, plan, agent)
CURSOR_BRIDGE_MODE=agent cursor-bridge

# Set workspace directory
CURSOR_BRIDGE_WORKSPACE=/path/to/project cursor-bridge

# Force mode even if model suggests otherwise
CURSOR_BRIDGE_FORCE=true cursor-bridge

# Auto-approve MCPs (use with caution)
CURSOR_BRIDGE_APPROVE_MCPS=true cursor-bridge

# Disable strict model checking
CURSOR_BRIDGE_STRICT_MODEL=false cursor-bridge
```

### Running Bridge as a Service

For production use, consider creating a systemd service:

```bash
sudo tee /etc/systemd/system/cursor-bridge.service << EOF
[Unit]
Description=Cursor OpenAI Bridge
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
sudo systemctl enable cursor-bridge
sudo systemctl start cursor-bridge
```

### Debug Logging

Enable debug logging for troubleshooting:

```bash
# OpenCode debug logs
opencode --print-logs --log-level DEBUG

# Check OpenCode log directory
ls -lh ~/.local/share/opencode/log/
```

## Additional Notes

### Differences from yet-another-opencode-cursor-auth

If you previously used `yet-another-opencode-cursor-auth`:

| Feature | yet-another-opencode-cursor-auth | cursor-opencode-auth (this repo) |
|---------|----------------------------------|----------------------------------|
| Tool Calling | ✅ Yes (direct API) | ✅ Yes (via bridge) |
| Method | Direct Cursor API | Cursor CLI wrapper |
| Auth | OAuth flow | cursor-agent login |
| Models | Limited | All Cursor CLI models |
| Modes | N/A | ask/plan/agent |
| Setup | OAuth only | Install + configure |

### Security Considerations

- The bridge runs locally and does not expose your credentials to the network
- Cursor CLI can read your repository - treat it as trusted code execution
- Configure permissions in `~/.cursor/cli-config.json` or `<project>/.cursor/cli.json` to restrict Cursor CLI capabilities
- See `docs/SECURITY.md` for detailed security considerations

## Getting Help

If you encounter issues not covered in this guide:

1. Check the main [README.md](../README.md) and [docs/USAGE.md](USAGE.md)
2. Review [docs/SECURITY.md](SECURITY.md) for safety considerations
3. Open an issue on the [GitHub repository](https://github.com/Infiland/cursor-opencode-auth/issues)

## Contributing

Found an issue with this guide or have suggestions for improvements? Please open a pull request or issue on GitHub.
