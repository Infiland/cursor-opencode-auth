import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { LanguageModelV3Prompt } from "@ai-sdk/provider";
import { CLIENT_TOOLS_NOTE } from "cursor-openai-bridge";

import { promptFromV3 } from "../../src/v2/prompt.js";

describe("promptFromV3", () => {
  it("passes a lone user message through unchanged", () => {
    const prompt: LanguageModelV3Prompt = [{ role: "user", content: [{ type: "text", text: "Explain this repo" }] }];
    assert.equal(promptFromV3(prompt, { clientTools: false }), "Explain this repo");
  });

  it("flattens a conversation with tool calls into one transcript", () => {
    const prompt: LanguageModelV3Prompt = [
      { role: "system", content: "You are a coding agent." },
      { role: "user", content: [{ type: "text", text: "List the files" }] },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "I should look first." },
          { type: "text", text: "Checking." },
          { type: "tool-call", toolCallId: "call-1", toolName: "bash", input: { command: "ls" } },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "call-1", toolName: "bash", output: { type: "text", value: "a.txt" } },
        ],
      },
      { role: "user", content: [{ type: "text", text: "Thanks" }] },
    ];
    assert.equal(
      promptFromV3(prompt, { clientTools: true }),
      [
        `System:\nYou are a coding agent.\n\n${CLIENT_TOOLS_NOTE}`,
        "User: List the files",
        'Assistant: Checking.\nAssistant called tool `bash` (call-1) with: {"command":"ls"}',
        "Tool result from `bash` (call-1):\na.txt",
        "User: Thanks",
        "Assistant:",
      ].join("\n\n"),
    );
  });

  it("renders every tool output type as text", () => {
    const result = (output: unknown) =>
      promptFromV3(
        [
          { role: "user", content: [{ type: "text", text: "go" }] },
          {
            role: "tool",
            content: [{ type: "tool-result", toolCallId: "c", toolName: "t", output } as never],
          },
        ],
        { clientTools: false },
      ).split("\n\n")[1];

    assert.equal(result({ type: "json", value: { ok: true } }), "Tool result from `t` (c):\n{\"ok\":true}");
    assert.equal(result({ type: "error-text", value: "nope" }), "Tool result from `t` (c):\nnope");
    assert.equal(
      result({ type: "execution-denied", reason: "user said no" }),
      "Tool result from `t` (c):\nExecution denied: user said no",
    );
    assert.equal(
      result({
        type: "content",
        value: [
          { type: "text", text: "line" },
          { type: "image-data", data: "AAAA", mediaType: "image/png" },
        ],
      }),
      "Tool result from `t` (c):\nline\n[media omitted]",
    );
  });

  it("replaces attachments with placeholders", () => {
    const prompt: LanguageModelV3Prompt = [
      { role: "system", content: "sys" },
      {
        role: "user",
        content: [
          { type: "text", text: "see: " },
          { type: "file", mediaType: "image/png", data: "AAAA" },
          { type: "file", mediaType: "application/pdf", data: "AAAA" },
        ],
      },
    ];
    const text = promptFromV3(prompt, { clientTools: false });
    assert.match(text, /User: see: \[image omitted: Cursor CLI accepts text only\]\[file attachment omitted\]/);
  });
});
