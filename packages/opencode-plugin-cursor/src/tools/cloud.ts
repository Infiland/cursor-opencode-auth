import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";

import { tool, type ToolContext } from "@opencode-ai/plugin";

import { cursorApiRequest } from "../lib/cursorApi.js";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const pretty = (value: unknown) => JSON.stringify(value, null, 2);
const agentId = () => tool.schema.string().describe("Agent id (e.g. bc_abc123)");

function isImage(buf: Uint8Array): boolean {
  const ascii = (start: number, end: number) => Buffer.from(buf.subarray(start, end)).toString("latin1");
  return (
    (buf[0] === 0x89 && ascii(1, 4) === "PNG") ||
    (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) ||
    ascii(0, 4) === "GIF8" ||
    (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP")
  );
}

/** Read an image for upload, refusing anything that is not actually an image. */
async function readImage(file: string): Promise<string> {
  const info = await stat(file);
  if (!info.isFile()) throw new Error(`Not a file: ${file}`);
  if (info.size > MAX_IMAGE_BYTES) throw new Error(`Image is larger than ${MAX_IMAGE_BYTES} bytes: ${file}`);
  const buf = await readFile(file);
  if (!isImage(buf)) throw new Error(`Only PNG, JPEG, GIF and WebP images can be attached: ${file}`);
  return buf.toString("base64");
}

function directoryOf(context: ToolContext, fallback: string): string {
  const dir = (context as { directory?: unknown }).directory;
  return typeof dir === "string" && dir ? dir : fallback;
}

export function createCloudTools(args: { cwd: string }) {
  return {
    cursor_cloud_models: tool({
      description: "List recommended models for Cursor Cloud Agents (GET /v0/models). Requires CURSOR_API_KEY.",
      args: {},
      async execute(_toolArgs, context) {
        return pretty(await cursorApiRequest({ method: "GET", path: "/v0/models", signal: context.abort }));
      },
    }),

    cursor_cloud_launch_agent: tool({
      description:
        "Launch a Cursor Cloud Agent on a GitHub repository or PR (POST /v0/agents). The agent runs remotely " +
        "and executes commands there. Returns the agent id and URLs.",
      args: {
        prompt: tool.schema.string().describe("Agent prompt text"),
        images: tool.schema
          .array(
            tool.schema.object({
              path: tool.schema.string().optional(),
              data: tool.schema.string().optional(),
              width: tool.schema.number().int().positive().optional(),
              height: tool.schema.number().int().positive().optional(),
            }),
          )
          .optional()
          .describe("Optional images: {data: base64} or {path: ./screenshot.png} (PNG/JPEG/GIF/WebP)."),
        model: tool.schema.string().optional().describe("Model name (optional; Cursor picks one otherwise)"),
        repository: tool.schema
          .string()
          .optional()
          .describe("Repository URL, e.g. https://github.com/org/repo (required unless prUrl is set)"),
        ref: tool.schema.string().optional().describe("Git ref (branch/tag/sha), e.g. main"),
        prUrl: tool.schema.string().optional().describe("GitHub PR URL (if set, repository/ref are ignored)"),
        target: tool.schema
          .object({
            autoCreatePr: tool.schema.boolean().optional(),
            openAsCursorGithubApp: tool.schema.boolean().optional(),
            skipReviewerRequest: tool.schema.boolean().optional(),
            branchName: tool.schema.string().optional(),
            autoBranch: tool.schema.boolean().optional(),
          })
          .optional()
          .describe("Optional target options"),
        webhook: tool.schema
          .object({ url: tool.schema.string(), secret: tool.schema.string().optional() })
          .optional()
          .describe("Optional webhook config"),
      },
      async execute(toolArgs, context) {
        const cwd = directoryOf(context, args.cwd);
        const images = toolArgs.images
          ? await Promise.all(
              toolArgs.images.map(async (img) => {
                const dimension = img.width && img.height ? { width: img.width, height: img.height } : undefined;
                if (img.data) return { data: img.data, dimension };
                if (!img.path) throw new Error("Each image must include either data (base64) or path.");
                return { data: await readImage(path.resolve(cwd, img.path)), dimension };
              }),
            )
          : undefined;

        let source: Record<string, string>;
        if (toolArgs.prUrl) source = { prUrl: toolArgs.prUrl };
        else if (toolArgs.repository) {
          source = { repository: toolArgs.repository, ...(toolArgs.ref ? { ref: toolArgs.ref } : {}) };
        } else throw new Error("repository is required unless prUrl is provided");

        const body = {
          prompt: { text: toolArgs.prompt, ...(images ? { images } : {}) },
          source,
          ...(toolArgs.model ? { model: toolArgs.model } : {}),
          ...(toolArgs.target ? { target: toolArgs.target } : {}),
          ...(toolArgs.webhook ? { webhook: toolArgs.webhook } : {}),
        };
        return pretty(
          await cursorApiRequest({ method: "POST", path: "/v0/agents", body, timeoutMs: 120_000, signal: context.abort }),
        );
      },
    }),

    cursor_cloud_agent: tool({
      description: "Get a Cursor Cloud Agent's status (GET /v0/agents/{id}).",
      args: { id: agentId() },
      async execute(toolArgs, context) {
        return pretty(
          await cursorApiRequest({
            method: "GET",
            path: `/v0/agents/${encodeURIComponent(toolArgs.id)}`,
            signal: context.abort,
          }),
        );
      },
    }),

    cursor_cloud_conversation: tool({
      description: "Fetch a Cursor Cloud Agent's conversation (GET /v0/agents/{id}/conversation).",
      args: { id: agentId() },
      async execute(toolArgs, context) {
        return pretty(
          await cursorApiRequest({
            method: "GET",
            path: `/v0/agents/${encodeURIComponent(toolArgs.id)}/conversation`,
            signal: context.abort,
          }),
        );
      },
    }),

    cursor_cloud_followup: tool({
      description: "Send a follow-up instruction to a Cursor Cloud Agent (POST /v0/agents/{id}/followup).",
      args: { id: agentId(), prompt: tool.schema.string().describe("Follow-up prompt text") },
      async execute(toolArgs, context) {
        return pretty(
          await cursorApiRequest({
            method: "POST",
            path: `/v0/agents/${encodeURIComponent(toolArgs.id)}/followup`,
            body: { prompt: { text: toolArgs.prompt } },
            signal: context.abort,
          }),
        );
      },
    }),

    cursor_cloud_stop: tool({
      description: "Stop a running Cursor Cloud Agent (POST /v0/agents/{id}/stop).",
      args: { id: agentId() },
      async execute(toolArgs, context) {
        return pretty(
          await cursorApiRequest({
            method: "POST",
            path: `/v0/agents/${encodeURIComponent(toolArgs.id)}/stop`,
            signal: context.abort,
          }),
        );
      },
    }),

    cursor_cloud_delete: tool({
      description: "Permanently delete a Cursor Cloud Agent (DELETE /v0/agents/{id}).",
      args: { id: agentId() },
      async execute(toolArgs, context) {
        return pretty(
          await cursorApiRequest({
            method: "DELETE",
            path: `/v0/agents/${encodeURIComponent(toolArgs.id)}`,
            signal: context.abort,
          }),
        );
      },
    }),

    cursor_cloud_me: tool({
      description: "Show information about the configured Cursor API key (GET /v0/me).",
      args: {},
      async execute(_toolArgs, context) {
        return pretty(await cursorApiRequest({ method: "GET", path: "/v0/me", signal: context.abort }));
      },
    }),

    cursor_cloud_agents: tool({
      description: "List Cursor Cloud Agents (GET /v0/agents).",
      args: {
        limit: tool.schema.number().int().positive().max(100).optional().describe("Max results (default 20, max 100)"),
        cursor: tool.schema.string().optional().describe("Pagination cursor from a previous response"),
        prUrl: tool.schema.string().optional().describe("Only agents for this PR URL"),
      },
      async execute(toolArgs, context) {
        const params = new URLSearchParams();
        if (toolArgs.limit) params.set("limit", String(toolArgs.limit));
        if (toolArgs.cursor) params.set("cursor", toolArgs.cursor);
        if (toolArgs.prUrl) params.set("prUrl", toolArgs.prUrl);
        const query = params.toString();
        return pretty(
          await cursorApiRequest({ method: "GET", path: `/v0/agents${query ? `?${query}` : ""}`, signal: context.abort }),
        );
      },
    }),

    cursor_cloud_repositories: tool({
      description: "List GitHub repositories available to Cursor Cloud Agents (GET /v0/repositories). Strictly rate limited.",
      args: {},
      async execute(_toolArgs, context) {
        return pretty(
          await cursorApiRequest({ method: "GET", path: "/v0/repositories", timeoutMs: 120_000, signal: context.abort }),
        );
      },
    }),
  };
}
