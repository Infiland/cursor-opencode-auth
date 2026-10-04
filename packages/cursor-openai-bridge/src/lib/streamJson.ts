/**
 * Incremental interpreter for Cursor CLI `--output-format stream-json` NDJSON.
 *
 * Event shapes handled (unknown events are ignored for forward compatibility):
 *   system/init                       session metadata
 *   user                              echo of the prompt (ignored)
 *   thinking (subtype delta|completed) reasoning trace fragments
 *   assistant                         model text, see below
 *   tool_call (started|completed|failed) Cursor's own tool invocations
 *   result                            terminal event with final text and usage
 *   error                             fatal error reported in-stream
 *
 * With `--stream-partial-output`, assistant events come in three flavours:
 * a new-text delta has `timestamp_ms` and no `model_call_id`; a buffered
 * duplicate of already-streamed text has both; the final flush of a message
 * has neither (which is also the only shape emitted without the flag).
 */

export type CursorUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type CursorToolCall = {
  callId: string;
  name: string;
  args: Record<string, unknown>;
};

export type StreamEvent =
  | { type: "init"; sessionId?: string; model?: string; cwd?: string }
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | ({ type: "tool-started" } & CursorToolCall)
  | ({ type: "tool-completed"; ok: boolean; error?: string; result?: unknown } & CursorToolCall)
  | {
      type: "result";
      isError: boolean;
      subtype?: string;
      text?: string;
      usage?: CursorUsage;
      durationMs?: number;
    }
  | { type: "error"; message: string };

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const part of content) {
    if (isRecord(part) && part.type === "text" && typeof part.text === "string") text += part.text;
  }
  return text;
}

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function parseUsage(raw: unknown): CursorUsage | undefined {
  if (!isRecord(raw)) return undefined;
  const usage: CursorUsage = {
    inputTokens: nonNegative(raw.inputTokens ?? raw.input_tokens),
    outputTokens: nonNegative(raw.outputTokens ?? raw.output_tokens),
    cacheReadTokens: nonNegative(raw.cacheReadTokens ?? raw.cache_read_tokens),
    cacheWriteTokens: nonNegative(raw.cacheWriteTokens ?? raw.cache_write_tokens),
  };
  const total = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  return total > 0 ? usage : undefined;
}

function parseArgs(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (isRecord(parsed)) return parsed;
    } catch {
      // not JSON
    }
    return { arguments: value };
  }
  return {};
}

/**
 * Cursor keys tool payloads by variant (`readToolCall`, `shellToolCall`, ...);
 * MCP and other generic tools use `function`/`functionCall` with a `name`.
 */
export function describeToolCall(toolCall: unknown): { name: string; args: Record<string, unknown>; result?: unknown } {
  if (!isRecord(toolCall)) return { name: "tool", args: {} };
  const keys = Object.keys(toolCall);
  const variantKey = keys.find((key) => /toolcall$/i.test(key));
  if (variantKey) {
    const inner = toolCall[variantKey];
    const name = variantKey.replace(/toolcall$/i, "") || variantKey;
    if (!isRecord(inner)) return { name, args: {} };
    return { name, args: parseArgs(inner.args), result: inner.result };
  }
  const fnKey = keys.find((key) => key === "function" || key === "functionCall");
  if (fnKey && isRecord(toolCall[fnKey])) {
    const inner = toolCall[fnKey] as Json;
    return {
      name: str(inner.name) ?? fnKey,
      args: parseArgs(inner.arguments ?? inner.args),
      result: inner.result,
    };
  }
  const first = keys[0];
  if (!first) return { name: "tool", args: {} };
  const inner = toolCall[first];
  return isRecord(inner)
    ? { name: first, args: parseArgs(inner.args ?? {}), result: inner.result }
    : { name: first, args: {} };
}

function toolFailure(result: unknown, subtype: string): string | undefined {
  if (isRecord(result)) {
    const error = result.error;
    if (typeof error === "string" && error) return error;
    if (isRecord(error)) return str(error.message) ?? "error";
    if (result.rejected) return "rejected";
    if (result.permissionDenied) return "permission denied";
    const failure = result.failure;
    if (isRecord(failure)) {
      return str(failure.error) ?? (typeof failure.exitCode === "number" ? `exit code ${failure.exitCode}` : "failed");
    }
  }
  return subtype === "failed" ? "failed" : undefined;
}

export class CursorStreamParser {
  private partial = "";
  // Assistant delta text received since the last complete message.
  private streamed = "";
  private emittedTail = "";
  private breakPending = false;
  private readonly tools = new Map<string, CursorToolCall>();
  /** Lines that were not JSON (banners, plain-text errors), kept for diagnostics. */
  readonly noise: string[] = [];
  /** All assistant text emitted so far. */
  text = "";

