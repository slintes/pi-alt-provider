import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test, type TestContext } from "node:test";
import {
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  envApiKeyAuth,
  normalizeContext,
  type AnyModel,
  type AssistantMessage,
  type DeferredHandle,
  type Model,
  type Provider,
  type ProviderRequestOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { classifierErrorResult, imageErrorResult } from "@earendil-works/pi-ai/utils/model-operations";
import { createReadToolDefinition, ModelRuntime, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { inheritProvider, parseConfig, type ProviderDefinition } from "../index.ts";

const model: Model<string> = {
  type: "chat",
  id: "test-model",
  name: "Test model",
  api: "test-api",
  provider: "original",
  baseUrl: "https://original.invalid/v1",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
  contextWindow: 123456,
  maxTokens: 8192,
  promptCache: { short: 300 },
  thinkingLevelMap: { high: "high", max: null },
  samplingParams: { temperature: 0.7 },
  headers: { "X-Model": "model-header" },
};

function response(model: Model<string>, deferred?: DeferredHandle) {
  const message: AssistantMessage = {
    role: "assistant", provider: model.provider, api: model.api, model: model.id,
    content: [{ type: "text", text: "ok" }], stopReason: deferred ? "deferred" : "stop", deferred, timestamp: Date.now(),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: deferred ? "deferred" : "stop", message });
    stream.end();
  });
  return stream;
}

