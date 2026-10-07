import 'dotenv/config';
import { context, propagation, trace } from '@opentelemetry/api';
import { ConversationIdSpanProcessor } from './conversation.js';
import { flushAiSdkInfo, resetAiSdkInfo } from './sdk-info.js';
import { _clearState, _setStore } from './skills.js';
import type { AiConfigRep, InitBaseClientOptions, LDClientInterface, LDContext, VariationMeta } from './types.js';
import { parseAiConfig } from './types.js';

const LD_DEFAULT_OTLP_ENDPOINT = 'https://otel.observability.app.launchdarkly.com';

/**
 * Reads an environment variable, treating empty/whitespace-only values as unset.
 * `.env.example` ships several optional vars blank (e.g. `OTEL_EXPORTER_OTLP_ENDPOINT=`),
 * and `??` does not fall through on empty strings — so a copied-verbatim `.env` would
 * otherwise defeat the built-in defaults. Returning `undefined` here restores them.
 */
function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

// biome-ignore lint/suspicious/noExplicitAny: OTel tracer provider loaded via dynamic import with no static type
let tracerProvider: any | null = null;

interface OtelGlobals {
  trace: boolean;
  context: boolean;
  propagation: boolean;
}

const NO_OTEL_GLOBALS: OtelGlobals = { trace: false, context: false, propagation: false };

/**
 * Which of OTel's process-global registrations `setupTelemetry` actually took.
 *
 * Each global is one-shot: a second registration is refused, with an
 * "Attempted duplicate registration of API" diag error, until the first is
 * disabled. So `shutdownTelemetry` must release them, or an init/shutdown/init
 * cycle routes every later span to the provider it just shut down. But it may
 * release only these: having built a provider does not mean we own the global,
 * since another library may have registered first, and disabling theirs would
 * tear down the host application's tracing.
 */
let ownedOtelGlobals: OtelGlobals = NO_OTEL_GLOBALS;

/**
 * Counts `shutdownTelemetry` calls, so a `setupTelemetry` that was still
 * awaiting its imports when one ran can tell, and build nothing. At that point
 * there was no provider to tear down, so the teardown could not stop it.
 */
let telemetryTeardowns = 0;

const LD_OTEL_PEER_DEPS = [
  '@opentelemetry/sdk-trace-node',
  '@opentelemetry/sdk-trace-base',
  '@opentelemetry/exporter-trace-otlp-http',
  '@opentelemetry/otlp-exporter-base',
  '@opentelemetry/resources',
  '@opentelemetry/context-async-hooks',
  '@opentelemetry/core',
].join(' ');

/**
 * Configures and registers the OTel tracer provider with an OTLP HTTP exporter.
 * The OTel SDK packages are optional peer dependencies loaded via dynamic import.
 * If any are missing, telemetry is silently disabled and a console.warn is emitted
 * with the npm install command to enable it.
 *
 * Resolves to the provider this call built, or `null` when it built none, so a
 * failed init can tell whether the current provider is its own to tear down.
 */
