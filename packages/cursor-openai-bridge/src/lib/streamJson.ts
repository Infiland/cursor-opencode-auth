/**
 * Minimal parser for Cursor CLI `--output-format stream-json` NDJSON output.
 *
 * The bridge only needs the final assistant text to return as an
 * OpenAI-compatible completion response.
 */

/** Extract all assistant message text from stream-json NDJSON output. */
export function extractAssistantText(stdout: string): string {
  const parts: string[] = [];

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (event?.type === "assistant") {
      const content = event.message?.content;
      if (Array.isArray(content)) {
        const text = content
          .map((p: any) => (p?.type === "text" && p?.text ? p.text : ""))
          .join("");
        if (text) parts.push(text);
      }
    }
  }

  return parts.join("\n\n");
}
