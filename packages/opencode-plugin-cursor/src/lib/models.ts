import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

import { listCursorModels, type CursorCliModel } from "cursor-openai-bridge";

export type { CursorCliModel } from "cursor-openai-bridge";

const FRESH_MS = 10 * 60_000;

type CacheFile = { at: number; agentBin: string; models: CursorCliModel[] };

let memory: CacheFile | undefined;
let inflight: { agentBin: string; models: Promise<CursorCliModel[]> } | undefined;

function cacheFile(): string {
  const base = process.env.XDG_CACHE_HOME || path.join(homedir(), ".cache");
  return path.join(base, "opencode-plugin-cursor", "models.json");
}

function isModel(value: unknown): value is CursorCliModel {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as CursorCliModel).id === "string" &&
    typeof (value as CursorCliModel).name === "string"
  );
}

/** Last known model list for this CLI binary, without running it. */
export async function cachedModels(agentBin: string): Promise<CursorCliModel[] | undefined> {
  if (memory?.agentBin === agentBin) return memory.models;
  try {
    const parsed = JSON.parse(await readFile(cacheFile(), "utf8")) as Partial<CacheFile>;
    if (parsed.agentBin !== agentBin || !Array.isArray(parsed.models)) return undefined;
    const models = parsed.models.filter(isModel);
    if (models.length === 0) return undefined;
    memory = { at: typeof parsed.at === "number" ? parsed.at : 0, agentBin, models };
    return models;
  } catch {
    return undefined;
  }
}

/**
 * Ask Cursor CLI for its models. Results are shared by concurrent callers,
 * kept fresh for a few minutes, and persisted so the next start is instant.
 */
export async function discoverModels(agentBin: string, opts: { force?: boolean } = {}): Promise<CursorCliModel[]> {
  if (!opts.force && memory?.agentBin === agentBin && Date.now() - memory.at < FRESH_MS) return memory.models;
  if (inflight?.agentBin === agentBin) return inflight.models;
  const models = listCursorModels({ agentBin, timeoutMs: 60_000 })
    .then(async (list) => {
      if (list.length === 0) throw new Error("Cursor CLI returned no models (try: agent --list-models)");
      memory = { at: Date.now(), agentBin, models: list };
      const file = cacheFile();
      await mkdir(path.dirname(file), { recursive: true })
        .then(() => writeFile(file, JSON.stringify(memory), "utf8"))
        .catch(() => undefined);
      return list;
    })
    .finally(() => {
      if (inflight?.models === models) inflight = undefined;
    });
  inflight = { agentBin, models };
  return models;
}

export function sameModels(a: CursorCliModel[], b: CursorCliModel[]): boolean {
  return a.length === b.length && a.every((m, i) => m.id === b[i].id && m.name === b[i].name);
}

/** Drop the in-memory cache (tests). */
export function resetModelCache() {
  memory = undefined;
  inflight = undefined;
}
