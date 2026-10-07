import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAiSdkPackage, resetAiSdkInfo } from '../sdk-info.js';

// ─── Mock external dependencies before any imports ───────────────────────────

const mockTrack = vi.fn();
const mockFlush = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);
const mockWaitForInitialization = vi.fn().mockResolvedValue(undefined);
const mockLdInit = vi.fn();
const ldSdk = vi.hoisted(() => ({ installed: true }));

vi.mock('@launchdarkly/node-server-sdk', () => ({
  // A getter, so a test can make the package look uninstalled to this module
  // instance: `initBaseClient` destructures `init` inside its import try/catch.
  get init() {
    if (!ldSdk.installed) throw new Error('Cannot find module @launchdarkly/node-server-sdk');
    return (...args: any[]) => mockLdInit(...args);
  },
}));

const mockTracerProviderShutdown = vi.fn().mockResolvedValue(undefined);
const tracerProviders: object[] = [];

// A function declaration, so the tests that make the package look uninstalled
// can restore this mock afterwards; `vi.doUnmock` would hand every later test
// the real provider.
function mockNodeTracerProviderModule() {
  return {
    NodeTracerProvider: class {
      shutdown = mockTracerProviderShutdown;
      constructor() {
        tracerProviders.push(this);
      }
    },
  };
}
vi.mock('@opentelemetry/sdk-trace-node', mockNodeTracerProviderModule);

vi.mock('@opentelemetry/sdk-trace-base', () => ({
  BatchSpanProcessor: class {},
}));

const mockOTLPTraceExporter = vi.fn();
vi.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: class {
    constructor(...args: any[]) {
      mockOTLPTraceExporter(...args);
    }
  },
}));

const mockResourceFromAttributes = vi.fn().mockReturnValue({});
vi.mock('@opentelemetry/resources', () => ({
  resourceFromAttributes: (...args: any[]) => mockResourceFromAttributes(...args),
}));

vi.mock('@opentelemetry/otlp-exporter-base', () => ({
  CompressionAlgorithm: { GZIP: 'gzip', NONE: 'none' },
}));

const mockContextManagerEnable = vi.fn();
const mockContextManagerDisable = vi.fn();
vi.mock('@opentelemetry/context-async-hooks', () => ({
  AsyncLocalStorageContextManager: class {
    enable = mockContextManagerEnable;
    disable = mockContextManagerDisable;
  },
}));

vi.mock('@opentelemetry/core', () => ({
  CompositePropagator: class {},
  W3CBaggagePropagator: class {},
  W3CTraceContextPropagator: class {},
}));

// OTel's process globals, modelled as the real API behaves: each registration is
// refused while something holds that global, until `disable()` releases it.
const otel = vi.hoisted(() => {
  const held: Record<'trace' | 'context' | 'propagation', unknown> = { trace: null, context: null, propagation: null };
  const api = (name: keyof typeof held) => ({
    set: vi.fn((value: unknown) => {
      if (held[name] != null) return false;
      held[name] = value;
      return true;
    }),
    disable: vi.fn(() => {
      held[name] = null;
    }),
  });
  return { held, trace: api('trace'), context: api('context'), propagation: api('propagation') };
});

vi.mock('@opentelemetry/api', () => ({
  createContextKey: (name: string) => Symbol(name),
  trace: {
    getTracerProvider: vi.fn().mockReturnValue({ _delegate: {} }),
    setGlobalTracerProvider: otel.trace.set,
    disable: otel.trace.disable,
  },
  context: {
    setGlobalContextManager: otel.context.set,
    disable: otel.context.disable,
  },
  propagation: {
    setGlobalPropagator: otel.propagation.set,
    disable: otel.propagation.disable,
  },
}));

