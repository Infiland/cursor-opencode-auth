import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import type { ToolContext } from "@opencode-ai/plugin";

import { resetModelCache } from "../src/lib/models.js";
import { CursorPlugin } from "../src/v1.js";
import { createFakeAgent, type FakeAgent } from "./helpers/fakeAgent.js";

type Hooks = Awaited<ReturnType<typeof CursorPlugin>>;

function context(directory: string, signal = new AbortController().signal): ToolContext {
  return {
    sessionID: "ses_test",
    messageID: "msg_test",
    agent: "build",
    directory,
    worktree: directory,
    abort: signal,
    metadata: () => undefined,
    ask: async () => undefined,
  };
}

async function load(directory: string, worktree = directory): Promise<Hooks> {
  const input = { directory, worktree } as Parameters<typeof CursorPlugin>[0];
  return CursorPlugin(input, { autostart: false });
}

async function callTool(hooks: Hooks, name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const def = hooks.tool?.[name];
  assert.ok(def, `tool ${name} exists`);
  const result = await def.execute(args as never, ctx);
  return typeof result === "string" ? result : result.output;
}

const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), "plugin-repo-"));
  gitIn(repo, "init", "-q", "-b", "main");
  gitIn(repo, "config", "user.email", "test@example.com");
  gitIn(repo, "config", "user.name", "Test");
  await writeFile(path.join(repo, "README.md"), "# Demo\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "init");
  return repo;
}

