import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import type * as http from "node:http";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { loadBridgeConfig, type BridgeConfig } from "../src/lib/config.js";
import { CLIENT_TOOLS_NOTE } from "../src/lib/prompt.js";
import { createBridgeServer } from "../src/lib/server.js";
import { createFakeAgent, type FakeAgent } from "./helpers/fakeAgent.js";

type Started = { server: http.Server; url: string; config: BridgeConfig; logs: string[] };

async function startServer(agent: FakeAgent, env: NodeJS.ProcessEnv = {}): Promise<Started> {
  const config = loadBridgeConfig({ CURSOR_AGENT_BIN: agent.bin, ...env }, { port: 0 });
  const logs: string[] = [];
  const server = createBridgeServer({ version: "9.9.9", config, log: (line) => logs.push(line) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, url: `http://127.0.0.1:${address.port}`, config, logs };
}

async function stopServer(started: Started) {
  started.server.closeAllConnections();
  await new Promise<void>((resolve) => started.server.close(() => resolve()));
}

function chat(url: string, body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) {
  return fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal,
  });
}

/** Parse an SSE body the way strict OpenAI-compatible clients do. */
function sseEvents(text: string): { data: unknown[]; done: boolean } {
  const data: unknown[] = [];
  let done = false;
  for (const block of text.split("\n\n")) {
    for (const line of block.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice("data: ".length);
      if (payload === "[DONE]") done = true;
      else data.push(JSON.parse(payload));
    }
  }
  return { data, done };
}

