import type { Plugin } from "@opencode/plugin";

/** Minimal stand-ins for the OpenCode 2.0 plugin context, enough for this plugin's setup. */

type ProviderEditor = Parameters<Parameters<Plugin.Context["provider"]["transform"]>[0]>[0];
type ToolEditor = Parameters<Parameters<Plugin.Context["tool"]["transform"]>[0]>[0];
type ToolContext = Parameters<Parameters<ToolEditor["add"]>[0]["execute"]>[1];

export type ProviderDraft = {
  id: string;
  name: string;
  activation: string;
  package: string;
  settings?: Record<string, unknown>;
};

export type ModelDraft = {
  id: string;
  modelID: string;
  providerID: string;
  name: string;
  family?: string;
  capabilities: { tools: boolean; input: string[]; output: string[] };
  limit: { context: number; input?: number; output: number };
  status: string;
  enabled: boolean;
};

export type RegisteredTool = {
  name: string;
  description: string;
  input: Record<string, unknown>;
  options?: { namespace?: string };
  execute: (input: unknown, ctx: ToolContext) => Promise<{ content: unknown }>;
};

/** Drafts start like OpenCode's `Provider.Info.empty` / `Model.Info.default`, plus any seeded fields. */
export function fakeProviderEditor(
  seedProviders: Record<string, Partial<ProviderDraft>> = {},
  seedModels: Record<string, Partial<ModelDraft>> = {},
) {
  const providers = new Map<string, ProviderDraft>();
  const models = new Map<string, ModelDraft>();
  const editor = {
    update(id: string, update: (draft: ProviderDraft) => void) {
      const draft = providers.get(id) ?? { id, name: id, activation: "auto", package: "", ...seedProviders[id] };
      update(draft);
      providers.set(id, draft);
    },
    models: {
      update(providerID: string, modelID: string, update: (draft: ModelDraft) => void) {
        const key = `${providerID}/${modelID}`;
        const draft = models.get(key) ?? {
          id: modelID,
          modelID,
          providerID,
          name: modelID,
          capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
          limit: { context: 200_000, output: 32_000 },
          status: "active",
          enabled: true,
          ...seedModels[key],
        };
        update(draft);
        models.set(key, draft);
      },
    },
  };
  return { editor: editor as unknown as ProviderEditor, providers, models };
}

export function fakeToolEditor() {
  const namespaces: { name: string; description?: string }[] = [];
  const tools = new Map<string, RegisteredTool>();
  const editor = {
    namespace(namespace: { name: string; description?: string }) {
      namespaces.push(namespace);
    },
    add(tool: RegisteredTool) {
      const namespace = tool.options?.namespace;
      tools.set(namespace ? `${namespace}_${tool.name}` : tool.name, tool);
    },
  };
  return { editor: editor as unknown as ToolEditor, namespaces, tools };
}

export function fakeToolContext(signal = new AbortController().signal) {
  const progress: Record<string, unknown>[] = [];
  const ctx = {
    sessionID: "ses_test",
    messageID: "msg_test",
    agent: "build",
    signal,
    progress: async (update: Record<string, unknown>) => {
      progress.push(update);
    },
  };
  return { ctx: ctx as unknown as ToolContext, progress };
}

/**
 * A fake OpenCode 2.0 location. Provider transforms are kept and re-applied to
 * a fresh editor on every reload, like OpenCode's provider rebuilds.
 */
export function fakeOpenCode2(opts: { directory: string; project?: string; options?: Record<string, unknown> }) {
  const transforms: ((editor: ProviderEditor) => void)[] = [];
  let state = fakeProviderEditor();
  let reloads = 0;
  let waiters: (() => void)[] = [];
  const tools = fakeToolEditor();
  let toolTransforms = 0;
  const registration = { dispose: async () => undefined };
  const project = opts.project ?? opts.directory;

  const ctx = {
    location: { directory: opts.directory, project: { id: "prj_test", directory: project, canonical: project } },
    options: opts.options ?? {},
    provider: {
      transform: async (callback: (editor: ProviderEditor) => void) => {
        transforms.push(callback);
        callback(state.editor);
        return registration;
      },
      reload: async () => {
        reloads++;
        state = fakeProviderEditor();
        for (const transform of transforms) transform(state.editor);
        const pending = waiters;
        waiters = [];
        for (const resolve of pending) resolve();
      },
    },
    tool: {
      transform: async (callback: (editor: ToolEditor) => void) => {
        toolTransforms++;
        callback(tools.editor);
        return registration;
      },
    },
  };

  return {
    ctx: ctx as unknown as Plugin.Context,
    get providers() {
      return state.providers;
    },
    get models() {
      return state.models;
    },
    get reloads() {
      return reloads;
    },
    get providerTransforms() {
      return transforms.length;
    },
    get toolTransforms() {
      return toolTransforms;
    },
    tools: tools.tools,
    namespaces: tools.namespaces,
    nextReload: () => new Promise<void>((resolve) => waiters.push(resolve)),
  };
}