async function fixture(t: TestContext, modelsConfig?: unknown) {
  const directory = await mkdtemp(join(tmpdir(), "pi-alt-provider-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  });
  if (modelsConfig) await writeFile(join(directory, "models.json"), JSON.stringify(modelsConfig));
  const runtime = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
  return { runtime, directory };
}

function setEnv(t: TestContext, values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
}

const definition = (overrides: ProviderDefinition["overrides"] = {}): ProviderDefinition => ({
  name: "alternative", originalProvider: "original", overrides,
});

async function fakeOriginal(t: TestContext) {
  const { runtime, directory } = await fixture(t);
  const calls: { operation: string; model: AnyModel; context?: TranscriptContext; options?: Pick<ProviderRequestOptions<never>, "apiKey" | "headers" | "signal"> & { onPayload?: unknown } }[] = [];
  const stream = (model: Model<string>, context: TranscriptContext, options?: ProviderRequestOptions<Model<string>>) => {
    assert.equal(model.provider, "original", "preserve provider-specific protocol behavior");
    calls.push({ operation: "stream", model, context, options });
    return response(model);
  };
  const original = createProvider({
    id: "original", name: "Original", baseUrl: model.baseUrl,
    headers: { "X-Provider": "provider-header" },
    auth: { apiKey: {
      ...envApiKeyAuth("Original key", []),
      check: async () => ({ type: "api_key", source: "test" }),
      resolve: async (input) => ({ auth: { apiKey: input.credential?.key ?? "original-key", baseUrl: "https://auth.invalid/v1" } }),
    } },
    models: [model,
      { ...model, type: "image", api: "test-images", output: ["image"] },
      { ...model, type: "classifier", api: "test-classifier" },
    ],
    api: { stream, streamSimple: stream },
    images: { "test-images": { generateImages: async (model, _context, options) => {
      calls.push({ operation: "images", model, options });
      return imageErrorResult(model, new Error("fixture"));
    } } },
    classifiers: { "test-classifier": { classify: async (model, _context, options) => {
      calls.push({ operation: "classify", model, options });
      return classifierErrorResult(model, new Error("fixture"));
    } } },
  });
  runtime.registerNativeProvider(original);
  await runtime.refresh({ allowNetwork: false });
  return { runtime, directory, calls, original };
}

test("config accepts multiple providers, empty overrides, and null headers", () => {
  assert.deepEqual(parseConfig({ providers: [
    { name: "copy", originalProvider: "openai" },
    { name: "proxy", originalProvider: "anthropic", overrides: { baseUrl: "http://localhost:8000", headers: { Authorization: null } } },
  ] }), [
    { name: "copy", originalProvider: "openai", overrides: {} },
    { name: "proxy", originalProvider: "anthropic", overrides: { baseUrl: "http://localhost:8000", headers: { Authorization: null } } },
  ]);
});

test("config rejects malformed settings without leaking their values", () => {
  const entry = { name: "copy", originalProvider: "openai" };
  for (const value of [null, [], {}, { providers: {} }, { providers: [null] },
    { providers: [{ ...entry, name: "bad/name" }] },
    { providers: [{ ...entry, originalProvider: "" }] },
    { providers: [entry, entry] },
    { providers: [{ ...entry, overrides: [] }] },
    { providers: [{ ...entry, overrides: null }] },
    { providers: [{ ...entry, overrides: { baseURL: "secret-value" } }] },
    { providers: [{ ...entry, overrides: { baseUrl: "file:///secret-value" } }] },
    { providers: [{ ...entry, overrides: { baseUrl: "secret-value" } }] },
    { providers: [{ ...entry, overrides: { apiKey: 123 } }] },
    ...[null, [], false, "secret-value", { supportsMidConvoEffort: "secret-value" }, { chatTemplateKwargs: [] }]
      .map((compat) => ({ providers: [{ ...entry, overrides: { compat } }] })),
    { providers: [{ ...entry, overrides: { headers: { test: 123 } } }] },
    { providers: [{ ...entry, overrides: { headers: { test: "secret-value\r\nInjected: yes" } } }] },
  ]) {
    assert.throws(() => parseConfig(value), (error: Error) => error.message.includes("altprovider.json") && !error.message.includes("secret-value"));
  }
});

test("static overrides expand environment references before URL validation without mutating config", (t) => {
  const url = "https://proxy.invalid/v1";
  setEnv(t, {
    PI_ALT_TEST_BASE_URL: url,
    PI_ALT_TEST_SCHEME: "https",
    PI_ALT_TEST_HOST: "proxy.invalid",
    PI_ALT_TEST_PATH: "v1",
    PI_ALT_TEST_NAME: "My proxy",
    PI_ALT_TEST_MISSING: undefined,
    PI_ALT_TEST_EMPTY: "",
    PI_ALT_TEST_INVALID_URL: "file:///secret-value",
  });
  for (const baseUrl of ["$PI_ALT_TEST_BASE_URL", "${PI_ALT_TEST_BASE_URL}", "${PI_ALT_TEST_SCHEME}://$PI_ALT_TEST_HOST/${PI_ALT_TEST_PATH}"]) {
    const config = { providers: [definition({ baseUrl, name: "${PI_ALT_TEST_NAME} $$USD" })] };
    const before = structuredClone(config);
    assert.deepEqual(parseConfig(config)[0].overrides, { baseUrl: url, name: "My proxy $USD" });
    assert.deepEqual(config, before);
  }
  for (const baseUrl of ["$PI_ALT_TEST_MISSING", "https://${PI_ALT_TEST_MISSING}/v1", "$PI_ALT_TEST_EMPTY", "https://${PI_ALT_TEST_EMPTY}/v1", "$PI_ALT_TEST_INVALID_URL"]) {
    assert.throws(() => parseConfig({ providers: [definition({ baseUrl })] }), (error: Error) =>
      error.message.includes("overrides.baseUrl") && !error.message.includes("secret-value"));
  }
});

test("inherits every model type and metadata without mutating the original", async (t) => {
  const { runtime, original } = await fakeOriginal(t);
  const before = structuredClone(original.getAllModels!());
  const alias = inheritProvider(definition({ baseUrl: "https://proxy.invalid/v1" }), runtime);
  assert.equal(alias.id, "alternative");
  assert.equal(alias.name, "alternative");
  assert.equal(alias.getModels().length, 1);
  assert.equal(alias.getAllModels!().length, 3);
  for (const [index, copy] of alias.getAllModels!().entries()) {
    assert.deepEqual(copy, { ...before[index], provider: "alternative", baseUrl: "https://proxy.invalid/v1", headers: undefined });
  }
  assert.deepEqual(original.getAllModels!(), before);
  assert.throws(() => inheritProvider({ ...definition(), name: "openai" }, runtime), /already exists/);
  assert.throws(() => inheritProvider({ ...definition(), originalProvider: "missing" }, runtime), /Unknown original provider/);
});

test("metadata-only overlays do not permit replacing built-in, registered, or populated providers", async (t) => {
  const { runtime } = await fixture(t, { providers: {
    occupied: { baseUrl: "https://original.invalid/v1", api: "openai-completions", models: [{ id: "test-model" }] },
    "empty-config": { compat: { supportsMidConvoEffort: false } },
    "oauth-transport": { oauth: "radius", baseUrl: "https://radius.invalid" },
  } });
  const builtin = runtime.getProvider("openai")!;
  builtin.getModels = () => [];
  builtin.getAllModels = () => [];
  runtime.registerNativeProvider({ ...builtin, id: "empty-native" });
  runtime.registerProvider("empty-legacy", { baseUrl: "https://legacy.invalid/v1" });
  await runtime.refresh({ allowNetwork: false });
  for (const name of ["openai", "empty-native", "empty-legacy", "oauth-transport"]) {
    assert.equal(runtime.getAllModels(name).length, 0);
    assert.throws(() => inheritProvider({ name, originalProvider: "anthropic", overrides: {} }, runtime), /already exists/);
  }
  assert.ok(runtime.getAllModels("occupied").length > 0);
  assert.throws(() => inheritProvider({ name: "occupied", originalProvider: "anthropic", overrides: {} }, runtime), /already exists/);
  assert.throws(() => inheritProvider({ name: "empty-config", originalProvider: "empty-config", overrides: {} }, runtime), /already exists/);
});

for (const configFile of ["altprovider.json", "models.json"]) test(`${configFile} compat overrides disable message-level effort and strict tools only for alternative Anthropic models`, async (t) => {
  const { runtime } = await fixture(t, { providers: { alternative: {
    ...(configFile === "models.json" ? { compat: { supportsMidConvoEffort: false, supportsStrictTools: false } } : {}),
    modelOverrides: { "claude-sonnet-5-5": { name: "Proxy Sonnet", maxTokens: 4096 } },
  } } });
  assert.ok(runtime.getProvider("alternative"));
  assert.equal(runtime.getAllModels("alternative").length, 0);
  const originalModels = structuredClone(runtime.getAllModels("anthropic"));
  const alias = inheritProvider(parseConfig({ providers: [{ name: "alternative", originalProvider: "anthropic", overrides: {
    apiKey: "dummy-proxy-key", baseUrl: "https://must-not-be-contacted.invalid",
    ...(configFile === "altprovider.json" ? { compat: { supportsMidConvoEffort: false, supportsStrictTools: false } } : {}),
  } }] })[0], runtime);
  const target = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
  target.registerNativeProvider(alias);
  await target.refresh({ allowNetwork: false });
  assert.equal(target.getError(), undefined);
  assert.equal(target.getModel("alternative", "claude-sonnet-5-5")?.name, "Proxy Sonnet");
  assert.equal(target.getModel("alternative", "claude-sonnet-5-5")?.maxTokens, 4096);
  const previous = await response({ ...model, provider: "previous-provider" }).result();
  const tool = createReadToolDefinition(process.cwd());
  const context = normalizeContext({ tools: [tool], messages: Array.from({ length: 7 }, (_, index) => index % 2
    ? previous : { role: "user" as const, content: "Synthetic test message", timestamp: 0 }) });
  let fetches = 0;
  for (const [provider, id, reasoning] of [
    ["alternative", "claude-haiku-5-5", "low"],
    ["alternative", "claude-sonnet-5-5", "xhigh"],
    ["alternative", "claude-opus-5-5", "max"],
    ["anthropic", "claude-sonnet-5-5", "xhigh"],
  ] as const) {
    const selected = target.getModel(provider, id);
    assert.ok(selected);
    let payload: {
      messages: { output_config?: unknown }[];
      tools?: { name: string; strict?: boolean; input_schema: { type: string; required: string[] } }[];
      output_config?: { effort: string };
      thinking?: { type: string; block_binding?: unknown };
      betas?: string[];
    } | undefined;
    const result = await target.streamSimple(selected, context, {
      apiKey: "dummy-request-key", reasoning, maxTokens: 32, maxRetries: 0,
      fetch: async () => { fetches++; throw new Error("Unexpected network request"); },
      onPayload: (value) => { payload = value as typeof payload; throw new Error("Captured locally before sending"); },
    }).result();
    assert.equal(result.stopReason, "error");
    assert.equal(result.errorMessage, "Captured locally before sending");
    assert.ok(payload);
    const sentTool = payload.tools?.find((entry) => entry.name === tool.name);
    assert.ok(sentTool, "ordinary tool calling must remain available");
    assert.equal(sentTool.strict, provider === "alternative" ? undefined : true);
    assert.equal(sentTool.input_schema.type, "object");
    assert.ok(sentTool.input_schema.required.includes("path"));
    assert.equal(payload.thinking?.type, "adaptive");
    const markers = payload.messages.flatMap((message, index) => message.output_config ? [index] : []);
    if (provider === "alternative") {
      assert.deepEqual(markers, []);
      assert.equal(payload.output_config?.effort, reasoning);
      assert.equal(payload.thinking?.block_binding, undefined);
      assert.ok(!payload.betas?.some((beta) => /mid-conversation-output-config|thinking-binding-controls/.test(beta)));
    } else {
      assert.deepEqual(markers, [7]);
      assert.ok(payload.thinking?.block_binding);
    }
  }
  assert.equal(fetches, 0);
  assert.deepEqual(runtime.getAllModels("anthropic"), originalModels);
  assert.deepEqual(target.getAllModels("anthropic"), originalModels);
});

test("compat overrides merge into chat models without mutating sources or overriding filtered metadata", async (t) => {
  const { runtime, original: source, calls } = await fakeOriginal(t);
  const original: Provider = source;
  const models = original.getAllModels!();
  const chat = { ...original.getModels()[0], compat: {
    supportsMidConvoEffort: true, supportsStrictTools: true,
    chatTemplateKwargs: { preserved: true, replaced: "original" },
  } };
  original.getModels = () => [chat];
  original.getAllModels = () => [chat, ...models.slice(1)];
  original.filterModels = (models) => models;
  original.filterAllModels = (models) => models;
  const before = structuredClone(original.getAllModels!());
  const config = { providers: [definition({ compat: {
    supportsMidConvoEffort: false, chatTemplateKwargs: { replaced: "override", added: 42 },
  } })] };
  const inputBefore = structuredClone(config);
  const alias = inheritProvider(parseConfig(config)[0], runtime);
  const copied = alias.getModels()[0];
  assert.deepEqual(copied.compat, {
    supportsMidConvoEffort: false, supportsStrictTools: true,
    chatTemplateKwargs: { preserved: true, replaced: "override", added: 42 },
  });
  for (const index of [1, 2]) {
    assert.deepEqual(alias.getAllModels!()[index], { ...before[index], provider: "alternative", headers: undefined });
  }
  const overridden = { ...copied, compat: { ...copied.compat, supportsMidConvoEffort: true } };
  assert.deepEqual(alias.filterModels!([overridden], undefined)[0].compat, overridden.compat);
  assert.deepEqual(alias.filterAllModels!([overridden], undefined)[0], overridden);
  await alias.streamSimple(copied, normalizeContext({ messages: [] })).result();
  assert.deepEqual((calls[0].model as typeof copied).compat, copied.compat);
  assert.deepEqual(original.getAllModels!(), before);
  assert.deepEqual(config, inputBefore);
});

test("inherits auth, forwards stream options, and overrides credential-dependent endpoints", async (t) => {
  const { runtime, calls } = await fakeOriginal(t);
  const alias = inheritProvider(definition({ name: "My proxy", baseUrl: "https://proxy.invalid/v1" }), runtime);
  const models = createModels();
  models.setProvider(alias);
  assert.equal(alias.name, "My proxy");
  assert.ok(await models.checkAuth("alternative"));
  assert.equal(alias.auth.oauth, undefined);
  assert.equal(alias.auth.apiKey?.login, undefined);
  const signal = new AbortController().signal;
  const onPayload = () => {};
  const result = await models.completeSimple(alias.getModels()[0], { messages: [] }, {
    signal, onPayload, reasoning: "high", maxTokens: 17, headers: { "X-Request": "request-header" },
  });
  assert.equal(result.provider, "alternative");
  const history = normalizeContext({ messages: [result] });
  const events = [];
  for await (const event of alias.streamSimple(alias.getModels()[0], history)) events.push(event);
  assert.ok(events.every((event) => ("partial" in event ? event.partial : event.type === "done" ? event.message : event.error).provider === "alternative"));
  assert.ok(events[0].type === "start" && events[1].type === "done" && events[0].partial === events[1].message);
  assert.equal(calls[1].context?.messages[0].role === "assistant" && calls[1].context.messages[0].provider, "original");
  assert.equal(history.messages[0].role === "assistant" && history.messages[0].provider, "alternative");
  assert.equal(calls[0].model.baseUrl, "https://proxy.invalid/v1");
  assert.equal(calls[0].options?.apiKey, "original-key");
  assert.equal(calls[0].options?.signal, signal);
  assert.equal(calls[0].options?.onPayload, onPayload);
  assert.equal(calls[0].options?.headers?.["x-model"], "model-header");
  assert.equal(calls[0].options?.headers?.["x-provider"], "provider-header");
  assert.equal(calls[0].options?.headers?.["x-request"], "request-header");
  const unchanged = inheritProvider(definition(), runtime);
  await unchanged.stream(unchanged.getModels()[0], normalizeContext({ messages: [] })).result();
  assert.equal(calls[2].model.baseUrl, "https://auth.invalid/v1");
});

test("key and header overrides support env references, removal, and request precedence", async (t) => {
  const { runtime, calls } = await fakeOriginal(t);
  const alias = inheritProvider(definition({ apiKey: "$ALT_KEY", headers: {
    "x-provider": null, "X-Extra": "${ALT_HEADER}", "X-Request": "configured",
  } }), runtime);
  const models = createModels();
  models.setProvider(alias);
  const result = await models.completeSimple(alias.getModels()[0], { messages: [] }, {
    env: { ALT_KEY: "configured-key", ALT_HEADER: "header-value" },
    headers: { "X-Request": "request-wins" },
  });
  assert.equal(result.stopReason, "stop");
  assert.equal(calls[0].options?.apiKey, "configured-key");
  assert.equal(calls[0].options?.headers?.["x-provider"], null);
  assert.equal(calls[0].options?.headers?.["x-extra"], "header-value");
  assert.equal(calls[0].options?.headers?.["x-request"], "request-wins");
  await models.completeSimple(alias.getModels()[0], { messages: [] }, {
    apiKey: "runtime-key", env: { ALT_HEADER: "header-value" },
  });
  assert.equal(calls[1].options?.apiKey, "runtime-key");
  assert.equal((await alias.streamSimple(alias.getModels()[0], normalizeContext({ messages: [] })).result()).stopReason, "error");
  assert.equal(calls.length, 2);
});

test("inline environment interpolation works in keys and headers without recursive expansion", async (t) => {
  const { runtime, calls } = await fakeOriginal(t);
  const alias = inheritProvider(definition({ apiKey: "prefix-${ALT_KEY}", headers: {
    Authorization: "Bearer $ALT_KEY", "X-Literal": "$$ALT_KEY",
  } }), runtime);
  const models = createModels();
  models.setProvider(alias);
  const options = { env: { ALT_KEY: "value$NOT_ANOTHER_REFERENCE" } };
  const result = await models.completeSimple(alias.getModels()[0], { messages: [] }, options);
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.equal(calls[0].options?.apiKey, "prefix-value$NOT_ANOTHER_REFERENCE");
  assert.equal(calls[0].options?.headers?.authorization, "Bearer value$NOT_ANOTHER_REFERENCE");
  assert.equal(calls[0].options?.headers?.["x-literal"], "$ALT_KEY");
  const missing = await alias.streamSimple(alias.getModels()[0], normalizeContext({ messages: [] }), { env: { ALT_KEY: "" } }).result();
  assert.equal(missing.stopReason, "error");
  assert.equal(calls.length, 1);
});

test("inherits image, classifier, deferred, and refresh operations", async (t) => {
  const { runtime, calls, original } = await fakeOriginal(t);
  let refreshEndpoint: string | undefined;
  let refreshKey: string | undefined;
  original.refreshModels = async (context) => {
    refreshEndpoint = context.baseUrl;
    refreshKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
  };
  original.fetchDeferred = (model, handle, options) => {
    assert.equal(handle.provider, "original");
    calls.push({ operation: "deferred", model, options });
    return response(model, handle);
  };
  original.cancelDeferred = async (model, handle, options) => {
    assert.equal(handle.provider, "original");
    calls.push({ operation: "cancel", model, options });
  };
  setEnv(t, { PI_ALT_TEST_OPERATION_ORIGIN: "https://proxy.invalid" });
  const [configured] = parseConfig({ providers: [definition({ baseUrl: "${PI_ALT_TEST_OPERATION_ORIGIN}/v1" })] });
  const alias = inheritProvider(configured, runtime);
  assert.equal(alias.baseUrl, "https://proxy.invalid/v1");
  assert.ok(alias.getAllModels!().every((model) => model.baseUrl === alias.baseUrl));
  const models = createModels();
  models.setProvider(alias);
  const image = models.getModelsOfType("image", "alternative")[0];
  const classifier = models.getModelsOfType("classifier", "alternative")[0];
  await models.generateImages(image, { input: [{ type: "text", text: "test" }] });
  await models.classify(classifier, { state: {}, questions: {} });
  const handle = { id: "job", provider: "alternative", modelId: "test-model", api: "test-api" };
  const deferred = await alias.fetchDeferred!(alias.getModels()[0], handle).result();
  assert.equal(deferred.provider, "alternative");
  assert.equal(deferred.deferred?.provider, "alternative");
  await alias.cancelDeferred!(alias.getModels()[0], handle);
  const refresh = { signal: new AbortController().signal, publish: async () => true };
  await alias.refreshModels!({ ...refresh, allowNetwork: false });
  assert.equal(refreshEndpoint, "https://proxy.invalid/v1");
  await alias.refreshModels!({ ...refresh, allowNetwork: true });
  assert.equal(refreshKey, "original-key");
  assert.deepEqual(calls.map((call) => call.operation), ["images", "classify", "deferred", "cancel"]);
  assert.ok(calls.every((call) => call.model.provider === "original" && call.model.baseUrl === "https://proxy.invalid/v1"));
  const broken = inheritProvider(definition({ apiKey: "$MISSING_TEST_KEY" }), runtime);
  const imageError = await broken.generateImages!(image, { input: [] }, { env: { MISSING_TEST_KEY: "" } });
  assert.equal(imageError.provider, "alternative");
  assert.equal(imageError.stopReason, "error");
  assert.deepEqual(imageError.output, []);
  const controller = new AbortController();
  controller.abort();
  const classifierError = await broken.classify!(classifier, { state: {}, questions: {} }, { signal: controller.signal, env: { MISSING_TEST_KEY: "" } });
  assert.equal(classifierError.stopReason, "aborted");
  assert.deepEqual(classifierError.answers, {});
  assert.equal(calls.length, 4);
});

test("uses original OAuth credentials and refreshes them only in original storage", async (t) => {
  const { runtime, directory, calls, original } = await fakeOriginal(t);
  let refreshes = 0;
  original.auth.oauth = {
    name: "Original OAuth", login: async () => { throw new Error("not used"); },
    refresh: async (credential) => { refreshes++; return { ...credential, access: "fresh-token", expires: Date.now() + 3_600_000 }; },
    toAuth: async (credential) => ({ apiKey: credential.access, baseUrl: "https://oauth.invalid/v1" }),
  };
  const authFile = join(directory, "auth.json");
  await writeFile(authFile, JSON.stringify({ original: { type: "oauth", access: "expired", refresh: "refresh-token", expires: 0 } }));
  await runtime.refresh({ allowNetwork: false });
  const alias = inheritProvider(definition(), runtime);
  original.filterModels = (models, credential) => credential?.type === "oauth" ? models : [];
  const filtered = inheritProvider(definition(), runtime);
  assert.equal(filtered.filterModels!(filtered.getModels(), undefined).length, 1);
  const models = createModels();
  models.setProvider(alias);
  await models.completeSimple(alias.getModels()[0], { messages: [] });
  assert.equal(calls[0].options?.apiKey, "fresh-token");
  assert.equal(calls[0].model.baseUrl, "https://oauth.invalid/v1");
  assert.equal(refreshes, 1);
  const stored = JSON.parse(await readFile(authFile, "utf8"));
  assert.deepEqual(Object.keys(stored), ["original"]);
  assert.equal(stored.original.access, "fresh-token");
});

test("an explicit key works for OAuth-only sources without reading or refreshing their OAuth credentials", async (t) => {
  const { runtime, original, directory, calls } = await fakeOriginal(t);
  delete original.auth.apiKey;
  original.auth.oauth = {
    name: "OAuth only", login: async () => { throw new Error("not used"); },
    refresh: async () => { throw new Error("must not refresh original OAuth"); },
    toAuth: async () => { throw new Error("must not read original OAuth"); },
  };
  await writeFile(join(directory, "auth.json"), JSON.stringify({ original: {
    type: "oauth", access: "old-secret", refresh: "refresh-secret", expires: 0,
  } }));
  const alias = inheritProvider(definition({ apiKey: "proxy-key", baseUrl: "https://proxy.invalid/v1" }), runtime);
  const models = createModels();
  models.setProvider(alias);
  const result = await models.completeSimple(alias.getModels()[0], { messages: [] });
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.equal(calls[0].options?.apiKey, "proxy-key");
  assert.ok(!JSON.stringify(calls[0]).includes("old-secret"));
});

test("an aborted request never reaches the original stream", async (t) => {
  const { runtime, calls } = await fakeOriginal(t);
  const alias = inheritProvider(definition(), runtime);
  const controller = new AbortController();
  controller.abort();
  const result = await alias.streamSimple(alias.getModels()[0], normalizeContext({ messages: [] }), { signal: controller.signal }).result();
  assert.equal(result.stopReason, "aborted");
  assert.equal(calls.length, 0);
});

test("a models.json source works through an overridden endpoint with all original headers", async (t) => {
  let received: { url?: string; authorization?: string; provider?: string; model?: string; extra?: string } = {};
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume the request */ }
    received = { url: request.url, authorization: request.headers.authorization,
      provider: request.headers["x-provider"] as string, model: request.headers["x-model"] as string,
      extra: request.headers["x-extra"] as string };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ id: "test", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  setEnv(t, { PI_ALT_TEST_HTTP_ORIGIN: `http://127.0.0.1:${address.port}` });
  const { runtime } = await fixture(t, { providers: { original: {
    baseUrl: "https://must-not-be-contacted.invalid/v1", api: "openai-completions", apiKey: "source-key",
    headers: { "X-Provider": "provider-value", "X-Model": "provider-default" },
    models: [{ id: "test-model", headers: { "X-Model": "model-value" } }],
  } } });
  const [configured] = parseConfig({ providers: [definition({ baseUrl: "${PI_ALT_TEST_HTTP_ORIGIN}/v1", headers: { "X-Extra": "override" } })] });
  const alias = inheritProvider(configured, runtime);
  assert.equal(alias.baseUrl, baseUrl);
  const models = createModels();
  models.setProvider(alias);
  const result = await models.completeSimple(alias.getModels()[0], { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] });
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.equal(result.provider, "alternative");
  assert.deepEqual(received, { url: "/v1/chat/completions", authorization: "Bearer source-key", provider: "provider-value", model: "model-value", extra: "override" });
});