// biome-ignore lint/suspicious/noExplicitAny: OTel tracer provider loaded via dynamic import with no static type
async function setupTelemetry(options: InitBaseClientOptions, sdkKey: string): Promise<any | null> {
  const teardownsAtStart = telemetryTeardowns;
  // biome-ignore lint/suspicious/noExplicitAny: optional OTel peer deps loaded via dynamic import with no static types
  let NodeTracerProvider: any,
    // biome-ignore lint/suspicious/noExplicitAny: optional OTel peer deps loaded via dynamic import with no static types
    BatchSpanProcessor: any,
    // biome-ignore lint/suspicious/noExplicitAny: optional OTel peer deps loaded via dynamic import with no static types
    OTLPTraceExporter: any,
    // biome-ignore lint/suspicious/noExplicitAny: optional OTel peer deps loaded via dynamic import with no static types
    CompressionAlgorithm: any,
    // biome-ignore lint/suspicious/noExplicitAny: optional OTel peer deps loaded via dynamic import with no static types
    resourceFromAttributes: any,
    // biome-ignore lint/suspicious/noExplicitAny: optional OTel peer deps loaded via dynamic import with no static types
    AsyncLocalStorageContextManager: any,
    // biome-ignore lint/suspicious/noExplicitAny: optional OTel peer deps loaded via dynamic import with no static types
    CompositePropagator: any,
    // biome-ignore lint/suspicious/noExplicitAny: optional OTel peer deps loaded via dynamic import with no static types
    W3CBaggagePropagator: any,
    // biome-ignore lint/suspicious/noExplicitAny: optional OTel peer deps loaded via dynamic import with no static types
    W3CTraceContextPropagator: any;

  try {
    ({ NodeTracerProvider } = await import('@opentelemetry/sdk-trace-node'));
    ({ BatchSpanProcessor } = await import('@opentelemetry/sdk-trace-base'));
    ({ OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http'));
    ({ CompressionAlgorithm } = await import('@opentelemetry/otlp-exporter-base'));
    ({ resourceFromAttributes } = await import('@opentelemetry/resources'));
    ({ AsyncLocalStorageContextManager } = await import('@opentelemetry/context-async-hooks'));
    ({ CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } = await import('@opentelemetry/core'));
  } catch {
    // biome-ignore lint/suspicious/noConsole: intentional warning when optional OTel peer deps are missing
    console.warn(
      '[LaunchDarkly] Telemetry is disabled because one or more OpenTelemetry SDK ' +
        'packages are not installed. To enable, run:\n' +
        `  npm install ${LD_OTEL_PEER_DEPS}`,
    );
    return null;
  }

  // One provider at a time. A second would be refused the global registration,
  // so it would receive no spans while replacing the handle `shutdownTelemetry`
  // flushes, leaking the live one. A BYOC call made while an options-path init
  // is still in flight reuses that attempt's provider, as OTel itself would; a
  // failed init has already torn its own down.
  // Checked after the imports, since nothing between here and the assignment
  // below awaits.
  if (tracerProvider) return null;

  // A teardown ran while the imports were pending: `shutdown()` abandoned the
  // init this setup belongs to, or the application stopped telemetry itself.
  // Either way, a provider built now would outlive it, and the next init would
  // reuse it with this attempt's options (its sdkKey as highlight.project_id).
  if (telemetryTeardowns !== teardownsAtStart) return null;

  const baseEndpoint = options.otlpEndpoint ?? env('OTEL_EXPORTER_OTLP_ENDPOINT') ?? LD_DEFAULT_OTLP_ENDPOINT;

  const exporter = new OTLPTraceExporter({
    url: `${baseEndpoint.replace(/\/$/, '')}/v1/traces`,
    compression: CompressionAlgorithm.GZIP,
  });

  const resource = resourceFromAttributes({
    'service.name': options.serviceName ?? process.env.LD_SERVICE_NAME ?? 'nodejs-sdk',
    // Required for the LaunchDarkly (Highlight.io-based) OTLP backend to route traces.
    'highlight.project_id': sdkKey,
    ...(options.environment || process.env.LD_ENVIRONMENT
      ? { 'deployment.environment': options.environment ?? process.env.LD_ENVIRONMENT }
      : {}),
  });

  const provider = new NodeTracerProvider({
    resource,
    spanProcessors: [new ConversationIdSpanProcessor(), new BatchSpanProcessor(exporter)],
  });

  // What `provider.register()` does, one global at a time, because each setter
  // reports whether it took the global and `register()` discards that.
  const contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  const owned: OtelGlobals = {
    trace: trace.setGlobalTracerProvider(provider),
    context: context.setGlobalContextManager(contextManager),
    propagation: propagation.setGlobalPropagator(
      new CompositePropagator({
        propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
      }),
    ),
  };
  if (!owned.context) contextManager.disable();
  if (!owned.trace) {
    // biome-ignore lint/suspicious/noConsole: OTel's own refusal goes to its diag logger, which is unset by default
    console.warn(
      '[LaunchDarkly] An OpenTelemetry tracer provider was already registered by something ' +
        "else in this process, so LaunchDarkly's telemetry options are not in effect; spans " +
        'go wherever that provider sends them.',
    );
  }

  tracerProvider = provider;
  ownedOtelGlobals = owned;
  return provider;
}

/**
 * Waits until the OTel tracer provider is registered in the global OTel context.
 * With our synchronous `setupTelemetry`, this resolves immediately on the first
 * check. The polling loop is retained for compatibility with callers that rely
 * on this function during startup.
 */
export async function waitForTelemetry(timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      // biome-ignore lint/suspicious/noExplicitAny: accessing _delegate which is not in OTel's public API
      const provider = trace.getTracerProvider() as any;
      const isReady = !('_delegate' in provider) || provider._delegate != null;
      if (isReady) return resolve();
      if (Date.now() - start >= timeoutMs) {
        return reject(new Error(`Telemetry provider not ready after ${timeoutMs}ms`));
      }
      setTimeout(check, 20);
    };
    check();
  });
}

