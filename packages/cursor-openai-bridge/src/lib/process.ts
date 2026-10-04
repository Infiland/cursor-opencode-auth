import { spawn, type ChildProcess } from "node:child_process";

export type RunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Written to the child's stdin, which is then closed. When omitted, stdin is ignored. */
  input?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called with every complete stdout line as it arrives (without the trailing newline). */
  onStdoutLine?: (line: string) => void;
  /** Keep the full stdout in the result (default: true). Streaming consumers can turn this off. */
  collectStdout?: boolean;
};

export type RunResult = {
  /** Exit code, or null when the process was terminated by a signal. */
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
};

export class CommandNotFoundError extends Error {
  readonly command: string;

  constructor(command: string) {
    super(`Command not found: ${command}`);
    this.name = "CommandNotFoundError";
    this.command = command;
  }
}

/** True when the run finished normally with exit code 0. */
export function succeeded(result: RunResult): boolean {
  return result.code === 0 && !result.timedOut && !result.aborted;
}

/** Human-readable description of how a run ended, for error messages. */
export function describeExit(result: RunResult): string {
  if (result.timedOut) return "timed out";
  if (result.aborted) return "was cancelled";
  if (result.signal) return `was killed by ${result.signal}`;
  return `exited with code ${result.code}`;
}

const KILL_GRACE_MS = 2_000;
// After the child exits, grandchildren that inherited its stdio can keep the pipes
// open indefinitely. Wait this long for "close", then stop reading.
const CLOSE_GRACE_MS = 1_000;
const MAX_STDERR_CHARS = 64 * 1024;

const active = new Set<ChildProcess>();
let exitHookInstalled = false;

function killTree(child: ChildProcess, signal: NodeJS.Signals) {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on(
        "error",
        () => undefined,
      );
      return;
    } catch {
      // fall through to child.kill
    }
  } else {
    try {
      // Children are spawned as process-group leaders, so this also reaches
      // the shells and helpers Cursor CLI starts.
      process.kill(-pid, signal);
      return;
    } catch {
      // fall through to child.kill
    }
  }
  try {
    child.kill(signal);
  } catch {
    // already gone
  }
}

/** Terminate every process started by `run` that is still alive. */
export function killActiveProcesses(signal: NodeJS.Signals = "SIGTERM") {
  for (const child of active) killTree(child, signal);
}

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => killActiveProcesses("SIGKILL"));
}

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      resolve({ code: null, signal: null, stdout: "", stderr: "", timedOut: false, aborted: true });
      return;
    }

    installExitHook();
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    active.add(child);

    const collectStdout = opts.collectStdout ?? true;
    let stdout = "";
    let stderr = "";
    let pending = "";
    let timedOut = false;
    let aborted = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let closeTimer: NodeJS.Timeout | undefined;

    const terminate = () => {
      killTree(child, "SIGTERM");
      killTimer ??= setTimeout(() => killTree(child, "SIGKILL"), KILL_GRACE_MS);
      killTimer.unref?.();
    };

    const timeout =
      typeof opts.timeoutMs === "number" && opts.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            terminate();
          }, opts.timeoutMs)
        : undefined;

    const onAbort = () => {
      aborted = true;
      terminate();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      active.delete(child);
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (closeTimer) clearTimeout(closeTimer);
      opts.signal?.removeEventListener("abort", onAbort);
    };

    const flushLine = (line: string) => {
      if (!opts.onStdoutLine) return;
      try {
        opts.onStdoutLine(line.endsWith("\r") ? line.slice(0, -1) : line);
      } catch {
        // A consumer bug must not wedge the process bookkeeping.
      }
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      if (pending) {
        flushLine(pending);
        pending = "";
      }
      cleanup();
      resolve({ code: exitCode, signal: exitSignal, stdout, stderr, timedOut, aborted });
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (collectStdout) stdout += chunk;
      if (!opts.onStdoutLine) return;
      pending += chunk;
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        flushLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > MAX_STDERR_CHARS) stderr = stderr.slice(-MAX_STDERR_CHARS);
    });

    if (opts.input !== undefined && child.stdin) {
      // EPIPE when the child exits without reading its input is not interesting.
      child.stdin.on("error", () => undefined);
      child.stdin.end(opts.input);
    }

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      if (err.code === "ENOENT" || child.pid === undefined) {
        settled = true;
        cleanup();
        reject(err.code === "ENOENT" ? new CommandNotFoundError(cmd) : err);
      }
      // Errors after a successful spawn (e.g. a failed kill) are not fatal.
    });

    child.on("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      closeTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish();
      }, CLOSE_GRACE_MS);
      closeTimer.unref?.();
    });

    child.on("close", (code, signal) => {
      exitCode ??= code;
      exitSignal ??= signal;
      finish();
    });
  });
}