test("factory reads agent-directory config, ignores package-local files, and is atomic on invalid sources", async (t) => {
  const { directory } = await fixture(t);
  const extensionDirectory = join(directory, "extension");
  await mkdir(extensionDirectory);
  await writeFile(join(directory, "package.json"), '{"type":"module"}');
  await cp(new URL("../index.ts", import.meta.url), join(extensionDirectory, "index.ts"));
  await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(directory, "node_modules"), "dir");
  await writeFile(join(extensionDirectory, "config.json"), "invalid legacy package-local config");
  await writeFile(join(extensionDirectory, "altprovider.json"), "invalid package-local config");
  const configPath = join(directory, "altprovider.json");
  const { default: extension } = await import(pathToFileURL(join(extensionDirectory, "index.ts")).href) as { default: (pi: ExtensionAPI) => Promise<void> };
  const registered: Provider[] = [];
  const pi = { registerProvider: (provider: Provider) => { registered.push(provider); } } as unknown as ExtensionAPI;
  await extension(pi);
  assert.equal(registered.length, 0);
  await writeFile(configPath, '{"providers":[]}');
  await extension(pi);
  assert.equal(registered.length, 0);
  await writeFile(configPath, JSON.stringify({ providers: [{ name: "openai-copy", originalProvider: "openai", overrides: { baseUrl: "https://proxy.invalid/v1" } }] }));
  await extension(pi);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].id, "openai-copy");
  assert.ok(registered[0].getModels().length > 0);
  assert.ok(registered[0].getModels().every((model) => model.baseUrl === "https://proxy.invalid/v1"));
  registered.length = 0;
  await writeFile(configPath, JSON.stringify({ providers: [
    { name: "valid", originalProvider: "openai" }, { name: "invalid", originalProvider: "missing" },
  ] }));
  await assert.rejects(extension(pi), /Unknown original provider/);
  assert.equal(registered.length, 0);
  await writeFile(configPath, '{"apiKey":"secret-value",');
  await assert.rejects(extension(pi), (error: Error) => !error.message.includes("secret-value") && error.message.includes("altprovider.json is not valid JSON"));
});