  /** Feed raw stdout; handles lines split across chunks. */
  push(chunk: string): StreamEvent[] {
    this.partial += chunk;
    const events: StreamEvent[] = [];
    let newline = this.partial.indexOf("\n");
    while (newline !== -1) {
      events.push(...this.line(this.partial.slice(0, newline)));
      this.partial = this.partial.slice(newline + 1);
      newline = this.partial.indexOf("\n");
    }
    return events;
  }

  /** Flush a trailing line that had no newline. */
  end(): StreamEvent[] {
    const rest = this.partial;
    this.partial = "";
    return rest ? this.line(rest) : [];
  }

  /** Feed one complete NDJSON line. */
  line(raw: string): StreamEvent[] {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      if (this.noise.length < 20) this.noise.push(trimmed.slice(0, 500));
      return [];
    }
    if (!isRecord(event) || typeof event.type !== "string") return [];

    switch (event.type) {
      case "system":
        if (event.subtype !== "init") return [];
        return [
          {
            type: "init",
            sessionId: str(event.session_id) ?? str(event.chatId) ?? str(event.chat_id),
            model: str(event.model),
            cwd: str(event.cwd),
          },
        ];
      case "assistant":
        return this.assistant(event);
      case "thinking":
      case "reasoning": {
        if (event.subtype !== undefined && event.subtype !== "delta") return [];
        const text = typeof event.text === "string" ? event.text : contentText((event.message as Json)?.content);
        return text ? [{ type: "reasoning", text }] : [];
      }
      case "tool_call":
        return this.toolCall(event);
      case "result":
        return [
          {
            type: "result",
            isError: event.is_error === true || (typeof event.subtype === "string" && event.subtype !== "success"),
            subtype: str(event.subtype),
            text: typeof event.result === "string" ? event.result : undefined,
            usage: parseUsage(event.usage),
            durationMs: typeof event.duration_ms === "number" ? event.duration_ms : undefined,
          },
        ];
      case "error": {
        const error = event.error;
        const message =
          str(event.message) ?? str(error) ?? (isRecord(error) ? str(error.message) : undefined) ?? "Cursor CLI error";
        return [{ type: "error", message }];
      }
      default:
        return [];
    }
  }

  private assistant(event: Json): StreamEvent[] {
    const message = isRecord(event.message) ? event.message : {};
    const text = contentText(message.content);
    const isDelta = event.timestamp_ms !== undefined && event.timestamp_ms !== null;
    const isDuplicate = isDelta && typeof event.model_call_id === "string" && event.model_call_id.length > 0;
    if (isDuplicate) return [];
    if (isDelta) {
      this.streamed += text;
      return this.emit(text);
    }

    // Complete message: only emit what the deltas did not already deliver.
    const streamed = this.streamed;
    this.streamed = "";
    let events: StreamEvent[] = [];
    if (!streamed) events = this.emit(text);
    else if (text.length > streamed.length && text.startsWith(streamed)) {
      events = this.emit(text.slice(streamed.length), true);
    }
    this.breakPending = true;
    return events;
  }

  private toolCall(event: Json): StreamEvent[] {
    const subtype = str(event.subtype) ?? "started";
    const callId = str(event.call_id) ?? str(event.id) ?? "";
    const described = describeToolCall(event.tool_call);
    if (subtype === "started") {
      const call = { callId, name: described.name, args: described.args };
      if (callId) this.tools.set(callId, call);
      this.breakPending = true;
      return [{ type: "tool-started", ...call }];
    }
    if (subtype !== "completed" && subtype !== "failed") return [];
    const origin = callId ? this.tools.get(callId) : undefined;
    if (callId) this.tools.delete(callId);
    this.breakPending = true;
    const error = toolFailure(described.result, subtype);
    return [
      {
        type: "tool-completed",
        callId,
        name: origin?.name ?? described.name,
        args: origin?.args ?? described.args,
        ok: error === undefined,
        error,
        result: described.result,
      },
    ];
  }

  private emit(text: string, continuation = false): StreamEvent[] {
    if (!text) return [];
    let out = text;
    if (this.breakPending && this.text && !continuation) {
      // Separate text segments that were interrupted by tool calls.
      if (!this.emittedTail.endsWith("\n\n") && !out.startsWith("\n")) {
        out = (this.emittedTail.endsWith("\n") ? "\n" : "\n\n") + out;
      }
    }
    this.breakPending = false;
    this.text += out;
    this.emittedTail = (this.emittedTail + out).slice(-2);
    return [{ type: "text", text: out }];
  }
}

/** Parse a complete stream-json transcript in one go. */
export function parseStreamJson(stdout: string): { events: StreamEvent[]; parser: CursorStreamParser } {
  const parser = new CursorStreamParser();
  const events = [...parser.push(stdout), ...parser.end()];
  return { events, parser };
}
