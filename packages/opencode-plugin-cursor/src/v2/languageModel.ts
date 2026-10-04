import {
  APICallError,
  type LanguageModelV3,
  type LanguageModelV3CallOptions,
  type LanguageModelV3Content,
  type LanguageModelV3GenerateResult,
  type LanguageModelV3StreamPart,
  type LanguageModelV3StreamResult,
  type LanguageModelV3Usage,
} from "@ai-sdk/provider";
import {
  buildPrintArgs,
  classifyCursorFailure,
  CommandNotFoundError,
  CURSOR_CLI_HINT,
  CursorStreamParser,
  describeFailure,
  describeToolFailure,
  describeToolStart,
  resolveAgentBin,
  run,
  type CursorExecutionMode,
  type CursorUsage,
  type FailureResponse,
  type RunResult,
  type StreamEvent,
} from "cursor-openai-bridge";

import { promptFromV3 } from "./prompt.js";

export type CursorModelSettings = {
  agentBin: string;
  /** Directory Cursor works in (the OpenCode location's directory). */
  workspace: string;
  mode: CursorExecutionMode;
  force: boolean;
  approveMcps: boolean;
  trust: boolean;
  /** 0 disables the timeout. */
  timeoutMs: number;
  toolActivity: "reasoning" | "off";
};

// Failures that happen this early (no login, unknown model, usage limit) reject
// doStream itself, so OpenCode reports them as request errors.
const EARLY_FAILURE_GRACE_MS = 3_000;

const pick = <T>(value: unknown, guard: (v: unknown) => v is T, fallback: T): T => (guard(value) ? value : fallback);
const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isMode = (v: unknown): v is CursorExecutionMode => v === "ask" || v === "plan" || v === "agent";
const isTimeout = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** Read model settings from the provider options OpenCode passes to the SDK factory. */
export function readModelSettings(options: Record<string, unknown>): CursorModelSettings {
  return {
    agentBin: pick(options.agentBin, isString, resolveAgentBin()),
    workspace: pick(options.workspace, isString, process.cwd()),
    mode: pick(options.mode, isMode, "ask"),
    force: pick(options.force, isBool, false),
    approveMcps: pick(options.approveMcps, isBool, false),
    trust: pick(options.trust, isBool, true),
    timeoutMs: pick(options.timeoutMs, isTimeout, 300_000),
    toolActivity: options.toolActivity === "off" ? "off" : "reasoning",
  };
}

export function toV3Usage(usage: CursorUsage | undefined): LanguageModelV3Usage {
  return {
    inputTokens: {
      total: usage ? usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens : undefined,
      noCache: usage?.inputTokens,
      cacheRead: usage?.cacheReadTokens,
      cacheWrite: usage?.cacheWriteTokens,
    },
    outputTokens: { total: usage?.outputTokens, text: undefined, reasoning: undefined },
  };
}

/** OpenCode keeps the HTTP status semantics of APICallError, so 4xx failures are not retried. */
function apiError(failure: FailureResponse, model: string): APICallError {
  const body = { error: { message: failure.message, code: failure.code } };
  return new APICallError({
    message: failure.message,
    url: `cursor-cli://agent/${model}`,
    requestBodyValues: {},
    statusCode: failure.status,
    responseBody: JSON.stringify(body),
    data: body,
    isRetryable: failure.code === "rate_limit_exceeded",
  });
}

function abortError(): Error {
  const error = new Error("The Cursor request was aborted");
  error.name = "AbortError";
  return error;
}

type Fragment = { type: "text" | "reasoning"; id: string };

