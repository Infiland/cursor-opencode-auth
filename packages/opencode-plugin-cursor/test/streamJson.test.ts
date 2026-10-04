import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatRunSummary, summarizeStreamJson } from "../src/lib/streamJson.js";

const line = (obj: unknown) => JSON.stringify(obj);

describe("summarizeStreamJson", () => {
  it("collects tool activity, deduplicated text, errors and usage", () => {
    const stdout = [
      line({ type: "system", subtype: "init", session_id: "s1", model: "GPT-5.2" }),
      line({ type: "tool_call", subtype: "started", call_id: "c1", tool_call: { grepToolCall: { args: { pattern: "TODO" } } } }),
      line({ type: "tool_call", subtype: "completed", call_id: "c1", tool_call: { grepToolCall: { args: { pattern: "TODO" }, result: { success: {} } } } }),
      line({ type: "assistant", message: { content: [{ type: "text", text: "Fou" }] }, timestamp_ms: 1 }),
      line({ type: "assistant", message: { content: [{ type: "text", text: "nd it" }] }, timestamp_ms: 2 }),
      line({ type: "assistant", message: { content: [{ type: "text", text: "Found it" }] } }),
      line({ type: "result", subtype: "success", is_error: false, result: "Found it", duration_ms: 1500, usage: { inputTokens: 3, outputTokens: 1 } }),
    ].join("\n");
    const summary = summarizeStreamJson(stdout);
    assert.equal(summary.model, "GPT-5.2");
    assert.equal(summary.text, "Found it");
    assert.deepEqual(summary.tools, [{ name: "grep", target: "TODO", ok: true, error: undefined }]);
    assert.equal(summary.usage?.inputTokens, 3);
    assert.equal(
      formatRunSummary(summary),
      "Model: GPT-5.2 · Session: s1 · Duration: 1.5s\n\n## Tool Calls (1)\n1. grep TODO — ok\n\n## Assistant Response\nFound it",
    );
  });

  it("falls back to the result text and reports errors", () => {
    const summary = summarizeStreamJson(
      [line({ type: "error", message: "overloaded" }), line({ type: "result", subtype: "success", result: "partial" })].join("\n"),
    );
    assert.equal(summary.text, "partial");
    assert.match(formatRunSummary(summary), /## Errors\noverloaded/);
  });
});
