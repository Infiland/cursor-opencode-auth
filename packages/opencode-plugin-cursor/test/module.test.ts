import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as mod from "../src/index.js";

describe("plugin module", () => {
  it("default-exports a plugin usable by both OpenCode plugin loaders", () => {
    const plugin = mod.default;
    assert.equal(typeof plugin.id, "string");
    // OpenCode 1.x: { id, server }
    assert.equal(typeof plugin.server, "function");
    // OpenCode v2: { id, setup }
    assert.equal(typeof plugin.setup, "function");
  });

  it("only has function-valued named exports (OpenCode 1.x treats each as a plugin)", () => {
    for (const [name, value] of Object.entries(mod)) {
      if (name === "default") continue;
      assert.equal(typeof value, "function", name);
    }
    assert.equal(mod.CursorPlugin, mod.default.server);
  });
});