vi.mock('dotenv/config', () => ({}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMockClient() {
  return {
    track: mockTrack,
    flush: mockFlush,
    close: mockClose,
    waitForInitialization: mockWaitForInitialization,
    variation: vi.fn(),
  };
}

function clearSingleton() {
  const key = Symbol.for('@launchdarkly/ai-server:singleton');
  (globalThis as any)[key] = null;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('lifecycle', () => {
  beforeEach(() => {
    clearSingleton();
    resetAiSdkInfo({ clearKnown: true });
    vi.clearAllMocks();
    delete process.env.LD_SDK_KEY;
    otel.held.trace = otel.held.context = otel.held.propagation = null;
    tracerProviders.length = 0;
    ldSdk.installed = true;
  });

  afterEach(async () => {
    // `clearSingleton` bypasses `shutdown()`, so drop the module's provider too:
    // a later test's setup would otherwise reuse it rather than build its own.
    const { shutdownTelemetry } = await import('../lifecycle.js');
    await shutdownTelemetry();
    clearSingleton();
    delete process.env.LD_SDK_KEY;
  });

  describe('getClient', () => {
    it('throws before initClient is called', async () => {
      const { getClient } = await import('../lifecycle.js');
      expect(() => getClient()).toThrow(/not initialized/i);
    });

    it('returns the client after initClient succeeds', async () => {
      const mockClient = makeMockClient();
      mockLdInit.mockReturnValue(mockClient);
      process.env.LD_SDK_KEY = 'test-key';

      const { initClient, getClient } = await import('../lifecycle.js');
      await initClient();
      expect(getClient()).toBe(mockClient);
    });
  });

  describe('initClient', () => {
    it('throws when LD_SDK_KEY is not set and no sdkKey option provided', async () => {
      const { initClient } = await import('../lifecycle.js');
      await expect(initClient()).rejects.toThrow(/LD_SDK_KEY/i);
    });

    it('uses options.sdkKey over the environment variable', async () => {
      const mockClient = makeMockClient();
      mockLdInit.mockReturnValue(mockClient);
      process.env.LD_SDK_KEY = 'env-key';

      const { initClient } = await import('../lifecycle.js');
      await initClient({ sdkKey: 'explicit-key' });

      expect(mockLdInit).toHaveBeenCalledWith('explicit-key', expect.anything());
    });

    it('does not pass baseUri/streamUri/eventsUri keys when they are absent', async () => {
      const mockClient = makeMockClient();
      mockLdInit.mockReturnValue(mockClient);
      process.env.LD_SDK_KEY = 'test-key';
      delete process.env.LD_BASE_URI;
      delete process.env.LD_STREAM_URI;
      delete process.env.LD_EVENTS_URI;

      const { initClient } = await import('../lifecycle.js');
      await initClient();

      const [, ldOptions] = mockLdInit.mock.calls[0];
      expect(ldOptions).not.toHaveProperty('baseUri');
      expect(ldOptions).not.toHaveProperty('streamUri');
      expect(ldOptions).not.toHaveProperty('eventsUri');
    });

    it('passes URI overrides when explicitly provided via options', async () => {
      const mockClient = makeMockClient();
      mockLdInit.mockReturnValue(mockClient);
      process.env.LD_SDK_KEY = 'test-key';

      const { initClient } = await import('../lifecycle.js');
      await initClient({
        baseUri: 'https://base.example.com',
        streamUri: 'https://stream.example.com',
        eventsUri: 'https://events.example.com',
      });

      const [, ldOptions] = mockLdInit.mock.calls[0];
      expect(ldOptions).toMatchObject({
        baseUri: 'https://base.example.com',
        streamUri: 'https://stream.example.com',
        eventsUri: 'https://events.example.com',
      });
    });

    it('treats empty LD_BASE_URI env var as unset and omits it', async () => {
      const mockClient = makeMockClient();
      mockLdInit.mockReturnValue(mockClient);
      process.env.LD_SDK_KEY = 'test-key';
      process.env.LD_BASE_URI = '';

      const { initClient } = await import('../lifecycle.js');
      await initClient();

      const [, ldOptions] = mockLdInit.mock.calls[0];
      expect(ldOptions).not.toHaveProperty('baseUri');

      delete process.env.LD_BASE_URI;
    });

    it('stamps highlight.project_id resource attribute with the resolved SDK key', async () => {
      const mockClient = makeMockClient();
      mockLdInit.mockReturnValue(mockClient);
      process.env.LD_SDK_KEY = 'sdk-test-key';

      const { initClient } = await import('../lifecycle.js');
      await initClient();

      expect(mockResourceFromAttributes).toHaveBeenCalledWith(
        expect.objectContaining({ 'highlight.project_id': 'sdk-test-key' }),
      );
    });

    it('configures GZIP compression on the OTLP exporter', async () => {
      const mockClient = makeMockClient();
      mockLdInit.mockReturnValue(mockClient);
      process.env.LD_SDK_KEY = 'sdk-test-key';

      const { initClient } = await import('../lifecycle.js');
      await initClient();

      expect(mockOTLPTraceExporter).toHaveBeenCalledWith(expect.objectContaining({ compression: 'gzip' }));
    });

    it('registers the tracer provider as the global one', async () => {
      mockLdInit.mockReturnValue(makeMockClient());
      process.env.LD_SDK_KEY = 'sdk-test-key';

      const { initClient } = await import('../lifecycle.js');
      await initClient();

      expect(tracerProviders).toHaveLength(1);
      expect(otel.held.trace).toBe(tracerProviders[0]);
    });

    it('registers an enabled AsyncLocalStorageContextManager', async () => {
      mockLdInit.mockReturnValue(makeMockClient());
      process.env.LD_SDK_KEY = 'sdk-test-key';

      const { initClient } = await import('../lifecycle.js');
      await initClient();

      expect(otel.context.set).toHaveBeenCalledWith(expect.objectContaining({ enable: mockContextManagerEnable }));
      expect(mockContextManagerEnable).toHaveBeenCalledOnce();
    });

    it('registers W3C propagators', async () => {
      mockLdInit.mockReturnValue(makeMockClient());
      process.env.LD_SDK_KEY = 'sdk-test-key';

      const { initClient } = await import('../lifecycle.js');
      await initClient();

      expect(otel.propagation.set).toHaveBeenCalledWith(expect.any(Object));
    });

    it('sets up telemetry when a pre-initialized client is passed (BYOC path)', async () => {
      const byocClient = {
        variation: vi.fn(),
        track: vi.fn(),
        flush: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const { initClient } = await import('../lifecycle.js');
      await initClient(byocClient);
      expect(otel.held.trace).toBe(tracerProviders[0]);
    });

    it('passes the BYOC overload options through to telemetry setup', async () => {
      // The second argument is the same options bag as the other overload, so
      // `otlpEndpoint` must reach the exporter rather than being dropped.
      const byocClient = {
        variation: vi.fn(),
        track: vi.fn(),
        flush: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const { initClient } = await import('../lifecycle.js');
      await initClient(byocClient, { otlpEndpoint: 'https://otlp.example.test/' });
      expect(mockOTLPTraceExporter).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'https://otlp.example.test/v1/traces' }),
      );
    });

    it('warns about an unrecognized option on both overloads', async () => {
      // A misspelt or retired option would otherwise be dropped silently.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const { initClient } = await import('../lifecycle.js');
        await initClient(makeMockClient(), { serviceName: 'svc', sdkkey: 'sdk-x' } as never);
        await initClient({ zeta: 1, alpha: 2 } as never);
        expect(warn.mock.calls).toEqual([
          ['[LaunchDarkly] Ignoring unrecognized initClient option(s): sdkkey'],
          ['[LaunchDarkly] Ignoring unrecognized initClient option(s): alpha, zeta'],
        ]);
      } finally {
        warn.mockRestore();
      }
    });

    it('does not warn about documented options', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const { initClient } = await import('../lifecycle.js');
        await initClient(makeMockClient(), {
          sdkKey: 'sdk-x',
          baseUri: 'https://base.example',
          streamUri: 'https://stream.example',
          eventsUri: 'https://events.example',
          serviceName: 'svc',
          environment: 'test',
          otlpEndpoint: 'https://otlp.example',
        });
        expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/unrecognized initClient option/));
      } finally {
        warn.mockRestore();
      }
    });

    it('is idempotent — calls init only once when called twice', async () => {
      const mockClient = makeMockClient();
      mockLdInit.mockReturnValue(mockClient);
      process.env.LD_SDK_KEY = 'test-key';

      const { initClient } = await import('../lifecycle.js');
      await initClient();
      await initClient();
      expect(mockLdInit).toHaveBeenCalledOnce();
    });

    it('retries after a failed init instead of replaying the rejection', async () => {
      // A rejection must not be cached: an app whose first call ran before its
      // key was available would otherwise fail for the life of the process.
      const mockClient = makeMockClient();
      mockLdInit.mockReturnValue(mockClient);

      const { initClient, getClient } = await import('../lifecycle.js');
      await expect(initClient()).rejects.toThrow(/LD_SDK_KEY/);

      await expect(initClient({ sdkKey: 'late-key' })).resolves.toBe(mockClient);
      expect(mockLdInit).toHaveBeenCalledOnce();
      expect(mockLdInit).toHaveBeenCalledWith('late-key', expect.anything());
      expect(getClient()).toBe(mockClient);
    });

    it('rejects every concurrent caller of a failed init, then retries', async () => {
      const { initClient } = await import('../lifecycle.js');
      const results = await Promise.allSettled([initClient(), initClient()]);
      expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);

      mockLdInit.mockReturnValue(makeMockClient());
      process.env.LD_SDK_KEY = 'test-key';
      await initClient();
      expect(mockLdInit).toHaveBeenCalledOnce();
    });

    it('closes the client it built when initialization fails, and retries with a new one', async () => {
      // Retrying a timed-out init would otherwise leak a streaming connection
      // per attempt.
      const failed = { ...makeMockClient(), close: vi.fn().mockResolvedValue(undefined) };
      failed.waitForInitialization = vi.fn().mockRejectedValue(new Error('timeout'));
      const succeeded = makeMockClient();
      mockLdInit.mockReturnValueOnce(failed).mockReturnValueOnce(succeeded);
      process.env.LD_SDK_KEY = 'test-key';

      const { initClient, getClient } = await import('../lifecycle.js');
      await expect(initClient()).rejects.toThrow('timeout');
      expect(failed.close).toHaveBeenCalledOnce();

      await initClient();
      expect(mockLdInit).toHaveBeenCalledTimes(2);
      expect(getClient()).toBe(succeeded);
    });

    it('reports the init failure even when closing the failed client also throws', async () => {
      const failed = { ...makeMockClient(), close: vi.fn().mockRejectedValue(new Error('close failed')) };
      failed.waitForInitialization = vi.fn().mockRejectedValue(new Error('timeout'));
      mockLdInit.mockReturnValue(failed);
      process.env.LD_SDK_KEY = 'test-key';

      const { initClient } = await import('../lifecycle.js');
      await expect(initClient()).rejects.toThrow('timeout');
    });

    it('flushes registered AI package information on the BYOC path', async () => {
      const client = makeMockClient();
      registerAiSdkPackage('@launchdarkly/ai-server', '0.1.1');

      const { initClient } = await import('../lifecycle.js');
      await initClient(client);

      expect(client.track).toHaveBeenCalledWith(
        '$ld:ai:sdk:info',
        { kind: 'ld_ai', key: 'ld-internal-tracking', anonymous: true },
        {
          aiSdkName: '@launchdarkly/ai-server',
          aiSdkVersion: '0.1.1',
          aiSdkLanguage: 'javascript',
        },
        1,
      );
    });

    it('flushes a package registered after initialization without reinitializing', async () => {
      const client = makeMockClient();
      mockLdInit.mockReturnValue(client);
      process.env.LD_SDK_KEY = 'test-key';
      registerAiSdkPackage('@launchdarkly/ai-server', '0.1.1');

      const { initClient } = await import('../lifecycle.js');
      await initClient();
      client.track.mockClear();
      registerAiSdkPackage('@launchdarkly/ai-openai-agents', '0.1.1');
      await initClient();

      expect(mockLdInit).toHaveBeenCalledOnce();
      expect(client.track).toHaveBeenCalledOnce();
      expect(client.track.mock.calls[0][2].aiSdkName).toBe('@launchdarkly/ai-openai-agents');
    });
  });

  describe('shutdown', () => {
    it('clears the singleton so getClient throws again', async () => {
      const mockClient = makeMockClient();
      mockLdInit.mockReturnValue(mockClient);
      process.env.LD_SDK_KEY = 'test-key';

      const { initClient, shutdown, getClient } = await import('../lifecycle.js');
      await initClient();
      await shutdown();
      expect(() => getClient()).toThrow(/not initialized/i);
    });

    it('calls tracer provider shutdown and flush/close on the LD client', async () => {
      const mockClient = makeMockClient();
      mockLdInit.mockReturnValue(mockClient);
      process.env.LD_SDK_KEY = 'test-key';

      const { initClient, shutdown } = await import('../lifecycle.js');
      await initClient();
      await shutdown();
      expect(mockTracerProviderShutdown).toHaveBeenCalled();
      expect(mockFlush).toHaveBeenCalled();
      expect(mockClose).toHaveBeenCalled();
    });

    it('allows re-initialization after shutdown', async () => {
      const mockClient = makeMockClient();
      mockLdInit.mockReturnValue(mockClient);
      process.env.LD_SDK_KEY = 'test-key';

      const { initClient, shutdown, getClient } = await import('../lifecycle.js');
      await initClient();
      await shutdown();
      clearSingleton();
      await initClient();
      expect(getClient()).toBe(mockClient);
    });

    it('reports registered packages again after shutdown and re-initialization', async () => {
      const client = makeMockClient();
      mockLdInit.mockReturnValue(client);
      process.env.LD_SDK_KEY = 'test-key';
      registerAiSdkPackage('@launchdarkly/ai-server', '0.1.1');

      const { initClient, shutdown } = await import('../lifecycle.js');
      await initClient();
      await shutdown();
      client.track.mockClear();
      await initClient();

      expect(client.track).toHaveBeenCalledOnce();
    });

    it('allows initialization after a failed init followed by shutdown', async () => {
      const mockClient = makeMockClient();
      mockLdInit.mockReturnValue(mockClient);

      const { initClient, shutdown, getClient } = await import('../lifecycle.js');
      await expect(initClient()).rejects.toThrow(/LD_SDK_KEY/);
      await shutdown();

      await initClient({ sdkKey: 'test-key' });
      expect(getClient()).toBe(mockClient);
    });

    it('clears an in-flight init even though there is no client yet', async () => {
      // shutdown() returns early without a client; the init promise must be
      // dropped before that, or the next initClient() would await the old one.
      let resolveFirst: () => void = () => {};
      const first = makeMockClient();
      first.waitForInitialization = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveFirst = resolve;
          }),
      );
      const second = makeMockClient();
      mockLdInit.mockReturnValueOnce(first).mockReturnValueOnce(second);
      process.env.LD_SDK_KEY = 'test-key';

      const { initClient, shutdown } = await import('../lifecycle.js');
      const inFlight = initClient();
      await vi.waitFor(() => expect(first.waitForInitialization).toHaveBeenCalled());
      await shutdown();

      await expect(initClient()).resolves.toBe(second);
      expect(mockLdInit).toHaveBeenCalledTimes(2);
      resolveFirst();
      await expect(inFlight).rejects.toThrow(/abandoned/);
    });

    it('does not let an abandoned init replace the client that came after it', async () => {
      // shutdown() drops an in-flight attempt so the next call starts fresh,
      // but the attempt keeps running. When it finishes it must not overwrite
      // the newer client — leaking that one's connection — and must close its
      // own instead.
      let resolveFirst: () => void = () => {};
      const first = { ...makeMockClient(), close: vi.fn().mockResolvedValue(undefined) };
      first.waitForInitialization = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveFirst = resolve;
          }),
      );
      const second = { ...makeMockClient(), close: vi.fn().mockResolvedValue(undefined) };
      mockLdInit.mockReturnValueOnce(first).mockReturnValueOnce(second);
      process.env.LD_SDK_KEY = 'test-key';

      const { initClient, shutdown, getClient } = await import('../lifecycle.js');
      const inFlight = initClient();
      await vi.waitFor(() => expect(first.waitForInitialization).toHaveBeenCalled());
      await shutdown();
      await initClient();

      resolveFirst();
      await expect(inFlight).rejects.toThrow(/abandoned/);
      expect(getClient()).toBe(second);
      expect(first.close).toHaveBeenCalledOnce();
      expect(second.close).not.toHaveBeenCalled();
    });

    it('abandons an in-flight init when a pre-initialized client is passed meanwhile', async () => {
      let resolveFirst: () => void = () => {};
      const first = { ...makeMockClient(), close: vi.fn().mockResolvedValue(undefined) };
      first.waitForInitialization = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveFirst = resolve;
          }),
      );
      mockLdInit.mockReturnValueOnce(first);
      process.env.LD_SDK_KEY = 'test-key';
      const byocClient = { ...makeMockClient(), close: vi.fn().mockResolvedValue(undefined) };

      const { initClient, getClient } = await import('../lifecycle.js');
      const inFlight = initClient();
      await vi.waitFor(() => expect(first.waitForInitialization).toHaveBeenCalled());
      await initClient(byocClient);

      resolveFirst();
      await expect(inFlight).rejects.toThrow(/abandoned/);
      expect(getClient()).toBe(byocClient);
      expect(first.close).toHaveBeenCalledOnce();
      expect(byocClient.close).not.toHaveBeenCalled();
      // The BYOC call reused the in-flight attempt's provider, so it stays.
      expect(tracerProviders).toHaveLength(1);
      expect(mockTracerProviderShutdown).not.toHaveBeenCalled();
      expect(otel.held.trace).toBe(tracerProviders[0]);
    });

    it('is a no-op (does not throw) when called without a prior initClient', async () => {
      const { shutdown } = await import('../lifecycle.js');
      // Should not throw even though the client was never initialized.
      await expect(shutdown()).resolves.toBeUndefined();
    });

    it('is a no-op (does not throw) when called a second time after already shutting down', async () => {
      const mockClient = makeMockClient();
      mockLdInit.mockReturnValue(mockClient);
      process.env.LD_SDK_KEY = 'test-key';

      const { initClient, shutdown } = await import('../lifecycle.js');
      await initClient();
      await shutdown();
      // Second call — singleton is now null; should be a no-op, not throw.
      await expect(shutdown()).resolves.toBeUndefined();
    });

    it('still nulls the singleton when flush() throws, so a second call becomes a no-op', async () => {
      const mockClient = makeMockClient();
      mockFlush.mockRejectedValueOnce(new Error('flush failed'));
      mockLdInit.mockReturnValue(mockClient);
      process.env.LD_SDK_KEY = 'test-key';

      const { initClient, shutdown, getClient } = await import('../lifecycle.js');
      await initClient();
      // First call: flush throws, but teardown should still null the singleton and close.
      await expect(shutdown()).rejects.toThrow('flush failed');
      expect(mockClose).toHaveBeenCalled();
      // Singleton must be null so getClient() throws.
      expect(() => getClient()).toThrow(/not initialized/i);
      // Second call must be a no-op (not throw "client not initialized").
      await expect(shutdown()).resolves.toBeUndefined();
    });

    describe('shutdown hooks', () => {
      const hooksKey = Symbol.for('@launchdarkly/ai-server:shutdown-hooks');
      const hooks = () => (globalThis as any)[hooksKey] as Map<string, () => void> | undefined;

      afterEach(() => {
        hooks()?.delete('test: throws');
        hooks()?.delete('test: records');
      });

      it('runs every registered hook, even before a client exists', async () => {
        const { registerShutdownHook } = await import('../shutdown-hooks.js');
        const hook = vi.fn();
        registerShutdownHook('test: records', hook);

        const { shutdown } = await import('../lifecycle.js');
        await shutdown();

        expect(hook).toHaveBeenCalledOnce();
      });

      it('a throwing hook is logged and fails neither the other hooks nor client teardown', async () => {
        // Experimental code reached from core through a hook must not break
        // the core call.
        const { registerShutdownHook } = await import('../shutdown-hooks.js');
        registerShutdownHook('test: throws', () => {
          throw new Error('clear exploded');
        });
        const after = vi.fn();
        registerShutdownHook('test: records', after);
        mockLdInit.mockReturnValue(makeMockClient());
        process.env.LD_SDK_KEY = 'test-key';
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        try {
          const { initClient, shutdown } = await import('../lifecycle.js');
          await initClient();
          await expect(shutdown()).resolves.toBeUndefined();

          expect(after).toHaveBeenCalledOnce();
          expect(mockClose).toHaveBeenCalledOnce();
          expect(warn).toHaveBeenCalledWith(expect.stringContaining('test: throws'), expect.any(Error));
        } finally {
          warn.mockRestore();
        }
      });

      it('re-registering a name replaces the hook rather than adding one', async () => {
        const { registerShutdownHook } = await import('../shutdown-hooks.js');
        const first = vi.fn();
        const second = vi.fn();
        registerShutdownHook('test: records', first);
        registerShutdownHook('test: records', second);

        const { shutdown } = await import('../lifecycle.js');
        await shutdown();

        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledOnce();
      });

      it('loading the package root registers no Agent Skills hook', async () => {
        // The root entry point must not import experimental code. Agent Skills
        // registers its hook when its core module loads, so the hook's absence
        // after loading the root shows the root never loaded that module.
        await import('../index.js');

        expect([...(hooks()?.keys() ?? [])].filter((name) => !name.startsWith('test: '))).toEqual([]);
      });
    });
  });

  describe('OTel global registration', () => {
    it('registers a fresh provider after an init/shutdown/init cycle', async () => {
      // Each OTel global is one-shot: unless shutdown releases it, the second
      // provider's registration is refused and every span goes to the first,
      // which has already been shut down.
      mockLdInit.mockReturnValue(makeMockClient());
      process.env.LD_SDK_KEY = 'test-key';

      const { initClient, shutdown } = await import('../lifecycle.js');
      await initClient();
      await shutdown();
      expect(otel.trace.disable).toHaveBeenCalledOnce();
      expect(otel.context.disable).toHaveBeenCalledOnce();
      expect(otel.propagation.disable).toHaveBeenCalledOnce();

      await initClient();
      expect(tracerProviders).toHaveLength(2);
      expect(otel.held.trace).toBe(tracerProviders[1]);
      expect(otel.trace.set).toHaveLastReturnedWith(true);
    });

    it('leaves globals another library registered first in place on shutdown', async () => {
      const host = { name: 'host provider' };
      otel.held.trace = host;
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockLdInit.mockReturnValue(makeMockClient());
      process.env.LD_SDK_KEY = 'test-key';

      const { initClient, shutdown } = await import('../lifecycle.js');
      await initClient();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('already registered'));
      warnSpy.mockRestore();

      await shutdown();
      // Ours is still shut down — it holds an exporter and a batch timer — but
      // the global it never took stays with the host.
      expect(mockTracerProviderShutdown).toHaveBeenCalledOnce();
      expect(otel.trace.disable).not.toHaveBeenCalled();
      expect(otel.held.trace).toBe(host);
      // The globals that were free are ours, and are released.
      expect(otel.context.disable).toHaveBeenCalledOnce();
      expect(otel.propagation.disable).toHaveBeenCalledOnce();
    });

    it('releases only the globals it took, one API at a time', async () => {
      const hostContextManager = { name: 'host context manager' };
      otel.held.context = hostContextManager;
      mockLdInit.mockReturnValue(makeMockClient());
      process.env.LD_SDK_KEY = 'test-key';

      const { initClient, shutdown } = await import('../lifecycle.js');
      await initClient();
      // Our refused context manager is not left enabled alongside theirs.
      expect(mockContextManagerDisable).toHaveBeenCalledOnce();

      await shutdown();
      expect(otel.context.disable).not.toHaveBeenCalled();
      expect(otel.held.context).toBe(hostContextManager);
      expect(otel.trace.disable).toHaveBeenCalledOnce();
      expect(otel.propagation.disable).toHaveBeenCalledOnce();
    });

    it('builds one provider across repeat BYOC calls', async () => {
      // A second provider would be refused registration yet replace the handle
      // shutdown flushes, so the live provider would leak and never flush.
      const byocClient = { ...makeMockClient(), variation: vi.fn() };
      const { initClient, shutdown } = await import('../lifecycle.js');
      await initClient(byocClient);
      await initClient(byocClient);
      expect(tracerProviders).toHaveLength(1);

      await shutdown();
      expect(mockTracerProviderShutdown.mock.contexts).toEqual([tracerProviders[0]]);
      expect(otel.held.trace).toBeNull();
    });

    it('tears down the provider of an init that times out after telemetry setup, then retries', async () => {
      const failed = makeMockClient();
      failed.waitForInitialization = vi.fn().mockRejectedValue(new Error('timeout'));
      mockLdInit.mockReturnValueOnce(failed).mockReturnValueOnce(makeMockClient());
      process.env.LD_SDK_KEY = 'test-key';

      const { initClient, shutdown } = await import('../lifecycle.js');
      await expect(initClient()).rejects.toThrow('timeout');
      expect(mockTracerProviderShutdown.mock.contexts).toEqual([tracerProviders[0]]);
      expect(otel.held).toEqual({ trace: null, context: null, propagation: null });

      await initClient();
      expect(tracerProviders).toHaveLength(2);
      expect(otel.held.trace).toBe(tracerProviders[1]);

      // Nothing leaked: shutdown reaches the retry's provider, so each built
      // provider is shut down exactly once.
      await shutdown();
      expect(mockTracerProviderShutdown.mock.contexts).toEqual(tracerProviders);
    });

    it('tears down the provider of an init that fails for want of node-server-sdk, then retries', async () => {
      ldSdk.installed = false;
      process.env.LD_SDK_KEY = 'test-key';

      const { initClient, getClient } = await import('../lifecycle.js');
      await expect(initClient()).rejects.toThrow(/node-server-sdk is not installed/);
      expect(mockTracerProviderShutdown.mock.contexts).toEqual([tracerProviders[0]]);
      expect(otel.held.trace).toBeNull();

      ldSdk.installed = true;
      const client = makeMockClient();
      mockLdInit.mockReturnValue(client);
      await initClient();
      expect(getClient()).toBe(client);
      expect(tracerProviders).toHaveLength(2);
      expect(otel.held.trace).toBe(tracerProviders[1]);
    });

    it('tears down the provider of an init in flight at shutdown, so the next init builds its own', async () => {
      // shutdown() used to return early without a client, leaving the in-flight
      // attempt's provider registered for the next init to reuse — with the
      // abandoned attempt's sdkKey as highlight.project_id.
      let resolveFirst: () => void = () => {};
      const first = makeMockClient();
      first.waitForInitialization = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveFirst = resolve;
          }),
      );
      mockLdInit.mockReturnValueOnce(first).mockReturnValueOnce(makeMockClient());

      const { initClient, shutdown } = await import('../lifecycle.js');
      const inFlight = initClient({ sdkKey: 'first-key' });
      await vi.waitFor(() => expect(first.waitForInitialization).toHaveBeenCalled());
      await shutdown();
      expect(mockTracerProviderShutdown.mock.contexts).toEqual([tracerProviders[0]]);
      expect(otel.held).toEqual({ trace: null, context: null, propagation: null });

      await initClient({ sdkKey: 'second-key' });
      expect(tracerProviders).toHaveLength(2);
      expect(otel.held.trace).toBe(tracerProviders[1]);
      expect(mockResourceFromAttributes).toHaveBeenLastCalledWith(
        expect.objectContaining({ 'highlight.project_id': 'second-key' }),
      );

      resolveFirst();
      await expect(inFlight).rejects.toThrow(/abandoned/);
      // Abandoning it leaves the newer provider alone.
      expect(otel.held.trace).toBe(tracerProviders[1]);
      expect(mockTracerProviderShutdown).toHaveBeenCalledOnce();
    });

    it('builds no provider for an init that shutdown abandons during telemetry setup', async () => {
      // No await before shutdown(): setupTelemetry is still awaiting its
      // imports, so there is no provider yet for shutdown to tear down. One
      // built afterwards would outlive the attempt and be reused by the next
      // init, with the abandoned attempt's sdkKey as highlight.project_id.
      const first = { ...makeMockClient(), close: vi.fn().mockResolvedValue(undefined) };
      mockLdInit.mockReturnValueOnce(first).mockReturnValueOnce(makeMockClient());

      const { initClient, shutdown } = await import('../lifecycle.js');
      const abandoned = initClient({ sdkKey: 'first-key' });
      await shutdown();
      await expect(abandoned).rejects.toThrow(/abandoned/);
      expect(tracerProviders).toHaveLength(0);
      expect(otel.held).toEqual({ trace: null, context: null, propagation: null });

      await initClient({ sdkKey: 'second-key' });
      expect(tracerProviders).toHaveLength(1);
      expect(otel.held.trace).toBe(tracerProviders[0]);
      expect(mockResourceFromAttributes).toHaveBeenCalledOnce();
      expect(mockResourceFromAttributes).toHaveBeenCalledWith(
        expect.objectContaining({ 'highlight.project_id': 'second-key' }),
      );
    });

    it('does not let an abandoned init that then fails tear down the newer provider', async () => {
      // The newer attempt is still in flight, so there is no client yet to
      // say the current provider is spoken for: only its identity does.
      let rejectFirst: (err: Error) => void = () => {};
      const first = makeMockClient();
      first.waitForInitialization = vi.fn(
        () =>
          new Promise<void>((_, reject) => {
            rejectFirst = reject;
          }),
      );
      let resolveSecond: () => void = () => {};
      const second = makeMockClient();
      second.waitForInitialization = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveSecond = resolve;
          }),
      );
      mockLdInit.mockReturnValueOnce(first).mockReturnValueOnce(second);
      process.env.LD_SDK_KEY = 'test-key';

      const { initClient, shutdown, getClient } = await import('../lifecycle.js');
      const abandoned = initClient();
      await vi.waitFor(() => expect(first.waitForInitialization).toHaveBeenCalled());
      await shutdown();
      const current = initClient();
      await vi.waitFor(() => expect(second.waitForInitialization).toHaveBeenCalled());

      rejectFirst(new Error('timeout'));
      await expect(abandoned).rejects.toThrow('timeout');
      expect(otel.held.trace).toBe(tracerProviders[1]);
      expect(mockTracerProviderShutdown.mock.contexts).toEqual([tracerProviders[0]]);

      resolveSecond();
      await expect(current).resolves.toBe(second);
      expect(getClient()).toBe(second);
    });

    it('builds the retry its own provider, with the options the retry passed', async () => {
      // Reusing the failed attempt's provider would stamp its spans with the
      // failed attempt's sdkKey as highlight.project_id.
      const failed = makeMockClient();
      failed.waitForInitialization = vi.fn().mockRejectedValue(new Error('timeout'));
      mockLdInit.mockReturnValueOnce(failed).mockReturnValueOnce(makeMockClient());

      const { initClient } = await import('../lifecycle.js');
      await expect(initClient({ sdkKey: 'first-key' })).rejects.toThrow('timeout');
      await initClient({ sdkKey: 'second-key' });

      expect(mockResourceFromAttributes).toHaveBeenLastCalledWith(
        expect.objectContaining({ 'highlight.project_id': 'second-key' }),
      );
    });
  });

  describe('when OTel SDK packages are not installed', () => {
    it('emits a console.warn and still resolves when an OTel peer dep cannot be imported', async () => {
      vi.resetModules();
      vi.doMock('@opentelemetry/sdk-trace-node', () => {
        throw new Error('Cannot find module @opentelemetry/sdk-trace-node');
      });

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const mockClient = makeMockClient();
      mockLdInit.mockReturnValue(mockClient);
      process.env.LD_SDK_KEY = 'test-key';

      const { initClient } = await import('../lifecycle.js');
      await expect(initClient()).resolves.toBeDefined();

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('npm install'));
      warnSpy.mockRestore();
      vi.doMock('@opentelemetry/sdk-trace-node', mockNodeTracerProviderModule);
    });

    it('getClient returns the LD client even when telemetry setup was skipped', async () => {
      vi.resetModules();
      vi.doMock('@opentelemetry/sdk-trace-node', () => {
        throw new Error('Cannot find module @opentelemetry/sdk-trace-node');
      });

      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const mockClient = makeMockClient();
      mockLdInit.mockReturnValue(mockClient);
      process.env.LD_SDK_KEY = 'test-key';

      const { initClient, getClient } = await import('../lifecycle.js');
      await initClient();
      expect(getClient()).toBe(mockClient);

      vi.restoreAllMocks();
      vi.doMock('@opentelemetry/sdk-trace-node', mockNodeTracerProviderModule);
    });

    it('shutdown does not throw for telemetry when setup was skipped', async () => {
      vi.resetModules();
      vi.doMock('@opentelemetry/sdk-trace-node', () => {
        throw new Error('Cannot find module @opentelemetry/sdk-trace-node');
      });

      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const mockClient = makeMockClient();
      mockLdInit.mockReturnValue(mockClient);
      process.env.LD_SDK_KEY = 'test-key';

      const { initClient, shutdown } = await import('../lifecycle.js');
      await initClient();
      await expect(shutdown()).resolves.toBeUndefined();
      expect(mockTracerProviderShutdown).not.toHaveBeenCalled();

      vi.restoreAllMocks();
      vi.doMock('@opentelemetry/sdk-trace-node', mockNodeTracerProviderModule);
    });
  });

  describe('inspectConfig', () => {
    it('returns enabled=true and the parsed config when the variation is enabled', async () => {
      const mockClient = makeMockClient();
      mockClient.variation = vi.fn().mockResolvedValue({
        _ldMeta: { enabled: true, variationKey: 'v1', version: 1, mode: 'messages' },
        model: { name: 'gpt-4o' },
        provider: { name: 'OpenAI' },
        instructions: 'You are helpful.',
      });
      mockLdInit.mockReturnValue(mockClient);
      process.env.LD_SDK_KEY = 'test-key';

      const { inspectConfig } = await import('../lifecycle.js');
      const ctx = { kind: 'user' as const, key: 'user-1' };
      const result = await inspectConfig('my-flag', ctx);

      expect(result.enabled).toBe(true);
      expect(result.config?.model.name).toBe('gpt-4o');
      expect(result.meta?.variationKey).toBe('v1');
    });

    it('does not fail on a malformed skills field', async () => {
      // Agent Skills is experimental, so its field cannot break a core call
      // (TESTING.md §0.3). `skillRefs` rejects it instead.
      const mockClient = makeMockClient();
      mockClient.variation = vi.fn().mockResolvedValue({
        _ldMeta: { enabled: true, variationKey: 'v1', version: 1, mode: 'messages' },
        model: { name: 'gpt-4o' },
        provider: { name: 'OpenAI' },
        instructions: 'You are helpful.',
        skills: [{ key: 'My_Skill', version: 0 }],
      });
      mockLdInit.mockReturnValue(mockClient);
      process.env.LD_SDK_KEY = 'test-key';

      const { inspectConfig, extractVariation } = await import('../lifecycle.js');
      const ctx = { kind: 'user' as const, key: 'user-1' };
      const result = await inspectConfig('my-flag', ctx);
      const extracted = await extractVariation('my-flag', ctx);

      expect(result.enabled).toBe(true);
      expect(result.config?.model.name).toBe('gpt-4o');
      expect(extracted.config.model.name).toBe('gpt-4o');
    });

    it('preserves modelKey and modelVersion from _ldMeta on meta', async () => {
      const mockClient = makeMockClient();
      mockClient.variation = vi.fn().mockResolvedValue({
        _ldMeta: {
          enabled: true,
          variationKey: 'v1',
          version: 1,
          mode: 'messages',
          modelKey: 'my-model',
          modelVersion: 3,
        },
        model: { name: 'gpt-4o' },
        provider: { name: 'OpenAI' },
        instructions: 'You are helpful.',
      });
      mockLdInit.mockReturnValue(mockClient);
      process.env.LD_SDK_KEY = 'test-key';

      const { inspectConfig } = await import('../lifecycle.js');
      const result = await inspectConfig('my-flag', { kind: 'user' as const, key: 'user-1' });

      expect(result.meta?.modelKey).toBe('my-model');
      expect(result.meta?.modelVersion).toBe(3);
    });

    it('returns enabled=false and config=null when the variation is disabled', async () => {
      const mockClient = makeMockClient();
      mockClient.variation = vi.fn().mockResolvedValue({
        _ldMeta: { enabled: false },
      });
      mockLdInit.mockReturnValue(mockClient);
      process.env.LD_SDK_KEY = 'test-key';

      const { inspectConfig } = await import('../lifecycle.js');
      const ctx = { kind: 'user' as const, key: 'user-1' };
      const result = await inspectConfig('my-flag', ctx);

      expect(result.enabled).toBe(false);
      expect(result.config).toBeNull();
    });

    it('returns enabled=true and config=null when the variation is enabled but fails schema validation', async () => {
      const mockClient = makeMockClient();
      mockClient.variation = vi.fn().mockResolvedValue({
        _ldMeta: { enabled: true },
        // missing model and provider
      });
      mockLdInit.mockReturnValue(mockClient);
      process.env.LD_SDK_KEY = 'test-key';

      const { inspectConfig } = await import('../lifecycle.js');
      const ctx = { kind: 'user' as const, key: 'user-1' };
      const result = await inspectConfig('my-flag', ctx);

      expect(result.enabled).toBe(true);
      expect(result.config).toBeNull();
    });

    it('recovers once LD_SDK_KEY becomes available after a failed lazy init', async () => {
      // inspectConfig swallows the init error, so a cached rejection would make
      // an app that called it too early serve disabled configs forever.
      const mockClient = makeMockClient();
      mockClient.variation = vi.fn().mockResolvedValue({
        _ldMeta: { enabled: true, variationKey: 'v1', version: 1, mode: 'messages' },
        model: { name: 'gpt-4o' },
        provider: { name: 'OpenAI' },
        instructions: 'You are helpful.',
      });
      mockLdInit.mockReturnValue(mockClient);

      const { inspectConfig } = await import('../lifecycle.js');
      const ctx = { kind: 'user' as const, key: 'user-1' };
      expect((await inspectConfig('my-flag', ctx)).enabled).toBe(false);

      process.env.LD_SDK_KEY = 'test-key';
      expect((await inspectConfig('my-flag', ctx)).enabled).toBe(true);
    });

    it('returns enabled=false when the LD client throws', async () => {
      const mockClient = makeMockClient();
      mockClient.variation = vi.fn().mockRejectedValue(new Error('network error'));
      mockLdInit.mockReturnValue(mockClient);
      process.env.LD_SDK_KEY = 'test-key';

      const { inspectConfig } = await import('../lifecycle.js');
      const ctx = { kind: 'user' as const, key: 'user-1' };
      const result = await inspectConfig('my-flag', ctx);

      expect(result.enabled).toBe(false);
      expect(result.config).toBeNull();
      expect(result.meta).toBeNull();
    });
  });

  describe('extractVariation', () => {
    it('returns config and meta when the variation is enabled and valid', async () => {
      const mockClient = makeMockClient();
      mockClient.variation = vi.fn().mockResolvedValue({
        _ldMeta: { enabled: true, variationKey: 'v1', version: 1, mode: 'messages' },
        model: { name: 'gpt-4o' },
        provider: { name: 'OpenAI' },
        instructions: 'You are helpful.',
      });
      mockLdInit.mockReturnValue(mockClient);
      process.env.LD_SDK_KEY = 'test-key';

      const { extractVariation } = await import('../lifecycle.js');
      const ctx = { kind: 'user' as const, key: 'user-1' };
      const { config, meta } = await extractVariation('my-flag', ctx);

      expect(config.model.name).toBe('gpt-4o');
      expect(meta.variationKey).toBe('v1');
    });

    it('preserves modelKey and modelVersion from _ldMeta on meta', async () => {
      const mockClient = makeMockClient();
      mockClient.variation = vi.fn().mockResolvedValue({
        _ldMeta: {
          enabled: true,
          variationKey: 'v1',
          version: 1,
          mode: 'messages',
          modelKey: 'my-model',
          modelVersion: 3,
        },
        model: { name: 'gpt-4o' },
        provider: { name: 'OpenAI' },
        instructions: 'You are helpful.',
      });
      mockLdInit.mockReturnValue(mockClient);
      process.env.LD_SDK_KEY = 'test-key';

      const { extractVariation } = await import('../lifecycle.js');
      const { meta } = await extractVariation('my-flag', { kind: 'user' as const, key: 'user-1' });

      expect(meta.modelKey).toBe('my-model');
      expect(meta.modelVersion).toBe(3);
    });

    it('throws when the variation is disabled', async () => {
      const mockClient = makeMockClient();
      mockClient.variation = vi.fn().mockResolvedValue({
        _ldMeta: { enabled: false },
      });
      mockLdInit.mockReturnValue(mockClient);
      process.env.LD_SDK_KEY = 'test-key';

      const { extractVariation } = await import('../lifecycle.js');
      const ctx = { kind: 'user' as const, key: 'user-1' };
      await expect(extractVariation('my-flag', ctx)).rejects.toThrow(/not enabled/i);
    });

    it('throws when the variation fails schema validation', async () => {
      const mockClient = makeMockClient();
      mockClient.variation = vi.fn().mockResolvedValue({
        _ldMeta: { enabled: true },
        // missing model and provider
      });
      mockLdInit.mockReturnValue(mockClient);
      process.env.LD_SDK_KEY = 'test-key';

      const { extractVariation } = await import('../lifecycle.js');
      const ctx = { kind: 'user' as const, key: 'user-1' };
      await expect(extractVariation('my-flag', ctx)).rejects.toThrow(/Invalid AI config/i);
    });
  });
});