/**
 * Flushes and shuts down the OTel tracer provider, then releases the OTel
 * globals this SDK registered, so a later `initClient` can register its own.
 * Must be called before process.exit() to ensure all pending spans are exported.
 */
export async function shutdownTelemetry(): Promise<void> {
  // Counted even with no provider yet: see `telemetryTeardowns`.
  telemetryTeardowns++;
  const provider = tracerProvider;
  const owned = ownedOtelGlobals;
  tracerProvider = null;
  ownedOtelGlobals = NO_OTEL_GLOBALS;
  if (!provider) return;
  try {
    await provider.shutdown();
  } finally {
    // See `ownedOtelGlobals`: only what our own registration took.
    if (owned.trace) trace.disable();
    if (owned.context) context.disable();
    if (owned.propagation) propagation.disable();
  }
}

// Use a Symbol.for key so the singleton is shared across all module instances of
// this package in the same process (e.g. multiple workspace packages each importing
// @launchdarkly/ai-server resolve separate module instances through their own symlinks,
// but Symbol.for and globalThis cross those boundaries).
const SINGLETON_KEY = Symbol.for('@launchdarkly/ai-server:singleton');

interface Singleton {
  client: LDClientInterface | null;
  initPromise: Promise<LDClientInterface> | null;
}

function getSingleton(): Singleton {
  // biome-ignore lint/suspicious/noExplicitAny: symbol-keyed property on globalThis has no typed accessor
  const g = globalThis as any;
  if (!g[SINGLETON_KEY]) {
    g[SINGLETON_KEY] = { client: null, initPromise: null };
  }
  return g[SINGLETON_KEY];
}

/**
 * Initializes the LaunchDarkly client using `@launchdarkly/node-server-sdk`.
 * The SDK is loaded via dynamic import so it is an optional peer dependency —
 * consumers on edge runtimes can skip installing it and pass a pre-initialized
 * client to `initClient()` directly.
 */
async function initBaseClient(options: InitBaseClientOptions = {}): Promise<LDClientInterface> {
  const sdkKey = options.sdkKey ?? process.env.LD_SDK_KEY;
  if (!sdkKey) {
    throw new Error('LD_SDK_KEY is not set');
  }

  const builtProvider = await setupTelemetry(options, sdkKey);
  try {
    return await startBaseClient(sdkKey, options);
  } catch (err) {
    // A rejected init is retried rather than cached, and the retry may bring
    // different options (another sdkKey is another highlight.project_id), so
    // drop the provider this attempt built instead of leaving the retry to reuse
    // it. Only if it is still the current one: `shutdown()` may have torn it
    // down already and a newer attempt built its own. And not if a BYOC call
    // has adopted it for its own client meanwhile.
    if (builtProvider && tracerProvider === builtProvider && !getSingleton().client) {
      try {
        await shutdownTelemetry();
      } catch {
        // The init failure is the error worth reporting.
      }
    }
    throw err;
  }
}

async function startBaseClient(sdkKey: string, options: InitBaseClientOptions): Promise<LDClientInterface> {
  // biome-ignore lint/suspicious/noExplicitAny: @launchdarkly/node-server-sdk loaded via dynamic import
  let init: any;
  try {
    ({ init } = await import('@launchdarkly/node-server-sdk'));
  } catch {
    throw new Error(
      '[LaunchDarkly] @launchdarkly/node-server-sdk is not installed. ' +
        'Either install it (npm install @launchdarkly/node-server-sdk) or pass a ' +
        'pre-initialized LD client to initClient().',
    );
  }

  const baseUri = options.baseUri ?? env('LD_BASE_URI');
  const streamUri = options.streamUri ?? env('LD_STREAM_URI');
  const eventsUri = options.eventsUri ?? env('LD_EVENTS_URI');
  const client: LDClientInterface = init(sdkKey, {
    ...(baseUri !== undefined && { baseUri }),
    ...(streamUri !== undefined && { streamUri }),
    ...(eventsUri !== undefined && { eventsUri }),
  });

  try {
    // biome-ignore lint/suspicious/noExplicitAny: waitForInitialization is a concrete SDK method not in LDClientInterface
    await (client as any).waitForInitialization({ timeout: 10 });
    await waitForTelemetry();
  } catch (err) {
    // We built this client, so close it: a rejected init is retried rather than
    // cached, and each attempt would otherwise leave a streaming connection open.
    try {
      await client.close();
    } catch {
      // The init failure is the error worth reporting.
    }
    throw err;
  }

  return client;
}

