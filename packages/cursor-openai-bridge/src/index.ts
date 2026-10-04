export { loadBridgeConfig, type BridgeConfig, type BridgeConfigOverrides, type ToolActivity } from "./lib/config.js";
export { createBridgeServer, startBridgeServer, type BridgeServerOptions } from "./lib/server.js";
export { bridgeVersion } from "./lib/version.js";

// Cursor CLI building blocks, shared with the OpenCode plugin.
export {
  buildPrintArgs,
  classifyCursorFailure,
  CURSOR_CLI_HINT,
  describeFailure,
  listCursorModels,
  normalizeModelId,
  parseModelList,
  resolveAgentBin,
  type CursorCliModel,
  type CursorExecutionMode,
  type CursorFailureKind,
  type CursorPrintArgs,
  type FailureResponse,
} from "./lib/cursorCli.js";
export {
  CommandNotFoundError,
  describeExit,
  killActiveProcesses,
  run,
  succeeded,
  type RunOptions,
  type RunResult,
} from "./lib/process.js";
export {
  CursorStreamParser,
  describeToolCall,
  parseStreamJson,
  parseUsage,
  type CursorToolCall,
  type CursorUsage,
  type StreamEvent,
} from "./lib/streamJson.js";
export { buildPrompt, CLIENT_TOOLS_NOTE, contentToText } from "./lib/prompt.js";
export { describeToolFailure, describeToolStart, toolTarget } from "./lib/toolActivity.js";
