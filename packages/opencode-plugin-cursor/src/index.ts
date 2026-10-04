import type { PluginModule } from "@opencode-ai/plugin";
import type { Plugin as OpenCode2 } from "@opencode/plugin";

import { CursorPlugin } from "./v1.js";
import { setupOpenCode2 } from "./v2/index.js";

export { CursorPlugin };

/**
 * One module for both plugin APIs: OpenCode 1.x calls `server` (tools and
 * hooks for the local bridge), OpenCode 2.0 calls `setup` (an in-process
 * Cursor provider plus the same tools).
 *
 * Keep named exports limited to plugin functions: OpenCode 1.x treats every
 * named export of a re-exporting shim (`export * from ...`) as a plugin.
 */
const plugin = {
  id: "cursor-opencode-auth",
  server: CursorPlugin,
  setup: setupOpenCode2,
} satisfies PluginModule & OpenCode2.Plugin;

export default plugin;
