import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import * as net from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  bridgeHealth,
  bridgeLogFile,
  bridgePidFile,
  ensureBridge,
  expectedBridgeVersion,
  resolveBridgeScript,
  stopBridge,
} from "../src/lib/bridge.js";
import { loadSettings, type PluginSettings } from "../src/lib/settings.js";
import { createBridgeTools } from "../src/tools/bridge.js";
import { createFakeAgent } from "./helpers/fakeAgent.js";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

describe("bridge lifecycle", () => {
  const saved = { ...process.env };
  let settings: PluginSettings;

  before(async () => {
    const agent = await createFakeAgent();
    process.env.XDG_DATA_HOME = await mkdtemp(path.join(tmpdir(), "plugin-data-"));
    settings = loadSettings({ CURSOR_AGENT_BIN: agent.bin, CURSOR_BRIDGE_PORT: String(await freePort()) });
  });

  after(async () => {
    await stopBridge(settings).catch(() => undefined);
    process.env = saved;
  });

  it("finds the bridge shipped with the plugin", () => {
    const script = resolveBridgeScript({});
    assert.ok(script && existsSync(script), "bridge dist/cli.js exists (run `npm run build` first)");
    assert.match(script, /cursor-openai-bridge[/\\]dist[/\\]cli\.js$/);
    assert.match(expectedBridgeVersion() ?? "", /^\d+\.\d+\.\d+/);
  });

  it("starts the bridge once, even for concurrent callers", async () => {
    const [a, b] = await Promise.all([ensureBridge(settings), ensureBridge(settings)]);
    assert.equal(a, b, "concurrent callers share one attempt");
    assert.equal(a.status, "started", a.status === "failed" ? a.error : undefined);
    const health = await bridgeHealth(settings);
    assert.ok(health?.pid);
    assert.equal(health.version, expectedBridgeVersion());
    assert.equal(Number(await readFile(bridgePidFile(), "utf8")), health.pid);
    assert.match(await readFile(bridgeLogFile(), "utf8"), /cursor-openai-bridge .* listening/);

    const again = await ensureBridge(settings);
    assert.equal(again.status, "running");
  });

  it("reports status through the tool", async () => {
    const tools = createBridgeTools({ settings, cwd: tmpdir() });
    const ctx = {} as Parameters<typeof tools.cursor_bridge_status.execute>[1];
    const status = JSON.parse((await tools.cursor_bridge_status.execute({}, ctx)) as string) as Record<string, unknown>;
    assert.equal(status.ok, true);
    assert.equal(status.v1BaseURL, `${settings.bridgeURL}/v1`);
    assert.equal(status.outdated, undefined);
  });

  it("stops the bridge it finds on the configured port", async () => {
    const result = await stopBridge(settings);
    assert.equal(result.stopped, true);
    assert.equal(await bridgeHealth(settings, 300), undefined);
    assert.equal(existsSync(bridgePidFile()), false);
    assert.equal((await stopBridge(settings)).stopped, false);
  });

  it("does not manage bridges on other machines", async () => {
    const remote = loadSettings({}, { bridgeURL: "http://10.0.0.5:8765" });
    assert.equal((await ensureBridge(remote)).status, "remote");
    assert.equal((await stopBridge(remote)).stopped, false);
  });
});
