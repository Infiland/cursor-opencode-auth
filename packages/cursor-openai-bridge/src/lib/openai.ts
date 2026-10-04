import type { CursorUsage } from "./streamJson.js";

export type OpenAiChatCompletionRequest = {
  model?: unknown;
  messages?: unknown;
  stream?: unknown;
  stream_options?: unknown;
  tools?: unknown;
};

export type OpenAiUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens: number };
};

export type CompletionMeta = { id: string; created: number; model: string };

export type ChunkDelta = { role?: "assistant"; content?: string; reasoning_content?: string };

/** Cursor reports cache reads/writes separately from (non-cached) input tokens. */
export function toOpenAiUsage(usage: CursorUsage | undefined): OpenAiUsage {
  if (!usage) return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const prompt = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  return {
    prompt_tokens: prompt,
    completion_tokens: usage.outputTokens,
    total_tokens: prompt + usage.outputTokens,
    prompt_tokens_details: { cached_tokens: usage.cacheReadTokens },
  };
}

export function chunk(meta: CompletionMeta, delta: ChunkDelta, finishReason: string | null = null) {
  return {
    id: meta.id,
    object: "chat.completion.chunk",
    created: meta.created,
    model: meta.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

/** The trailing usage chunk sent when `stream_options.include_usage` is set. */
export function usageChunk(meta: CompletionMeta, usage: OpenAiUsage) {
  return {
    id: meta.id,
    object: "chat.completion.chunk",
    created: meta.created,
    model: meta.model,
    choices: [],
    usage,
  };
}

export function completion(meta: CompletionMeta, content: string, reasoning: string, usage: OpenAiUsage) {
  return {
    id: meta.id,
    object: "chat.completion",
    created: meta.created,
    model: meta.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content, ...(reasoning ? { reasoning_content: reasoning } : {}) },
        finish_reason: "stop",
      },
    ],
    usage,
  };
}

export function wantsUsage(body: OpenAiChatCompletionRequest): boolean {
  const opts = body.stream_options;
  return typeof opts === "object" && opts !== null && (opts as { include_usage?: unknown }).include_usage === true;
}

export function hasTools(body: OpenAiChatCompletionRequest): boolean {
  return Array.isArray(body.tools) && body.tools.length > 0;
}
