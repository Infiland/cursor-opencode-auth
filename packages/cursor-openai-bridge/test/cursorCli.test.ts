import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildPrintArgs,
  classifyCursorFailure,
  normalizeModelId,
  parseModelList,
  resolveAgentBin,
} from "../src/lib/cursorCli.js";

describe("parseModelList", () => {
  it("parses the `id - Name` format and skips headers and tips", () => {
    const output = [
      "\u001b[1mAvailable models\u001b[0m",
      "",
      "auto - Auto",
      "gpt-5.2 - GPT-5.2 (current, default)",
      "sonnet-4.5-thinking - Claude 4.5 Sonnet (Thinking)",
      "",
      "Tip: use --model <id> to switch.",
    ].join("\n");
    assert.deepEqual(parseModelList(output), [
      { id: "auto", name: "Auto" },
      { id: "gpt-5.2", name: "GPT-5.2", isDefault: true, isCurrent: true },
      { id: "sonnet-4.5-thinking", name: "Claude 4.5 Sonnet (Thinking)" },
    ]);
  });

  it("accepts bare IDs (optionally bulleted) and de-duplicates", () => {
    assert.deepEqual(parseModelList("- gpt-5\n* gpt-5\nopus-4.6\n"), [
      { id: "gpt-5", name: "gpt-5" },
      { id: "opus-4.6", name: "opus-4.6" },
    ]);
  });
});

describe("buildPrintArgs", () => {
  it("omits --mode for agent mode and adds flags only when requested", () => {
    assert.deepEqual(buildPrintArgs({ mode: "agent" }), ["--print", "--output-format", "text"]);
    assert.deepEqual(
      buildPrintArgs({
        mode: "ask",
        model: "gpt-5.2",
        workspace: "/w",
        outputFormat: "stream-json",
        streamPartialOutput: true,
        force: true,
        approveMcps: true,
        trust: true,
      }),
      [
        "--print",
        "--output-format",
        "stream-json",
        "--stream-partial-output",
        "--mode",
        "ask",
        "--workspace",
        "/w",
        "--model",
        "gpt-5.2",
        "--force",
        "--approve-mcps",
        "--trust",
      ],
    );
  });

  it("only streams partial output with stream-json", () => {
    assert.ok(!buildPrintArgs({ outputFormat: "json", streamPartialOutput: true }).includes("--stream-partial-output"));
  });
});

describe("classifyCursorFailure", () => {
  it("recognises authentication, limits and model errors", () => {
    assert.equal(classifyCursorFailure("Error: Authentication required. Please run 'agent login' first"), "auth");
    assert.equal(classifyCursorFailure("No access token found"), "auth");
    assert.equal(classifyCursorFailure("ActionRequiredError: You've hit your usage limit"), "usage_limit");
    assert.equal(classifyCursorFailure("429 Too Many Requests"), "rate_limit");
    assert.equal(classifyCursorFailure("Cannot use this model: foo"), "model");
    assert.equal(classifyCursorFailure("Model 'foo' not found"), "model");
    assert.equal(classifyCursorFailure("segfault"), "failed");
  });
});

describe("normalizeModelId / resolveAgentBin", () => {
  it("strips provider prefixes", () => {
    assert.equal(normalizeModelId("cursor/gpt-5.2"), "gpt-5.2");
    assert.equal(normalizeModelId("  "), undefined);
    assert.equal(normalizeModelId(42), undefined);
  });

  it("prefers CURSOR_AGENT_BIN, then legacy variables", () => {
    assert.equal(resolveAgentBin({}), "agent");
    assert.equal(resolveAgentBin({ CURSOR_CLI_PATH: "/c" }), "/c");
    assert.equal(resolveAgentBin({ CURSOR_AGENT_BIN: "/a", CURSOR_CLI_BIN: "/b" }), "/a");
  });
});
