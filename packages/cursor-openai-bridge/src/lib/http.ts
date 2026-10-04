import { createHash, timingSafeEqual } from "node:crypto";
import type * as http from "node:http";

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, message: string, code: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Bearer tokens in the Authorization header. Clients that merge headers
 * case-insensitively (an SDK's `Authorization` plus a hook's `authorization`)
 * send several, joined with commas.
 */
export function extractBearerTokens(req: http.IncomingMessage): string[] {
  const header = req.headers["authorization"];
  if (!header) return [];
  return (Array.isArray(header) ? header : [header])
    .flatMap((value) => value.split(/,\s*(?=Bearer\s)/i))
    .flatMap((part) => {
      const match = part.trim().match(/^Bearer\s+(.+)$/i);
      return match ? [match[1].trim()] : [];
    });
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function json(res: http.ServerResponse, status: number, body: unknown) {
  if (res.headersSent || res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

export function errorBody(message: string, code: string, type = "invalid_request_error") {
  return { error: { message, type, code } };
}

export function sendError(res: http.ServerResponse, status: number, message: string, code: string, type?: string) {
  json(res, status, errorBody(message, code, type ?? (status >= 500 ? "server_error" : "invalid_request_error")));
}

export function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) {
      req.resume();
      reject(new HttpError(413, `Request body exceeds ${maxBytes} bytes`, "request_too_large"));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on("data", (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > maxBytes) {
        failed = true;
        reject(new HttpError(413, `Request body exceeds ${maxBytes} bytes`, "request_too_large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!failed) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (err) => {
      if (!failed) reject(err);
    });
  });
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

function hostnameOf(value: string): string {
  const v = value.trim().toLowerCase();
  if (v.startsWith("[")) return v.slice(1, v.indexOf("]") === -1 ? undefined : v.indexOf("]"));
  const colon = v.lastIndexOf(":");
  // A bare IPv6 literal has several colons and no port.
  return colon !== -1 && v.indexOf(":") === colon ? v.slice(0, colon) : v;
}

/**
 * Hostnames the bridge answers to. Rejecting anything else defeats DNS
 * rebinding, where a web page re-points its own domain at 127.0.0.1.
 */
export function makeHostCheck(bindHost: string, extra: string[]) {
  if (extra.includes("*")) return () => true;
  const allowed = new Set([...LOOPBACK, ...extra.map(hostnameOf)]);
  const bind = hostnameOf(bindHost);
  if (bind && bind !== "0.0.0.0" && bind !== "::") allowed.add(bind);
  return (value: string) => allowed.has(hostnameOf(value));
}

/** Validate Host and Origin so browsers cannot drive the bridge (CSRF / DNS rebinding). */
export function checkRequestSource(req: http.IncomingMessage, hostAllowed: (host: string) => boolean): string | undefined {
  const host = req.headers.host;
  if (host && !hostAllowed(host)) return `Host "${host}" is not allowed`;
  const origin = req.headers.origin;
  if (origin === undefined) return undefined;
  try {
    if (hostAllowed(new URL(origin).host)) return undefined;
  } catch {
    // "null" or garbage
  }
  return `Origin "${origin}" is not allowed`;
}