/**
 * Returns true when `value` looks like a pre-initialized LDClientInterface
 * (has a `variation` method), as opposed to an options bag.
 */
function isLDClient(value: unknown): value is LDClientInterface {
  return (
    typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).variation === 'function'
  );
}

/**
 * Initializes the LaunchDarkly client.
 *
 * **Overload 1 — options bag (default Node.js path):**
 * Lazily initializes `@launchdarkly/node-server-sdk` using the supplied options
 * or environment variables. Calling this is optional — the first AI API call
 * will trigger initialization automatically when `LD_SDK_KEY` is set.
 *
 * **Overload 2 — pre-initialized client (edge / custom runtimes):**
 * Pass an already-initialized `LDClientInterface`-compatible client (e.g. from
 * `@launchdarkly/vercel-server-sdk`) to bypass the Node SDK entirely. The
 * optional second argument is the same options bag as the first overload.
 *
 * Idempotent: later calls return the existing client and ignore every option
 * **except** `skillStore`, which is applied on every call, so you can add a store
 * after initialization with `initClient({ skillStore: store })`. A nullish store
 * never clears the current one (use `shutdown()`). Without a store, the Agent
 * Skills accessors throw.
 *
 * That idempotency covers overload 2 too: once a client is set, passing a
 * *different* pre-initialized client does not swap it, and the second call's
 * telemetry options are ignored rather than re-running telemetry setup. Call
 * `shutdown()` first to hand the SDK a new client.
 *
 * A call that rejects caches neither a client nor the failure: a later call
 * retries initialization (once `LD_SDK_KEY` is available, say) rather than
 * replaying the same rejection.
 *
 * A call still in flight when `shutdown()` runs, or when a pre-initialized
 * client is passed meanwhile, is abandoned: it closes the client it built and
 * rejects, rather than replacing whatever client came after it.
 *
 * Both overloads return the client instance for further customization.
 */
export async function initClient(
  client: LDClientInterface,
  options?: InitBaseClientOptions,
): Promise<LDClientInterface>;
export async function initClient(options?: InitBaseClientOptions): Promise<LDClientInterface>;
export async function initClient(
  optionsOrClient?: InitBaseClientOptions | LDClientInterface,
  clientOptions?: InitBaseClientOptions,
): Promise<LDClientInterface> {
  const singleton = getSingleton();

  // Applied on every call, before the idempotency check.
  const skillStore = (isLDClient(optionsOrClient) ? clientOptions : optionsOrClient)?.skillStore;
  if (skillStore != null) _setStore(skillStore);

  // Ahead of *both* init paths, so "a second call returns the existing client
  // and every other option is ignored" holds for BYOC as well, as it does in
  // the Python SDK's `_resolve_client`. Below the BYOC branch, a repeat
  // `initClient(client)` re-ran telemetry setup with the new options, which
  // could not take effect, and swapped the stored client.
  if (singleton.client) {
    flushAiSdkInfo(singleton.client);
    return singleton.client;
  }

  if (isLDClient(optionsOrClient)) {
    // Pre-initialized client path (edge / custom runtimes).
    // Still run telemetry setup (with the caller's options) so OTel traces work
    // regardless of which LD SDK provides the client. The SDK key is optional
    // here — it's only used for the highlight.project_id resource attribute.
    await setupTelemetry(clientOptions ?? {}, clientOptions?.sdkKey ?? process.env.LD_SDK_KEY ?? '');
    singleton.client = optionsOrClient;
    singleton.initPromise = Promise.resolve(optionsOrClient);
    flushAiSdkInfo(optionsOrClient);
    return optionsOrClient;
  }

  const pending = singleton.initPromise ?? startInit(singleton, optionsOrClient);
  let client: LDClientInterface;
  try {
    client = await pending;
  } catch (err) {
    // A rejection is not cached, so a later call retries — with a key that is
    // now set, say — instead of replaying this failure for the life of the
    // process. Concurrent waiters on the same attempt all land here; clear it
    // only if nothing (a BYOC call, `shutdown()`) has replaced it meanwhile.
    if (singleton.initPromise === pending) singleton.initPromise = null;
    throw err;
  }
  flushAiSdkInfo(client);
  return client;
}

/**
 * Starts an options-path init attempt and records it as the in-flight one.
 *
 * The attempt adopts its client itself, once, rather than each waiter doing so:
 * the check that it is still the current attempt and the assignment then run in
 * the same synchronous step, with no await between them for `shutdown()` to
 * land in.
 */