test("Pi CLI loads altprovider.json from the default and overridden agent directories at startup", async (t) => {
  const { directory } = await fixture(t);
  const extensionDirectory = join(directory, "extension");
  const home = join(directory, "home");
  await mkdir(extensionDirectory);
  await cp(new URL("../index.ts", import.meta.url), join(extensionDirectory, "index.ts"));
  const cli = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
  for (const [agentDir, name] of [[directory, "startup-proxy"], [join(home, ".pi", "agent"), "home-proxy"]]) {
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "altprovider.json"), JSON.stringify({ providers: [{
      name, originalProvider: "openai", overrides: { baseUrl: "${PI_ALT_TEST_CLI_ORIGIN}/v1", apiKey: "dummy-proxy-key", compat: { supportsMidConvoEffort: false } },
    }] }));
    if (agentDir !== directory) await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: {
      [name]: { modelOverrides: { "gpt-4.1": { name: "Startup GPT" } } },
    } }));
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, OPENAI_API_KEY: "", PI_ALT_TEST_CLI_ORIGIN: "https://proxy.invalid" };
    if (agentDir === directory) env.PI_CODING_AGENT_DIR = agentDir;
    else delete env.PI_CODING_AGENT_DIR;
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [cli,
      "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files",
      "-e", join(extensionDirectory, "index.ts"), "--list-models", name,
    ], { cwd: extensionDirectory, env, timeout: 30_000 });
    assert.match(stdout, new RegExp(`^${name}\\s+`, "m"), stderr);
    assert.doesNotMatch(stderr, /Failed to load|Error loading|register_provider/);
  }
});
