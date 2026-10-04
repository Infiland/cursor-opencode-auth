import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import {
  APICallError,
  type LanguageModelV3CallOptions,
  type LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { CLIENT_TOOLS_NOTE } from "cursor-openai-bridge";

import { createCursor } from "../../src/v2/provider.js";
import { createFakeAgent, type FakeAgent } from "../helpers/fakeAgent.js";

type Part = LanguageModelV3StreamPart;

function call(text: string, extra: Partial<LanguageModelV3CallOptions> = {}): LanguageModelV3CallOptions {
  return { prompt: [{ role: "user", content: [{ type: "text", text }] }], ...extra };
}

async function collect(stream: ReadableStream<Part>): Promise<Part[]> {
  const parts: Part[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return parts;
    parts.push(value);
  }
}

const deltas = (parts: Part[], type: "text-delta" | "reasoning-delta") =>
  parts.flatMap((part) => (part.type === type ? [part.delta] : [])).join("");

/** Reasoning text grouped by block, in order. */
function reasoningBlocks(parts: Part[]): string[] {
  const blocks = new Map<string, string>();
  for (const part of parts) {
    if (part.type === "reasoning-start") blocks.set(part.id, "");
    if (part.type === "reasoning-delta") blocks.set(part.id, (blocks.get(part.id) ?? "") + part.delta);
  }
  return [...blocks.values()];
}

function assertCursorError(error: unknown, status: number, code: string): APICallError {
  assert.ok(APICallError.isInstance(error), `expected an APICallError, got ${String(error)}`);
  assert.equal(error.statusCode, status);
  assert.equal((error.data as { error: { code: string } }).error.code, code);
  assert.equal(error.isRetryable, false);
  return error;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

type Pids = { agent: number; grandchild: number };

/** The pids the fake agent records for slow/stall runs, once it has written them. */
function readPids(file: string): Pids | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Pids;
  } catch {
    return undefined;
  }
}

