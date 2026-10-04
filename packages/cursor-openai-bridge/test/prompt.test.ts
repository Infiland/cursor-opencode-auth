import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildPrompt, CLIENT_TOOLS_NOTE, contentToText } from "../src/lib/prompt.js";

describe("buildPrompt", () => {
  it("passes a lone user message through unchanged", () => {
    assert.equal(buildPrompt([{ role: "user", content: "say hi" }]), "say hi");
  });

  it("renders system, developer and conversation turns", () => {
    const prompt = buildPrompt([
      { role: "system", content: "Be brief." },
      { role: "developer", content: "Use British spelling." },
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello!" },
      { role: "user", content: [{ type: "text", text: "Colour?" }] },
    ]);
    assert.equal(
      prompt,
      "System:\nBe brief.\n\nUse British spelling.\n\nUser: Hi\n\nAssistant: Hello!\n\nUser: Colour?\n\nAssistant:",
    );
  });

  it("keeps tool calls and their results, matched by id", () => {
    const prompt = buildPrompt([
      { role: "user", content: "Read a.ts" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"a.ts"}' } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "export const a = 1" },
    ]);
    assert.match(prompt, /Assistant called tool `read` \(call_1\) with: \{"path":"a\.ts"\}/);
    assert.match(prompt, /Tool result from `read` \(call_1\):\nexport const a = 1/);
  });

  it("notes when the client offered tools", () => {
    const prompt = buildPrompt([{ role: "user", content: "hi" }], { clientTools: true });
    assert.ok(prompt.startsWith(`System:\n${CLIENT_TOOLS_NOTE}`));
  });

  it("tolerates junk input", () => {
    assert.equal(buildPrompt("nope"), "Assistant:");
    assert.equal(buildPrompt([null, 3, { role: "user", content: "x" }]), "x");
  });
});

describe("contentToText", () => {
  it("replaces images with a placeholder", () => {
    assert.equal(
      contentToText([{ type: "text", text: "see: " }, { type: "image_url", image_url: { url: "data:..." } }]),
      "see: [image omitted: Cursor CLI accepts text only]",
    );
  });
});
