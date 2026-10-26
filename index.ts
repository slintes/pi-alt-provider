import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  isModelType,
  lazyStream,
  type AnyModel,
  type ApiKeyAuth,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Credential,
  type Model,
  type TranscriptContext,
  type Provider,
  type ProviderHeaders,
  type ProviderRequestOptions,
  type Static,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { getAgentDir, ModelRuntime, readStoredCredential, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Compile } from "typebox/compile";

// Resolve beside Pi's mapped provider entry; its loader aliases other pi-ai subpaths.
const { ProviderCompatSchema } = createRequire(import.meta.resolve("@earendil-works/pi-ai/providers/all"))(
  "./compat-schema.js",
) as typeof import("@earendil-works/pi-ai/providers/compat-schema");
const validateCompat = Compile(ProviderCompatSchema);

interface Overrides {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  headers?: ProviderHeaders;
  compat?: Static<typeof ProviderCompatSchema>;
}

export interface ProviderDefinition {
  name: string;
  originalProvider: string;
  overrides: Overrides;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: string[], location: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`${location}: unsupported setting "${key}"`);
  }
}

const BUILTIN_PROVIDER_IDS = new Set(builtinProviders().map((provider) => provider.id));
const ENV_REFERENCE = /\$\$|\$(?:\{([a-zA-Z_][a-zA-Z0-9_]*)\}|([a-zA-Z_][a-zA-Z0-9_]*))/g;

function interpolateValue(value: string, env: (name: string) => string | undefined): string | undefined {
  let missing = false;
  const resolved = value.replace(ENV_REFERENCE, (match, braced: string | undefined, plain: string | undefined) => {
    if (match === "$$") return "$";
    const replacement = env((braced ?? plain)!);
    if (replacement === undefined || replacement === "") missing = true;
    return replacement ?? "";
  });
  return missing ? undefined : resolved;
}

export function parseConfig(value: unknown): ProviderDefinition[] {
  if (!isObject(value)) throw new Error("altprovider.json must contain an object");
  onlyKeys(value, ["providers"], "altprovider.json");
  if (!Array.isArray(value.providers)) throw new Error("altprovider.json: providers must be an array");
  const names = new Set<string>();
  return value.providers.map((entry, index) => {
    const location = `altprovider.json: providers[${index}]`;
    if (!isObject(entry)) throw new Error(`${location} must be an object`);
    onlyKeys(entry, ["name", "originalProvider", "overrides"], location);
    for (const key of ["name", "originalProvider"]) {
      if (typeof entry[key] !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(entry[key])) {
        throw new Error(`${location}: ${key} must be a provider ID (letters, digits, dots, underscores, hyphens)`);
      }
    }
    const name = entry.name as string;
    if (names.has(name)) throw new Error(`${location}: duplicate provider name "${name}"`);
    names.add(name);
    const settings = entry.overrides === undefined ? {} : entry.overrides;
    if (!isObject(settings)) throw new Error(`${location}: overrides must be an object`);
    const overrides = { ...settings };
    onlyKeys(overrides, ["name", "baseUrl", "apiKey", "headers", "compat"], `${location}.overrides`);
    for (const key of ["name", "baseUrl", "apiKey"]) {
      if (key in overrides && (typeof overrides[key] !== "string" || !overrides[key].trim())) {
        throw new Error(`${location}: overrides.${key} must be a non-empty string`);
      }
    }
    for (const key of ["name", "baseUrl"]) {
      if (typeof overrides[key] !== "string") continue;
      const resolved = interpolateValue(overrides[key], (name) => process.env[name]);
      if (resolved === undefined) throw new Error(`${location}: overrides.${key} environment variable is not set or is empty`);
      if (!resolved.trim()) throw new Error(`${location}: overrides.${key} must resolve to a non-empty string`);
      overrides[key] = resolved;
    }
    if (overrides.baseUrl !== undefined) {
      let url: URL;
      try {
        url = new URL(overrides.baseUrl as string);
      } catch {
        throw new Error(`${location}: overrides.baseUrl must be an absolute HTTP(S) URL`);
      }
      if (!["http:", "https:"].includes(url.protocol)) {
        throw new Error(`${location}: overrides.baseUrl must be an absolute HTTP(S) URL`);
      }
    }
    if (overrides.headers !== undefined) {
      if (!isObject(overrides.headers)) throw new Error(`${location}: overrides.headers must be an object`);
      for (const [key, header] of Object.entries(overrides.headers)) {
        if (header !== null && typeof header !== "string") {
          throw new Error(`${location}: header values must be strings or null`);
        }
        try {
          new Headers({ [key]: header ?? "" });
        } catch {
          throw new Error(`${location}: invalid HTTP header`);
        }
      }
    }
    if (overrides.compat !== undefined && !validateCompat.Check(overrides.compat)) {
      throw new Error(`${location}: overrides.compat must be a valid compatibility object`);
    }
    return { name, originalProvider: entry.originalProvider as string, overrides: overrides as Overrides };
  });
}

