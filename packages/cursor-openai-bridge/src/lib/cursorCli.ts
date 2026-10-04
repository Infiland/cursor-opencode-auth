import { tmpdir } from "node:os";

import { CommandNotFoundError, describeExit, run, succeeded, type RunResult } from "./process.js";

export type CursorExecutionMode = "agent" | "ask" | "plan";

export type CursorCliModel = {
  id: string;
  name: string;
  /** Marked "(default)" by `agent --list-models`. */
  isDefault?: boolean;
  /** Marked "(current)" by `agent --list-models`. */
  isCurrent?: boolean;
};

export type CursorPrintArgs = {
  mode?: CursorExecutionMode;
  model?: string;
  workspace?: string;
  outputFormat?: "text" | "json" | "stream-json";
  /** Emit assistant text as incremental deltas (stream-json only). */
  streamPartialOutput?: boolean;
  force?: boolean;
  approveMcps?: boolean;
  /** Trust the workspace without prompting (headless runs in new directories need this). */
  trust?: boolean;
};

export const CURSOR_CLI_HINT =
  "Install Cursor CLI (curl https://cursor.com/install -fsS | bash) or set CURSOR_AGENT_BIN to its path.";

/** Resolve the Cursor CLI binary from the environment. */
export function resolveAgentBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.CURSOR_AGENT_BIN || env.CURSOR_CLI_BIN || env.CURSOR_CLI_PATH || "agent";
}

/**
 * Arguments for a headless (`--print`) run. The prompt itself is not included:
 * pass it on stdin, which keeps large prompts off the command line (argv is
 * size-limited) and out of process listings.
 */
export function buildPrintArgs(opts: CursorPrintArgs): string[] {
  const args = ["--print"];
  const format = opts.outputFormat ?? "text";
  args.push("--output-format", format);
  if (format === "stream-json" && opts.streamPartialOutput) args.push("--stream-partial-output");
  // "agent" is the CLI default; it only accepts --mode ask|plan.
  if (opts.mode && opts.mode !== "agent") args.push("--mode", opts.mode);
  if (opts.workspace) args.push("--workspace", opts.workspace);
  if (opts.model) args.push("--model", opts.model);
  if (opts.force) args.push("--force");
  if (opts.approveMcps) args.push("--approve-mcps");
  if (opts.trust) args.push("--trust");
  return args;
}

/** Strip a client-side provider prefix: "cursor/gpt-5.2" -> "gpt-5.2". */
export function normalizeModelId(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || undefined;
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const MODEL_LINE = /^([A-Za-z0-9][A-Za-z0-9._:/-]*)\s+-\s+(.+)$/;
const ANNOTATION = /\s*\(((?:current|default)(?:\s*,\s*(?:current|default))*)\)\s*$/i;
const BARE_ID = /^[a-z0-9][a-z0-9._:/-]*$/;

/**
 * Parse `agent --list-models` output. Lines look like `gpt-5.2 - GPT-5.2 (current, default)`;
 * headers such as "Available models" and "Tip: ..." are skipped. Bare model IDs
 * (one per line, optionally bulleted) are accepted as a fallback.
 */
export function parseModelList(output: string): CursorCliModel[] {
  const byId = new Map<string, CursorCliModel>();
  for (const rawLine of output.replace(ANSI, "").split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^[-*•]\s+/, "");
    if (!line || /^tip:/i.test(line)) continue;

    const match = MODEL_LINE.exec(line);
    if (match) {
      const id = match[1];
      let name = match[2].trim();
      const model: CursorCliModel = { id, name };
      const annotation = ANNOTATION.exec(name);
      if (annotation) {
        name = name.slice(0, annotation.index).trim();
        const flags = annotation[1].toLowerCase();
        if (flags.includes("default")) model.isDefault = true;
        if (flags.includes("current")) model.isCurrent = true;
      }
      model.name = name || id;
      byId.set(id, model);
      continue;
    }
    if (BARE_ID.test(line)) byId.set(line, { id: line, name: line });
  }
  return [...byId.values()];
}

export async function listCursorModels(opts: {
  agentBin: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<CursorCliModel[]> {
  let result;
  try {
    result = await run(opts.agentBin, ["--list-models"], {
      cwd: tmpdir(),
      timeoutMs: opts.timeoutMs ?? 60_000,
      signal: opts.signal,
    });
  } catch (err) {
    if (err instanceof CommandNotFoundError) throw new Error(`${err.message}. ${CURSOR_CLI_HINT}`);
    throw err;
  }
  if (!succeeded(result)) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(`agent --list-models ${describeExit(result)}${detail ? `: ${detail}` : ""}`);
  }
  return parseModelList(result.stdout);
}

export type CursorFailureKind = "auth" | "usage_limit" | "rate_limit" | "model" | "failed";

const AUTH_RE =
  /not (?:logged|signed) in|not authenticated|unauthori[sz]ed|authentication (?:required|failed|error)|(?:run|use) [`'"]?(?:cursor-)?agent login|invalid api key|api key (?:is )?(?:invalid|expired|missing)|login required|no access token/i;
const USAGE_LIMIT_RE = /usage.?limits?\b|quota[ _-]?(?:exceeded|exhausted|reached)|spend(?:ing)? limit|out of (?:credits|requests)/i;
const RATE_LIMIT_RE = /\brate.?limit(?:s|ed)?\b|too many requests|\b429\b/i;
const MODEL_RE =
  /(?:unknown|invalid|unsupported|unavailable) model|model[^\n]{0,80}(?:not found|not available|not supported|is invalid|does not exist|unknown)|cannot use (?:this )?model|no such model/i;

/** Classify a failed Cursor CLI run from its error output. */
export function classifyCursorFailure(text: string): CursorFailureKind {
  if (USAGE_LIMIT_RE.test(text)) return "usage_limit";
  if (RATE_LIMIT_RE.test(text)) return "rate_limit";
  if (AUTH_RE.test(text)) return "auth";
  if (MODEL_RE.test(text)) return "model";
  return "failed";
}

export type FailureResponse = { status: number; code: string; message: string };

function truncate(text: string, max = 400): string {
  const flat = text.trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * HTTP status, error code and message for a failed Cursor CLI run. Statuses
 * are chosen so that clients do not retry: OpenCode (and the AI SDK) retry
 * 5xx and plain 429 responses automatically, and every retry would start
 * another full Cursor agent run.
 */
export function describeFailure(
  kind: CursorFailureKind,
  detail: string,
  outcome: Pick<RunResult, "code" | "signal" | "timedOut" | "aborted">,
  model: string,
): FailureResponse {
  const suffix = detail ? ` — ${truncate(detail)}` : "";
  switch (kind) {
    case "auth":
      return {
        status: 401,
        code: "cursor_auth_required",
        message: `Cursor CLI is not authenticated (run \`agent login\` or set CURSOR_API_KEY)${suffix}`,
      };
    case "usage_limit":
      return { status: 429, code: "insufficient_quota", message: `Cursor usage limit reached (quota exceeded)${suffix}` };
    case "rate_limit":
      return { status: 429, code: "rate_limit_exceeded", message: `Cursor rate limit${suffix}` };
    case "model":
      return { status: 404, code: "model_not_found", message: `Cursor CLI rejected model "${model}"${suffix}` };
    default:
      return {
        status: 424,
        code: "cursor_cli_error",
        message: `Cursor CLI ${describeExit({ ...outcome, stdout: "", stderr: "" })}${suffix}`,
      };
  }
}
