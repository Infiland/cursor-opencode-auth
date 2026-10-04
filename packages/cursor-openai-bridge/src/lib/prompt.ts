/**
 * Flattens an OpenAI chat transcript into a single prompt for Cursor CLI,
 * which takes one user message per run.
 */

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (!isRecord(part)) continue;
    if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
    else if (part.type === "image_url" || part.type === "image" || part.type === "input_image") {
      parts.push("[image omitted: Cursor CLI accepts text only]");
    } else if (part.type === "file" || part.type === "input_file") parts.push("[file attachment omitted]");
  }
  return parts.join("");
}

function toolCallsOf(message: Json): { id: string; name: string; args: string }[] {
  if (!Array.isArray(message.tool_calls)) return [];
  const calls: { id: string; name: string; args: string }[] = [];
  for (const call of message.tool_calls) {
    if (!isRecord(call)) continue;
    const fn = isRecord(call.function) ? call.function : {};
    calls.push({
      id: typeof call.id === "string" ? call.id : "",
      name: typeof fn.name === "string" ? fn.name : "tool",
      args: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
    });
  }
  return calls;
}

export type BuildPromptOptions = {
  /** The client sent tool definitions that the bridge cannot honour. */
  clientTools?: boolean;
};

export const CLIENT_TOOLS_NOTE =
  "Note: this conversation reaches you from a client whose tools you cannot call. " +
  "Do not emit tool-call syntax for them; use your own tools and capabilities instead.";

export function buildPrompt(messages: unknown, opts: BuildPromptOptions = {}): string {
  const list = Array.isArray(messages) ? messages.filter(isRecord) : [];
  const system: string[] = [];
  const turns: string[] = [];
  const toolNames = new Map<string, string>();

  for (const message of list) {
    const role = message.role;
    const text = contentToText(message.content);

    if (role === "system" || role === "developer") {
      if (text) system.push(text);
      continue;
    }
    if (role === "user") {
      if (text) turns.push(`User: ${text}`);
      continue;
    }
    if (role === "assistant") {
      const lines: string[] = [];
      if (text) lines.push(`Assistant: ${text}`);
      for (const call of toolCallsOf(message)) {
        if (call.id) toolNames.set(call.id, call.name);
        lines.push(`Assistant called tool \`${call.name}\`${call.id ? ` (${call.id})` : ""} with: ${call.args}`);
      }
      if (lines.length) turns.push(lines.join("\n"));
      continue;
    }
    if (role === "tool" || role === "function") {
      const id = typeof message.tool_call_id === "string" ? message.tool_call_id : "";
      const name = toolNames.get(id) ?? (typeof message.name === "string" ? message.name : "tool");
      turns.push(`Tool result from \`${name}\`${id ? ` (${id})` : ""}:\n${text}`);
    }
  }

  if (opts.clientTools) system.push(CLIENT_TOOLS_NOTE);

  // A lone user message needs no transcript framing.
  if (system.length === 0 && turns.length === 1 && turns[0].startsWith("User: ")) {
    return turns[0].slice("User: ".length);
  }

  const sections: string[] = [];
  if (system.length) sections.push(`System:\n${system.join("\n\n")}`);
  if (turns.length) sections.push(turns.join("\n\n"));
  sections.push("Assistant:");
  return sections.join("\n\n");
}
