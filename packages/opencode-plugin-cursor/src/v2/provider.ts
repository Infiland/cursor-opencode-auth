import { CursorLanguageModel, readModelSettings } from "./languageModel.js";

/**
 * AI SDK provider factory for OpenCode 2.0. OpenCode loads this module through
 * the provider's `aisdk:file://...` package and calls its first `create*` export
 * with the provider settings, so keep it the only `create*` export here.
 */
export function createCursor(options: Record<string, unknown> = {}) {
  const settings = readModelSettings(options);
  const languageModel = (modelId: string) => new CursorLanguageModel(modelId, settings);
  const unsupported = (kind: string) => () => {
    throw new Error(`Cursor does not provide ${kind} models`);
  };
  return Object.assign(languageModel, {
    specificationVersion: "v3" as const,
    languageModel,
    chat: languageModel,
    embeddingModel: unsupported("embedding"),
    textEmbeddingModel: unsupported("embedding"),
    imageModel: unsupported("image"),
  });
}
