import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";

import { CompletionWriter } from "./completionWriter.js";
import type { BridgeConfig } from "./config.js";
import {
  buildPrintArgs,
  classifyCursorFailure,
  CURSOR_CLI_HINT,
  describeFailure,
  listCursorModels,
  normalizeModelId,
  type CursorCliModel,
} from "./cursorCli.js";
import {
  checkRequestSource,
  extractBearerTokens,
  HttpError,
  json,
  makeHostCheck,
  readBody,
  safeEqual,
  sendError,
} from "./http.js";
import { hasTools, wantsUsage, type OpenAiChatCompletionRequest } from "./openai.js";
import { CommandNotFoundError, run, type RunResult } from "./process.js";
import { buildPrompt } from "./prompt.js";
import { CursorStreamParser, type StreamEvent } from "./streamJson.js";
import { describeToolFailure, describeToolStart } from "./toolActivity.js";

export type BridgeServerOptions = {
  version: string;
  config: BridgeConfig;
  /** Request log sink (default: console.log). */
  log?: (line: string) => void;
};

const MODEL_CACHE_TTL_MS = 5 * 60_000;
const MAX_DETAIL_CHARS = 400;

type ResultEvent = Extract<StreamEvent, { type: "result" }>;

function truncate(text: string, max = MAX_DETAIL_CHARS): string {
  const flat = text.trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function decodeHeaderPath(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

export function createBridgeServer(opts: BridgeServerOptions): http.Server {
  const { config } = opts;
  const log = opts.log ?? ((line: string) => console.log(line));
  const hostAllowed = makeHostCheck(config.host, config.allowedHosts);

  let lastRequestedModel: string | undefined;
  let modelCache: { at: number; models: Promise<CursorCliModel[]> } | undefined;

  const authorized = (req: http.IncomingMessage) => {
    const key = config.requiredKey;
    return !key || extractBearerTokens(req).some((token) => safeEqual(token, key));
  };

  const getModels = (): Promise<CursorCliModel[]> => {
    if (!modelCache || Date.now() - modelCache.at > MODEL_CACHE_TTL_MS) {
      const models = listCursorModels({ agentBin: config.agentBin, timeoutMs: 60_000 });
      const entry = { at: Date.now(), models };
      modelCache = entry;
      // Do not cache failures.
      models.catch(() => {
        if (modelCache === entry) modelCache = undefined;
      });
    }
    return modelCache.models;
  };

  const resolveModel = (raw: unknown): string => {
    const requested = normalizeModelId(raw);
    const explicit = requested && requested !== "auto" ? requested : undefined;
    if (explicit) lastRequestedModel = explicit;
    return (
      explicit ??
      (config.strictModel ? lastRequestedModel : undefined) ??
      requested ??
      lastRequestedModel ??
      config.defaultModel
    );
  };

  const resolveWorkspace = async (req: http.IncomingMessage): Promise<string> => {
    const header = req.headers["x-cursor-workspace"];
    const raw = (Array.isArray(header) ? header[0] : header)?.trim();
    if (!raw) return config.workspace;
    const dir = decodeHeaderPath(raw);
    if (!path.isAbsolute(dir)) {
      throw new HttpError(400, "X-Cursor-Workspace must be an absolute path", "invalid_workspace");
    }
    const info = await stat(dir).catch(() => undefined);
    if (!info?.isDirectory()) {
      throw new HttpError(400, `X-Cursor-Workspace is not a directory: ${dir}`, "invalid_workspace");
    }
    return path.resolve(dir);
  };

  const health = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const base = { ok: true, version: opts.version, pid: process.pid };
    // Without a valid key, do not reveal local paths or settings.
    if (!authorized(req)) return json(res, 200, base);
    json(res, 200, {
      ...base,
      workspace: config.workspace,
      mode: config.mode,
      defaultModel: config.defaultModel,
      force: config.force,
      approveMcps: config.approveMcps,
      trust: config.trust,
      strictModel: config.strictModel,
      toolActivity: config.toolActivity,
    });
  };

  const modelObject = (m: CursorCliModel) => ({ id: m.id, object: "model", created: 0, owned_by: "cursor", name: m.name });

  const listModels = async (res: http.ServerResponse) => {
    let models: CursorCliModel[];
    try {
      models = await getModels();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new HttpError(424, `Could not list Cursor models: ${truncate(message)}`, "cursor_cli_error");
    }
    json(res, 200, { object: "list", data: models.map(modelObject) });
  };

  const getModel = async (res: http.ServerResponse, id: string) => {
    const models = await getModels().catch(() => [] as CursorCliModel[]);
    const found = models.find((m) => m.id === id);
    if (!found) throw new HttpError(404, `Unknown model: ${id}`, "model_not_found");
    json(res, 200, modelObject(found));
  };

  const chatCompletions = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const startedAt = Date.now();
    const raw = await readBody(req, config.maxBodyBytes);
    let body: OpenAiChatCompletionRequest;
    try {
      body = raw ? (JSON.parse(raw) as OpenAiChatCompletionRequest) : {};
    } catch {
      throw new HttpError(400, "Request body is not valid JSON", "invalid_json");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new HttpError(400, "Request body must be a JSON object", "invalid_request");
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      throw new HttpError(400, "`messages` must be a non-empty array", "invalid_messages");
    }

    const model = resolveModel(body.model);
    const workspace = await resolveWorkspace(req);
    const stream = body.stream === true;
    const prompt = buildPrompt(body.messages, { clientTools: hasTools(body) });
    const writer = new CompletionWriter(res, {
      stream,
      includeUsage: wantsUsage(body),
      meta: { id: `chatcmpl-${randomUUID().replace(/-/g, "")}`, created: Math.floor(Date.now() / 1000), model },
    });

    const logDone = (outcome: string) =>
      log(
        `POST /v1/chat/completions model=${model} stream=${stream} workspace=${workspace} -> ${outcome} ` +
          `(${((Date.now() - startedAt) / 1000).toFixed(1)}s)`,
      );

    const controller = new AbortController();
    res.once("close", () => {
      if (writer.finished) return;
      writer.close();
      controller.abort();
    });

    const parser = new CursorStreamParser();
    const errors: string[] = [];
    let result: ResultEvent | undefined;
    let reasoningTail = "";
    const reason = (text: string) => {
      // Keep activity lines on their own line inside the reasoning block.
      const prefixed = reasoningTail && !reasoningTail.endsWith("\n") ? `\n${text}` : text;
      reasoningTail = prefixed;
      writer.appendReasoning(prefixed);
    };
    const onEvent = (event: StreamEvent) => {
      switch (event.type) {
        case "text":
          writer.appendText(event.text);
          return;
        case "reasoning":
          reasoningTail = event.text;
          writer.appendReasoning(event.text);
          return;
        case "tool-started":
          if (config.toolActivity === "reasoning") reason(describeToolStart(event));
          return;
        case "tool-completed":
          if (config.toolActivity === "reasoning" && !event.ok) reason(describeToolFailure(event, event.error));
          return;
        case "result":
          result = event;
          return;
        case "error":
          errors.push(event.message);
          return;
        default:
          return;
      }
    };

    let outcome: RunResult;
    try {
      outcome = await run(
        config.agentBin,
        buildPrintArgs({
          mode: config.mode,
          model,
          workspace,
          outputFormat: "stream-json",
          streamPartialOutput: true,
          force: config.force,
          approveMcps: config.approveMcps,
          trust: config.trust,
        }),
        {
          cwd: workspace,
          input: prompt,
          timeoutMs: config.timeoutMs,
          signal: controller.signal,
          collectStdout: false,
          onStdoutLine: (line) => {
            for (const event of parser.line(line)) onEvent(event);
          },
        },
      );
    } catch (err) {
      if (!(err instanceof CommandNotFoundError)) throw err;
      writer.fail(424, `${err.message}. ${CURSOR_CLI_HINT}`, "cursor_cli_not_found");
      logDone("424 cursor_cli_not_found");
      return;
    }

    if (outcome.aborted) {
      logDone("client disconnected");
      return;
    }
    if (outcome.timedOut) {
      writer.fail(424, `Cursor CLI timed out after ${config.timeoutMs} ms`, "cursor_cli_timeout");
      logDone("424 cursor_cli_timeout");
      return;
    }

    const failed = outcome.code !== 0 || errors.length > 0 || result?.isError === true;
    if (!failed) {
      // Older CLIs may only report the final text in the result event.
      if (!writer.text && result?.text) writer.appendText(result.text);
      writer.succeed(result?.usage);
      logDone("200");
      return;
    }

    const detail = [...errors, result?.isError ? result.text : undefined, outcome.stderr, ...parser.noise]
      .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
      .join("\n");
    const failure = describeFailure(classifyCursorFailure(detail), detail, outcome, model);
    writer.fail(failure.status, failure.message, failure.code);
    logDone(`${failure.status} ${failure.code}`);
  };

  return http.createServer(async (req, res) => {
    try {
      const sourceError = checkRequestSource(req, hostAllowed);
      if (sourceError) return sendError(res, 403, sourceError, "forbidden");

      // Parse against a fixed base: the Host header is client-controlled.
      const url = new URL(req.url || "/", "http://bridge.invalid");
      const pathname = url.pathname.replace(/\/+$/, "") || "/";

      if (req.method === "GET" && pathname === "/health") return health(req, res);
      if (!authorized(req)) return sendError(res, 401, "Invalid API key", "invalid_api_key");
      if (req.method === "GET" && pathname === "/v1/models") return await listModels(res);
      if (req.method === "GET" && pathname.startsWith("/v1/models/")) {
        return await getModel(res, decodeURIComponent(pathname.slice("/v1/models/".length)));
      }
      if (req.method === "POST" && pathname === "/v1/chat/completions") return await chatCompletions(req, res);
      sendError(res, 404, `No route for ${req.method} ${pathname}`, "not_found");
    } catch (err) {
      if (err instanceof HttpError) return sendError(res, err.status, err.message, err.code);
      if (err instanceof URIError) return sendError(res, 400, "Malformed URL", "invalid_url");
      const message = err instanceof Error ? err.message : String(err);
      log(`${req.method} ${req.url} -> 500 internal_error: ${message}`);
      sendError(res, 500, message, "internal_error");
    }
  });
}

/** Create the server and start listening (logs a short banner once bound). */
export function startBridgeServer(opts: BridgeServerOptions): http.Server {
  const { config } = opts;
  const server = createBridgeServer(opts);
  server.listen(config.port, config.host, () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : config.port;
    const lines = [
      `cursor-openai-bridge ${opts.version} listening on http://${config.host}:${port}/v1`,
      `- agent bin: ${config.agentBin}`,
      `- workspace: ${config.workspace} (override per request with X-Cursor-Workspace)`,
      `- mode: ${config.mode}  force: ${config.force}  approve mcps: ${config.approveMcps}  trust: ${config.trust}`,
      `- default model: ${config.defaultModel}  strict model: ${config.strictModel}`,
      `- api key required: ${config.requiredKey ? "yes" : "no"}`,
      "",
      "Note: Cursor CLI is a full coding agent, not a bare model. Requests run Cursor's own",
      "agent loop; its tool use is reported as reasoning, and OpenCode's tools are not called.",
    ];
    console.log(lines.join("\n"));
  });
  return server;
}
