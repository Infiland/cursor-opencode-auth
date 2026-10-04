import { parseStreamJson, toolTarget, type CursorUsage } from "cursor-openai-bridge";

export type ToolActivity = { name: string; target?: string; ok?: boolean; error?: string };

export type RunSummary = {
  model?: string;
  sessionId?: string;
  text: string;
  reasoning: string;
  tools: ToolActivity[];
  isError: boolean;
  errors: string[];
  durationMs?: number;
  usage?: CursorUsage;
};

/** Summarise the stdout of a `--output-format stream-json` run. */
export function summarizeStreamJson(stdout: string): RunSummary {
  const { events, parser } = parseStreamJson(stdout);
  const summary: RunSummary = { text: "", reasoning: "", tools: [], isError: false, errors: [] };
  const byCall = new Map<string, ToolActivity>();
  let resultText: string | undefined;

  for (const event of events) {
    switch (event.type) {
      case "init":
        summary.model = event.model;
        summary.sessionId = event.sessionId;
        break;
      case "reasoning":
        summary.reasoning += event.text;
        break;
      case "tool-started": {
        const entry: ToolActivity = { name: event.name, target: toolTarget(event.args) };
        summary.tools.push(entry);
        if (event.callId) byCall.set(event.callId, entry);
        break;
      }
      case "tool-completed": {
        const entry = (event.callId && byCall.get(event.callId)) || { name: event.name, target: toolTarget(event.args) };
        if (!summary.tools.includes(entry)) summary.tools.push(entry);
        entry.ok = event.ok;
        entry.error = event.error;
        break;
      }
      case "result":
        summary.isError = event.isError;
        summary.durationMs = event.durationMs;
        summary.usage = event.usage;
        resultText = event.text;
        break;
      case "error":
        summary.errors.push(event.message);
        break;
      default:
        break;
    }
  }
  summary.text = parser.text || resultText || "";
  return summary;
}

export function formatRunSummary(summary: RunSummary): string {
  const sections: string[] = [];
  const header = [
    summary.model && `Model: ${summary.model}`,
    summary.sessionId && `Session: ${summary.sessionId}`,
    summary.durationMs !== undefined && `Duration: ${(summary.durationMs / 1000).toFixed(1)}s`,
  ].filter(Boolean);
  if (header.length) sections.push(header.join(" · "));

  if (summary.tools.length) {
    const lines = summary.tools.map((t, i) => {
      const status = t.ok === undefined ? "(no result)" : t.ok ? "ok" : `failed${t.error ? `: ${t.error}` : ""}`;
      return `${i + 1}. ${t.name}${t.target ? ` ${t.target}` : ""} — ${status}`;
    });
    sections.push(`## Tool Calls (${summary.tools.length})\n${lines.join("\n")}`);
  }
  if (summary.errors.length) sections.push(`## Errors\n${summary.errors.join("\n")}`);
  if (summary.text) sections.push(`## Assistant Response\n${summary.text}`);
  return sections.join("\n\n");
}
