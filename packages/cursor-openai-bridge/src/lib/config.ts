import * as path from "node:path";

import { normalizeModelId, resolveAgentBin, type CursorExecutionMode } from "./cursorCli.js";

export type { CursorExecutionMode } from "./cursorCli.js";

/** How Cursor's internal tool calls are surfaced to the client. */
export type ToolActivity = "reasoning" | "off";

export type BridgeConfig = {
  agentBin: string;
  host: string;
  port: number;
  requiredKey?: string;
  defaultModel: string;
  mode: CursorExecutionMode;
  force: boolean;
  approveMcps: boolean;
  trust: boolean;
  strictModel: boolean;
  workspace: string;
  /** Per-request Cursor CLI timeout; 0 disables it. */
  timeoutMs: number;
  toolActivity: ToolActivity;
  maxBodyBytes: number;
  /** Extra hostnames accepted in the Host header ("*" accepts any). */
  allowedHosts: string[];
};

export type BridgeConfigOverrides = Partial<Pick<BridgeConfig, "host" | "port" | "workspace" | "mode">>;

export const DEFAULT_PORT = 8765;
export const DEFAULT_HOST = "127.0.0.1";

function envBool(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw == null) return defaultValue;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return defaultValue;
}

function envInt(raw: string | undefined, defaultValue: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (raw == null || raw.trim() === "") return defaultValue;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : defaultValue;
}

export function parseMode(raw: string | undefined): CursorExecutionMode | undefined {
  const m = (raw || "").trim().toLowerCase();
  return m === "ask" || m === "plan" || m === "agent" ? m : undefined;
}

export function parsePort(raw: string | undefined): number | undefined {
  if (raw == null || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 65_535 ? n : undefined;
}

export function loadBridgeConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: BridgeConfigOverrides = {},
): BridgeConfig {
  const workspace = overrides.workspace ?? env.CURSOR_BRIDGE_WORKSPACE;
  const envPort = parsePort(env.CURSOR_BRIDGE_PORT);
  return {
    agentBin: resolveAgentBin(env),
    host: overrides.host || env.CURSOR_BRIDGE_HOST || DEFAULT_HOST,
    port: overrides.port ?? (envPort ? envPort : DEFAULT_PORT),
    requiredKey: env.CURSOR_BRIDGE_API_KEY || undefined,
    defaultModel: normalizeModelId(env.CURSOR_BRIDGE_DEFAULT_MODEL) || "auto",
    // Ask mode keeps Cursor read-only, which is what a model provider should be.
    mode: overrides.mode ?? parseMode(env.CURSOR_BRIDGE_MODE) ?? "ask",
    force: envBool(env.CURSOR_BRIDGE_FORCE, false),
    approveMcps: envBool(env.CURSOR_BRIDGE_APPROVE_MCPS, false),
    trust: envBool(env.CURSOR_BRIDGE_TRUST, true),
    strictModel: envBool(env.CURSOR_BRIDGE_STRICT_MODEL, true),
    workspace: workspace ? path.resolve(workspace) : process.cwd(),
    timeoutMs: envInt(env.CURSOR_BRIDGE_TIMEOUT_MS, 300_000, 0),
    toolActivity: env.CURSOR_BRIDGE_TOOL_ACTIVITY?.trim().toLowerCase() === "off" ? "off" : "reasoning",
    maxBodyBytes: envInt(env.CURSOR_BRIDGE_MAX_BODY_BYTES, 32 * 1024 * 1024, 1024),
    allowedHosts: (env.CURSOR_BRIDGE_ALLOWED_HOSTS || "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  };
}
