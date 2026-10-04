import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isLocalBridge, loadSettings } from "../src/lib/settings.js";

describe("loadSettings", () => {
  it("defaults to a local bridge and the cursor provider", () => {
    const s = loadSettings({});
    assert.equal(s.agentBin, "agent");
    assert.equal(s.providerID, "cursor");
    assert.equal(s.providerName, "Cursor");
    assert.equal(s.bridgeURL, "http://127.0.0.1:8765");
    assert.equal(s.autostart, true);
    assert.equal(s.models, undefined);
    assert.equal(isLocalBridge(s), true);
  });

  it("derives a reachable URL from the bridge bind address", () => {
    assert.equal(loadSettings({ CURSOR_BRIDGE_HOST: "0.0.0.0", CURSOR_BRIDGE_PORT: "9000" }).bridgeURL, "http://127.0.0.1:9000");
    assert.equal(loadSettings({ CURSOR_BRIDGE_HOST: "::1" }).bridgeURL, "http://[::1]:8765");
    assert.equal(loadSettings({ CURSOR_BRIDGE_PORT: "99999" }).bridgeURL, "http://127.0.0.1:8765");
  });

  it("reads plugin options and the environment", () => {
    const s = loadSettings(
      { CURSOR_BRIDGE_AUTOSTART: "false", CURSOR_AGENT_BIN: "/opt/agent", CURSOR_BRIDGE_API_KEY: "k" },
      { bridgeURL: "http://192.168.1.5:8765/v1/", models: ["a", " ", 3, "b"], outputLimit: 64_000, contextLimit: -1 },
    );
    assert.equal(s.autostart, false);
    assert.equal(s.agentBin, "/opt/agent");
    assert.equal(s.bridgeApiKey, "k");
    assert.equal(s.bridgeURL, "http://192.168.1.5:8765");
    assert.deepEqual(s.models, ["a", "b"]);
    assert.equal(s.outputLimit, 64_000);
    assert.equal(s.contextLimit, 200_000);
    assert.equal(isLocalBridge(s), false);
    assert.equal(loadSettings({ CURSOR_BRIDGE_AUTOSTART: "0" }, { autostart: true }).autostart, true);
  });
});
