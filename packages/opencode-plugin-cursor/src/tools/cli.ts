import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { tool, type ToolContext } from "@opencode-ai/plugin";
import {
  buildPrintArgs,
  classifyCursorFailure,
  CommandNotFoundError,
  CURSOR_CLI_HINT,
  describeExit,
  run,
  succeeded,
  type RunResult,
} from "cursor-openai-bridge";

import { git, snapshotWorkingTree } from "../lib/git.js";
import { discoverModels } from "../lib/models.js";
import { formatRunSummary, summarizeStreamJson } from "../lib/streamJson.js";

type CliToolsArgs = {
  agentBin: string;
  /** Project directory OpenCode was opened in. */
  cwd: string;
  /** Root of the git worktree, when the project is a git repository. */
  repoRoot?: string;
};

const timeoutArg = () =>
  tool.schema.number().int().positive().optional().describe("Timeout in ms for the Cursor CLI call (optional)");

function failureHint(output: string): string {
  switch (classifyCursorFailure(output)) {
    case "auth":
      return "\nHint: authenticate with `agent login` or set CURSOR_API_KEY.";
    case "usage_limit":
      return "\nHint: your Cursor usage limit is reached; try another model or wait for the limit to reset.";
    case "model":
      return "\nHint: list valid model IDs with cursor_cli_models.";
    default:
      return "";
  }
}

async function runCursor(agentBin: string, args: string[], opts: Parameters<typeof run>[2]): Promise<RunResult> {
  try {
    return await run(agentBin, args, opts);
  } catch (err) {
    if (err instanceof CommandNotFoundError) throw new Error(`${err.message}. ${CURSOR_CLI_HINT}`);
    throw err;
  }
}

function ensureSucceeded(label: string, result: RunResult) {
  if (succeeded(result)) return;
  if (result.aborted) throw new Error(`${label} was cancelled.`);
  const output = (result.stderr || result.stdout).trim();
  throw new Error(`${label} ${describeExit(result)}.${output ? `\n${output}` : ""}${failureHint(output)}`);
}

function directoryOf(context: ToolContext, fallback: string): string {
  // Newer OpenCode versions pass the session directory on the tool context.
  const dir = (context as { directory?: unknown }).directory;
  return typeof dir === "string" && dir ? dir : fallback;
}

