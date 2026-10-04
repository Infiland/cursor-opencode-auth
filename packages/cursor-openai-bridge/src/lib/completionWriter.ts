import type * as http from "node:http";

import { errorBody, json } from "./http.js";
import { chunk, completion, toOpenAiUsage, usageChunk, type CompletionMeta } from "./openai.js";
import type { CursorUsage } from "./streamJson.js";

export type CompletionWriterOptions = {
  stream: boolean;
  includeUsage: boolean;
  meta: CompletionMeta;
  /**
   * Streaming responses hold their headers back this long (or until the first
   * output), so failures that happen early can still be reported with a real
   * HTTP status instead of inside a 200 stream.
   */
  headerGraceMs?: number;
  keepaliveMs?: number;
};

/** Writes one chat completion as either an SSE stream or a single JSON body. */
export class CompletionWriter {
  private committed = false;
  private done = false;
  private content = "";
  private reasoning = "";
  private graceTimer?: NodeJS.Timeout;
  private keepaliveTimer?: NodeJS.Timeout;

  constructor(
    private readonly res: http.ServerResponse,
    private readonly opts: CompletionWriterOptions,
  ) {
    if (opts.stream) {
      this.graceTimer = setTimeout(() => this.commit(), opts.headerGraceMs ?? 5_000);
      this.graceTimer.unref?.();
    }
  }

  get finished(): boolean {
    return this.done;
  }

  get text(): string {
    return this.content;
  }

  appendText(delta: string) {
    if (!delta || this.done) return;
    this.content += delta;
    if (this.opts.stream) this.send(chunk(this.opts.meta, { content: delta }));
  }

  appendReasoning(delta: string) {
    if (!delta || this.done) return;
    this.reasoning += delta;
    if (this.opts.stream) this.send(chunk(this.opts.meta, { reasoning_content: delta }));
  }

  succeed(usage?: CursorUsage) {
    if (this.done) return;
    const openAiUsage = toOpenAiUsage(usage);
    if (!this.opts.stream) {
      this.finish();
      json(this.res, 200, completion(this.opts.meta, this.content, this.reasoning, openAiUsage));
      return;
    }
    this.commit();
    this.write(chunk(this.opts.meta, {}, "stop"));
    if (this.opts.includeUsage) this.write(usageChunk(this.opts.meta, openAiUsage));
    this.end();
  }

  fail(status: number, message: string, code: string) {
    if (this.done) return;
    if (!this.committed) {
      this.finish();
      json(this.res, status, errorBody(message, code, status >= 500 ? "server_error" : "invalid_request_error"));
      return;
    }
    // Headers are already out; the only way to tell the user is in-band.
    this.write(chunk(this.opts.meta, { content: `${this.content ? "\n\n" : ""}[cursor-openai-bridge] ${message}` }));
    this.write(chunk(this.opts.meta, {}, "stop"));
    this.end();
  }

  /** Stop timers without writing anything (client went away). */
  close() {
    this.finish();
  }

  private commit() {
    if (this.committed || this.done || !this.writable()) return;
    this.committed = true;
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    this.write(chunk(this.opts.meta, { role: "assistant", content: "" }));
    this.keepaliveTimer = setInterval(() => {
      if (this.writable()) this.res.write(": keep-alive\n\n");
    }, this.opts.keepaliveMs ?? 15_000);
    this.keepaliveTimer.unref?.();
  }

  private send(payload: unknown) {
    this.commit();
    this.write(payload);
  }

  private write(payload: unknown) {
    if (this.writable()) this.res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  private end() {
    this.finish();
    if (this.writable()) {
      this.res.write("data: [DONE]\n\n");
      this.res.end();
    }
  }

  private finish() {
    this.done = true;
    if (this.graceTimer) clearTimeout(this.graceTimer);
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
  }

  private writable(): boolean {
    return !this.res.writableEnded && !this.res.destroyed;
  }
}
