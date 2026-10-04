import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { resetModelCache } from "../../src/lib/models.js";
import { setupOpenCode2 } from "../../src/v2/index.js";
import { createFakeAgent, type FakeAgent } from "../helpers/fakeAgent.js";
import { fakeOpenCode2, fakeToolContext } from "../helpers/opencode2.js";

const tick = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

describe("OpenCode 2.0 plugin setup", () => {
  let agent: FakeAgent;
  let directory: string;
  let listLog: string;
  const saved = { ...process.env };

  const listCalls = () => (existsSync(listLog) ? readFileSync(listLog, "utf8").split("\n").filter(Boolean).length : 0);

  before(async () => {
    agent = await createFakeAgent();
    directory = await realpath(await mkdtemp(path.join(tmpdir(), "cursor-v2-location-")));
  });

  beforeEach(async () => {
    resetModelCache();
    listLog = path.join(await mkdtemp(path.join(tmpdir(), "cursor-v2-list-")), "list.log");
    process.env = {
      ...saved,
      CURSOR_AGENT_BIN: agent.bin,
      FAKE_AGENT_LOG: agent.logFile,
      FAKE_AGENT_LIST_LOG: listLog,
      XDG_CACHE_HOME: await mkdtemp(path.join(tmpdir(), "cursor-v2-cache-")),
    };
  });

  after(() => {
    process.env = saved;
    resetModelCache();
  });

  it("registers Cursor at once, then reloads with the models Cursor lists", async () => {
    const opencode = fakeOpenCode2({ directory });
    const reloaded = opencode.nextReload();
    await setupOpenCode2(opencode.ctx);

    assert.equal(opencode.providers.get("cursor")?.settings?.workspace, directory);
    assert.deepEqual([...opencode.models.keys()], ["cursor/auto"]);

    await reloaded;
    assert.deepEqual(
      [...opencode.models.keys()],
      ["cursor/auto", "cursor/gpt-5.2", "cursor/sonnet-4.5-thinking"],
    );
    assert.equal(opencode.models.get("cursor/sonnet-4.5-thinking")?.name, "Claude 4.5 Sonnet (Thinking)");
    assert.equal(listCalls(), 1);
  });

  it("starts from the cached model list without reloading", async () => {
    const first = fakeOpenCode2({ directory });
    const reloaded = first.nextReload();
    await setupOpenCode2(first.ctx);
    await reloaded;
    assert.equal(listCalls(), 1);

    resetModelCache(); // a new OpenCode process: only the disk cache is left
    const opencode = fakeOpenCode2({ directory });
    await setupOpenCode2(opencode.ctx);
    assert.deepEqual(
      [...opencode.models.keys()],
      ["cursor/auto", "cursor/gpt-5.2", "cursor/sonnet-4.5-thinking"],
    );
    await tick();
    assert.equal(opencode.reloads, 0);
    assert.equal(listCalls(), 1);
  });

  it("registers only configured models and does not ask Cursor for its list", async () => {
    const opencode = fakeOpenCode2({ directory, options: { models: ["gpt-5.2"], providerID: "cur", name: "Cur" } });
    await setupOpenCode2(opencode.ctx);
    await tick();
    assert.equal(opencode.providers.get("cur")?.name, "Cur");
    assert.deepEqual([...opencode.models.keys()], ["cur/gpt-5.2"]);
    assert.equal(listCalls(), 0);
    assert.equal(opencode.reloads, 0);
  });

  it("registers the Cursor tools in the cursor namespace", async () => {
    const opencode = fakeOpenCode2({ directory, options: { provider: false } });
    await setupOpenCode2(opencode.ctx);

    assert.deepEqual(
      opencode.namespaces.map((namespace) => namespace.name),
      ["cursor"],
    );
    const names = [...opencode.tools.keys()];
    for (const name of ["cursor_cli_status", "cursor_cli_run", "cursor_cli_patch", "cursor_cloud_launch_agent"]) {
      assert.ok(names.includes(name), name);
    }
    for (const tool of opencode.tools.values()) {
      assert.equal(tool.options?.namespace, "cursor");
      assert.equal(tool.input.type, "object", tool.name);
      assert.ok(!tool.name.startsWith("cursor_"), tool.name);
    }
    const run = opencode.tools.get("cursor_cli_run");
    assert.ok(run);
    assert.deepEqual((run.input as { required?: string[] }).required, ["prompt"]);
    const timeout = (run.input as { properties: Record<string, Record<string, unknown>> }).properties.timeoutMs;
    assert.deepEqual(
      { type: timeout?.type, exclusiveMinimum: timeout?.exclusiveMinimum, maximum: timeout?.maximum },
      { type: "integer", exclusiveMinimum: 0, maximum: undefined },
    );
  });

  it("runs Cursor CLI tools in the location directory", async () => {
    const opencode = fakeOpenCode2({ directory, options: { provider: false } });
    await setupOpenCode2(opencode.ctx);

    const status = await opencode.tools.get("cursor_cli_status")?.execute({}, fakeToolContext().ctx);
    assert.match(String(status?.content), /Logged in as test@example\.com/);

    const { ctx, progress } = fakeToolContext();
    const before = (await agent.calls()).length;
    const answer = await opencode.tools.get("cursor_cli_run")?.execute({ prompt: "Say hello" }, ctx);
    assert.match(String(answer?.content), /Hello from the fake agent\./);
    assert.deepEqual(progress, [{ title: "Cursor ask" }]);
    const call = (await agent.calls())[before];
    assert.equal(call?.cwd, directory);
    assert.equal(call?.stdin, "Say hello");
  });

  it("rejects tool input that does not match the schema", async () => {
    const opencode = fakeOpenCode2({ directory, options: { provider: false } });
    await setupOpenCode2(opencode.ctx);
    await assert.rejects(opencode.tools.get("cursor_cli_run")!.execute({ prompt: 42 }, fakeToolContext().ctx));
  });

  it("can leave out the provider or the tools", async () => {
    const opencode = fakeOpenCode2({ directory, options: { provider: false, tools: false } });
    await setupOpenCode2(opencode.ctx);
    await tick();
    assert.equal(opencode.providerTransforms, 0);
    assert.equal(opencode.toolTransforms, 0);
    assert.equal(listCalls(), 0);
  });

  it("ignores plugin contexts that are not OpenCode 2.0", async () => {
    // OpenCode 1.18's preview runtime also calls `setup`, with a different context.
    await setupOpenCode2({ options: {}, location: { directory } } as never);
    await setupOpenCode2(undefined as never);
  });
});
