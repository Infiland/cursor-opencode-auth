import { tool, type ToolContext as V1ToolContext, type ToolDefinition } from "@opencode-ai/plugin";
import type { Plugin } from "@opencode/plugin";

type ToolEditor = Parameters<Parameters<Plugin.Context["tool"]["transform"]>[0]>[0];
type Location = Plugin.Context["location"];

export const TOOL_NAMESPACE = "cursor";

/** zod gives every `.int()` the safe-integer range, which is noise in the tool signatures models see. */
function tidySchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(tidySchema);
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "maximum" && entry === Number.MAX_SAFE_INTEGER) continue;
    if (key === "minimum" && entry === Number.MIN_SAFE_INTEGER) continue;
    out[key] = tidySchema(entry);
  }
  return out;
}

/**
 * Register OpenCode 1.x tool definitions with OpenCode 2.0. Each tool keeps its
 * id: `cursor_cli_run` becomes `cli_run` in the `cursor` namespace, whose
 * effective name is again `cursor_cli_run`. Inputs are described with plain
 * JSON Schema because OpenCode 2.0 only converts zod schemas from its own copy.
 */
export function registerCursorTools(editor: ToolEditor, tools: Record<string, ToolDefinition>, location: Location) {
  editor.namespace({
    name: TOOL_NAMESPACE,
    description: "Cursor CLI (Cursor's local agent) and the Cursor Cloud Agents API",
  });
  for (const [id, def] of Object.entries(tools)) {
    const schema = tool.schema.object(def.args);
    editor.add({
      name: id.replace(new RegExp(`^${TOOL_NAMESPACE}_`), ""),
      description: def.description,
      input: tidySchema(tool.schema.toJSONSchema(schema, { target: "draft-2020-12" })) as Record<string, unknown>,
      options: { namespace: TOOL_NAMESPACE },
      execute: async (input, ctx) => {
        const context: V1ToolContext = {
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
          agent: ctx.agent,
          directory: location.directory,
          worktree: location.project.directory,
          abort: ctx.signal,
          metadata: (update) => {
            void ctx.progress({ ...(update.metadata ?? {}), ...(update.title ? { title: update.title } : {}) });
          },
          ask: async () => undefined,
        };
        const result = await def.execute(schema.parse(input), context);
        return { content: typeof result === "string" ? result : result.output };
      },
    });
  }
}