function startInit(singleton: Singleton, options?: InitBaseClientOptions): Promise<LDClientInterface> {
  const attempt: Promise<LDClientInterface> = initBaseClient(options).then(async (client) => {
    if (singleton.initPromise !== attempt) {
      // `shutdown()` or a BYOC call replaced this attempt while it was in
      // flight. Adopting its client would clobber whatever came after and leak
      // that client's connection, so close this one instead. Its telemetry is
      // not ours to tear down here: `shutdown()` already did, or the BYOC call
      // reused the provider.
      try {
        await client.close();
      } catch {
        // The abandonment is the error worth reporting.
      }
      throw new Error('[LaunchDarkly] initClient was abandoned: shutdown() or another initClient() replaced it.');
    }
    singleton.client = client;
    return client;
  });
  singleton.initPromise = attempt;
  return attempt;
}

export function getClient(): LDClientInterface {
  const { client } = getSingleton();
  if (!client) throw new Error('LaunchDarkly client not initialized. Call initClient() first.');
  return client;
}

export async function shutdown(): Promise<void> {
  const singleton = getSingleton();
  // A store can be configured without a client, and an init can be in flight
  // without one, so shutdown() always leaves the next initClient() starting
  // from scratch. Dropping the init promise abandons that attempt: it closes
  // its own client when it finishes (see `startInit`).
  _clearState();
  singleton.initPromise = null;
  // Null the singleton before teardown so that any failure mid-flight still
  // leaves the process in a state where a second shutdown() call is a no-op.
  const client = singleton.client;
  singleton.client = null;
  if (client) resetAiSdkInfo();
  // With or without a client: an in-flight init has already built its
  // provider, and the next init would otherwise reuse it with the old options.
  await shutdownTelemetry();
  if (!client) return;
  try {
    await client.flush();
  } finally {
    await client.close();
  }
}

/**
 * The result returned by `inspectConfig`. Always returned even when the flag
 * is disabled or an error occurs — callers should check `enabled` before using
 * `config` or `meta`.
 */
export type InspectConfigResult = {
  /** Whether the flag variation is active. */
  enabled: boolean;
  /** The parsed AI config, or `null` when disabled, invalid, or unreachable. */
  config: AiConfigRep | null;
  /** The variation metadata, or `null` when unreachable. */
  meta: VariationMeta | null;
};

/**
 * Reads an AI Config variation without invoking the model. Use this to
 * inspect the current config state (enabled/disabled, model name, provider,
 * etc.) for health checks, logging, or any purpose that doesn't need to
 * actually run the AI provider.
 *
 * Unlike `config().invoke()`, this function:
 * - Never throws — returns `{ enabled: false, config: null, meta: null }` on
 *   any error (unreachable LD, bad key, unparseable config, etc.)
 * - Does not emit generation, duration, or token tracking events
 * - Does not call any AI provider
 *
 * Lazily initializes the LD client when `LD_SDK_KEY` is set.
 */
export async function inspectConfig(key: string, context: LDContext): Promise<InspectConfigResult> {
  try {
    await initClient();
    const variation = await getClient().variation(key, context, { enabled: false });
    // biome-ignore lint/suspicious/noExplicitAny: _ldMeta is LaunchDarkly private metadata not in public variation type
    const raw = variation as any;
    const enabled = Boolean(raw?._ldMeta?.enabled);
    const rawMeta: VariationMeta | null = raw?._ldMeta ?? null;
    if (!enabled) {
      return { enabled: false, config: null, meta: rawMeta };
    }
    const parsed = parseAiConfig(variation);
    if (!parsed.success) {
      return { enabled: true, config: null, meta: rawMeta };
    }
    return { enabled: true, config: parsed.data, meta: rawMeta };
  } catch {
    return { enabled: false, config: null, meta: null };
  }
}

export const extractVariation = async (
  key: string,
  userContext: LDContext,
): Promise<{ config: AiConfigRep; meta: VariationMeta }> => {
  await initClient();
  const variation = await getClient().variation(key, userContext, { enabled: false });
  // biome-ignore lint/suspicious/noExplicitAny: _ldMeta is LaunchDarkly private metadata not in public variation type
  if (!(variation as any)?._ldMeta?.enabled) {
    throw new Error(`Variation ${key} is not enabled`);
  }
  const parsed = parseAiConfig(variation);
  if (!parsed.success) {
    throw new Error(`Invalid AI config for "${key}": ${parsed.error.message}`);
  }

  // biome-ignore lint/suspicious/noExplicitAny: _ldMeta is LaunchDarkly private metadata not in public variation type
  return { config: parsed.data, meta: (variation as any)._ldMeta as VariationMeta };
};