type Chunk = {
  choices: { delta?: { content?: string; reasoning_content?: string; role?: string }; finish_reason: string | null }[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
};

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

describe("bridge server", () => {
  let agent: FakeAgent;
  let bridge: Started;

  before(async () => {
    agent = await createFakeAgent();
    process.env.FAKE_AGENT_LOG = agent.logFile;
    bridge = await startServer(agent);
  });

  after(async () => {
    await stopServer(bridge);
    delete process.env.FAKE_AGENT_LOG;
  });

  it("serves health without auth details leaking when a key is required", async () => {
    const res = await fetch(`${bridge.url}/health`);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.version, "9.9.9");
    assert.equal(body.pid, process.pid);
    assert.equal(body.workspace, bridge.config.workspace);
  });

  it("lists models from the CLI", async () => {
    const res = await fetch(`${bridge.url}/v1/models`);
    const body = (await res.json()) as { data: { id: string; name: string }[] };
    assert.deepEqual(
      body.data.map((m) => [m.id, m.name]),
      [
        ["auto", "Auto"],
        ["gpt-5.2", "GPT-5.2"],
        ["sonnet-4.5-thinking", "Claude 4.5 Sonnet (Thinking)"],
      ],
    );
    const one = await fetch(`${bridge.url}/v1/models/gpt-5.2`);
    assert.equal(one.status, 200);
    assert.equal((await fetch(`${bridge.url}/v1/models/nope`)).status, 404);
  });

  it("streams text, reasoning and usage in OpenAI chunk format", async () => {
    const res = await chat(bridge.url, {
      model: "cursor/gpt-5.2",
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "hello" },
      ],
      tools: [{ type: "function", function: { name: "bash", description: "", parameters: {} } }],
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const { data, done } = sseEvents(await res.text());
    assert.ok(done, "stream ends with [DONE]");
    const chunks = data as Chunk[];
    // Strict clients (OpenCode v2) require `choices` on every event.
    for (const c of chunks) assert.ok(Array.isArray(c.choices));
    const content = chunks.map((c) => c.choices[0]?.delta?.content ?? "").join("");
    const reasoning = chunks.map((c) => c.choices[0]?.delta?.reasoning_content ?? "").join("");
    assert.equal(content, "First part.\n\nHello from the fake agent.");
    assert.match(reasoning, /^Let me look at the code\.\n\[cursor\] read: src\/index\.ts\n/);
    assert.match(reasoning, /\[cursor\] shell failed: No such file/);
    assert.equal(chunks.filter((c) => c.choices[0]?.finish_reason === "stop").length, 1);
    const usage = chunks.at(-1)?.usage;
    assert.deepEqual(usage, {
      prompt_tokens: 160,
      completion_tokens: 20,
      total_tokens: 180,
      prompt_tokens_details: { cached_tokens: 50 },
    });

    const call = (await agent.calls()).at(-1);
    assert.ok(call);
    // The prompt travels on stdin, never on the command line.
    assert.ok(!call.argv.some((arg) => arg.includes("hello")));
    assert.equal(call.stdin, `System:\nBe brief.\n\n${CLIENT_TOOLS_NOTE}\n\nUser: hello\n\nAssistant:`);
    for (const flag of ["--print", "--trust", "--stream-partial-output"]) assert.ok(call.argv.includes(flag), flag);
    assert.deepEqual(call.argv.slice(call.argv.indexOf("--mode"), call.argv.indexOf("--mode") + 2), ["--mode", "ask"]);
    assert.equal(call.argv[call.argv.indexOf("--model") + 1], "gpt-5.2");
    assert.equal(call.argv[call.argv.indexOf("--workspace") + 1], bridge.config.workspace);
  });

  it("returns a complete JSON response when not streaming", async () => {
    const res = await chat(bridge.url, { model: "gpt-5.2", messages: [{ role: "user", content: "hi" }] });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      object: string;
      choices: { message: { content: string; reasoning_content?: string }; finish_reason: string }[];
      usage: { total_tokens: number };
    };
    assert.equal(body.object, "chat.completion");
    assert.equal(body.choices[0].message.content, "First part.\n\nHello from the fake agent.");
    assert.match(body.choices[0].message.reasoning_content ?? "", /Let me look at the code/);
    assert.equal(body.choices[0].finish_reason, "stop");
    assert.equal(body.usage.total_tokens, 180);
  });

  it("falls back to the result text when no assistant messages were streamed", async () => {
    const res = await chat(bridge.url, { messages: [{ role: "user", content: "[[scenario:result-only]]" }] });
    const body = (await res.json()) as { choices: { message: { content: string } }[] };
    assert.equal(body.choices[0].message.content, "Hello from the fake agent.");
  });

  it("maps CLI failures to statuses clients will not retry", async () => {
    const cases: [string, number, string][] = [
      ["auth", 401, "cursor_auth_required"],
      ["limit", 429, "insufficient_quota"],
      ["model", 404, "model_not_found"],
      ["crash", 424, "cursor_cli_error"],
      ["error-event", 424, "cursor_cli_error"],
    ];
    for (const [scenario, status, code] of cases) {
      const res = await chat(bridge.url, { stream: false, messages: [{ role: "user", content: `[[scenario:${scenario}]]` }] });
      const body = (await res.json()) as { error: { code: string; message: string } };
      assert.equal(res.status, status, scenario);
      assert.equal(body.error.code, code, scenario);
      assert.ok(body.error.message.length < 600, "error stays short enough to be shown in full");
    }
  });

  it("reports early failures of streaming requests with a real HTTP status", async () => {
    const res = await chat(bridge.url, { stream: true, messages: [{ role: "user", content: "[[scenario:auth]]" }] });
    assert.equal(res.status, 401);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  });

  it("reports failures after streaming started in-band", async () => {
    const res = await chat(bridge.url, { stream: true, messages: [{ role: "user", content: "[[scenario:crash]]" }] });
    assert.equal(res.status, 200);
    const { data, done } = sseEvents(await res.text());
    const content = (data as Chunk[]).map((c) => c.choices[0]?.delta?.content ?? "").join("");
    assert.ok(done);
    assert.match(content, /^First part\.\n\n\[cursor-openai-bridge\] Cursor CLI exited with code 3 — boom: internal error/);
  });

  it("validates the request body", async () => {
    assert.equal((await chat(bridge.url, "{not json")).status, 400);
    assert.equal((await chat(bridge.url, { messages: [] })).status, 400);
    assert.equal((await chat(bridge.url, [1, 2])).status, 400);
    const res = await fetch(`${bridge.url}/v1/nope`);
    assert.equal(res.status, 404);
  });

  it("honours and validates X-Cursor-Workspace", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bridge ws é-"));
    const ok = await chat(bridge.url, { messages: [{ role: "user", content: "hi" }] }, { "x-cursor-workspace": encodeURI(dir) });
    assert.equal(ok.status, 200);
    await ok.text();
    const call = (await agent.calls()).at(-1);
    assert.equal(call?.argv[call.argv.indexOf("--workspace") + 1], dir);
    assert.equal(call?.cwd, dir);

    const relative = await chat(bridge.url, { messages: [{ role: "user", content: "hi" }] }, { "x-cursor-workspace": "rel/dir" });
    assert.equal(relative.status, 400);
    const missing = await chat(bridge.url, { messages: [{ role: "user", content: "hi" }] }, { "x-cursor-workspace": "/no/such/dir" });
    assert.equal(missing.status, 400);
  });

  it("rejects foreign Host and Origin headers", async () => {
    const http = await import("node:http");
    const status = (headers: Record<string, string>) =>
      new Promise<number>((resolve, reject) => {
        const req = http.request(`${bridge.url}/v1/models`, { headers }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end();
      });
    assert.equal(await status({ host: "evil.example" }), 403);
    assert.equal(await status({ origin: "https://evil.example" }), 403);
    assert.equal(await status({ origin: "null" }), 403);
    assert.equal(await status({ host: "localhost:1234", origin: "http://127.0.0.1:3000" }), 200);
  });

  it("pins `auto` to the last explicit model in strict mode", async () => {
    await (await chat(bridge.url, { model: "sonnet-4.5-thinking", messages: [{ role: "user", content: "a" }] })).text();
    await (await chat(bridge.url, { model: "auto", messages: [{ role: "user", content: "b" }] })).text();
    const calls = await agent.calls();
    const last = calls.at(-1);
    assert.equal(last?.argv[last.argv.indexOf("--model") + 1], "sonnet-4.5-thinking");
  });
});

