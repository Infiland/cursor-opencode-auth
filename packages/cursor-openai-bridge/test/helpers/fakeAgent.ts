import { chmod, copyFile, mkdtemp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export type FakeAgentCall = { argv: string[]; cwd: string; stdin: string };

export type FakeAgent = {
  bin: string;
  dir: string;
  logFile: string;
  /** --print invocations recorded so far (requires FAKE_AGENT_LOG=logFile in the environment). */
  calls(): Promise<FakeAgentCall[]>;
};

function sharedScript(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = path.join(dir, "test-support", "fake-agent.cjs");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("test-support/fake-agent.cjs not found");
    dir = parent;
  }
}

/** Copy the shared fake Cursor CLI (test-support/fake-agent.cjs) into a fresh temp dir. */
export async function createFakeAgent(): Promise<FakeAgent> {
  const dir = await mkdtemp(path.join(tmpdir(), "fake-cursor-agent-"));
  const bin = path.join(dir, "agent");
  const logFile = path.join(dir, "calls.jsonl");
  await copyFile(sharedScript(), bin);
  await chmod(bin, 0o755);
  return {
    bin,
    dir,
    logFile,
    async calls() {
      const text = await readFile(logFile, "utf8").catch(() => "");
      return text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as FakeAgentCall);
    },
  };
}
