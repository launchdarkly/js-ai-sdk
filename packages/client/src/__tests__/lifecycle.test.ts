import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mock external dependencies before any imports ───────────────────────────

const mockTrack = vi.fn();
const mockFlush = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);
const mockWaitForInitialization = vi.fn().mockResolvedValue(undefined);
const mockLdInit = vi.fn();

vi.mock('@launchdarkly/node-server-sdk', () => ({
  init: (...args: any[]) => mockLdInit(...args),
}));

const mockTracerProviderShutdown = vi.fn().mockResolvedValue(undefined);
const mockTracerProviderRegister = vi.fn();

vi.mock('@opentelemetry/sdk-trace-node', () => ({
  NodeTracerProvider: class {
    register = mockTracerProviderRegister;
    shutdown = mockTracerProviderShutdown;
  },
}));

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
vi.mock('@opentelemetry/context-async-hooks', () => ({
  AsyncLocalStorageContextManager: class {
    enable = mockContextManagerEnable;
  },
}));

vi.mock('@opentelemetry/core', () => ({
  CompositePropagator: class {},
  W3CBaggagePropagator: class {},
  W3CTraceContextPropagator: class {},
}));

vi.mock('@opentelemetry/api', () => ({
  createContextKey: (name: string) => Symbol(name),
  trace: {
    getTracerProvider: vi.fn().mockReturnValue({ _delegate: {} }),
  },
  propagation: {
    setGlobalPropagator: vi.fn(),
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
    vi.clearAllMocks();
    delete process.env.LD_SDK_KEY;
  });

  afterEach(() => {
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

    it('registers AsyncLocalStorageContextManager via tracerProvider.register', async () => {
      const mockClient = makeMockClient();
      mockLdInit.mockReturnValue(mockClient);
      process.env.LD_SDK_KEY = 'sdk-test-key';

      const { initClient } = await import('../lifecycle.js');
      await initClient();

      expect(mockTracerProviderRegister).toHaveBeenCalledWith(
        expect.objectContaining({ contextManager: expect.objectContaining({ enable: expect.any(Function) }) }),
      );
    });

    it('registers W3C propagators via tracerProvider.register', async () => {
      const mockClient = makeMockClient();
      mockLdInit.mockReturnValue(mockClient);
      process.env.LD_SDK_KEY = 'sdk-test-key';

      const { initClient } = await import('../lifecycle.js');
      await initClient();

      expect(mockTracerProviderRegister).toHaveBeenCalledWith(
        expect.objectContaining({ propagator: expect.any(Object) }),
      );
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
      expect(mockTracerProviderRegister).toHaveBeenCalled();
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
      vi.doUnmock('@opentelemetry/sdk-trace-node');
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
      vi.doUnmock('@opentelemetry/sdk-trace-node');
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
      vi.doUnmock('@opentelemetry/sdk-trace-node');
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
