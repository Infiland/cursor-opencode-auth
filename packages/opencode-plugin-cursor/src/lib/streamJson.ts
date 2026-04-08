/**
 * Parser for Cursor CLI's `--output-format stream-json` NDJSON output.
 *
 * Each line is a JSON object with a `type` field. Known event types:
 *   - system  (subtype: "init")   – session metadata
 *   - user                        – echoed user prompt
 *   - assistant                   – model response text
 *   - tool_call (subtype: "started" | "completed") – tool invocations
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SystemInitEvent {
  type: "system";
  subtype: "init";
  model?: string;
  session_id?: string;
  cwd?: string;
  permissionMode?: string;
  apiKeySource?: string;
}

export interface UserEvent {
  type: "user";
  message: { role: "user"; content: Array<{ type: string; text?: string }> };
  session_id?: string;
}

export interface AssistantEvent {
  type: "assistant";
  message: {
    role: "assistant";
    content: Array<{ type: string; text?: string }>;
  };
  session_id?: string;
}

export interface ToolCallEvent {
  type: "tool_call";
  subtype: "started" | "completed";
  call_id: string;
  tool_call: Record<string, any>;
  session_id?: string;
}

export type CursorStreamEvent =
  | SystemInitEvent
  | UserEvent
  | AssistantEvent
  | ToolCallEvent
  | { type: string; [key: string]: any }; // forward-compat for unknown events

// ---------------------------------------------------------------------------
// Parsed summary
// ---------------------------------------------------------------------------

export interface ToolCallSummary {
  callId: string;
  toolName: string;
  args: Record<string, any>;
  result?: Record<string, any>;
  completed: boolean;
}

export interface StreamJsonSummary {
  model?: string;
  sessionId?: string;
  cwd?: string;
  assistantMessages: string[];
  toolCalls: ToolCallSummary[];
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Parse the full stdout of a `--output-format stream-json` CLI run. */
export function parseStreamJsonOutput(stdout: string): StreamJsonSummary {
  const summary: StreamJsonSummary = {
    assistantMessages: [],
    toolCalls: [],
  };

  const toolMap = new Map<string, ToolCallSummary>();

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event: CursorStreamEvent;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue; // skip non-JSON lines (e.g. Cursor CLI banners)
    }

    if (!event || typeof event.type !== "string") continue;

    switch (event.type) {
      case "system": {
        const e = event as SystemInitEvent;
        if (e.subtype === "init") {
          summary.model = e.model;
          summary.sessionId = e.session_id;
          summary.cwd = e.cwd;
        }
        break;
      }

      case "assistant": {
        const e = event as AssistantEvent;
        const text = extractContentText(e.message?.content);
        if (text) summary.assistantMessages.push(text);
        break;
      }

      case "tool_call": {
        const e = event as ToolCallEvent;
        const { toolName, args, result } = describeToolCall(e.tool_call);

        if (e.subtype === "started") {
          const entry: ToolCallSummary = {
            callId: e.call_id,
            toolName,
            args,
            completed: false,
          };
          toolMap.set(e.call_id, entry);
          summary.toolCalls.push(entry);
        } else if (e.subtype === "completed") {
          const existing = toolMap.get(e.call_id);
          if (existing) {
            existing.completed = true;
            existing.result = result;
          } else {
            summary.toolCalls.push({
              callId: e.call_id,
              toolName,
              args,
              result,
              completed: true,
            });
          }
        }
        break;
      }

      // Unknown event types are silently ignored for forward-compat.
      default:
        break;
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Produce a human-readable summary of a stream-json run. */
export function formatStreamJsonSummary(summary: StreamJsonSummary): string {
  const sections: string[] = [];

  // Header
  const headerParts: string[] = [];
  if (summary.model) headerParts.push(`Model: ${summary.model}`);
  if (summary.sessionId) headerParts.push(`Session: ${summary.sessionId}`);
  if (headerParts.length) sections.push(headerParts.join("\n"));

  // Tool calls
  if (summary.toolCalls.length > 0) {
    const lines = [`## Tool Calls (${summary.toolCalls.length})`];
    for (let i = 0; i < summary.toolCalls.length; i++) {
      const tc = summary.toolCalls[i];
      const argStr = formatArgs(tc.args);
      const resultStr = tc.completed ? formatToolResult(tc.result) : "(running)";
      lines.push(`${i + 1}. ${tc.toolName}(${argStr}) -> ${resultStr}`);
    }
    sections.push(lines.join("\n"));
  }

  // Assistant response
  if (summary.assistantMessages.length > 0) {
    sections.push(
      "## Assistant Response\n" + summary.assistantMessages.join("\n\n"),
    );
  }

  return sections.join("\n\n");
}

/** Extract only the final assistant text (for use in the bridge). */
export function extractAssistantText(summary: StreamJsonSummary): string {
  return summary.assistantMessages.join("\n\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractContentText(
  content: Array<{ type: string; text?: string }> | undefined,
): string {
  if (!content || !Array.isArray(content)) return "";
  return content
    .map((part) => (part.type === "text" && part.text ? part.text : ""))
    .join("");
}

/**
 * Cursor's tool_call object uses keys like `readToolCall`, `editToolCall`,
 * `shellToolCall`, etc. Extract the tool name and args/result from whichever
 * key is present.
 */
function describeToolCall(tc: Record<string, any>): {
  toolName: string;
  args: Record<string, any>;
  result?: Record<string, any>;
} {
  if (!tc || typeof tc !== "object") {
    return { toolName: "unknown", args: {} };
  }

  for (const key of Object.keys(tc)) {
    if (!key.endsWith("ToolCall") && !key.endsWith("toolCall")) continue;
    const inner = tc[key];
    if (!inner || typeof inner !== "object") continue;

    // Derive a readable name: "readToolCall" -> "read", "editToolCall" -> "edit"
    const toolName = key.replace(/[Tt]oolCall$/, "") || key;
    const { args, result, ...rest } = inner;
    return {
      toolName,
      args: args ?? rest,
      result: result ?? undefined,
    };
  }

  // Fallback: use the first key as the tool name
  const firstKey = Object.keys(tc)[0];
  if (firstKey) {
    const inner = tc[firstKey];
    return {
      toolName: firstKey,
      args: typeof inner === "object" ? (inner?.args ?? inner) : {},
      result: typeof inner === "object" ? inner?.result : undefined,
    };
  }

  return { toolName: "unknown", args: {} };
}

function formatArgs(args: Record<string, any>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return "";
  // Show at most 3 args, truncate long values
  return entries
    .slice(0, 3)
    .map(([k, v]) => {
      const val = typeof v === "string" ? truncate(v, 60) : JSON.stringify(v);
      return `${k}: ${val}`;
    })
    .join(", ");
}

function formatToolResult(result: Record<string, any> | undefined): string {
  if (!result) return "done";

  // Check for common result shapes from Cursor CLI
  if ("success" in result) {
    const s = result.success;
    if (s?.totalLines != null) return `${s.totalLines} lines read`;
    if (s?.content != null) return `success (${truncate(String(s.content), 40)})`;
    return "success";
  }
  if ("error" in result) {
    return `error: ${truncate(String(result.error), 60)}`;
  }

  return "done";
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return JSON.stringify(s);
  return JSON.stringify(s.slice(0, max - 3) + "...");
}
