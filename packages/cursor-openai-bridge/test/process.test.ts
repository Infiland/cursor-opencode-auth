import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

import { CommandNotFoundError, describeExit, run, succeeded } from "../src/lib/process.js";

const node = process.execPath;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("condition not met in time");
}

describe("run", () => {
  it("reports exit codes and output", async () => {
    const result = await run(node, ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"]);
    assert.equal(result.code, 3);
    assert.equal(result.stdout, "out");
    assert.equal(result.stderr, "err");
    assert.equal(succeeded(result), false);
    assert.equal(describeExit(result), "exited with code 3");
  });

  it("writes input to stdin", async () => {
    const result = await run(node, ["-e", "process.stdin.pipe(process.stdout)"], { input: "a".repeat(300_000) });
    assert.equal(result.code, 0);
    assert.equal(result.stdout.length, 300_000);
  });

  it("does not report a timed-out process as successful", async () => {
    const result = await run(node, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 200 });
    assert.equal(result.timedOut, true);
    assert.equal(result.code, null);
    assert.equal(succeeded(result), false);
    assert.equal(describeExit(result), "timed out");
  });

  it("stops the process when aborted", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const result = await run(node, ["-e", "setInterval(() => {}, 1000)"], { signal: controller.signal });
    assert.equal(result.aborted, true);
    assert.equal(succeeded(result), false);
  });

  it("returns immediately for an already-aborted signal", async () => {
    const result = await run(node, ["-e", "setInterval(() => {}, 1000)"], { signal: AbortSignal.abort() });
    assert.equal(result.aborted, true);
  });

  it("kills grandchildren that hold the output pipes", { skip: process.platform === "win32" }, async () => {
    const pidFile = path.join(tmpdir(), `run-test-${process.pid}-${Date.now()}.pid`);
    const script = `
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"] });
      require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      setInterval(() => {}, 1000);
    `;
    const started = Date.now();
    const result = await run(node, ["-e", script], { timeoutMs: 500 });
    assert.equal(result.timedOut, true);
    assert.ok(Date.now() - started < 4_000, "run should not hang on inherited pipes");
    const grandchild = Number(await readFile(pidFile, "utf8"));
    await waitFor(() => !alive(grandchild));
  });

  it("resolves soon after exit even if a grandchild keeps the pipes open", { skip: process.platform === "win32" }, async () => {
    const pidFile = path.join(tmpdir(), `run-test-${process.pid}-${Date.now()}-b.pid`);
    const script = `
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: ["ignore", "inherit", "inherit"] });
      require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      process.stdout.write("done\\n");
      process.exit(0);
    `;
    const started = Date.now();
    const result = await run(node, ["-e", script]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "done\n");
    assert.ok(Date.now() - started < 4_000);
    const grandchild = Number(await readFile(pidFile, "utf8"));
    try {
      process.kill(grandchild, "SIGKILL");
    } catch {
      // already gone
    }
  });

  it("throws CommandNotFoundError for missing binaries", async () => {
    await assert.rejects(run("definitely-not-a-real-binary-xyz", []), CommandNotFoundError);
  });

  it("delivers stdout line by line across chunk boundaries", async () => {
    const lines: string[] = [];
    await run(
      node,
      ["-e", "process.stdout.write('a\\nb'); setTimeout(() => process.stdout.write('c\\r\\nd\\ntail'), 50)"],
      { onStdoutLine: (line) => lines.push(line), collectStdout: false },
    );
    assert.deepEqual(lines, ["a", "bc", "d", "tail"]);
  });
});