export function createCliTools(args: CliToolsArgs) {
  return {
    cursor_cli_status: tool({
      description: "Show Cursor CLI authentication status (agent status).",
      args: { timeoutMs: timeoutArg() },
      async execute(toolArgs, context) {
        const res = await runCursor(args.agentBin, ["status"], {
          cwd: directoryOf(context, args.cwd),
          timeoutMs: toolArgs.timeoutMs ?? 60_000,
          signal: context.abort,
        });
        ensureSucceeded("agent status", res);
        return res.stdout.trim();
      },
    }),

    cursor_cli_models: tool({
      description: "List the model IDs Cursor CLI can use (agent --list-models).",
      args: {
        refresh: tool.schema.boolean().optional().describe("Bypass the short-lived model cache"),
      },
      async execute(toolArgs) {
        try {
          const models = await discoverModels(args.agentBin, { force: toolArgs.refresh ?? false });
          return JSON.stringify(
            {
              models: models.map((m) => ({
                id: m.id,
                name: m.name,
                ...(m.isDefault ? { default: true } : {}),
                ...(m.isCurrent ? { current: true } : {}),
              })),
            },
            null,
            2,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(`Could not list Cursor models: ${message}${failureHint(message)}`);
        }
      },
    }),

    cursor_cli_run: tool({
      description:
        "Run Cursor CLI (agent) headlessly with a prompt and return its answer. Defaults to read-only ask mode.",
      args: {
        prompt: tool.schema.string().describe("Prompt to send to Cursor CLI"),
        mode: tool.schema.enum(["ask", "plan", "agent"]).optional().describe("Cursor CLI mode (default: ask)"),
        model: tool.schema.string().optional().describe("Cursor model ID (optional, e.g. gpt-5.2)"),
        outputFormat: tool.schema
          .enum(["text", "json", "stream-json"])
          .optional()
          .describe("Output format (default: text). stream-json adds a summary of Cursor's tool calls."),
        force: tool.schema
          .boolean()
          .optional()
          .describe("Pass --force so Cursor may edit files and run commands without asking. Use with care."),
        timeoutMs: timeoutArg(),
      },
      async execute(toolArgs, context) {
        const mode = toolArgs.mode ?? "ask";
        const outputFormat = toolArgs.outputFormat ?? "text";
        const cwd = directoryOf(context, args.cwd);
        context.metadata({ title: `Cursor ${mode}${toolArgs.model ? ` (${toolArgs.model})` : ""}` });
        const res = await runCursor(
          args.agentBin,
          buildPrintArgs({
            mode,
            model: toolArgs.model,
            workspace: cwd,
            outputFormat,
            force: toolArgs.force ?? false,
            trust: true,
          }),
          { cwd, input: toolArgs.prompt, timeoutMs: toolArgs.timeoutMs, signal: context.abort },
        );
        ensureSucceeded("Cursor CLI", res);
        if (outputFormat === "stream-json") return formatRunSummary(summarizeStreamJson(res.stdout));
        return res.stdout.trim();
      },
    }),

    cursor_cli_patch: tool({
      description:
        "Run Cursor CLI in an isolated git worktree and return its changes as a unified diff (inside <patch>). " +
        "Your working tree is not modified unless apply is true.",
      args: {
        prompt: tool.schema.string().describe("Task prompt. Cursor applies changes inside a temporary worktree."),
        model: tool.schema.string().optional().describe("Cursor model ID (optional, e.g. gpt-5.2)"),
        mode: tool.schema
          .enum(["agent", "plan", "ask"])
          .optional()
          .describe("Cursor CLI mode (default: agent; ask/plan cannot edit files)"),
        allowDirty: tool.schema
          .boolean()
          .optional()
          .describe(
            "Run even with uncommitted changes. Cursor then works on a snapshot of your current files " +
              "(including untracked ones), so the patch applies on top of them.",
          ),
        apply: tool.schema
          .boolean()
          .optional()
          .describe("Apply the resulting patch to your working tree with `git apply` (default: false)."),
        keepTemp: tool.schema.boolean().optional().describe("Keep the temporary worktree for debugging"),
        timeoutMs: timeoutArg(),
      },
      async execute(toolArgs, context) {
        const repoRoot = args.repoRoot;
        if (!repoRoot) throw new Error("cursor_cli_patch requires a git repository (no worktree detected).");
        const signal = context.abort;
        const mode = toolArgs.mode ?? "agent";

        const status = await git(["status", "--porcelain"], repoRoot, { signal });
        const dirty = status.trim().length > 0;
        if (dirty && !toolArgs.allowDirty) {
          throw new Error(
            "The working tree has uncommitted changes. Commit or stash them, or pass allowDirty: true " +
              "to let Cursor work on a snapshot of your current files.",
          );
        }

        const scratch = await mkdtemp(path.join(tmpdir(), "cursor-opencode-patch-"));
        const worktree = path.join(scratch, "worktree");
        let added = false;
        try {
          const base = dirty ? await snapshotWorkingTree(repoRoot, scratch, signal) : "HEAD";
          await git(["worktree", "add", "--detach", worktree, base], repoRoot, { signal });
          added = true;

          context.metadata({ title: `Cursor patch (${mode})` });
          const cursorRes = await runCursor(
            args.agentBin,
            buildPrintArgs({
              mode,
              model: toolArgs.model,
              workspace: worktree,
              outputFormat: "stream-json",
              force: true,
              trust: true,
            }),
            { cwd: worktree, input: toolArgs.prompt, timeoutMs: toolArgs.timeoutMs, signal },
          );
          ensureSucceeded("Cursor CLI (in temporary worktree)", cursorRes);

          await git(["add", "-A"], worktree, { signal });
          const diffArgs = ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/"];
          const patch = (await git([...diffArgs, "--binary"], worktree, { signal })).trimEnd();
          const files = (await git([...diffArgs, "--name-status"], worktree, { signal })).trim();

          const activity = formatRunSummary(summarizeStreamJson(cursorRes.stdout));
          const stderr = cursorRes.stderr.trim();
          const parts = ["<cursor_cli_patch>"];
          if (!patch) parts.push("<message>Cursor completed, but produced no changes.</message>");
          if (files) parts.push(`<summary>\n${files}\n</summary>`);
          if (activity) parts.push(`<cursor_activity>\n${activity}\n</cursor_activity>`);
          if (stderr) parts.push(`<cursor_stderr>\n${stderr}\n</cursor_stderr>`);
          if (patch) {
            if (toolArgs.apply) {
              await git(["apply", "--whitespace=nowarn", "-"], repoRoot, { input: `${patch}\n`, signal });
              parts.push("<applied>The patch was applied to your working tree.</applied>");
            }
            parts.push("<patch>", patch, "</patch>");
          }
          if (toolArgs.keepTemp) parts.push(`<worktree>${worktree}</worktree>`);
          parts.push("</cursor_cli_patch>");
          return parts.join("\n");
        } finally {
          if (!toolArgs.keepTemp) {
            if (added) {
              await git(["worktree", "remove", "--force", worktree], repoRoot).catch(() => undefined);
            }
            await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
            await git(["worktree", "prune"], repoRoot).catch(() => undefined);
          }
        }
      },
    }),

    cursor_cli_mcp_list: tool({
      description: "List MCP servers configured in Cursor CLI (agent mcp list).",
      args: { timeoutMs: timeoutArg() },
      async execute(toolArgs, context) {
        const res = await runCursor(args.agentBin, ["mcp", "list"], {
          cwd: directoryOf(context, args.cwd),
          timeoutMs: toolArgs.timeoutMs ?? 60_000,
          signal: context.abort,
        });
        ensureSucceeded("agent mcp list", res);
        return res.stdout.trim();
      },
    }),

    cursor_cli_mcp_tools: tool({
      description: "List tools provided by an MCP server configured in Cursor CLI (agent mcp list-tools <server>).",
      args: {
        serverName: tool.schema.string().describe("Name of the MCP server to inspect"),
        timeoutMs: timeoutArg(),
      },
      async execute(toolArgs, context) {
        const res = await runCursor(args.agentBin, ["mcp", "list-tools", toolArgs.serverName], {
          cwd: directoryOf(context, args.cwd),
          timeoutMs: toolArgs.timeoutMs ?? 60_000,
          signal: context.abort,
        });
        ensureSucceeded("agent mcp list-tools", res);
        return res.stdout.trim();
      },
    }),
  };
}
