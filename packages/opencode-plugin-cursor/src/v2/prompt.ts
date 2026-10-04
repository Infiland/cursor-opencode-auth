import type { LanguageModelV3Prompt, LanguageModelV3ToolResultOutput } from "@ai-sdk/provider";
import { buildPrompt } from "cursor-openai-bridge";

function toolOutputText(output: LanguageModelV3ToolResultOutput): string {
  switch (output.type) {
    case "text":
    case "error-text":
      return output.value;
    case "json":
    case "error-json":
      return JSON.stringify(output.value);
    case "execution-denied":
      return `Execution denied${output.reason ? `: ${output.reason}` : ""}`;
    case "content":
      return output.value.map((part) => (part.type === "text" ? part.text : "[media omitted]")).join("\n");
    default:
      return "";
  }
}

/**
 * Flatten an AI SDK prompt into the single message Cursor CLI takes, using the
 * same transcript format as the OpenAI-compatible bridge.
 */
export function promptFromV3(prompt: LanguageModelV3Prompt, opts: { clientTools: boolean }): string {
  const messages: Record<string, unknown>[] = [];
  for (const message of prompt) {
    switch (message.role) {
      case "system":
        messages.push({ role: "system", content: message.content });
        break;
      case "user":
        messages.push({
          role: "user",
          content: message.content.map((part) =>
            part.type === "text"
              ? { type: "text", text: part.text }
              : { type: part.mediaType.startsWith("image/") ? "image_url" : "file" },
          ),
        });
        break;
      case "assistant": {
        const text = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
        const toolCalls = message.content.flatMap((part) =>
          part.type === "tool-call"
            ? [
                {
                  id: part.toolCallId,
                  type: "function",
                  function: { name: part.toolName, arguments: JSON.stringify(part.input ?? {}) },
                },
              ]
            : [],
        );
        messages.push({ role: "assistant", content: text || null, tool_calls: toolCalls });
        for (const part of message.content) {
          if (part.type !== "tool-result") continue;
          messages.push({ role: "tool", tool_call_id: part.toolCallId, name: part.toolName, content: toolOutputText(part.output) });
        }
        break;
      }
      case "tool":
        for (const part of message.content) {
          if (part.type !== "tool-result") continue;
          messages.push({ role: "tool", tool_call_id: part.toolCallId, name: part.toolName, content: toolOutputText(part.output) });
        }
        break;
    }
  }
  return buildPrompt(messages, { clientTools: opts.clientTools });
}
