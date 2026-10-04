import { readFileSync } from "node:fs";

let cached: string | undefined;

/** Version from this package's package.json (resolves the same from src/ and dist/). */
export function bridgeVersion(): string {
  if (cached) return cached;
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      version?: unknown;
    };
    cached = typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    cached = "0.0.0";
  }
  return cached;
}
