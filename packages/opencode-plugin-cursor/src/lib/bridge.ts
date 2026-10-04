import { execFile, spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { isLocalBridge, type PluginSettings } from "./settings.js";

export type BridgeHealth = {
  version?: string;
  pid?: number;
  workspace?: string;
  mode?: string;
};

export type EnsureResult =
  | { status: "running"; health: BridgeHealth }
  | { status: "started" | "restarted"; health: BridgeHealth; pid: number; logFile: string }
  | { status: "remote" }
  | { status: "failed"; error: string; logFile?: string };

const localRequire = createRequire(import.meta.url);

function dataDir(): string {
  const xdg = process.env.XDG_DATA_HOME;
  return xdg ? path.join(xdg, "opencode") : path.join(homedir(), ".local", "share", "opencode");
}

export function bridgePidFile(): string {
  return path.join(dataDir(), "cursor-openai-bridge.pid");
}

export function bridgeLogFile(): string {
  return path.join(dataDir(), "cursor-openai-bridge.log");
}

/** Locate the bridge entrypoint: explicit override, installed package, or monorepo sibling. */
export function resolveBridgeScript(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.CURSOR_OPENAI_BRIDGE_SCRIPT) return env.CURSOR_OPENAI_BRIDGE_SCRIPT;
  try {
    return localRequire.resolve("cursor-openai-bridge/cli");
  } catch {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const sibling = path.resolve(here, "..", "..", "..", "cursor-openai-bridge", "dist", "cli.js");
    return existsSync(sibling) ? sibling : undefined;
  }
}

