import type { CursorToolCall } from "./streamJson.js";

const TARGET_KEYS = [
  "path",
  "file_path",
  "filePath",
  "target_file",
  "targetFile",
  "command",
  "pattern",
  "query",
  "url",
  "glob",
  "globPattern",
  "directory",
  "dir",
];

function oneLine(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The most informative argument of a Cursor tool call, e.g. the file it reads. */
export function toolTarget(args: Record<string, unknown>): string | undefined {
  for (const key of TARGET_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return oneLine(value, 160);
  }
  return undefined;
}

/** One reasoning line describing a tool Cursor started. */
export function describeToolStart(call: CursorToolCall): string {
  const target = toolTarget(call.args);
  return `[cursor] ${call.name}${target ? `: ${target}` : ""}\n`;
}

/** One reasoning line describing a tool call that failed. */
export function describeToolFailure(call: CursorToolCall, error: string | undefined): string {
  return `[cursor] ${call.name} failed${error ? `: ${oneLine(error, 200)}` : ""}\n`;
}