async function resolveValue(value: string, env: (name: string) => Promise<string | undefined>): Promise<string | undefined> {
  const names = new Set([...value.matchAll(ENV_REFERENCE)]
    .filter((match) => match[0] !== "$$").map((match) => match[1] ?? match[2]));
  const values = new Map(await Promise.all([...names].map(async (name) => [name, await env(name)] as const)));
  return interpolateValue(value, (name) => values.get(name));
}

function mergeHeaders(...sources: (ProviderHeaders | undefined)[]): ProviderHeaders {
  const headers: ProviderHeaders = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source ?? {})) headers[key.toLowerCase()] = value;
  }
  return headers;
}

function mergeCompat(base: Record<string, unknown> | undefined, override: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...base, ...override };
  for (const key of ["openRouterRouting", "vercelGatewayRouting", "chatTemplateKwargs", "chatTemplateArgs"]) {
    if (isObject(base?.[key]) && isObject(override[key])) merged[key] = { ...base[key], ...override[key] };
  }
  return merged;
}

function operationError<T extends AnyModel>(model: T, error: unknown, aborted?: boolean) {
  return {
    api: model.api, provider: model.provider, model: model.id,
    stopReason: aborted ? "aborted" as const : "error" as const,
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
}

export function inheritProvider(definition: ProviderDefinition, runtime: ModelRuntime): Provider {
  const { name, originalProvider, overrides } = definition;
  const original = runtime.getProvider(originalProvider);
  if (!original) throw new Error(`Unknown original provider "${originalProvider}" for "${name}"`);
  // models.json creates empty placeholders for metadata-only extension overlays.
  if (name === originalProvider || BUILTIN_PROVIDER_IDS.has(name) ||
    runtime.getRegisteredProviderIds().includes(name) || runtime.getProvider(name)?.auth.oauth ||
    runtime.getAllModels(name).length > 0) {
    throw new Error(`Provider "${name}" already exists; choose a new name`);
  }

  const allModels = () => original.getAllModels?.() ?? original.getModels();
  const copyModel = <T extends AnyModel>(model: T): T => ({
    ...model,
    provider: name,
    baseUrl: overrides.baseUrl ?? model.baseUrl,
    // Resolve original headers at request time, including models.json interpolation.
    headers: undefined,
  });
  const copyCatalogModel = <T extends AnyModel>(model: T): T => ({
    ...copyModel(model),
    ...(overrides.compat && isModelType(model, "chat") ? { compat: mergeCompat(model.compat, overrides.compat) } : {}),
  });
  const credential = (own?: Credential): Credential | undefined =>
    (own?.type === "oauth" || own?.key || own?.env ? own : undefined)
    ?? (overrides.apiKey !== undefined ? { type: "api_key" } : readStoredCredential(originalProvider));
  const check: NonNullable<ApiKeyAuth["check"]> = async (input) => {
    input.signal.throwIfAborted();
    if (input.credential?.key) return { type: "api_key", source: "request API key" };
    if (overrides.apiKey !== undefined) {
      const key = await resolveValue(overrides.apiKey, (key) => input.ctx.env(key));
      return key ? { type: "api_key", source: "configured API key" } : undefined;
    }
    return runtime.checkAuth(originalProvider, { signal: input.signal });
  };

  const prepare = async <T extends AnyModel, O extends ProviderRequestOptions<T>>(model: T, options?: O) => {
    const env = async (key: string) => options?.env?.[key] ?? process.env[key];
    const configuredKey = overrides.apiKey === undefined ? undefined : await resolveValue(overrides.apiKey, env);
    if (overrides.apiKey !== undefined && !configuredKey && options?.apiKey === undefined) {
      throw new Error(`Provider "${name}": apiKey environment variable is not set`);
    }
    const apiKey = options?.apiKey ?? configuredKey;
    const sourceModel = allModels().find((entry) => entry.id === model.id && (entry.type ?? "chat") === (model.type ?? "chat"));
    const auth = apiKey !== undefined && !original.auth.apiKey
      ? { auth: { apiKey }, env: options?.env }
      : await runtime.getAuth({ ...model, provider: originalProvider, headers: sourceModel?.headers }, {
        apiKey,
        env: options?.env,
        signal: options?.signal,
      });
    if (!auth && apiKey === undefined) throw new Error(`Provider "${originalProvider}" is not authenticated`);
    const headers: ProviderHeaders = {};
    for (const [key, value] of Object.entries(overrides.headers ?? {})) {
      const resolved = value === null ? null : await resolveValue(value, async (key) => auth?.env?.[key] ?? env(key));
      if (resolved === undefined) throw new Error(`Provider "${name}": header environment variable is not set`);
      headers[key] = resolved;
    }
    return {
      model: {
        ...model,
        provider: originalProvider,
        headers: sourceModel?.headers,
        baseUrl: overrides.baseUrl ?? auth?.auth.baseUrl ?? model.baseUrl,
      },
      options: {
        ...options,
        apiKey: apiKey ?? auth?.auth.apiKey,
        headers: mergeHeaders(original.headers, auth?.auth.headers, headers, options?.headers),
        env: { ...auth?.env, ...options?.env },
      } as O,
    };
  };

  // Built-in APIs branch on provider IDs; keep that identity on the wire, not in Pi's catalog.
  const sourceContext = (context: TranscriptContext): TranscriptContext => ({
    ...context,
    messages: context.messages.map((message) => message.role === "assistant" && message.provider === name
      ? { ...message, provider: originalProvider }
      : message),
  });
  const copyResponse = <T extends { provider: string }>(message: T): T => ({ ...message, provider: name });
  async function* aliasEvents(events: AsyncIterable<AssistantMessageEvent>, signal?: AbortSignal): AsyncGenerator<AssistantMessageEvent> {
    let partial: AssistantMessage | undefined;
    const relabel = (message: AssistantMessage): AssistantMessage => {
      partial = Object.assign(partial ?? {}, message, { provider: name });
      if (message.deferred) partial.deferred = { ...message.deferred, provider: name };
      return partial;
    };
    for await (const event of events) {
      if ("partial" in event) yield { ...event, partial: relabel(event.partial) };
      else if (event.type === "done") yield { ...event, message: relabel(event.message) };
      else {
        const error = relabel(event.error);
        if (signal?.aborted) error.stopReason = "aborted";
        yield { ...event, reason: error.stopReason === "aborted" ? "aborted" : "error", error };
      }
    }
  }
  const stream = (model: Model<string>, signal: AbortSignal | undefined, setup: () => Promise<AsyncIterable<AssistantMessageEvent>>) =>
    lazyStream(model, async () => aliasEvents(lazyStream({ ...model, provider: originalProvider }, setup), signal));

  const provider: Provider = {
    ...original,
    id: name,
    name: overrides.name ?? name,
    baseUrl: overrides.baseUrl ?? original.baseUrl,
    headers: undefined,
    // Authentication stays with the original provider; no credentials are copied.
    auth: {
      apiKey: {
        name: `Use ${original.name} authentication`,
        check,
        resolve: async (input) => {
          if (!(await check(input))) return undefined;
          const apiKey = input.credential?.key ?? (overrides.apiKey === undefined
            ? undefined
            : await resolveValue(overrides.apiKey, (key) => input.ctx.env(key)));
          return { auth: { apiKey }, env: input.credential?.env, source: `Inherited from ${originalProvider}` };
        },
      },
    },
    getModels: () => original.getModels().map(copyCatalogModel),
    getAllModels: () => allModels().map(copyCatalogModel),
    stream: (model, context, options) => stream(model, options?.signal, async () => {
      const request = await prepare(model, options);
      return original.stream(request.model, sourceContext(context), request.options);
    }),
    streamSimple: (model, context, options) => stream(model, options?.signal, async () => {
      const request = await prepare(model, options);
      return original.streamSimple(request.model, sourceContext(context), request.options);
    }),
  };
  if (original.filterModels) {
    provider.filterModels = (models, own) => original.filterModels!(
      models.map((model) => ({ ...model, provider: originalProvider })), credential(own),
    ).map(copyModel);
  }
  if (original.filterAllModels) {
    provider.filterAllModels = (models, own) => original.filterAllModels!(
      models.map((model) => ({ ...model, provider: originalProvider })), credential(own),
    ).map(copyModel);
  }
  if (original.refreshModels) {
    provider.refreshModels = async (context) => {
      let effective = credential(context.credential);
      if (context.allowNetwork && overrides.apiKey === undefined) {
        const auth = await runtime.getAuth(originalProvider, { signal: context.signal });
        effective = credential(context.credential) ?? (auth
          ? { type: "api_key", key: auth.auth.apiKey, env: auth.env }
          : undefined);
      }
      await original.refreshModels!({ ...context, credential: effective, baseUrl: overrides.baseUrl ?? context.baseUrl });
    };
  }
  if (original.fetchDeferred) {
    provider.fetchDeferred = (model, handle, options) => stream(model, options?.signal, async () => {
      const request = await prepare(model, options);
      return original.fetchDeferred!(request.model, { ...handle, provider: originalProvider }, request.options);
    });
  }
  if (original.cancelDeferred) {
    provider.cancelDeferred = async (model, handle, options) => {
      const request = await prepare(model, options);
      await original.cancelDeferred!(request.model, { ...handle, provider: originalProvider }, request.options);
    };
  }
  if (original.generateImages) {
    provider.generateImages = async (model, context, options) => {
      try {
        const request = await prepare(model, options);
        return copyResponse(await original.generateImages!(request.model, context, request.options));
      } catch (error) {
        return { ...operationError(model, error, options?.signal?.aborted), output: [] };
      }
    };
  }
  if (original.classify) {
    provider.classify = async (model, context, options) => {
      try {
        const request = await prepare(model, options);
        return copyResponse(await original.classify!(request.model, context, request.options));
      } catch (error) {
        return { ...operationError(model, error, options?.signal?.aborted), answers: {} };
      }
    };
  }
  return provider;
}

export default async function (pi: ExtensionAPI): Promise<void> {
  let text: string;
  try {
    text = await readFile(join(getAgentDir(), "altprovider.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch {
    throw new Error("pi-alt-provider: altprovider.json is not valid JSON");
  }
  const definitions = parseConfig(config);
  if (!definitions.length) return;
  const runtime = await ModelRuntime.create({ allowModelNetwork: false });
  const providers = definitions.map((definition) => inheritProvider(definition, runtime));
  for (const provider of providers) pi.registerProvider(provider);
}