/** Version of the bridge package this plugin ships with. */
export function expectedBridgeVersion(): string | undefined {
  try {
    const pkg = localRequire("cursor-openai-bridge/package.json") as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

export async function bridgeHealth(settings: PluginSettings, timeoutMs = 800): Promise<BridgeHealth | undefined> {
  try {
    const res = await fetch(`${settings.bridgeURL}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: settings.bridgeApiKey ? { authorization: `Bearer ${settings.bridgeApiKey}` } : {},
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as Record<string, unknown>;
    if (!data || data.ok !== true) return undefined;
    return {
      version: typeof data.version === "string" ? data.version : undefined,
      pid: typeof data.pid === "number" ? data.pid : undefined,
      workspace: typeof data.workspace === "string" ? data.workspace : undefined,
      mode: typeof data.mode === "string" ? data.mode : undefined,
    };
  } catch {
    return undefined;
  }
}

async function waitForHealth(settings: PluginSettings, timeoutMs: number): Promise<BridgeHealth | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await bridgeHealth(settings, 300);
    if (health) return health;
    await new Promise((r) => setTimeout(r, 150));
  }
  return undefined;
}

async function waitUntilDown(settings: PluginSettings, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await bridgeHealth(settings, 300))) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function readPidFile(): Promise<number | undefined> {
  const raw = await readFile(bridgePidFile(), "utf8").catch(() => "");
  const pid = Number(raw.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** Command line of a live process (POSIX only), used to confirm a pid really is the bridge. */
function commandLine(pid: number): Promise<string | undefined> {
  if (process.platform === "win32") return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile("ps", ["-o", "command=", "-p", String(pid)], { timeout: 2_000 }, (err, stdout) =>
      resolve(err ? undefined : stdout.trim() || undefined),
    );
  });
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => (child.pid ? resolve() : reject(new Error("bridge process did not start"))), 1_000);
    child.once("spawn", () => {
      clearTimeout(timer);
      resolve();
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function rotateLog(file: string) {
  const info = await stat(file).catch(() => undefined);
  if (info && info.size > 5 * 1024 * 1024) await rename(file, `${file}.1`).catch(() => undefined);
}

/** Start the bridge as a detached background process that outlives this OpenCode process. */
export async function startBridge(
  settings: PluginSettings,
  opts: { workspace?: string } = {},
): Promise<{ pid: number; logFile: string }> {
  const script = resolveBridgeScript();
  if (!script) {
    throw new Error(
      "Could not find cursor-openai-bridge. Run `npm install && npm run build` in your cursor-opencode-auth " +
        "checkout, or set CURSOR_OPENAI_BRIDGE_SCRIPT to its dist/cli.js.",
    );
  }
  const url = new URL(settings.bridgeURL);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CURSOR_AGENT_BIN: settings.agentBin,
    CURSOR_BRIDGE_PORT: url.port || "80",
    CURSOR_BRIDGE_HOST: process.env.CURSOR_BRIDGE_HOST || url.hostname.replace(/^\[|\]$/g, ""),
  };
  if (opts.workspace && !process.env.CURSOR_BRIDGE_WORKSPACE) env.CURSOR_BRIDGE_WORKSPACE = opts.workspace;

  const logFile = bridgeLogFile();
  await mkdir(path.dirname(logFile), { recursive: true });
  await rotateLog(logFile);
  const fd = openSync(logFile, "a");
  try {
    const child = spawn(process.env.CURSOR_BRIDGE_NODE_BIN || "node", [script], {
      detached: true,
      stdio: ["ignore", fd, fd],
      env,
      cwd: opts.workspace && existsSync(opts.workspace) ? opts.workspace : homedir(),
      windowsHide: true,
    });
    // Without a listener, a spawn failure (e.g. no `node` on PATH) would crash OpenCode.
    child.on("error", () => undefined);
    await waitForSpawn(child);
    child.unref();
    const pid = child.pid as number;
    await writeFile(bridgePidFile(), String(pid), "utf8");
    return { pid, logFile };
  } finally {
    closeSync(fd);
  }
}

/** Stop the bridge that answers on the configured URL (identified through /health). */
export async function stopBridge(settings: PluginSettings): Promise<{ stopped: boolean; pid?: number; message: string }> {
  if (!isLocalBridge(settings)) return { stopped: false, message: `${settings.bridgeURL} is not a local bridge` };
  const health = await bridgeHealth(settings);
  if (!health) {
    await rm(bridgePidFile(), { force: true });
    return { stopped: false, message: "bridge is not running" };
  }
  let pid = health.pid;
  if (pid === undefined) {
    // Bridges before 0.3 do not report their pid; trust the pid file only if it points at a bridge.
    const recorded = await readPidFile();
    if (recorded && (await commandLine(recorded))?.includes("cursor-openai-bridge")) pid = recorded;
  }
  if (pid === undefined) return { stopped: false, message: "running bridge did not report its pid; stop it manually" };
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // already exiting
  }
  if (!(await waitUntilDown(settings, 3_000))) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
  }
  await rm(bridgePidFile(), { force: true });
  return { stopped: true, pid, message: `stopped bridge (pid ${pid})` };
}

async function startedByUs(health: BridgeHealth): Promise<boolean> {
  const recorded = await readPidFile();
  if (!recorded) return false;
  if (health.pid !== undefined) return health.pid === recorded;
  return (await commandLine(recorded))?.includes("cursor-openai-bridge") ?? false;
}

let inflight: Promise<EnsureResult> | undefined;

/**
 * Make sure a bridge answers on the configured URL. A bridge the plugin itself
 * started from an older build is replaced; any other running bridge is reused.
 * Concurrent callers share one attempt.
 */
export function ensureBridge(settings: PluginSettings, opts: { workspace?: string } = {}): Promise<EnsureResult> {
  inflight ??= doEnsure(settings, opts).finally(() => {
    inflight = undefined;
  });
  return inflight;
}

async function doEnsure(settings: PluginSettings, opts: { workspace?: string }): Promise<EnsureResult> {
  if (!isLocalBridge(settings)) return { status: "remote" };
  let restarted = false;
  const health = await bridgeHealth(settings);
  if (health) {
    const expected = expectedBridgeVersion();
    const outdated = expected !== undefined && health.version !== expected;
    if (!outdated || !(await startedByUs(health))) return { status: "running", health };
    await stopBridge(settings);
    restarted = true;
  }
  let logFile: string | undefined;
  try {
    const started = await startBridge(settings, opts);
    logFile = started.logFile;
    const up = await waitForHealth(settings, 5_000);
    if (!up) return { status: "failed", error: `bridge did not become healthy; see ${logFile}`, logFile };
    return { status: restarted ? "restarted" : "started", health: up, pid: started.pid, logFile };
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err), logFile };
  }
}
