import type { Plugin } from "@opencode/plugin";

import { cachedModels, discoverModels, sameModels, type CursorCliModel } from "../lib/models.js";
import { loadSettings } from "../lib/settings.js";
import { createCliTools } from "../tools/cli.js";
import { createCloudTools } from "../tools/cloud.js";
import { applyCursorProvider } from "./registry.js";
import { registerCursorTools } from "./tools.js";

const FALLBACK_MODELS: CursorCliModel[] = [{ id: "auto", name: "Auto" }];

/** OpenCode 1.18 ships an earlier, incompatible "v2" preview runtime that also calls `setup`. */
function isOpenCode2(ctx: unknown): ctx is Plugin.Context {
  const c = ctx as Partial<Plugin.Context> | undefined;
  return (
    typeof c?.location?.directory === "string" &&
    typeof c.provider?.transform === "function" &&
    typeof c.tool?.transform === "function"
  );
}

/**
 * OpenCode 2.0 plugin setup. Registers Cursor as an in-process model provider
 * (no bridge needed) and the Cursor CLI / Cloud Agents tools for this location.
 */
export async function setupOpenCode2(ctx: Plugin.Context): Promise<void> {
  if (!isOpenCode2(ctx)) return;
  const settings = loadSettings(process.env, ctx.options);
  const { location } = ctx;

  if (ctx.options.provider !== false) {
    let models = (await cachedModels(settings.agentBin)) ?? FALLBACK_MODELS;
    await ctx.provider.transform((editor) => applyCursorProvider(editor, models, settings, location.directory));
    if (!settings.models) {
      void discoverModels(settings.agentBin)
        .then(async (fresh) => {
          if (sameModels(fresh, models)) return;
          models = fresh;
          await ctx.provider.reload();
        })
        .catch(() => undefined);
    }
  }

  if (ctx.options.tools !== false) {
    const tools = {
      ...createCliTools({ agentBin: settings.agentBin, cwd: location.directory, repoRoot: location.project.directory }),
      ...createCloudTools({ cwd: location.directory }),
    };
    await ctx.tool.transform((editor) => registerCursorTools(editor, tools, location));
  }
}
