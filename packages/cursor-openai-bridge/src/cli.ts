#!/usr/bin/env node
import { parseArgs } from "node:util";

import { loadBridgeConfig, parseMode, parsePort, type BridgeConfigOverrides } from "./lib/config.js";
import { killActiveProcesses } from "./lib/process.js";
import { startBridgeServer } from "./lib/server.js";
import { bridgeVersion } from "./lib/version.js";

const HELP = `Usage: cursor-openai-bridge [options]

Serves an OpenAI-compatible API (/v1/chat/completions, /v1/models) backed by Cursor CLI.

Options:
  --host <host>        Interface to bind (env CURSOR_BRIDGE_HOST, default 127.0.0.1)
  --port <port>        Port to listen on (env CURSOR_BRIDGE_PORT, default 8765)
  --workspace <dir>    Default Cursor workspace (env CURSOR_BRIDGE_WORKSPACE, default cwd)
  --mode <mode>        ask | plan | agent (env CURSOR_BRIDGE_MODE, default ask)
  -v, --version        Print the version
  -h, --help           Show this help

Other settings are read from the environment; see docs/USAGE.md in the project repository.`;

function fail(message: string): never {
  console.error(`cursor-openai-bridge: ${message}\n\n${HELP}`);
  process.exit(2);
}

function main() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        host: { type: "string" },
        port: { type: "string" },
        workspace: { type: "string" },
        mode: { type: "string" },
        version: { type: "boolean", short: "v" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
    }));
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  if (values.help) {
    console.log(HELP);
    return;
  }
  if (values.version) {
    console.log(bridgeVersion());
    return;
  }

  const overrides: BridgeConfigOverrides = {};
  if (values.host) overrides.host = values.host;
  if (values.workspace) overrides.workspace = values.workspace;
  if (values.port !== undefined) {
    const port = parsePort(values.port);
    if (port === undefined) fail(`invalid --port: ${values.port}`);
    overrides.port = port;
  }
  if (values.mode !== undefined) {
    const mode = parseMode(values.mode);
    if (!mode) fail(`invalid --mode: ${values.mode} (expected ask, plan or agent)`);
    overrides.mode = mode;
  }

  const config = loadBridgeConfig(process.env, overrides);
  const server = startBridgeServer({ version: bridgeVersion(), config });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`cursor-openai-bridge: ${config.host}:${config.port} is already in use (is a bridge already running?)`);
    } else {
      console.error(`cursor-openai-bridge: ${err.message}`);
    }
    process.exit(1);
  });

  const shutdown = (signal: NodeJS.Signals) => {
    console.log(`cursor-openai-bridge: received ${signal}, shutting down`);
    killActiveProcesses("SIGTERM");
    server.close(() => process.exit(0));
    server.closeAllConnections?.();
    setTimeout(() => process.exit(0), 3_000).unref();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main();
