import 'dotenv/config';
import { trace } from '@opentelemetry/api';
import { ConversationIdSpanProcessor } from './conversation.js';
import { flushAiSdkInfo, resetAiSdkInfo } from './sdk-info.js';
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
 */
async function setupTelemetry(options: InitBaseClientOptions, sdkKey: string): Promise<void> {
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
    return;
  }

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

  tracerProvider = new NodeTracerProvider({
    resource,
    spanProcessors: [new ConversationIdSpanProcessor(), new BatchSpanProcessor(exporter)],
  });
  tracerProvider.register({
    contextManager: new AsyncLocalStorageContextManager(),
    propagator: new CompositePropagator({
      propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
    }),
  });
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
 * Flushes and shuts down the OTel tracer provider.
 * Must be called before process.exit() to ensure all pending spans are exported.
 */
export async function shutdownTelemetry(): Promise<void> {
  if (tracerProvider) {
    await tracerProvider.shutdown();
    tracerProvider = null;
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

  await setupTelemetry(options, sdkKey);

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

  // biome-ignore lint/suspicious/noExplicitAny: waitForInitialization is a concrete SDK method not in LDClientInterface
  await (client as any).waitForInitialization({ timeout: 10 });
  await waitForTelemetry();

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
 * `@launchdarkly/vercel-server-sdk`) to bypass the Node SDK entirely.
 *
 * Both overloads return the client instance for further customization.
 */
export async function initClient(client: LDClientInterface): Promise<LDClientInterface>;
export async function initClient(options?: InitBaseClientOptions): Promise<LDClientInterface>;
export async function initClient(
  optionsOrClient?: InitBaseClientOptions | LDClientInterface,
): Promise<LDClientInterface> {
  const singleton = getSingleton();

  if (isLDClient(optionsOrClient)) {
    // Pre-initialized client path (edge / custom runtimes).
    // Still run telemetry setup so OTel traces work regardless of which
    // LD SDK is providing the client. SDK key is optional here — it's only
    // used for the highlight.project_id resource attribute.
    await setupTelemetry({}, process.env.LD_SDK_KEY ?? '');
    singleton.client = optionsOrClient;
    singleton.initPromise = Promise.resolve(optionsOrClient);
    flushAiSdkInfo(optionsOrClient);
    return optionsOrClient;
  }

  if (singleton.client) {
    flushAiSdkInfo(singleton.client);
    return singleton.client;
  }
  if (!singleton.initPromise) {
    singleton.initPromise = initBaseClient(optionsOrClient);
  }
  singleton.client = await singleton.initPromise;
  flushAiSdkInfo(singleton.client);
  return singleton.client;
}

export function getClient(): LDClientInterface {
  const { client } = getSingleton();
  if (!client) throw new Error('LaunchDarkly client not initialized. Call initClient() first.');
  return client;
}

export async function shutdown(): Promise<void> {
  const singleton = getSingleton();
  if (!singleton.client) return;
  // Null the singleton before teardown so that any failure mid-flight still
  // leaves the process in a state where a second shutdown() call is a no-op.
  const client = singleton.client;
  singleton.client = null;
  singleton.initPromise = null;
  resetAiSdkInfo();
  await shutdownTelemetry();
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