/** An AI SDK language model that runs Cursor CLI headlessly for every call. */
export class CursorLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3";
  readonly provider = "cursor";
  readonly supportedUrls: Record<string, RegExp[]> = {};

  constructor(
    readonly modelId: string,
    private readonly settings: CursorModelSettings,
  ) {}

  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const { stream } = await this.doStream(options);
    let text = "";
    let reasoning = "";
    let finish: Extract<LanguageModelV3StreamPart, { type: "finish" }> | undefined;
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.type === "text-delta") text += value.delta;
      else if (value.type === "reasoning-delta") reasoning += value.delta;
      else if (value.type === "finish") finish = value;
      else if (value.type === "error") throw value.error;
    }
    const content: LanguageModelV3Content[] = [];
    if (reasoning) content.push({ type: "reasoning", text: reasoning });
    if (text) content.push({ type: "text", text });
    return {
      content,
      finishReason: finish?.finishReason ?? { unified: "stop", raw: "stop" },
      usage: finish?.usage ?? toV3Usage(undefined),
      warnings: [],
    };
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const s = this.settings;
    const model = this.modelId;
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    if (options.abortSignal?.aborted) throw abortError();
    options.abortSignal?.addEventListener("abort", onAbort, { once: true });

    let controller!: ReadableStreamDefaultController<LanguageModelV3StreamPart>;
    let closed = false;
    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start: (c) => {
        controller = c;
      },
      cancel: () => {
        closed = true;
        abort.abort();
      },
    });
    const emit = (part: LanguageModelV3StreamPart) => {
      if (!closed) controller.enqueue(part);
    };
    const end = () => {
      if (closed) return;
      closed = true;
      controller.close();
    };
    // Queued now so they precede any output that arrives while doStream waits for early failures.
    emit({ type: "stream-start", warnings: [] });
    emit({ type: "response-metadata", modelId: model });

    let produced = false;
    let markReady: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => (markReady = resolve));
    let seq = 0;
    let current: Fragment | undefined;
    let reasoningTail = "";

    const closeFragment = () => {
      if (!current) return;
      emit(current.type === "text" ? { type: "text-end", id: current.id } : { type: "reasoning-end", id: current.id });
      current = undefined;
    };
    const append = (type: Fragment["type"], delta: string) => {
      if (!delta) return;
      if (current?.type !== type) {
        closeFragment();
        current = { type, id: `${type}-${seq++}` };
        emit(type === "text" ? { type: "text-start", id: current.id } : { type: "reasoning-start", id: current.id });
      }
      emit(
        type === "text"
          ? { type: "text-delta", id: current.id, delta }
          : { type: "reasoning-delta", id: current.id, delta },
      );
      if (type === "reasoning") reasoningTail = delta;
      produced = true;
      markReady();
    };
    const activity = (line: string) => {
      const continuing = current?.type === "reasoning" && reasoningTail && !reasoningTail.endsWith("\n");
      append("reasoning", continuing ? `\n${line}` : line);
    };

    const parser = new CursorStreamParser();
    const errors: string[] = [];
    let result: Extract<StreamEvent, { type: "result" }> | undefined;
    const onEvent = (event: StreamEvent) => {
      switch (event.type) {
        case "text":
          append("text", event.text);
          return;
        case "reasoning":
          append("reasoning", event.text);
          return;
        case "tool-started":
          if (s.toolActivity === "reasoning") activity(describeToolStart(event));
          return;
        case "tool-completed":
          if (s.toolActivity === "reasoning" && !event.ok) activity(describeToolFailure(event, event.error));
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

    const failureOf = (outcome: RunResult): APICallError | undefined => {
      if (outcome.timedOut) {
        return apiError(
          { status: 424, code: "cursor_cli_timeout", message: `Cursor CLI timed out after ${s.timeoutMs} ms` },
          model,
        );
      }
      if (outcome.code === 0 && errors.length === 0 && result?.isError !== true) return undefined;
      const detail = [...errors, result?.isError ? result.text : undefined, outcome.stderr, ...parser.noise]
        .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
        .join("\n");
      return apiError(describeFailure(classifyCursorFailure(detail), detail, outcome, model), model);
    };

    const finished: Promise<{ outcome: RunResult } | { error: unknown }> = run(
      s.agentBin,
      buildPrintArgs({
        mode: s.mode,
        model,
        workspace: s.workspace,
        outputFormat: "stream-json",
        streamPartialOutput: true,
        force: s.force,
        approveMcps: s.approveMcps,
        trust: s.trust,
      }),
      {
        cwd: s.workspace,
        input: promptFromV3(options.prompt, { clientTools: (options.tools?.length ?? 0) > 0 }),
        timeoutMs: s.timeoutMs,
        signal: abort.signal,
        collectStdout: false,
        onStdoutLine: (line) => {
          for (const event of parser.line(line)) onEvent(event);
        },
      },
    ).then(
      (outcome) => ({ outcome }),
      (error: unknown) => ({ error }),
    );

    const settled = await Promise.race([
      ready.then(() => undefined),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), EARLY_FAILURE_GRACE_MS).unref?.()),
      finished,
    ]);

    const failureFor = (value: { outcome: RunResult } | { error: unknown }): unknown => {
      if ("error" in value) {
        if (value.error instanceof CommandNotFoundError) {
          return apiError(
            { status: 424, code: "cursor_cli_not_found", message: `${value.error.message}. ${CURSOR_CLI_HINT}` },
            model,
          );
        }
        return value.error;
      }
      if (value.outcome.aborted) return abortError();
      return failureOf(value.outcome);
    };

    if (settled && !produced) {
      const failure = failureFor(settled);
      if (failure) {
        closed = true;
        options.abortSignal?.removeEventListener("abort", onAbort);
        throw failure;
      }
    }

    void finished.then((value) => {
      options.abortSignal?.removeEventListener("abort", onAbort);
      if (closed) return;
      if ("outcome" in value && value.outcome.aborted) {
        end();
        return;
      }
      const failure = failureFor(value);
      closeFragment();
      if (failure) {
        emit({ type: "error", error: failure });
        end();
        return;
      }
      // Older CLIs may only report the final text in the result event.
      if (!parser.text && result?.text) {
        append("text", result.text);
        closeFragment();
      }
      emit({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: toV3Usage(result?.usage) });
      end();
    });
    return { stream };
  }
}
