import { spawn } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

function getBridgeHost(): string {
  return process.env.CURSOR_BRIDGE_HOST || "127.0.0.1";
}

function getBridgePort(): number {
  const raw = process.env.CURSOR_BRIDGE_PORT;
  const n = raw ? Number(raw) : 8765;
  return Number.isFinite(n) && n > 0 ? n : 8765;
}

export function getBridgeBaseURL(): string {
  return `http://${getBridgeHost()}:${getBridgePort()}`;
}

export function getBridgeHealthURL(): string {
  return `${getBridgeBaseURL()}/health`;
}

function shouldAutostartBridge(): boolean {
  const raw = process.env.CURSOR_BRIDGE_AUTOSTART;
  if (!raw) return true;
  return !(raw === "0" || raw.toLowerCase() === "false");
}

function getBridgeScriptPath(): string | undefined {
  const envPath = process.env.CURSOR_OPENAI_BRIDGE_SCRIPT;
  if (envPath) return envPath;

  // Local monorepo default: packages/cursor-openai-bridge/dist/cli.js
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkgRoot = path.resolve(here, "..", "..");
  return path.resolve(pkgRoot, "../cursor-openai-bridge/dist/cli.js");
}

function getBridgePidPath(): string {
  const home = process.env.HOME || tmpdir();
  return path.join(home, ".local", "share", "opencode", "cursor-openai-bridge.pid");
}

export async function isBridgeUp(timeoutMs = 500): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(getBridgeHealthURL(), { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Returns the workspace the running bridge was started with, or undefined if
 * the bridge is not reachable.
 */
export async function getBridgeWorkspace(timeoutMs = 500): Promise<string | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(getBridgeHealthURL(), { signal: controller.signal });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { workspace?: string };
    return data.workspace;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

export async function startBridgeDetached(agentBin: string, workspace?: string): Promise<number> {
  const script = getBridgeScriptPath();
  if (!script) {
    throw new Error(
      "CURSOR_OPENAI_BRIDGE_SCRIPT is not set and default bridge script path could not be resolved.",
    );
  }

  const nodeBin = process.env.CURSOR_BRIDGE_NODE_BIN || "node";
  const child = spawn(nodeBin, [script], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      CURSOR_AGENT_BIN: agentBin,
      ...(workspace && !process.env.CURSOR_BRIDGE_WORKSPACE
        ? { CURSOR_BRIDGE_WORKSPACE: workspace }
        : {}),
      // Bridge defaults are safe, but set explicit defaults on spawn for robustness.
      ...(process.env.CURSOR_BRIDGE_MODE ? {} : { CURSOR_BRIDGE_MODE: "ask" }),
      ...(process.env.CURSOR_BRIDGE_FORCE ? {} : { CURSOR_BRIDGE_FORCE: "false" }),
      ...(process.env.CURSOR_BRIDGE_APPROVE_MCPS
        ? {}
        : { CURSOR_BRIDGE_APPROVE_MCPS: "false" }),
    },
  });

  if (!child.pid) {
    throw new Error("Failed to spawn cursor-openai-bridge (no pid)");
  }

  child.unref();

  const pidPath = getBridgePidPath();
  await mkdir(path.dirname(pidPath), { recursive: true });
  await writeFile(pidPath, String(child.pid), "utf8");
  return child.pid;
}

export async function stopBridgeByPidFile(): Promise<boolean> {
  const pidPath = getBridgePidPath();
  try {
    const raw = await readFile(pidPath, "utf8");
    const pid = Number(raw.trim());
    if (!Number.isFinite(pid) || pid <= 0) {
      await unlink(pidPath);
      return false;
    }

    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // ignore
    }

    await unlink(pidPath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureBridgeProcess(agentBin: string, workspace?: string) {
  if (!shouldAutostartBridge()) return;

  // If the bridge is already running, check whether its workspace matches.
  // When the workspace differs (e.g. OpenCode opened a different project), restart
  // the bridge so the new project gets the correct --workspace flag.
  if (await isBridgeUp()) {
    if (workspace) {
      const running = await getBridgeWorkspace();
      if (running && path.resolve(running) !== path.resolve(workspace)) {
        // Workspace mismatch — stop the old bridge and start a new one.
        await stopBridgeByPidFile();
        // Give the OS a moment to release the port.
        await new Promise((r) => setTimeout(r, 300));
      } else {
        return; // bridge is up and workspace matches (or we don't care)
      }
    } else {
      return; // no workspace preference — whatever is running is fine
    }
  }

  try {
    await startBridgeDetached(agentBin, workspace);

    const start = Date.now();
    while (Date.now() - start < 3_000) {
      if (await isBridgeUp(300)) return;
      await new Promise((r) => setTimeout(r, 200));
    }
  } catch {
    // Best-effort. If it fails, the provider will error when used.
  }
}
