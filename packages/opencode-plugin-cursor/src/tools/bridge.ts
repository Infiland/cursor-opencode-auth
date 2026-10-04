import { tool } from "@opencode-ai/plugin";

import {
  bridgeHealth,
  bridgeLogFile,
  ensureBridge,
  expectedBridgeVersion,
  stopBridge,
} from "../lib/bridge.js";
import { isLocalBridge, type PluginSettings } from "../lib/settings.js";

const pretty = (value: unknown) => JSON.stringify(value, null, 2);

export function createBridgeTools(args: { settings: PluginSettings; cwd: string }) {
  const { settings } = args;
  const urls = { baseURL: settings.bridgeURL, v1BaseURL: `${settings.bridgeURL}/v1` };

  return {
    cursor_bridge_status: tool({
      description: "Check whether the local cursor-openai-bridge (Cursor as an OpenCode provider) is running.",
      args: {},
      async execute() {
        const health = await bridgeHealth(settings);
        const expected = expectedBridgeVersion();
        return pretty({
          ok: Boolean(health),
          ...urls,
          ...(health ?? {}),
          ...(health && expected && health.version !== expected
            ? { outdated: true, expectedVersion: expected, hint: "Run cursor_bridge_restart to use the new build." }
            : {}),
          logFile: bridgeLogFile(),
        });
      },
    }),

    cursor_bridge_start: tool({
      description: "Start the local cursor-openai-bridge in the background if it is not already running.",
      args: {},
      async execute() {
        const result = await ensureBridge(settings, { workspace: args.cwd });
        if (result.status === "remote") {
          return pretty({ ok: false, ...urls, message: "The bridge URL is not local; start that bridge yourself." });
        }
        if (result.status === "failed") return pretty({ ok: false, ...urls, error: result.error, logFile: result.logFile });
        return pretty({ ok: true, ...urls, status: result.status, ...result.health });
      },
    }),

    cursor_bridge_stop: tool({
      description: "Stop the local cursor-openai-bridge.",
      args: {},
      async execute() {
        const result = await stopBridge(settings);
        return pretty({ ...result, running: Boolean(await bridgeHealth(settings, 300)) });
      },
    }),

    cursor_bridge_restart: tool({
      description: "Restart the local cursor-openai-bridge (picks up a rebuilt bridge or changed environment).",
      args: {},
      async execute() {
        if (!isLocalBridge(settings)) {
          return pretty({ ok: false, ...urls, message: "The bridge URL is not local; restart that bridge yourself." });
        }
        const stopped = await stopBridge(settings);
        const result = await ensureBridge(settings, { workspace: args.cwd });
        if (result.status === "failed") return pretty({ ok: false, stopped, error: result.error, logFile: result.logFile });
        return pretty({ ok: true, ...urls, stopped: stopped.stopped, ...("health" in result ? result.health : {}) });
      },
    }),
  };
}
