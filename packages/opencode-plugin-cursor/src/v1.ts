import * as path from "node:path";

import type { Plugin } from "@opencode-ai/plugin";

import { ensureBridge } from "./lib/bridge.js";
import { loadSettings } from "./lib/settings.js";
import { createBridgeTools } from "./tools/bridge.js";
import { createCliTools } from "./tools/cli.js";
import { createCloudTools } from "./tools/cloud.js";

const STARTUP_WAIT_MS = 6_000;

/**
 * OpenCode 1.x plugin: Cursor CLI / Cloud Agents tools, bridge management, and
 * per-project routing for the `cursor` provider.
 */
export const CursorPlugin: Plugin = async ({ directory, worktree }, options) => {
  const settings = loadSettings(process.env, options ?? {});
  const cwd = directory || process.cwd();
  // OpenCode reports the filesystem root as the worktree of non-git projects.
  const repoRoot = worktree && worktree !== path.parse(worktree).root ? worktree : undefined;

  if (settings.autostart) {
    // Give a provider request issued right after startup a chance to find the bridge,
    // without holding up OpenCode for long if it cannot start.
    await Promise.race([
      ensureBridge(settings, { workspace: cwd }).catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, STARTUP_WAIT_MS).unref?.()),
    ]);
  }

  return {
    tool: {
      ...createBridgeTools({ settings, cwd }),
      ...createCliTools({ agentBin: settings.agentBin, cwd, repoRoot }),
      ...createCloudTools({ cwd }),
    },
    // One bridge serves every open project; tell it which project a request belongs to.
    "chat.headers": async (input, output) => {
      if (input.model.providerID !== settings.providerID) return;
      output.headers["x-cursor-workspace"] = encodeURI(cwd);
      // Same spelling as the OpenAI-compatible SDK, so this replaces its `apiKey` header instead of adding one.
      if (settings.bridgeApiKey) output.headers["Authorization"] = `Bearer ${settings.bridgeApiKey}`;
    },
  };
};
