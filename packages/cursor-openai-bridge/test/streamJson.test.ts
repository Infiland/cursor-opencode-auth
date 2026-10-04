import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CursorStreamParser, describeToolCall, parseStreamJson, parseUsage, type StreamEvent } from "../src/lib/streamJson.js";

const line = (obj: unknown) => JSON.stringify(obj);
const assistant = (text: string, extra: Record<string, unknown> = {}) =>
  line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] }, session_id: "s", ...extra });

function texts(events: StreamEvent[]): string {
  return events.flatMap((e) => (e.type === "text" ? [e.text] : [])).join("");
}

describe("CursorStreamParser", () => {
  it("emits partial-output deltas once and skips duplicates and the final flush", () => {
    const parser = new CursorStreamParser();
    const events = [
      assistant("Hel", { timestamp_ms: 1 }),
      assistant("lo", { timestamp_ms: 2 }),
      assistant("Hello", { timestamp_ms: 3, model_call_id: "m1" }),
      assistant("Hello"),
    ].flatMap((l) => parser.line(l));
    assert.equal(texts(events), "Hello");
    assert.equal(parser.text, "Hello");
  });

  it("emits only the unstreamed tail when the final flush extends the deltas", () => {
    const parser = new CursorStreamParser();
    const events = [assistant("Hel", { timestamp_ms: 1 }), assistant("Hello world")].flatMap((l) => parser.line(l));
    assert.equal(texts(events), "Hello world");
  });

  it("handles complete messages without the partial-output flag and separates segments", () => {
    const parser = new CursorStreamParser();
    const events = [
      assistant("First."),
      line({ type: "tool_call", subtype: "started", call_id: "c1", tool_call: { readToolCall: { args: { path: "a.ts" } } } }),
      line({ type: "tool_call", subtype: "completed", call_id: "c1", tool_call: { readToolCall: { args: { path: "a.ts" }, result: { success: {} } } } }),
      assistant("Second."),
    ].flatMap((l) => parser.line(l));
    assert.equal(texts(events), "First.\n\nSecond.");
  });

  it("does not double paragraph breaks that the model already wrote", () => {
    const parser = new CursorStreamParser();
    const events = [assistant("First.\n\n"), assistant("Second.")].flatMap((l) => parser.line(l));
    assert.equal(texts(events), "First.\n\nSecond.");
  });

  it("reports thinking deltas as reasoning and ignores completion markers", () => {
    const { events } = parseStreamJson(
      [
        line({ type: "thinking", subtype: "delta", text: "Hmm ", timestamp_ms: 1 }),
        line({ type: "thinking", subtype: "delta", text: "ok", timestamp_ms: 2 }),
        line({ type: "thinking", subtype: "completed", timestamp_ms: 3 }),
      ].join("\n"),
    );
    assert.deepEqual(events, [
      { type: "reasoning", text: "Hmm " },
      { type: "reasoning", text: "ok" },
    ]);
  });

  it("tracks tool calls from start to completion, including failures", () => {
    const parser = new CursorStreamParser();
    const events = [
      line({ type: "tool_call", subtype: "started", call_id: "c1", tool_call: { shellToolCall: { args: { command: "ls" } } } }),
      line({ type: "tool_call", subtype: "updated", call_id: "c1", tool_call: { shellToolCall: { args: { command: "ls" } } } }),
      line({
        type: "tool_call",
        subtype: "completed",
        call_id: "c1",
        tool_call: { shellToolCall: { args: { command: "ls" }, result: { failure: { exitCode: 2 } } } },
      }),
    ].flatMap((l) => parser.line(l));
    assert.equal(events.length, 2);
    assert.deepEqual(events[0], { type: "tool-started", callId: "c1", name: "shell", args: { command: "ls" } });
    assert.equal(events[1].type, "tool-completed");
    assert.ok(events[1].type === "tool-completed" && !events[1].ok && events[1].error === "exit code 2");
  });

  it("parses the result event, usage and error flags", () => {
    const { events } = parseStreamJson(
      line({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        duration_ms: 12,
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 0 },
      }),
    );
    assert.deepEqual(events, [
      {
        type: "result",
        isError: false,
        subtype: "success",
        text: "done",
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 0 },
        durationMs: 12,
      },
    ]);
    const failed = parseStreamJson(line({ type: "result", subtype: "error", result: "nope" })).events[0];
    assert.ok(failed.type === "result" && failed.isError);
  });

  it("surfaces error events and keeps non-JSON noise for diagnostics", () => {
    const { events, parser } = parseStreamJson(`Some banner\n${line({ type: "error", error: { message: "overloaded" } })}\n`);
    assert.deepEqual(events, [{ type: "error", message: "overloaded" }]);
    assert.deepEqual(parser.noise, ["Some banner"]);
  });

  it("reassembles lines split across chunks", () => {
    const parser = new CursorStreamParser();
    const full = `${assistant("abc")}\n${assistant("def")}`;
    const events = [...parser.push(full.slice(0, 7)), ...parser.push(full.slice(7)), ...parser.end()];
    assert.equal(texts(events), "abc\n\ndef");
  });

  it("extracts the session from system init", () => {
    const { events } = parseStreamJson(line({ type: "system", subtype: "init", session_id: "abc", model: "GPT-5", cwd: "/w" }));
    assert.deepEqual(events, [{ type: "init", sessionId: "abc", model: "GPT-5", cwd: "/w" }]);
  });
});

describe("describeToolCall", () => {
  it("names variant tool calls and generic function calls", () => {
    assert.deepEqual(describeToolCall({ editToolCall: { args: { path: "x" } } }), { name: "edit", args: { path: "x" }, result: undefined });
    assert.deepEqual(describeToolCall({ function: { name: "mcp_lookup", arguments: '{"q":1}' } }), {
      name: "mcp_lookup",
      args: { q: 1 },
      result: undefined,
    });
    assert.deepEqual(describeToolCall(null), { name: "tool", args: {} });
  });
});

describe("parseUsage", () => {
  it("accepts camelCase and snake_case and ignores empty usage", () => {
    assert.deepEqual(parseUsage({ input_tokens: 4, output_tokens: 2 }), {
      inputTokens: 4,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    assert.equal(parseUsage({ inputTokens: 0 }), undefined);
    assert.equal(parseUsage("nope"), undefined);
  });
});
