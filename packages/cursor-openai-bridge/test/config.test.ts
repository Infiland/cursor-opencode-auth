import assert from "node:assert/strict";
import * as path from "node:path";
import { describe, it } from "node:test";

import { DEFAULT_PORT, loadBridgeConfig } from "../src/lib/config.js";

describe("loadBridgeConfig", () => {
  it("uses safe defaults", () => {
    const config = loadBridgeConfig({});
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.port, DEFAULT_PORT);
    assert.equal(config.mode, "ask");
    assert.equal(config.force, false);
    assert.equal(config.approveMcps, false);
    assert.equal(config.trust, true);
    assert.equal(config.strictModel, true);
    assert.equal(config.defaultModel, "auto");
    assert.equal(config.timeoutMs, 300_000);
    assert.equal(config.toolActivity, "reasoning");
    assert.equal(config.requiredKey, undefined);
    assert.equal(config.workspace, process.cwd());
  });

  it("reads the environment and ignores invalid values", () => {
    const config = loadBridgeConfig({
      CURSOR_BRIDGE_PORT: "9001",
      CURSOR_BRIDGE_MODE: "PLAN",
      CURSOR_BRIDGE_FORCE: "yes",
      CURSOR_BRIDGE_TRUST: "off",
      CURSOR_BRIDGE_TIMEOUT_MS: "0",
      CURSOR_BRIDGE_DEFAULT_MODEL: "cursor/gpt-5.2",
      CURSOR_BRIDGE_WORKSPACE: "relative/dir",
      CURSOR_BRIDGE_TOOL_ACTIVITY: "off",
      CURSOR_BRIDGE_ALLOWED_HOSTS: "Bridge.Local, docker.internal ",
      CURSOR_BRIDGE_API_KEY: "secret",
    });
    assert.equal(config.port, 9001);
    assert.equal(config.mode, "plan");
    assert.equal(config.force, true);
    assert.equal(config.trust, false);
    assert.equal(config.timeoutMs, 0);
    assert.equal(config.defaultModel, "gpt-5.2");
    assert.equal(config.workspace, path.resolve("relative/dir"));
    assert.equal(config.toolActivity, "off");
    assert.deepEqual(config.allowedHosts, ["bridge.local", "docker.internal"]);
    assert.equal(config.requiredKey, "secret");

    const fallback = loadBridgeConfig({ CURSOR_BRIDGE_PORT: "nope", CURSOR_BRIDGE_MODE: "yolo", CURSOR_BRIDGE_TIMEOUT_MS: "-5" });
    assert.equal(fallback.port, DEFAULT_PORT);
    assert.equal(fallback.mode, "ask");
    assert.equal(fallback.timeoutMs, 300_000);
  });

  it("lets explicit overrides win", () => {
    const config = loadBridgeConfig({ CURSOR_BRIDGE_PORT: "9001" }, { port: 0, host: "localhost", mode: "agent" });
    assert.equal(config.port, 0);
    assert.equal(config.host, "localhost");
    assert.equal(config.mode, "agent");
  });
});