async function waitFor(check: () => boolean, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("OpenCode 2.0 Cursor language model", () => {
  let agent: FakeAgent;
  let workspace: string;
  let pidsFile: string;
  const saved = { ...process.env };

  const model = (settings: Record<string, unknown> = {}, id = "gpt-5.2") =>
    createCursor({ agentBin: agent.bin, workspace, ...settings }).languageModel(id);

  before(async () => {
    agent = await createFakeAgent();
    workspace = await realpath(await mkdtemp(path.join(tmpdir(), "cursor-v2-workspace-")));
    pidsFile = path.join(agent.dir, "pids.json");
    process.env.FAKE_AGENT_LOG = agent.logFile;
    process.env.FAKE_AGENT_PIDS = pidsFile;
  });

  beforeEach(async () => {
    await writeFile(agent.logFile, "");
  });

  after(() => {
    process.env = saved;
  });

  it("streams Cursor's answer, reasoning and tool activity", async () => {
    const { stream } = await model().doStream(call("Say hello"));
    const parts = await collect(stream);

    assert.equal(parts[0]?.type, "stream-start");
    assert.deepEqual(parts[1], { type: "response-metadata", modelId: "gpt-5.2" });
    assert.equal(deltas(parts, "text-delta"), "First part.\n\nHello from the fake agent.");
    assert.deepEqual(reasoningBlocks(parts), [
      "Let me look at the code.",
      "[cursor] read: src/index.ts\n[cursor] shell: ls missing\n[cursor] shell failed: No such file\n",
    ]);

    // Every block is opened and closed exactly once, and parts never interleave.
    let open: string | undefined;
    for (const part of parts) {
      if (part.type === "text-start" || part.type === "reasoning-start") {
        assert.equal(open, undefined);
        open = part.id;
      } else if (part.type === "text-end" || part.type === "reasoning-end") {
        assert.equal(part.id, open);
        open = undefined;
      } else if (part.type === "text-delta" || part.type === "reasoning-delta") {
        assert.equal(part.id, open);
      }
    }
    assert.equal(open, undefined);

    const finish = parts.at(-1);
    assert.equal(finish?.type, "finish");
    assert.deepEqual(finish.finishReason, { unified: "stop", raw: "stop" });
    assert.deepEqual(finish.usage, {
      inputTokens: { total: 160, noCache: 100, cacheRead: 50, cacheWrite: 10 },
      outputTokens: { total: 20, text: undefined, reasoning: undefined },
    });
  });

  it("runs Cursor headlessly in the workspace with the prompt on stdin", async () => {
    await collect((await model().doStream(call("Say hello"))).stream);
    const [run] = await agent.calls();
    assert.ok(run);
    assert.equal(run.cwd, workspace);
    assert.equal(run.stdin, "Say hello");
    assert.deepEqual(run.argv, [
      "--print",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      "--mode",
      "ask",
      "--workspace",
      workspace,
      "--model",
      "gpt-5.2",
      "--trust",
    ]);
  });

  it("applies provider settings to the Cursor run", async () => {
    const parts = await collect(
      (
        await model({ mode: "plan", force: true, approveMcps: true, trust: false, toolActivity: "off" }).doStream(
          call("Plan it"),
        )
      ).stream,
    );
    const [run] = await agent.calls();
    assert.ok(run);
    assert.ok(run.argv.includes("--force"));
    assert.ok(run.argv.includes("--approve-mcps"));
    assert.ok(!run.argv.includes("--trust"));
    assert.equal(run.argv[run.argv.indexOf("--mode") + 1], "plan");
    assert.equal(deltas(parts, "reasoning-delta"), "Let me look at the code.");
  });

  it("tells Cursor when OpenCode offers tools it cannot call", async () => {
    const tools = [{ type: "function" as const, name: "read", inputSchema: { type: "object" as const } }];
    await collect((await model().doStream(call("Read the file", { tools }))).stream);
    const [run] = await agent.calls();
    assert.ok(run?.stdin.includes(CLIENT_TOOLS_NOTE));
    assert.ok(run.stdin.includes("User: Read the file"));
  });

  it("collects the stream for doGenerate", async () => {
    const result = await model().doGenerate(call("Say hello"));
    assert.deepEqual(result.content, [
      {
        type: "reasoning",
        text: "Let me look at the code.[cursor] read: src/index.ts\n[cursor] shell: ls missing\n[cursor] shell failed: No such file\n",
      },
      { type: "text", text: "First part.\n\nHello from the fake agent." },
    ]);
    assert.equal(result.usage.outputTokens.total, 20);
  });

  it("falls back to the result event when the CLI streams no text", async () => {
    const parts = await collect((await model().doStream(call("[[scenario:result-only]]"))).stream);
    assert.equal(deltas(parts, "text-delta"), "Hello from the fake agent.");
    assert.equal(parts.at(-1)?.type, "finish");
  });

  it("rejects early failures with non-retryable API errors", async () => {
    const auth = await model().doStream(call("[[scenario:auth]]")).catch((e: unknown) => e);
    assert.match(assertCursorError(auth, 401, "cursor_auth_required").message, /agent login/);

    const limit = await model().doStream(call("[[scenario:limit]]")).catch((e: unknown) => e);
    assert.match(assertCursorError(limit, 429, "insufficient_quota").message, /quota exceeded/);

    const unknown = await model({}, "gpt-9").doStream(call("[[scenario:model]]")).catch((e: unknown) => e);
    assertCursorError(unknown, 404, "model_not_found");

    const overloaded = await model().doStream(call("[[scenario:error-event]]")).catch((e: unknown) => e);
    assert.match(assertCursorError(overloaded, 424, "cursor_cli_error").message, /overloaded/);
  });

  it("reports a missing Cursor CLI", async () => {
    const error = await createCursor({ agentBin: path.join(agent.dir, "missing-agent"), workspace })
      .languageModel("auto")
      .doStream(call("hi"))
      .catch((e: unknown) => e);
    assert.match(assertCursorError(error, 424, "cursor_cli_not_found").message, /Cursor CLI/);
  });

  it("ends the stream with an error part when Cursor fails mid-answer", async () => {
    const parts = await collect((await model().doStream(call("[[scenario:crash]]"))).stream);
    assert.equal(deltas(parts, "text-delta"), "First part.");
    assert.ok(!parts.some((part) => part.type === "finish"));
    const last = parts.at(-1);
    assert.equal(last?.type, "error");
    assert.match(assertCursorError(last.error, 424, "cursor_cli_error").message, /boom: internal error/);
  });

  it("times out a stalled run", async () => {
    const parts = await collect((await model({ timeoutMs: 400 }).doStream(call("[[scenario:stall]]"))).stream);
    assert.equal(deltas(parts, "text-delta"), "Working on it.");
    const last = parts.at(-1);
    assert.equal(last?.type, "error");
    assertCursorError(last.error, 424, "cursor_cli_timeout");
  });

  it("aborts a run that has not answered yet", async () => {
    await writeFile(pidsFile, "");
    const controller = new AbortController();
    const started = model().doStream(call("[[scenario:slow]]", { abortSignal: controller.signal }));
    await waitFor(() => readPids(pidsFile) !== undefined);
    controller.abort();
    await assert.rejects(started, { name: "AbortError" });
    const pids = readPids(pidsFile)!;
    await waitFor(() => !alive(pids.agent) && !alive(pids.grandchild));
  });

  it("stops Cursor when OpenCode cancels the stream", async () => {
    await writeFile(pidsFile, "");
    const { stream } = await model().doStream(call("[[scenario:stall]]"));
    const reader = stream.getReader();
    for (;;) {
      const { value } = await reader.read();
      if (value?.type === "text-delta") break;
    }
    await reader.cancel();
    const pids = readPids(pidsFile)!;
    await waitFor(() => !alive(pids.agent) && !alive(pids.grandchild));
  });

  it("does not start Cursor for an already aborted call", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(model().doStream(call("hi", { abortSignal: controller.signal })), { name: "AbortError" });
    assert.deepEqual(await agent.calls(), []);
  });
});
