import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { loadSettings } from "../../src/lib/settings.js";
import { applyCursorProvider, PROVIDER_PACKAGE, smallModelFamily } from "../../src/v2/registry.js";
import { fakeProviderEditor } from "../helpers/opencode2.js";

const MODELS = [
  { id: "auto", name: "Auto" },
  { id: "gpt-5.2", name: "GPT-5.2" },
  { id: "haiku-4.5", name: "Claude 4.5 Haiku" },
];

describe("OpenCode 2.0 provider registration", () => {
  it("registers Cursor as an enabled AI SDK provider backed by this package", () => {
    const fake = fakeProviderEditor();
    applyCursorProvider(fake.editor, MODELS, loadSettings({ CURSOR_AGENT_BIN: "/opt/agent" }), "/work/project");

    const provider = fake.providers.get("cursor");
    assert.ok(provider);
    assert.equal(provider.name, "Cursor");
    assert.equal(provider.activation, "enabled");
    assert.equal(provider.package, PROVIDER_PACKAGE);
    assert.match(PROVIDER_PACKAGE, /^aisdk:file:\/\//);
    assert.ok(existsSync(fileURLToPath(PROVIDER_PACKAGE.slice("aisdk:".length))), "provider module exists");
    assert.deepEqual(provider.settings, {
      agentBin: "/opt/agent",
      workspace: "/work/project",
      mode: "ask",
      force: false,
      approveMcps: false,
      trust: true,
      timeoutMs: 300_000,
      toolActivity: "reasoning",
    });
  });

  it("keeps provider fields that are already set", () => {
    const fake = fakeProviderEditor({
      cursor: {
        id: "cursor",
        name: "My Cursor",
        activation: "disabled",
        package: "aisdk:custom-package",
        settings: { mode: "agent", force: true },
      },
    });
    applyCursorProvider(fake.editor, MODELS, loadSettings({}), "/work/project");
    const provider = fake.providers.get("cursor");
    assert.equal(provider?.name, "My Cursor");
    assert.equal(provider?.activation, "disabled");
    assert.equal(provider?.package, "aisdk:custom-package");
    assert.equal(provider?.settings?.mode, "agent");
    assert.equal(provider?.settings?.force, true);
    assert.equal(provider?.settings?.workspace, "/work/project");
  });

  it("describes each model as text-only with the configured limits", () => {
    const fake = fakeProviderEditor();
    applyCursorProvider(fake.editor, MODELS, loadSettings({}, { contextLimit: 100_000 }), "/w");
    assert.deepEqual([...fake.models.keys()], ["cursor/auto", "cursor/gpt-5.2", "cursor/haiku-4.5"]);
    const gpt = fake.models.get("cursor/gpt-5.2");
    assert.equal(gpt?.name, "GPT-5.2");
    assert.deepEqual(gpt?.capabilities, { tools: false, input: ["text"], output: ["text"] });
    assert.deepEqual(gpt?.limit, { context: 100_000, output: 32_000 });
    assert.equal(gpt?.family, undefined);
    // Lets OpenCode pick a small Cursor model for session titles.
    assert.equal(fake.models.get("cursor/haiku-4.5")?.family, "claude-haiku");
  });

  it("registers only the configured models, including ones Cursor did not list", () => {
    const fake = fakeProviderEditor();
    const settings = loadSettings({}, { providerID: "cur", models: ["gpt-5.2", "opus-5"] });
    applyCursorProvider(fake.editor, MODELS, settings, "/w");
    assert.deepEqual([...fake.providers.keys()], ["cur"]);
    assert.deepEqual([...fake.models.keys()], ["cur/gpt-5.2", "cur/opus-5"]);
    assert.equal(fake.models.get("cur/opus-5")?.name, "opus-5");
  });

  it("keeps model names and families set in user configuration", () => {
    const fake = fakeProviderEditor({}, { "cursor/haiku-4.5": { name: "Fast", family: "custom" } });
    applyCursorProvider(fake.editor, MODELS, loadSettings({}), "/w");
    assert.equal(fake.models.get("cursor/haiku-4.5")?.name, "Fast");
    assert.equal(fake.models.get("cursor/haiku-4.5")?.family, "custom");
  });
});

describe("smallModelFamily", () => {
  it("maps Cursor model ids to the families OpenCode uses for small tasks", () => {
    assert.equal(smallModelFamily("haiku-4.5"), "claude-haiku");
    assert.equal(smallModelFamily("claude-4.5-haiku"), "claude-haiku");
    assert.equal(smallModelFamily("gemini-3-flash"), "gemini-flash");
    assert.equal(smallModelFamily("gemini-2.5-flash-lite"), "gemini-flash-lite");
    assert.equal(smallModelFamily("gpt-5.6-luna"), "gpt-luna");
    assert.equal(smallModelFamily("GPT-5.6-Luna"), "gpt-luna");
  });

  it("leaves other models, and thinking variants, without a family", () => {
    for (const id of ["auto", "gpt-5.2", "sonnet-4.5", "opus-4.5", "haiku-4.5-thinking", "composer-1"]) {
      assert.equal(smallModelFamily(id), undefined, id);
    }
  });
});
