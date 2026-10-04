import { resolveAgentBin, type CursorExecutionMode } from "cursor-openai-bridge";

export type PluginOptions = Readonly<Record<string, unknown>>;

export type PluginSettings = {
  agentBin: string;
  /** Provider ID registered in OpenCode (models are `<providerID>/<model>`). */
  providerID: string;
  providerName: string;
  /** Bridge root URL, without `/v1`. */
  bridgeURL: string;
  bridgeApiKey?: string;
  /** Start the bridge automatically when it is not running (local bridges only). */
  autostart: boolean;
  /** Register only these model IDs instead of everything `agent --list-models` reports. */
  models?: string[];
  contextLimit: number;
  outputLimit: number;
  /** How Cursor runs when it serves as the model (env names shared with the bridge). */
  mode: CursorExecutionMode;
  force: boolean;
  approveMcps: boolean;
  trust: boolean;
  /** Per-request Cursor CLI timeout; 0 disables it. */
  timeoutMs: number;
  /** Report Cursor's own tool calls as reasoning ("reasoning") or not at all ("off"). */
  toolActivity: "reasoning" | "off";
};

const DEFAULT_PORT = 8765;

function envBool(raw: string | undefined, defaultValue: boolean): boolean {
  const v = raw?.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return defaultValue;
}

function optString(options: PluginOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optInt(options: PluginOptions, key: string, fallback: number): number {
  const value = options[key];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function optBool(options: PluginOptions, key: string, env: string | undefined, fallback: boolean): boolean {
  const value = options[key];
  return typeof value === "boolean" ? value : envBool(env, fallback);
}

function parseMode(raw: unknown): CursorExecutionMode | undefined {
  const m = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return m === "ask" || m === "plan" || m === "agent" ? m : undefined;
}

function parseTimeout(options: PluginOptions, env: string | undefined): number {
  const value = options.timeoutMs ?? (env?.trim() ? Number(env) : undefined);
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 300_000;
}

function clientHost(host: string): string {
  if (host === "0.0.0.0" || host === "::" || host === "") return "127.0.0.1";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export function loadSettings(env: NodeJS.ProcessEnv = process.env, options: PluginOptions = {}): PluginSettings {
  const port = Number(env.CURSOR_BRIDGE_PORT);
  const bridgeURL =
    optString(options, "bridgeURL")?.replace(/\/+$/, "").replace(/\/v1$/, "") ??
    `http://${clientHost(env.CURSOR_BRIDGE_HOST?.trim() || "127.0.0.1")}:${
      Number.isInteger(port) && port > 0 && port < 65_536 ? port : DEFAULT_PORT
    }`;
  const models = Array.isArray(options.models)
    ? options.models.filter((m): m is string => typeof m === "string" && m.trim() !== "").map((m) => m.trim())
    : undefined;
  return {
    agentBin: optString(options, "agentBin") ?? resolveAgentBin(env),
    providerID: optString(options, "providerID") ?? "cursor",
    providerName: optString(options, "name") ?? "Cursor",
    bridgeURL,
    bridgeApiKey: env.CURSOR_BRIDGE_API_KEY || undefined,
    autostart: typeof options.autostart === "boolean" ? options.autostart : envBool(env.CURSOR_BRIDGE_AUTOSTART, true),
    models: models && models.length > 0 ? models : undefined,
    contextLimit: optInt(options, "contextLimit", 200_000),
    outputLimit: optInt(options, "outputLimit", 32_000),
    // Ask mode keeps Cursor read-only, which is what a model provider should be by default.
    mode: parseMode(options.mode) ?? parseMode(env.CURSOR_BRIDGE_MODE) ?? "ask",
    force: optBool(options, "force", env.CURSOR_BRIDGE_FORCE, false),
    approveMcps: optBool(options, "approveMcps", env.CURSOR_BRIDGE_APPROVE_MCPS, false),
    trust: optBool(options, "trust", env.CURSOR_BRIDGE_TRUST, true),
    timeoutMs: parseTimeout(options, env.CURSOR_BRIDGE_TIMEOUT_MS),
    toolActivity:
      (options.toolActivity ?? env.CURSOR_BRIDGE_TOOL_ACTIVITY)?.toString().trim().toLowerCase() === "off"
        ? "off"
        : "reasoning",
  };
}

/** Only bridges on this machine can be started or stopped by the plugin. */
export function isLocalBridge(settings: PluginSettings): boolean {
  try {
    const host = new URL(settings.bridgeURL).hostname.replace(/^\[|\]$/g, "");
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}
