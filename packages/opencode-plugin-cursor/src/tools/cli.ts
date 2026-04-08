import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { tool } from "@opencode-ai/plugin";

import { parseModelList } from "../lib/models.js";
import { run } from "../lib/process.js";
import {
  formatStreamJsonSummary,
  parseStreamJsonOutput,
} from "../lib/streamJson.js";

export function createCliTools(args: {
  agentBin: string;
  cwd: string;
  repoRoot?: string;
}) {
  return {
    cursor_cli_status: tool({
      description: "Show Cursor CLI authentication/status (agent status).",
      args: {
        timeoutMs: tool.schema
          .number()
          .int()
          .positive()
          .optional()
          .describe("Timeout in ms for the Cursor CLI call (optional)"),
      },
      async execute(toolArgs) {
        const res = await run(args.agentBin, ["status"], {
          cwd: args.cwd,
          timeoutMs: toolArgs.timeoutMs ?? 60_000,
        });
        if (res.code !== 0) {
          throw new Error(
            `Cursor CLI status failed (exit ${res.code}).\n${res.stderr.trim()}`,
          );
        }
        return res.stdout.trim();
      },
    }),

    cursor_cli_models: tool({
      description: "List all models available to Cursor CLI (agent --list-models).",
      args: {
        // Keep args empty for now; future: `raw`, `filter`, etc.
      },
      async execute() {
        const res = await run(args.agentBin, ["--list-models"], {
          cwd: args.cwd,
          timeoutMs: 60_000,
        });
        if (res.code !== 0) {
          const hint =
            res.stderr.includes("Not authenticated") ||
            res.stderr.toLowerCase().includes("login")
              ? "Try: agent login (browser auth) or set CURSOR_API_KEY"
              : "";
          throw new Error(
            `Failed to run Cursor CLI (agent --list-models). ${hint}\n` +
              `stderr: ${res.stderr.trim()}`,
          );
        }

        const models = parseModelList(res.stdout);
        if (models.length === 0) {
          throw new Error("Cursor CLI returned no models. Try running: agent --list-models");
        }

        return JSON.stringify({ models }, null, 2);
      },
    }),

    cursor_cli_run: tool({
      description: "Run Cursor CLI (agent) in --print mode and return the final text.",
      args: {
        prompt: tool.schema.string().describe("Prompt to send to Cursor CLI"),
        mode: tool.schema
          .enum(["ask", "plan", "agent"])
          .optional()
          .describe("Cursor CLI mode (default: ask)"),
        model: tool.schema
          .string()
          .optional()
          .describe("Cursor model ID (optional, e.g. gpt-5.2)"),
        outputFormat: tool.schema
          .enum(["text", "json", "stream-json"])
          .optional()
          .describe(
            "Cursor CLI output format (default: text). Use stream-json to see tool calls and intermediate steps.",
          ),
        force: tool.schema
          .boolean()
          .optional()
          .describe(
            "If true, passes --force. This can enable writes/commands in print mode; use Cursor CLI permissions to constrain.",
          ),
        timeoutMs: tool.schema
          .number()
          .int()
          .positive()
          .optional()
          .describe("Timeout in ms for the Cursor CLI call (optional)"),
      },
      async execute(toolArgs) {
        const mode = toolArgs.mode ?? "ask";
        const outputFormat = toolArgs.outputFormat ?? "text";
        const force = toolArgs.force ?? false;

        const cmdArgs: string[] = ["--print"];

        // Cursor CLI only accepts --mode=ask|plan. "agent" is the default when --mode is omitted.
        if (mode !== "agent") {
          cmdArgs.push("--mode", mode);
        }

        cmdArgs.push("--workspace", args.cwd);
        cmdArgs.push("--output-format", outputFormat);

        if (toolArgs.model) {
          cmdArgs.push("--model", toolArgs.model);
        }

        if (force) {
          cmdArgs.push("--force");
        }

        cmdArgs.push(toolArgs.prompt);

        const res = await run(args.agentBin, cmdArgs, {
          cwd: args.cwd,
          timeoutMs: toolArgs.timeoutMs,
        });
        if (res.code !== 0) {
          throw new Error(
            `Cursor CLI failed (exit ${res.code}).\n` + `stderr: ${res.stderr.trim()}`,
          );
        }

        if (outputFormat === "stream-json") {
          const summary = parseStreamJsonOutput(res.stdout);
          return formatStreamJsonSummary(summary);
        }

        return res.stdout.trim();
      },
    }),

    cursor_cli_patch: tool({
      description: "Run Cursor CLI in an isolated git worktree and return a unified diff patch.",
      args: {
        prompt: tool.schema
          .string()
          .describe("Task prompt. Cursor will apply changes inside a temp worktree."),
        model: tool.schema
          .string()
          .optional()
          .describe("Cursor model ID (optional, e.g. gpt-5.2)"),
        mode: tool.schema
          .enum(["agent", "plan", "ask"])
          .optional()
          .describe("Cursor CLI mode (default: agent)")
          .default("agent"),
        allowDirty: tool.schema
          .boolean()
          .optional()
          .describe(
            "If true, runs even when the main repo has uncommitted changes (not recommended).",
          ),
        keepTemp: tool.schema
          .boolean()
          .optional()
          .describe(
            "If true, do not remove temp worktree directory (for debugging).",
          ),
        timeoutMs: tool.schema
          .number()
          .int()
          .positive()
          .optional()
          .describe("Timeout in ms for the Cursor CLI call (optional)"),
      },
      async execute(toolArgs) {
        if (!args.repoRoot) {
          throw new Error("cursor_cli_patch requires a git repository (no worktree detected).");
        }

        const allowDirty = toolArgs.allowDirty ?? false;
        const keepTemp = toolArgs.keepTemp ?? false;
        const mode = toolArgs.mode ?? "agent";

        // Enforce clean working tree by default for correct patching.
        const status = await run("git", ["status", "--porcelain"], {
          cwd: args.repoRoot,
          timeoutMs: 30_000,
        });

        if (status.code !== 0) {
          throw new Error(
            `git status failed.\n${status.stderr.trim() || status.stdout.trim()}`,
          );
        }

        if (!allowDirty && status.stdout.trim().length > 0) {
          throw new Error(
            "Working tree is not clean. Commit/stash changes (or pass allowDirty=true).",
          );
        }

        const tempBase = await mkdtemp(path.join(tmpdir(), "cursor-opencode-worktree-"));
        const tempDir = tempBase;

        try {
          // Create detached worktree from current HEAD.
          const wtAdd = await run(
            "git",
            ["worktree", "add", "--detach", tempDir, "HEAD"],
            { cwd: args.repoRoot, timeoutMs: 60_000 },
          );

          if (wtAdd.code !== 0) {
            throw new Error(
              `git worktree add failed.\n${wtAdd.stderr.trim() || wtAdd.stdout.trim()}`,
            );
          }

          const cmdArgs: string[] = ["--print", "--force", "--output-format", "stream-json"];
          // Cursor CLI only accepts --mode=ask|plan. "agent" is the default when --mode is omitted.
          if (mode !== "agent") cmdArgs.push("--mode", mode);
          if (toolArgs.model) cmdArgs.push("--model", toolArgs.model);
          cmdArgs.push(toolArgs.prompt);

          const cursorRes = await run(args.agentBin, cmdArgs, {
            cwd: tempDir,
            timeoutMs: toolArgs.timeoutMs,
          });

          if (cursorRes.code !== 0) {
            throw new Error(
              `Cursor CLI failed inside worktree (exit ${cursorRes.code}).\n` +
                `stderr: ${cursorRes.stderr.trim()}`,
            );
          }

          // Include untracked files in diff.
          const addIntent = await run("git", ["add", "-N", "."], {
            cwd: tempDir,
            timeoutMs: 60_000,
          });
          if (addIntent.code !== 0) {
            throw new Error(
              `git add -N failed.\n${addIntent.stderr.trim() || addIntent.stdout.trim()}`,
            );
          }

          const diff = await run("git", ["diff", "--patch", "--binary"], {
            cwd: tempDir,
            timeoutMs: 60_000,
          });

          if (diff.code !== 0) {
            throw new Error(
              `git diff failed.\n${diff.stderr.trim() || diff.stdout.trim()}`,
            );
          }

          const nameStatus = await run("git", ["diff", "--name-status"], {
            cwd: tempDir,
            timeoutMs: 60_000,
          });

          const patchText = diff.stdout.trimEnd();
          const fileSummary = nameStatus.code === 0 ? nameStatus.stdout.trim() : "";

          // Parse stream-json output for structured activity report.
          const parsed = parseStreamJsonOutput(cursorRes.stdout);
          const activityText = formatStreamJsonSummary(parsed);

          if (!patchText) {
            return [
              "<cursor_cli_patch>",
              "<message>Cursor completed, but produced no git diff (no changes).</message>",
              fileSummary ? `<summary>\n${fileSummary}\n</summary>` : "",
              activityText
                ? `<cursor_activity>\n${activityText}\n</cursor_activity>`
                : "",
              cursorRes.stderr.trim()
                ? `<cursor_stderr>\n${cursorRes.stderr.trim()}\n</cursor_stderr>`
                : "",
              "</cursor_cli_patch>",
            ]
              .filter(Boolean)
              .join("\n");
          }

          return [
            "<cursor_cli_patch>",
            fileSummary ? `<summary>\n${fileSummary}\n</summary>` : "",
            activityText
              ? `<cursor_activity>\n${activityText}\n</cursor_activity>`
              : "",
            cursorRes.stderr.trim()
              ? `<cursor_stderr>\n${cursorRes.stderr.trim()}\n</cursor_stderr>`
              : "",
            "<patch>",
            patchText,
            "</patch>",
            "</cursor_cli_patch>",
          ]
            .filter(Boolean)
            .join("\n");
        } finally {
          if (!keepTemp) {
            // Remove worktree entry; may need force due to modifications.
            const rmRes = await run("git", ["worktree", "remove", tempDir], {
              cwd: args.repoRoot,
              timeoutMs: 60_000,
            });
            if (rmRes.code !== 0) {
              await run("git", ["worktree", "remove", "--force", tempDir], {
                cwd: args.repoRoot,
                timeoutMs: 60_000,
              });
            }
            await rm(tempDir, { recursive: true, force: true });
          }
        }
      },
    }),

    cursor_cli_mcp_list: tool({
      description:
        "List MCP servers configured in Cursor CLI (agent mcp list).",
      args: {
        timeoutMs: tool.schema
          .number()
          .int()
          .positive()
          .optional()
          .describe("Timeout in ms (optional)"),
      },
      async execute(toolArgs) {
        const res = await run(args.agentBin, ["mcp", "list"], {
          cwd: args.cwd,
          timeoutMs: toolArgs.timeoutMs ?? 60_000,
        });
        if (res.code !== 0) {
          throw new Error(
            `agent mcp list failed (exit ${res.code}).\n${res.stderr.trim()}`,
          );
        }
        return res.stdout.trim();
      },
    }),

    cursor_cli_mcp_tools: tool({
      description:
        "List tools provided by a specific MCP server in Cursor CLI (agent mcp list-tools <server>).",
      args: {
        serverName: tool.schema
          .string()
          .describe("Name of the MCP server to inspect"),
        timeoutMs: tool.schema
          .number()
          .int()
          .positive()
          .optional()
          .describe("Timeout in ms (optional)"),
      },
      async execute(toolArgs) {
        const res = await run(
          args.agentBin,
          ["mcp", "list-tools", toolArgs.serverName],
          {
            cwd: args.cwd,
            timeoutMs: toolArgs.timeoutMs ?? 60_000,
          },
        );
        if (res.code !== 0) {
          throw new Error(
            `agent mcp list-tools failed (exit ${res.code}).\n${res.stderr.trim()}`,
          );
        }
        return res.stdout.trim();
      },
    }),
  };
}
