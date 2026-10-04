import { Buffer } from "node:buffer";

export type CursorApiAuthStyle = "basic" | "bearer";

/**
 * The API key, base URL and auth style come only from the environment. Tool
 * arguments are model-controlled, and letting a prompt-injected model choose
 * the base URL would let it send CURSOR_API_KEY to any server.
 */
function apiConfig(env: NodeJS.ProcessEnv = process.env) {
  const key = env.CURSOR_API_KEY;
  if (!key) {
    throw new Error("Missing Cursor API key. Set CURSOR_API_KEY in the environment OpenCode runs in.");
  }
  const style: CursorApiAuthStyle = env.CURSOR_API_AUTH_STYLE?.trim().toLowerCase() === "bearer" ? "bearer" : "basic";
  const baseURL = (env.CURSOR_API_BASE_URL || "https://api.cursor.com").replace(/\/+$/, "");
  return { key, style, baseURL };
}

function authHeader(key: string, style: CursorApiAuthStyle): string {
  if (style === "bearer") return `Bearer ${key}`;
  // Basic auth with the key as username, as documented for the Cloud Agents API.
  return `Basic ${Buffer.from(`${key}:`).toString("base64")}`;
}

export async function cursorApiRequest<T>(args: {
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<T> {
  const { key, style, baseURL } = apiConfig();
  const signals = [AbortSignal.timeout(args.timeoutMs ?? 60_000), ...(args.signal ? [args.signal] : [])];
  const res = await fetch(`${baseURL}${args.path}`, {
    method: args.method,
    headers: {
      Authorization: authHeader(key, style),
      Accept: "application/json",
      ...(args.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: args.body === undefined ? undefined : JSON.stringify(args.body),
    signal: AbortSignal.any(signals),
  });

  const contentType = res.headers.get("content-type") || "";
  const isJson = contentType.includes("application/json");

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const hint =
      res.status === 401
        ? " (authentication failed: check CURSOR_API_KEY)"
        : res.status === 403
          ? " (forbidden: does this key have Cloud Agents access?)"
          : res.status === 429
            ? " (rate limited)"
            : "";
    throw new Error(`Cursor API ${args.method} ${args.path} failed: ${res.status} ${res.statusText}${hint}\n${text}`.trim());
  }

  if (res.status === 204) return undefined as T;
  if (isJson) return (await res.json()) as T;
  return (await res.text()) as unknown as T;
}