describe("OpenCode 1.x tools", () => {
  let agent: FakeAgent;
  const saved = { ...process.env };

  before(async () => {
    agent = await createFakeAgent();
  });

  beforeEach(() => {
    resetModelCache();
    process.env.CURSOR_AGENT_BIN = agent.bin;
    process.env.FAKE_AGENT_LOG = agent.logFile;
  });

  after(() => {
    process.env = saved;
  });

  it("lists models in the `id - Name` format Cursor CLI prints", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "plugin-dir-"));
    const hooks = await load(dir);
    const out = JSON.parse(await callTool(hooks, "cursor_cli_models", {}, context(dir))) as {
      models: { id: string; name: string; default?: boolean }[];
    };
    assert.deepEqual(out.models, [
      { id: "auto", name: "Auto" },
      { id: "gpt-5.2", name: "GPT-5.2", default: true, current: true },
      { id: "sonnet-4.5-thinking", name: "Claude 4.5 Sonnet (Thinking)" },
    ]);
  });

  it("runs Cursor with the prompt on stdin, in ask mode, trusted, in the session directory", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "plugin-dir-"));
    const hooks = await load(dir);
    const out = await callTool(hooks, "cursor_cli_run", { prompt: "--help is not a flag here" }, context(dir));
    assert.equal(out, "Hello from the fake agent.");
    const call = (await agent.calls()).at(-1);
    assert.ok(call);
    assert.equal(call.stdin, "--help is not a flag here");
    assert.ok(!call.argv.includes("--help is not a flag here"));
    assert.ok(call.argv.includes("--trust"));
    assert.equal(call.argv[call.argv.indexOf("--mode") + 1], "ask");
    assert.equal(call.argv[call.argv.indexOf("--workspace") + 1], dir);
    assert.equal(call.cwd, dir);
  });

  it("summarises stream-json runs", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "plugin-dir-"));
    const hooks = await load(dir);
    const out = await callTool(hooks, "cursor_cli_run", { prompt: "hi", outputFormat: "stream-json" }, context(dir));
    assert.match(out, /Model: auto · Session: sess-1234 · Duration: 0\.0s/);
    assert.match(out, /## Tool Calls \(2\)\n1\. read src\/index\.ts — ok\n2\. shell ls missing — failed: No such file/);
    assert.match(out, /## Assistant Response\nFirst part\.\n\nHello from the fake agent\.$/);
  });

  it("explains authentication failures", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "plugin-dir-"));
    const hooks = await load(dir);
    await assert.rejects(
      callTool(hooks, "cursor_cli_run", { prompt: "[[scenario:auth]]" }, context(dir)),
      /exited with code 1[\s\S]*Hint: authenticate with `agent login`/,
    );
  });

  it("stops Cursor when the tool call is cancelled", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "plugin-dir-"));
    const hooks = await load(dir);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    await assert.rejects(
      callTool(hooks, "cursor_cli_run", { prompt: "[[scenario:slow]]" }, context(dir, controller.signal)),
      /cancelled/,
    );
  });

  it("produces a patch from an isolated worktree and leaves the repo untouched", async () => {
    const repo = await makeRepo();
    const hooks = await load(repo);
    const out = await callTool(hooks, "cursor_cli_patch", { prompt: "[[scenario:edit]]" }, context(repo));
    assert.match(out, /<summary>\nA\tNEW_FILE\.txt\nM\tREADME\.md\n<\/summary>/);
    assert.match(out, /\+Edited by fake agent/);
    assert.match(out, /\+brand new/);
    assert.equal(await readFile(path.join(repo, "README.md"), "utf8"), "# Demo\n");
    assert.equal(gitIn(repo, "status", "--porcelain"), "");
    assert.equal(gitIn(repo, "worktree", "list").trim().split("\n").length, 1, "temporary worktree removed");

    const patch = /<patch>\n([\s\S]*)\n<\/patch>/.exec(out)?.[1];
    assert.ok(patch);
    execFileSync("git", ["apply", "--check", "-"], { cwd: repo, input: `${patch}\n` });
  });

  it("refuses a dirty tree unless allowDirty is set, then works on a snapshot", async () => {
    const repo = await makeRepo();
    await appendFile(path.join(repo, "README.md"), "uncommitted line\n");
    await writeFile(path.join(repo, "notes.txt"), "untracked\n");
    const hooks = await load(repo);
    await assert.rejects(callTool(hooks, "cursor_cli_patch", { prompt: "[[scenario:edit]]" }, context(repo)), /allowDirty/);

    const out = await callTool(hooks, "cursor_cli_patch", { prompt: "[[scenario:edit]]", allowDirty: true }, context(repo));
    const patch = /<patch>\n([\s\S]*)\n<\/patch>/.exec(out)?.[1];
    assert.ok(patch);
    // The patch is relative to the user's current files, so it applies on top of them...
    execFileSync("git", ["apply", "--check", "-"], { cwd: repo, input: `${patch}\n` });
    // ...and Cursor saw the uncommitted and untracked files.
    assert.match(patch, / uncommitted line\n\+Edited by fake agent/);
    assert.ok(!patch.includes("notes.txt"), "untracked files are context, not changes");
    assert.equal(await readFile(path.join(repo, "README.md"), "utf8"), "# Demo\nuncommitted line\n");
  });

  it("applies the patch when asked", async () => {
    const repo = await makeRepo();
    const hooks = await load(repo);
    const out = await callTool(hooks, "cursor_cli_patch", { prompt: "[[scenario:edit]]", apply: true }, context(repo));
    assert.match(out, /<applied>/);
    assert.equal(await readFile(path.join(repo, "README.md"), "utf8"), "# Demo\nEdited by fake agent\n");
    assert.equal(await readFile(path.join(repo, "NEW_FILE.txt"), "utf8"), "brand new\n");
  });

  it("requires a git repository for patches", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "plugin-dir-"));
    const hooks = await load(dir, "/");
    await assert.rejects(callTool(hooks, "cursor_cli_patch", { prompt: "x" }, context(dir)), /requires a git repository/);
  });

  it("routes provider requests to the session's project through chat.headers", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "plugin dir é-"));
    const hooks = await load(dir);
    const hook = hooks["chat.headers"];
    assert.ok(hook);
    const run = async (providerID: string) => {
      const output = { headers: {} as Record<string, string> };
      await hook({ model: { providerID } } as Parameters<typeof hook>[0], output);
      return output.headers;
    };
    assert.deepEqual(await run("cursor"), { "x-cursor-workspace": encodeURI(dir) });
    assert.deepEqual(await run("anthropic"), {});

    process.env.CURSOR_BRIDGE_API_KEY = "s3cret";
    try {
      const keyed = await load(dir);
      const output = { headers: {} as Record<string, string> };
      await keyed["chat.headers"]?.({ model: { providerID: "cursor" } } as Parameters<typeof hook>[0], output);
      // Spelled like the OpenAI-compatible SDK's header, so it replaces the `apiKey` one.
      assert.equal(output.headers.Authorization, "Bearer s3cret");
    } finally {
      delete process.env.CURSOR_BRIDGE_API_KEY;
    }
  });
});
