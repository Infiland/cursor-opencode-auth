import type { Plugin } from "@opencode/plugin";

import type { CursorCliModel } from "../lib/models.js";
import type { PluginSettings } from "../lib/settings.js";

type ProviderEditor = Parameters<Parameters<Plugin.Context["provider"]["transform"]>[0]>[0];

/** The in-process Cursor model, loaded by OpenCode 2.0's AI SDK provider loader. */
export const PROVIDER_PACKAGE = `aisdk:${new URL("./provider.js", import.meta.url).href}`;

/** Settings handed to `createCursor()` for every model of the provider. */
export function providerSettings(settings: PluginSettings, workspace: string) {
  return {
    agentBin: settings.agentBin,
    workspace,
    mode: settings.mode,
    force: settings.force,
    approveMcps: settings.approveMcps,
    trust: settings.trust,
    timeoutMs: settings.timeoutMs,
    toolActivity: settings.toolActivity,
  };
}

// OpenCode 2.0 generates session titles with the first available model of
// these families (`Model.small`); without one it falls back to the session's
// own model. Thinking variants are left out: titles need a quick answer.
const SMALL_MODEL_FAMILIES: ReadonlyArray<readonly [RegExp, string]> = [
  [/gpt.*luna/, "gpt-luna"],
  [/gemini.*flash.*lite/, "gemini-flash-lite"],
  [/gemini.*flash/, "gemini-flash"],
  [/haiku/, "claude-haiku"],
];

/** The OpenCode model family for a Cursor model id, when it is one OpenCode treats as small. */
export function smallModelFamily(id: string): string | undefined {
  const key = id.toLowerCase();
  if (key.includes("thinking")) return undefined;
  return SMALL_MODEL_FAMILIES.find(([pattern]) => pattern.test(key))?.[1];
}

/**
 * Register Cursor as an OpenCode 2.0 provider. Runs on every provider rebuild;
 * user configuration under `providers.<id>` is applied afterwards and wins.
 */
export function applyCursorProvider(
  editor: ProviderEditor,
  models: CursorCliModel[],
  settings: PluginSettings,
  workspace: string,
) {
  const providerID = settings.providerID;
  editor.update(providerID, (provider) => {
    if (!provider.name || provider.name === providerID) provider.name = settings.providerName;
    if (!provider.package) provider.package = PROVIDER_PACKAGE;
    // Cursor CLI handles its own login; there is no OpenCode credential to wait for.
    if (provider.activation === "auto") provider.activation = "enabled";
    provider.settings = { ...providerSettings(settings, workspace), ...provider.settings };
  });

  const wanted = settings.models ? new Set(settings.models) : undefined;
  const selected = wanted ? models.filter((m) => wanted.has(m.id)) : [...models];
  for (const id of settings.models ?? []) {
    if (!selected.some((m) => m.id === id)) selected.push({ id, name: id });
  }
  for (const entry of selected) {
    editor.models.update(providerID, entry.id, (model) => {
      if (!model.name || model.name === entry.id) model.name = entry.name;
      const family = smallModelFamily(entry.id);
      if (family && !model.family) model.family = family as NonNullable<typeof model.family>;
      // OpenCode's tools are never called by Cursor (it uses its own), and the CLI takes text only.
      model.capabilities = { tools: false, input: ["text"], output: ["text"] };
      model.limit = { ...model.limit, context: settings.contextLimit, output: settings.outputLimit };
    });
  }
}
