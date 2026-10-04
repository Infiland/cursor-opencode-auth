#!/usr/bin/env node
// Stand-in for Cursor CLI used by the test suites. Scenario markers in the prompt (stdin)
// such as [[scenario:auth]] select the behaviour; every --print call is appended as
// {argv, cwd, stdin} JSON to $FAKE_AGENT_LOG when that is set.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const value = (flag) => { const i = argv.indexOf(flag); return i === -1 ? undefined : argv[i + 1]; };
const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const sid = "sess-1234";

if (has("--list-models")) {
  if (process.env.FAKE_AGENT_LIST_LOG) fs.appendFileSync(process.env.FAKE_AGENT_LIST_LOG, "list\n");
  process.stdout.write("Available models\n\nauto - Auto\ngpt-5.2 - GPT-5.2 (current, default)\nsonnet-4.5-thinking - Claude 4.5 Sonnet (Thinking)\n\nTip: use --model <id> to switch.\n");
  process.exit(0);
}
if (argv[0] === "status") { process.stdout.write("Logged in as test@example.com\n"); process.exit(0); }
if (argv[0] === "mcp" && argv[1] === "list") { process.stdout.write("fake-server: ready\n"); process.exit(0); }
if (argv[0] === "mcp" && argv[1] === "list-tools") { process.stdout.write("Tools for " + argv[2] + ":\n- lookup\n"); process.exit(0); }
if (!has("--print")) { process.stderr.write("fake agent: unsupported invocation " + argv.join(" ") + "\n"); process.exit(64); }

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (stdin += c));
process.stdin.on("end", main);

function main() {
  if (process.env.FAKE_AGENT_LOG) {
    fs.appendFileSync(process.env.FAKE_AGENT_LOG, JSON.stringify({ argv, cwd: process.cwd(), stdin }) + "\n");
  }
  const scenario = (/\[\[scenario:([a-z-]+)\]\]/.exec(stdin) || [])[1] || "default";
  const format = value("--output-format") || "text";
  const partial = has("--stream-partial-output");
  const model = value("--model") || "auto";

  if (scenario === "auth") { process.stderr.write("Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY.\n"); process.exit(1); }
  if (scenario === "limit") { process.stderr.write("ActionRequiredError: You've hit your usage limit. Your usage limits will reset when your monthly cycle ends on 9/12/2026.\n"); process.exit(1); }
  if (scenario === "model") { process.stderr.write("Cannot use this model: " + model + ". Run agent --list-models to see available models.\n"); process.exit(1); }
  // slow: never answers; stall: answers a little, then hangs.
  if (scenario === "slow" || scenario === "stall") {
    if (process.env.FAKE_AGENT_PIDS) {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"] });
      fs.writeFileSync(process.env.FAKE_AGENT_PIDS, JSON.stringify({ agent: process.pid, grandchild: child.pid }));
    }
    if (format === "stream-json") {
      out({ type: "system", subtype: "init", session_id: sid, model, cwd: process.cwd() });
      if (scenario === "stall") {
        out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Working on it." }] }, session_id: sid, ...(partial ? { timestamp_ms: 1 } : {}) });
      }
    }
    setInterval(() => {}, 1000);
    return;
  }
  if (scenario === "edit") {
    fs.appendFileSync(path.join(process.cwd(), "README.md"), "Edited by fake agent\n");
    fs.writeFileSync(path.join(process.cwd(), "NEW_FILE.txt"), "brand new\n");
  }

  const text = scenario === "edit" ? "I updated README.md and added NEW_FILE.txt." : "Hello from the fake agent.";
  if (format === "text") { process.stdout.write(text + "\n"); process.exit(0); }
  if (format === "json") {
    out({ type: "result", subtype: "success", is_error: false, result: text, session_id: sid, duration_ms: 5 });
    process.exit(0);
  }

  out({ type: "system", subtype: "init", apiKeySource: "login", cwd: process.cwd(), session_id: sid, model, permissionMode: "default" });
  out({ type: "user", message: { role: "user", content: [{ type: "text", text: stdin }] }, session_id: sid });

  if (scenario === "result-only") {
    out({ type: "result", subtype: "success", is_error: false, result: text, session_id: sid, duration_ms: 5 });
    process.exit(0);
  }
  if (scenario === "error-event") {
    out({ type: "error", message: "Model is overloaded, try again later", session_id: sid });
    process.exit(0);
  }

  out({ type: "thinking", subtype: "delta", text: "Let me look ", session_id: sid, timestamp_ms: 1 });
  out({ type: "thinking", subtype: "delta", text: "at the code.", session_id: sid, timestamp_ms: 2 });
  out({ type: "thinking", subtype: "completed", session_id: sid, timestamp_ms: 3 });

  const segment1 = "First part.";
  const segment2 = scenario === "crash" ? "" : text;
  const emit = (segment) => {
    if (!segment) return;
    if (partial) {
      const half = Math.ceil(segment.length / 2);
      out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: segment.slice(0, half) }] }, session_id: sid, timestamp_ms: 10 });
      out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: segment.slice(half) }] }, session_id: sid, timestamp_ms: 11 });
      out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: segment }] }, session_id: sid, timestamp_ms: 12, model_call_id: "mc-1" });
    }
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: segment }] }, session_id: sid });
  };

  emit(segment1);
  out({ type: "tool_call", subtype: "started", call_id: "call-1", tool_call: { readToolCall: { args: { path: "src/index.ts" } } }, session_id: sid });
  out({ type: "tool_call", subtype: "completed", call_id: "call-1", tool_call: { readToolCall: { args: { path: "src/index.ts" }, result: { success: { content: "export {}", totalLines: 1 } } } }, session_id: sid });
  out({ type: "tool_call", subtype: "started", call_id: "call-2", tool_call: { shellToolCall: { args: { command: "ls missing" } } }, session_id: sid });
  out({ type: "tool_call", subtype: "completed", call_id: "call-2", tool_call: { shellToolCall: { args: { command: "ls missing" }, result: { error: { message: "No such file" } } } }, session_id: sid });

  if (scenario === "crash") { process.stderr.write("boom: internal error\n"); process.exit(3); }

  emit(segment2);
  out({ type: "result", subtype: "success", is_error: false, result: segment2, session_id: sid, duration_ms: 42,
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 10 } });
  process.exit(0);
}