describe("bridge server lifecycle", () => {
  let agent: FakeAgent;

  before(async () => {
    agent = await createFakeAgent();
  });

  beforeEach(() => {
    delete process.env.FAKE_AGENT_PIDS;
  });

  it("requires the API key when one is configured", async () => {
    const bridge = await startServer(agent, { CURSOR_BRIDGE_API_KEY: "s3cret" });
    try {
      const health = (await (await fetch(`${bridge.url}/health`)).json()) as Record<string, unknown>;
      assert.equal(health.ok, true);
      assert.equal(health.workspace, undefined, "no local paths without the key");
      assert.equal((await fetch(`${bridge.url}/v1/models`)).status, 401);
      const ok = await fetch(`${bridge.url}/v1/models`, { headers: { authorization: "Bearer s3cret" } });
      assert.equal(ok.status, 200);
      // SDK and plugin headers merged case-insensitively arrive comma-joined.
      const merged = await fetch(`${bridge.url}/v1/models`, { headers: { authorization: "Bearer unused, Bearer s3cret" } });
      assert.equal(merged.status, 200);
      const wrong = await fetch(`${bridge.url}/v1/models`, { headers: { authorization: "Bearer unused, Bearer nope" } });
      assert.equal(wrong.status, 401);
    } finally {
      await stopServer(bridge);
    }
  });

  it("rejects oversized bodies", async () => {
    const bridge = await startServer(agent, { CURSOR_BRIDGE_MAX_BODY_BYTES: "2048" });
    try {
      const res = await chat(bridge.url, { messages: [{ role: "user", content: "x".repeat(5_000) }] });
      assert.equal(res.status, 413);
    } finally {
      await stopServer(bridge);
    }
  });

  it("times out runaway runs without reporting success", async () => {
    const bridge = await startServer(agent, { CURSOR_BRIDGE_TIMEOUT_MS: "300" });
    try {
      const res = await chat(bridge.url, { messages: [{ role: "user", content: "[[scenario:slow]]" }] });
      const body = (await res.json()) as { error: { code: string } };
      assert.equal(res.status, 424);
      assert.equal(body.error.code, "cursor_cli_timeout");
    } finally {
      await stopServer(bridge);
    }
  });

  it("kills Cursor (and its children) when the client disconnects", { skip: process.platform === "win32" }, async () => {
    const pidFile = path.join(agent.dir, `pids-${Date.now()}.json`);
    process.env.FAKE_AGENT_PIDS = pidFile;
    const bridge = await startServer(agent);
    try {
      const controller = new AbortController();
      const pending = chat(bridge.url, { stream: true, messages: [{ role: "user", content: "[[scenario:slow]]" }] }, {}, controller.signal);
      pending.catch(() => undefined);
      let pids: { agent: number; grandchild: number } | undefined;
      await waitFor(async () => {
        pids = await readFile(pidFile, "utf8")
          .then((t) => JSON.parse(t) as { agent: number; grandchild: number })
          .catch(() => undefined);
        return pids !== undefined;
      });
      assert.ok(pids && alive(pids.agent));
      controller.abort();
      await waitFor(() => !alive(pids!.agent) && !alive(pids!.grandchild));
      await waitFor(() => bridge.logs.some((l) => l.includes("client disconnected")));
    } finally {
      await stopServer(bridge);
    }
  });

  it("explains a missing Cursor CLI", async () => {
    const config = loadBridgeConfig({ CURSOR_AGENT_BIN: "/nonexistent/agent" }, { port: 0 });
    const server = createBridgeServer({ version: "1", config, log: () => undefined });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    try {
      const res = await chat(`http://127.0.0.1:${address.port}`, { messages: [{ role: "user", content: "hi" }] });
      const body = (await res.json()) as { error: { code: string; message: string } };
      assert.equal(res.status, 424);
      assert.equal(body.error.code, "cursor_cli_not_found");
      assert.match(body.error.message, /CURSOR_AGENT_BIN/);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
