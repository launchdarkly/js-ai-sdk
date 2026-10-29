import { propagation, SpanStatusCode, type TextMapPropagator } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockQuery = vi.fn();
const mockTool = vi.fn().mockReturnValue({});
const mockCreateSdkMcpServer = vi.fn().mockReturnValue({});
const { makeMockSpan, mockChildSpans, mockSpan } = vi.hoisted(() => {
  const makeSpan = () => ({
    setAttribute: vi.fn(),
    addEvent: vi.fn(),
    setStatus: vi.fn(),
    end: vi.fn(),
    recordException: vi.fn(),
  });
  return {
    makeMockSpan: makeSpan,
    mockChildSpans: [] as Array<{ name: string; span: ReturnType<typeof makeSpan> }>,
    mockSpan: makeSpan(),
  };
});

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: any[]) => mockQuery(...args),
  tool: (...args: any[]) => mockTool(...args),
  createSdkMcpServer: (...args: any[]) => mockCreateSdkMcpServer(...args),
}));

vi.mock('@opentelemetry/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opentelemetry/api')>();
  return {
    ...actual,
    trace: {
      ...actual.trace,
      getTracer: vi.fn().mockReturnValue({
        startActiveSpan: vi.fn().mockImplementation((_name: string, fn: Function) => fn(mockSpan)),
        startSpan: vi.fn().mockImplementation((name: string) => {
          if (name === 'invoke_agent') return mockSpan;
          const span = makeMockSpan();
          mockChildSpans.push({ name, span });
          return span;
        }),
      }),
    },
  };
});

vi.mock('@launchdarkly/ai-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@launchdarkly/ai-server')>();
  return {
    ...actual,
    configInternal: vi.fn().mockReturnValue({ invoke: vi.fn().mockResolvedValue({ response: 'ok', usage: {} }) }),
  };
});

import {
  configure,
  type Message,
  NATIVE_TOOL_KEY,
  NativeTool,
  type ProviderHandler,
  shutdown,
} from '@launchdarkly/ai-server';
import { buildPrompt, buildToolMCP, createClaudeAgentsHandler, partitionTools } from '../handler.js';
import { expectNoNeverForwardedValue, NEVER_FORWARDED_PARAMETERS } from './never-forwarded.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeResultMessage(result = 'agent output', usage = { input_tokens: 10, output_tokens: 5 }) {
  return async function* () {
    yield { type: 'result', subtype: 'success', result, usage };
  };
}

const baseConfig = {
  model: { name: 'claude-opus-4-5' },
  provider: { name: 'Anthropic' },
  instructions: 'You are helpful.',
};

// ─── buildPrompt ──────────────────────────────────────────────────────────────

describe('buildPrompt', () => {
  it('uses instructions as systemPrompt and userInput as prompt', () => {
    const { prompt, systemPrompt } = buildPrompt({ ...baseConfig, instructions: 'Be helpful.' } as any, 'hi', {});
    expect(systemPrompt).toBe('Be helpful.');
    expect(prompt).toBe('hi');
  });

  it('substitutes variables in instructions', () => {
    const { systemPrompt } = buildPrompt({ ...baseConfig, instructions: 'Hello {{name}}.' } as any, 'q', {
      name: 'Eve',
    });
    expect(systemPrompt).toBe('Hello Eve.');
  });

  it('leaves unresolved placeholders as-is', () => {
    const { systemPrompt } = buildPrompt({ ...baseConfig, instructions: 'Hello {{missing}}.' } as any, 'q', {});
    expect(systemPrompt).toBe('Hello {{missing}}.');
  });

  it('prefers instructions over messages for the system prompt', () => {
    const config = {
      model: { name: 'claude-opus-4-5' },
      provider: { name: 'Anthropic' },
      instructions: 'From instructions.',
      messages: [{ role: 'system', content: 'From messages.' }],
    };
    const { systemPrompt } = buildPrompt(config as any, 'q', {});
    expect(systemPrompt).toBe('From instructions.');
  });

  it('builds prompt from messages when instructions absent', () => {
    const config = {
      model: { name: 'claude-opus-4-5' },
      provider: { name: 'Anthropic' },
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Old message' },
      ],
    };
    const { prompt, systemPrompt } = buildPrompt(config as any, 'new input', {});
    expect(systemPrompt).toBe('Be concise.');
    expect(prompt).toContain('Old message');
    expect(prompt).toContain('new input');
  });

  it('returns only prompt when neither instructions nor messages present', () => {
    const config = { model: { name: 'claude-opus-4-5' }, provider: { name: 'Anthropic' } };
    const { prompt, systemPrompt } = buildPrompt(config as any, 'just input', {});
    expect(prompt).toBe('just input');
    expect(systemPrompt).toBeUndefined();
  });
});

// ─── partitionTools ───────────────────────────────────────────────────────────

describe('partitionTools', () => {
  it('routes NativeTool stubs to nativeToolMap', () => {
    const native = new NativeTool(Symbol('n'), 'WebSearch');
    const stub = () => {};
    (stub as any)[NATIVE_TOOL_KEY] = native;
    const { nativeToolMap, nativeToolNames } = partitionTools(
      { webSearch: { name: 'webSearch', type: 'function' as const, parameters: {} } },
      { webSearch: stub },
    );
    expect(nativeToolMap.has('WebSearch')).toBe(true);
    expect(nativeToolNames).toContain('WebSearch');
  });

  it('does not enable a native tool that is not attached to the active config (SEC-9507)', () => {
    const native = new NativeTool(Symbol('bash'), 'Bash');
    const stub = () => {};
    (stub as any)[NATIVE_TOOL_KEY] = native;
    for (const configTools of [
      undefined,
      {},
      { other: { name: 'other', type: 'function' as const, parameters: {} } },
    ]) {
      const { nativeToolMap, nativeToolNames, nativeToolAliases } = partitionTools(configTools, { runBash: stub });
      expect(nativeToolMap.size).toBe(0);
      expect(nativeToolNames).toEqual([]);
      expect(nativeToolAliases.size).toBe(0);
    }
  });

  it('ignores inherited config tool names (SEC-9507)', () => {
    const configTools = Object.create({ search: { name: 'search', type: 'function', parameters: {} } });
    const { userConfigTools } = partitionTools(configTools, { search: vi.fn() });
    expect(userConfigTools).toEqual({});
  });

  it('routes user-defined tool handlers to userConfigTools', () => {
    const configTools = {
      search: { name: 'search', type: 'function' as const, parameters: {} },
    };
    const fn = vi.fn();
    const { userConfigTools } = partitionTools(configTools, { search: fn });
    expect(userConfigTools).toHaveProperty('search');
  });
});

// ─── createClaudeAgentsHandler ────────────────────────────────────────────────

describe('createClaudeAgentsHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockChildSpans.length = 0;
    for (const key of Object.keys(mockSpan)) {
      (mockSpan as any)[key].mockReset?.();
    }
  });

  // ── 1.1 Factory and metadata ────────────────────────────────────────────────

  it('returns a callable function', () => {
    expect(typeof createClaudeAgentsHandler()).toBe('function');
  });

  it('attaches providesFor = ["Anthropic", "agent"]', () => {
    expect(createClaudeAgentsHandler().providesFor).toEqual(['Anthropic', 'agent']);
  });

  it('returns independent instances on multiple calls', () => {
    expect(createClaudeAgentsHandler()).not.toBe(createClaudeAgentsHandler());
  });

  // ── 1.2 & 1.4 Prompt construction and agentic loop ─────────────────────────

  it('passes systemPrompt and model name to query', async () => {
    mockQuery.mockImplementation(makeResultMessage());
    await createClaudeAgentsHandler()(baseConfig as any, 'hello');
    const { options } = mockQuery.mock.calls[0][0];
    expect(options.systemPrompt).toBe('You are helpful.');
    expect(options.model).toBe('claude-opus-4-5');
  });

  it('returns the result from the query generator', async () => {
    mockQuery.mockImplementation(makeResultMessage('final answer'));
    const result = await createClaudeAgentsHandler()(baseConfig as any, 'q');
    expect(result.output).toBe('final answer');
  });

  it('forwards model.parameters.maxTurns to query options', async () => {
    mockQuery.mockImplementation(makeResultMessage());
    const config = { ...baseConfig, model: { ...baseConfig.model, parameters: { maxTurns: 3 } } };
    await createClaudeAgentsHandler()(config as any, 'q');
    const { options } = mockQuery.mock.calls[0][0];
    expect(options.maxTurns).toBe(3);
  });

  // The LaunchDarkly UI writes model.parameters in snake_case (the wire name every provider
  // client expects), but the Claude Agent SDK's query() Options only reads camelCase — so a
  // config saved as `max_turns` must reach query() as `maxTurns`, not vanish silently.
  it('converts a snake_case max_turns to maxTurns for query options', async () => {
    mockQuery.mockImplementation(makeResultMessage());
    const config = { ...baseConfig, model: { ...baseConfig.model, parameters: { max_turns: 7 } } };
    await createClaudeAgentsHandler()(config as any, 'q');
    const { options } = mockQuery.mock.calls[0][0];
    expect(options.maxTurns).toBe(7);
    expect(options.max_turns).toBeUndefined();
  });

  it('converts snake_case model.parameters keys for query options (maxThinkingTokens etc.)', async () => {
    mockQuery.mockImplementation(makeResultMessage());
    const config = {
      ...baseConfig,
      model: {
        ...baseConfig.model,
        parameters: { max_thinking_tokens: 2048, max_budget_usd: 1.5, fallback_model: 'claude-haiku' },
      },
    };
    await createClaudeAgentsHandler()(config as any, 'q');
    const { options } = mockQuery.mock.calls[0][0];
    expect(options.maxThinkingTokens).toBe(2048);
    expect(options.maxBudgetUsd).toBe(1.5);
    expect(options.fallbackModel).toBe('claude-haiku');
  });

  it('forwards recognized model.parameters keys to query options', async () => {
    mockQuery.mockImplementation(makeResultMessage());
    const config = {
      ...baseConfig,
      model: {
        ...baseConfig.model,
        parameters: { maxThinkingTokens: 2048, maxBudgetUsd: 1.5, effort: 'high', fallbackModel: 'claude-haiku' },
      },
    };
    await createClaudeAgentsHandler()(config as any, 'q');
    const { options } = mockQuery.mock.calls[0][0];
    expect(options.maxThinkingTokens).toBe(2048);
    expect(options.maxBudgetUsd).toBe(1.5);
    expect(options.effort).toBe('high');
    expect(options.fallbackModel).toBe('claude-haiku');
  });

  it('drops model.parameters keys that are not on the query options allowlist', async () => {
    mockQuery.mockImplementation(makeResultMessage());
    const config = {
      ...baseConfig,
      model: { ...baseConfig.model, parameters: { temperature: 0.7, someUnknownKey: 100, maxTurns: 2 } },
    };
    await createClaudeAgentsHandler()(config as any, 'q');
    const { options } = mockQuery.mock.calls[0][0];
    expect(options.temperature).toBeUndefined();
    expect(options.someUnknownKey).toBeUndefined();
    expect(options.maxTurns).toBe(2);
  });

  it('never forwards credentials, endpoints, remote tools or host-process settings to query options', async () => {
    mockQuery.mockImplementation(makeResultMessage());
    const config = { ...baseConfig, model: { ...baseConfig.model, parameters: NEVER_FORWARDED_PARAMETERS } };
    await createClaudeAgentsHandler()(config as any, 'q');
    const { options } = mockQuery.mock.calls[0][0];
    // mcpServers and hooks are set by the handler itself; the deep check proves neither carries
    // the config's value.
    // `settingSources` is handler-owned: always sent, `[]` unless the application gives sources.
    expectNoNeverForwardedValue(options, ['mcpServers', 'hooks', 'settingSources']);
  });

  it('never forwards them on the streaming path either', async () => {
    mockQuery.mockImplementation(async function* () {
      yield { type: 'result', subtype: 'success', result: 'done', usage: {} };
    });
    const config = { ...baseConfig, model: { ...baseConfig.model, parameters: NEVER_FORWARDED_PARAMETERS } };
    await collectStream(createClaudeAgentsHandler().stream?.(config as any, 'q', {}, {}));
    const { options } = mockQuery.mock.calls[0][0];
    // `settingSources` is handler-owned: always sent, `[]` unless the application gives sources.
    expectNoNeverForwardedValue(options, ['mcpServers', 'hooks', 'settingSources']);
  });

  it('forwards every allowed key under the Claude Agent SDK name and shape', async () => {
    mockQuery.mockImplementation(makeResultMessage());
    const config = {
      ...baseConfig,
      model: {
        ...baseConfig.model,
        parameters: {
          max_turns: 4,
          max_thinking_tokens: 2048,
          thinking: { type: 'enabled', budget_tokens: 1024, display: 'summarized', extra_key: 'dropped' },
          effort: 'high',
          max_budget_usd: 1.5,
          fallback_model: 'claude-haiku',
          betas: ['context-1m-2025-08-07'],
        },
      },
    };
    await createClaudeAgentsHandler()(config as any, 'q');
    const { options } = mockQuery.mock.calls[0][0];
    expect(options).toMatchObject({
      maxTurns: 4,
      maxThinkingTokens: 2048,
      effort: 'high',
      maxBudgetUsd: 1.5,
      fallbackModel: 'claude-haiku',
      betas: ['context-1m-2025-08-07'],
    });
    // The SDK's ThinkingEnabled reads budgetTokens, not the Messages API's budget_tokens.
    expect(options.thinking).toEqual({ type: 'enabled', budgetTokens: 1024, display: 'summarized' });
  });

  it('never forwards output_format, on invoke or stream: structured output comes from the config outputFormat', async () => {
    const schema = { type: 'object', properties: { smuggled: { type: 'string' } } };
    const parameters = {
      output_format: { type: 'json_schema', schema },
      outputFormat: { type: 'json_schema', schema },
      temperature: 0.2,
    };
    const config = { ...baseConfig, model: { ...baseConfig.model, parameters } };
    mockQuery.mockImplementation(makeResultMessage());
    await createClaudeAgentsHandler()(config as any, 'q');
    expect(mockQuery.mock.calls[0][0].options.outputFormat).toBeUndefined();
    mockQuery.mockClear();
    mockQuery.mockImplementation(async function* () {
      yield { type: 'result', subtype: 'success', result: 'done', usage: {} };
    });
    await collectStream(createClaudeAgentsHandler().stream?.(config as any, 'q', {}, {}));
    expect(mockQuery.mock.calls[0][0].options.outputFormat).toBeUndefined();
  });

  // The cross-SDK Claude Agents list: the options a config adds or changes on top of what the
  // handler sets itself are exactly these, on invoke and on stream. `thinking` is compared by
  // value because the handler sets `{ type: 'disabled' }` by default, and `env` comes from
  // `max_tokens`.
  it('adds exactly the canonical query options, the same on invoke and stream', async () => {
    const parameters = {
      betas: ['context-1m-2025-08-07'],
      effort: 'high',
      fallback_model: 'claude-haiku',
      max_budget_usd: 1.5,
      max_thinking_tokens: 2048,
      max_tokens: 200,
      max_turns: 4,
      output_format: { type: 'json_schema', schema: { type: 'object' } },
      thinking: { type: 'enabled', budget_tokens: 1024 },
      temperature: 0.2,
      top_p: 0.9,
      made_up_key: 1,
    };
    const optionsFor = async (params: Record<string, unknown> | undefined, path: 'invoke' | 'stream') => {
      mockQuery.mockClear();
      const config = { ...baseConfig, model: { ...baseConfig.model, parameters: params } };
      if (path === 'invoke') {
        mockQuery.mockImplementation(makeResultMessage());
        await createClaudeAgentsHandler()(config as any, 'q');
      } else {
        mockQuery.mockImplementation(async function* () {
          yield { type: 'result', subtype: 'success', result: 'done', usage: {} };
        });
        await collectStream(createClaudeAgentsHandler().stream?.(config as any, 'q', {}, {}));
      }
      return mockQuery.mock.calls[0][0].options as Record<string, unknown>;
    };
    const expected = [
      'betas',
      'effort',
      'env',
      'fallbackModel',
      'maxBudgetUsd',
      'maxThinkingTokens',
      'maxTurns',
      'thinking',
    ];
    const added: Record<string, string[]> = {};
    const forwarded: Record<string, Record<string, unknown>> = {};
    for (const path of ['invoke', 'stream'] as const) {
      const baseline = await optionsFor(undefined, path);
      const options = await optionsFor(parameters, path);
      added[path] = Object.keys(options)
        .filter((key) => options[key] !== undefined && JSON.stringify(options[key]) !== JSON.stringify(baseline[key]))
        .sort();
      forwarded[path] = Object.fromEntries(expected.map((key) => [key, options[key]]));
    }
    expect(added.invoke).toEqual(expected);
    expect(added.stream).toEqual(expected);
    expect(forwarded.stream).toEqual(forwarded.invoke);
  });

  // A dropped thinking counts as not set, so the handler's `{ type: 'disabled' }` default applies.
  it('accepts a camelCase thinking.budgetTokens and drops a thinking value without a type', async () => {
    mockQuery.mockImplementation(makeResultMessage());
    const run = async (thinking: unknown) => {
      mockQuery.mockClear();
      const config = { ...baseConfig, model: { ...baseConfig.model, parameters: { thinking } } };
      await createClaudeAgentsHandler()(config as any, 'q');
      return mockQuery.mock.calls[0][0].options.thinking;
    };
    expect(await run({ type: 'enabled', budgetTokens: 512 })).toEqual({ type: 'enabled', budgetTokens: 512 });
    expect(await run({ type: 'adaptive' })).toEqual({ type: 'adaptive' });
    expect(await run({ budget_tokens: 512 })).toEqual({ type: 'disabled' });
    expect(await run('enabled')).toEqual({ type: 'disabled' });
  });

  it('drops a thinking with an unknown type or an enabled thinking without a budget', async () => {
    mockQuery.mockImplementation(makeResultMessage());
    const run = async (thinking: unknown) => {
      mockQuery.mockClear();
      const config = { ...baseConfig, model: { ...baseConfig.model, parameters: { thinking } } };
      await createClaudeAgentsHandler()(config as any, 'q');
      return mockQuery.mock.calls[0][0].options.thinking;
    };
    expect(await run({ type: 'enabled' })).toEqual({ type: 'disabled' });
    expect(await run({ type: 'enabled', budget_tokens: '1024' })).toEqual({ type: 'disabled' });
    expect(await run({ type: 'on', budget_tokens: 1024 })).toEqual({ type: 'disabled' });
    expect(await run({ type: 'disabled', budget_tokens: 1, display: 'omitted' })).toEqual({ type: 'disabled' });
    expect(await run({ type: 'adaptive', display: 'verbose' })).toEqual({ type: 'adaptive' });
    expect(await run({ type: 'adaptive', display: 'omitted' })).toEqual({ type: 'adaptive', display: 'omitted' });
  });

  it('does not let model.parameters override model, tools, allowedTools, mcpServers, hooks, or systemPrompt', async () => {
    mockQuery.mockImplementation(makeResultMessage());
    const config = {
      ...baseConfig,
      model: {
        ...baseConfig.model,
        parameters: {
          model: 'smuggled-model',
          tools: ['smuggled-tool'],
          allowedTools: ['smuggled-allowed'],
          mcpServers: { smuggled: true },
          hooks: { smuggled: true },
          systemPrompt: 'smuggled prompt',
        },
      },
    };
    await createClaudeAgentsHandler()(config as any, 'q');
    const { options } = mockQuery.mock.calls[0][0];
    expect(options.model).toBe('claude-opus-4-5');
    expect(options.systemPrompt).toBe('You are helpful.');
    expect(options.tools).not.toEqual(['smuggled-tool']);
    expect(options.allowedTools).not.toEqual(['smuggled-allowed']);
    expect(options.mcpServers).not.toEqual({ smuggled: true });
    expect(options.hooks).not.toEqual({ smuggled: true });
  });

  it('does not set maxTurns or other forwarded keys when model.parameters is absent', async () => {
    mockQuery.mockImplementation(makeResultMessage());
    await createClaudeAgentsHandler()(baseConfig as any, 'q');
    const { options } = mockQuery.mock.calls[0][0];
    expect(options.maxTurns).toBeUndefined();
    expect(options.maxThinkingTokens).toBeUndefined();
    expect(options.maxBudgetUsd).toBeUndefined();
    expect(options.effort).toBeUndefined();
    expect(options.fallbackModel).toBeUndefined();
    expect(options.env).toBeUndefined();
    // The CLI would otherwise choose thinking itself.
    expect(options.thinking).toEqual({ type: 'disabled' });
  });

  // The cross-SDK Claude Agents rule: `max_tokens` reaches the CLI as CLAUDE_CODE_MAX_OUTPUT_TOKENS,
  // and thinking is off unless the config asks for it. The CLI would otherwise send its own
  // defaults (max_tokens 32000 and a 31,999-token thinking budget on claude-haiku-4-5).
  describe('output limit and thinking default', () => {
    const optionsFor = async (parameters: Record<string, unknown>, path: 'invoke' | 'stream') => {
      mockQuery.mockClear();
      const config = { ...baseConfig, model: { ...baseConfig.model, parameters } };
      if (path === 'invoke') {
        mockQuery.mockImplementation(makeResultMessage());
        await createClaudeAgentsHandler()(config as any, 'q');
      } else {
        mockQuery.mockImplementation(async function* () {
          yield { type: 'result', subtype: 'success', result: 'done', usage: {} };
        });
        await collectStream(createClaudeAgentsHandler().stream?.(config as any, 'q', {}, {}));
      }
      return mockQuery.mock.calls[0][0].options as Record<string, any>;
    };

    for (const path of ['invoke', 'stream'] as const) {
      describe(path, () => {
        it('sets CLAUDE_CODE_MAX_OUTPUT_TOKENS from max_tokens and disables thinking', async () => {
          process.env.LD_TEST_INHERITED = 'kept';
          try {
            const options = await optionsFor({ max_tokens: 200 }, path);
            // The SDK replaces the child's environment with `env`, so it must be everything the
            // child would inherit, plus the one variable and nothing else.
            expect(options.env).toEqual({ ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: '200' });
            expect(options.env.LD_TEST_INHERITED).toBe('kept');
            expect(options.thinking).toEqual({ type: 'disabled' });
          } finally {
            delete process.env.LD_TEST_INHERITED;
          }
        });

        it('reads the camelCase maxTokens as well', async () => {
          const options = await optionsFor({ maxTokens: 300 }, path);
          expect(options.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('300');
        });

        it('passes no env without a max_tokens', async () => {
          const options = await optionsFor({ max_turns: 2 }, path);
          expect('env' in options).toBe(false);
        });

        it.each([
          0,
          -5,
          1.5,
          Number.MAX_SAFE_INTEGER + 1,
          '200',
          true,
          null,
          Number.POSITIVE_INFINITY,
        ])('drops a max_tokens of %s', async (maxTokens) => {
          const options = await optionsFor({ max_tokens: maxTokens }, path);
          expect('env' in options).toBe(false);
        });

        it('passes the configured thinking in place of the default', async () => {
          const options = await optionsFor(
            { max_tokens: 4096, thinking: { type: 'enabled', budget_tokens: 2048 } },
            path,
          );
          expect(options.thinking).toEqual({ type: 'enabled', budgetTokens: 2048 });
        });

        it('passes no thinking when only max_thinking_tokens is set, so the CLI applies it', async () => {
          const options = await optionsFor({ max_thinking_tokens: 2048 }, path);
          expect(options.maxThinkingTokens).toBe(2048);
          expect(options.thinking).toBeUndefined();
        });

        it('passes both as given when thinking and max_thinking_tokens are set', async () => {
          const options = await optionsFor(
            { max_thinking_tokens: 4096, thinking: { type: 'enabled', budget_tokens: 2048 } },
            path,
          );
          expect(options.maxThinkingTokens).toBe(4096);
          expect(options.thinking).toEqual({ type: 'enabled', budgetTokens: 2048 });
        });

        it('disables thinking when only effort is set', async () => {
          const options = await optionsFor({ effort: 'low' }, path);
          expect(options.effort).toBe('low');
          expect(options.thinking).toEqual({ type: 'disabled' });
        });

        // `null` still reaches `query()`, and the Agent SDK reads `maxThinkingTokens` only when
        // `thinking` is unset, where a null budget throws. The default must cover it.
        it('disables thinking when max_thinking_tokens is null', async () => {
          const options = await optionsFor({ max_thinking_tokens: null }, path);
          expect(options.thinking).toEqual({ type: 'disabled' });
        });

        // The Agent SDK injects the active span into the CLI's environment only for trace variables
        // `env` does not already hold, so an inherited TRACEPARENT copied into `env` would win.
        describe('inherited trace context', () => {
          const injecting: TextMapPropagator = {
            inject: (_context, carrier, setter) => setter.set(carrier, 'traceparent', '00-active-span-01'),
            extract: (context) => context,
            fields: () => ['traceparent'],
          };

          it('leaves out TRACEPARENT and TRACESTATE when the active context injects a traceparent', async () => {
            process.env.TRACEPARENT = '00-inherited-01';
            process.env.TRACESTATE = 'inherited=1';
            propagation.setGlobalPropagator(injecting);
            try {
              const options = await optionsFor({ max_tokens: 200 }, path);
              expect(options.env).not.toHaveProperty('TRACEPARENT');
              expect(options.env).not.toHaveProperty('TRACESTATE');
              expect(options.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('200');
            } finally {
              propagation.disable();
              delete process.env.TRACEPARENT;
              delete process.env.TRACESTATE;
            }
          });

          it('keeps them when there is nothing to inject, as the CLI would inherit them', async () => {
            process.env.TRACEPARENT = '00-inherited-01';
            try {
              const options = await optionsFor({ max_tokens: 200 }, path);
              expect(options.env.TRACEPARENT).toBe('00-inherited-01');
            } finally {
              delete process.env.TRACEPARENT;
            }
          });
        });
      });
    }
  });

  // ── 1.3 Tool wiring ─────────────────────────────────────────────────────────

  it('builds MCP server when config.tools has user-defined tools', async () => {
    mockQuery.mockImplementation(makeResultMessage());
    const config = {
      ...baseConfig,
      tools: { search: { name: 'search', type: 'function' as const, parameters: { type: 'object', properties: {} } } },
    };
    await createClaudeAgentsHandler()(config as any, 'q', { search: vi.fn() });
    expect(mockCreateSdkMcpServer).toHaveBeenCalled();
  });

  it('does not build MCP server when config.tools is absent', async () => {
    mockQuery.mockImplementation(makeResultMessage());
    await createClaudeAgentsHandler()(baseConfig as any, 'q');
    expect(mockCreateSdkMcpServer).not.toHaveBeenCalled();
  });

  // ── 1.5 Telemetry ───────────────────────────────────────────────────────────

  it('sets gen_ai span attributes on the invoke_agent root', async () => {
    mockQuery.mockImplementation(makeResultMessage('ok', { input_tokens: 8, output_tokens: 4 }));
    await createClaudeAgentsHandler()(baseConfig as any, 'q');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.operation.name', 'invoke_agent');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.system', 'anthropic');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.provider.name', 'anthropic');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.request.model', 'claude-opus-4-5');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.response.model', 'claude-opus-4-5');
    // The agent SDK reports usage cumulatively on the result message, which is what the root wants.
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.usage.input_tokens', 8);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.usage.output_tokens', 4);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.usage.total_tokens', 12);
    // `chat` belongs to the per-response children, never to the root.
    expect(mockSpan.setAttribute).not.toHaveBeenCalledWith('gen_ai.operation.name', 'chat');
  });

  // The CLI's own instrumentation emits span names outside the semantic conventions
  // (`claude_code.llm_request`, `claude_code.tool`, `claude_code.tool.blocked_on_user`), so
  // enabling it would make this handler's traces read differently from the other five and from
  // any non-LaunchDarkly OTel backend. Without a config `max_tokens`, `env` must also stay absent
  // entirely, so the child keeps the SDK's own inheritance instead of a bag assembled here. With
  // one, `env` is `process.env` plus CLAUDE_CODE_MAX_OUTPUT_TOKENS only.
  it('never enables the CLI own telemetry exporter', async () => {
    mockQuery.mockImplementation(makeResultMessage('ok', { input_tokens: 1, output_tokens: 1 }));
    await createClaudeAgentsHandler()(baseConfig as any, 'q');

    const { options } = mockQuery.mock.calls[0][0];
    expect('env' in options).toBe(false);
    expect(JSON.stringify(options)).not.toContain('CLAUDE_CODE');
  });

  it('includes cache tokens in input usage and preserves the provider breakdown', async () => {
    const rawUsage = {
      input_tokens: 4,
      output_tokens: 5,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 20,
    };
    mockQuery.mockImplementation(makeResultMessage('ok', rawUsage));

    const result = await createClaudeAgentsHandler()(baseConfig as any, 'q');

    // Cumulative run usage, so asserted on the root.
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.usage.input_tokens', 124);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.usage.output_tokens', 5);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.usage.total_tokens', 129);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.usage.cache_read.input_tokens', 100);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.usage.cache_creation.input_tokens', 20);
    expect(result.usage).toEqual(rawUsage);
  });

  // ── LaunchDarkly correlation ────────────────────────────────────────────────
  //
  // The `feature_flag` span event is how the AI Config Monitoring tab locates a trace:
  //   events.name = feature_flag
  //   AND events.attributes.feature_flag.key = <configKey>
  // It must be on the root, because the root is the span that query finds. Losing it, or
  // emitting it on a child instead, silently detaches every trace from its AI Config —
  // with no error and no failing assertion anywhere else in this suite.

  const ldFixture = {
    __ld: {
      configKey: 'test-config',
      variationKey: 'variation-a',
      runId: 'run-123',
      environmentId: 'env-abc',
      version: 1,
      modelName: 'test-model',
      providerName: 'TestProvider',
    },
  };

  it('emits the feature_flag correlation event on the invoke_agent root', async () => {
    mockQuery.mockImplementation(makeResultMessage('ok', { input_tokens: 1, output_tokens: 1 }));
    await createClaudeAgentsHandler()(baseConfig as any, 'q', {}, ldFixture);

    expect(mockSpan.addEvent).toHaveBeenCalledWith('feature_flag', {
      'feature_flag.key': 'test-config',
      'feature_flag.provider.name': 'LaunchDarkly',
      'feature_flag.set.id': 'env-abc',
    });
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('launchdarkly.operation.type', 'gen_ai');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('launchdarkly.config.key', 'test-config');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('launchdarkly.variation.key', 'variation-a');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('launchdarkly.run.id', 'run-123');
  });

  it('does not emit the feature_flag event on child spans', async () => {
    mockQuery.mockImplementation(makeResultMessage('ok', { input_tokens: 1, output_tokens: 1 }));
    await createClaudeAgentsHandler()(baseConfig as any, 'q', {}, ldFixture);

    const childEvents = mockChildSpans.flatMap(({ span }) => span.addEvent.mock.calls.map((c: unknown[]) => c[0]));
    expect(childEvents).not.toContain('feature_flag');
  });

  it('emits the feature_flag event on the root of the streaming path too', async () => {
    mockQuery.mockImplementation(makeResultMessage('ok', { input_tokens: 1, output_tokens: 1 }));
    await collectStream(createClaudeAgentsHandler().stream?.(baseConfig as any, 'q', {}, ldFixture));

    expect(mockSpan.addEvent).toHaveBeenCalledWith(
      'feature_flag',
      expect.objectContaining({ 'feature_flag.key': 'test-config' }),
    );
  });

  it('uses an agent root and starts no per-call span of its own', async () => {
    const { trace } = await import('@opentelemetry/api');
    mockQuery.mockImplementation(makeResultMessage());
    await createClaudeAgentsHandler()(baseConfig as any, 'q');
    expect((trace.getTracer as any)().startActiveSpan).toHaveBeenCalledWith('invoke_agent', expect.any(Function));
    // No `startSpan` at all on a tool-less run: the only spans this handler starts directly are
    // `execute_tool` ones from hooks.
    expect((trace.getTracer as any)().startSpan).not.toHaveBeenCalled();
  });

  it('creates tool-execution child spans for an agent loop, and nothing else', async () => {
    mockQuery.mockImplementation(async function* ({ options }: any) {
      yield {
        type: 'assistant',
        message: { usage: { input_tokens: 10, output_tokens: 2 }, content: [] },
      };
      await options.hooks.PreToolUse[0].hooks[0]({
        hook_event_name: 'PreToolUse',
        tool_name: 'mcp__tool-mcp__search',
        tool_use_id: 'tool-1',
        tool_input: { query: 'x' },
      });
      await options.hooks.PostToolUse[0].hooks[0]({
        hook_event_name: 'PostToolUse',
        tool_name: 'mcp__tool-mcp__search',
        tool_use_id: 'tool-1',
        tool_input: { query: 'x' },
        tool_response: { ok: true },
      });
      yield {
        type: 'assistant',
        message: { usage: { input_tokens: 12, output_tokens: 3 }, content: [] },
      };
      yield { type: 'result', subtype: 'success', result: 'done', usage: { input_tokens: 22, output_tokens: 5 } };
    });
    const config = {
      ...baseConfig,
      tools: { search: { name: 'search', type: 'function' as const, parameters: { type: 'object', properties: {} } } },
    };

    await createClaudeAgentsHandler()(config as any, 'q', { search: vi.fn() });

    const toolSpan = mockChildSpans.find(({ name }) => name === 'execute_tool search')?.span;
    // Two model responses and one tool call, so two `chat` spans and one `execute_tool`. Sorted
    // because `chat` spans are created when the run flushes rather than as each message arrives —
    // their start and end timestamps are explicit, so creation order is not chronological order.
    expect(mockChildSpans.map(({ name }) => name).sort()).toEqual([
      'chat claude-opus-4-5',
      'chat claude-opus-4-5',
      'execute_tool search',
    ]);
    expect(toolSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.operation.name', 'execute_tool');
    expect(toolSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.tool.name', 'search');
    expect(toolSpan?.setAttribute).toHaveBeenCalledWith('gen_ai.tool.call.id', 'tool-1');
    expect(toolSpan?.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(toolSpan?.end).toHaveBeenCalledOnce();
  });

  describe('content capture resolves at run time', () => {
    // `configure` is process-wide; shutdown() restores the built-in default and clears its lock.
    afterEach(() => shutdown());

    const run = async (handler: ProviderHandler = createClaudeAgentsHandler()) => {
      mockQuery.mockImplementation(makeResultMessage('done'));
      await handler(baseConfig as any, 'question');
      return JSON.stringify(mockSpan.setAttribute.mock.calls);
    };

    it('captures content when nothing sets it', async () => {
      expect(await run()).toContain('question');
    });

    it('captures nothing with an explicit false', async () => {
      expect(await run(createClaudeAgentsHandler({ captureContent: false }))).not.toContain('question');
    });

    it('captures nothing when configure turns the default off', async () => {
      configure({ options: { captureContent: false } });
      expect(await run()).not.toContain('question');
    });

    it('reads configure when the handler runs, not when it is built', async () => {
      const handler = createClaudeAgentsHandler();
      configure({ options: { captureContent: false } });
      expect(await run(handler)).not.toContain('question');
    });

    it('captures content with an explicit true when configure turns the default off', async () => {
      configure({ options: { captureContent: false } });
      expect(await run(createClaudeAgentsHandler({ captureContent: true }))).toContain('question');
    });
  });

  it('puts prompt and completion on span attributes when capture is enabled', async () => {
    mockQuery.mockImplementation(makeResultMessage('done'));
    await createClaudeAgentsHandler({ captureContent: true })(baseConfig as any, 'question');

    // Attributes are what LaunchDarkly's readers parse, and OTEP 4430 deprecated event-recorded
    // content — but the events are still emitted alongside them, because every published version of
    // this handler has emitted them and dropping them would break a consumer silently.
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.prompt.1.content', 'question');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.completion.0.content', 'done');
    expect(mockSpan.addEvent).toHaveBeenCalledWith('gen_ai.content.prompt', expect.anything());
    expect(mockSpan.addEvent).toHaveBeenCalledWith('gen_ai.content.completion', expect.anything());
  });

  it('sets OK status and ends span on success', async () => {
    mockQuery.mockImplementation(makeResultMessage());
    await createClaudeAgentsHandler()(baseConfig as any, 'q');
    expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(mockSpan.end).toHaveBeenCalled();
  });

  // ── 1.6 Error handling ──────────────────────────────────────────────────────

  it('records exception, sets ERROR status, ends span, and re-throws', async () => {
    const err = new Error('agent SDK failure');
    mockQuery.mockImplementation(async function* () {
      throw err;
    });
    await expect(createClaudeAgentsHandler()(baseConfig as any, 'q')).rejects.toThrow('agent SDK failure');
    expect(mockSpan.recordException).toHaveBeenCalledWith(err);
    expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR, message: 'agent SDK failure' });
    expect(mockSpan.end).toHaveBeenCalled();
  });

  // ── 1.7 Convenience export ──────────────────────────────────────────────────

  it('claudeAgents calls config() with the correct handler', async () => {
    const { claudeAgents } = await import('../handler.js');
    const { configInternal: config } = await import('@launchdarkly/ai-server');
    const ctx = { kind: 'user' as const, key: 'u' };
    await claudeAgents('flag', 'hello', ctx, {} as any);
    expect(config).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'flag',
        handler: expect.objectContaining({ providesFor: ['Anthropic', 'agent'] }),
      }),
    );
  });

  it('claudeAgents passes userInput and context to config().invoke()', async () => {
    const { claudeAgents } = await import('../handler.js');
    const { configInternal: config } = await import('@launchdarkly/ai-server');
    const invokeMock = vi.fn().mockResolvedValue({ response: 'ok', usage: {} });
    vi.mocked(config).mockReturnValue({ invoke: invokeMock } as any);
    const ctx = { kind: 'user' as const, key: 'u' };
    await claudeAgents('flag', 'hello', ctx, {} as any);
    expect(invokeMock).toHaveBeenCalledWith('hello', ctx, undefined);
  });

  // ── 1.8 Streaming ────────────────────────────────────────────────────────────

  async function collectStream<T>(gen: AsyncGenerator<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const e of gen) out.push(e);
    return out;
  }

  it('handler.stream is defined', () => {
    const handler = createClaudeAgentsHandler();
    expect(typeof handler.stream).toBe('function');
  });

  it('yields chunk events from stream_event text_delta messages', async () => {
    mockQuery.mockImplementation(async function* () {
      yield {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
      };
      yield {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ' world' } },
      };
      yield {
        type: 'result',
        subtype: 'success',
        result: 'Hello world',
        usage: { input_tokens: 10, output_tokens: 5 },
      };
    });
    const handler = createClaudeAgentsHandler();
    const events = await collectStream(handler.stream?.(baseConfig as any, 'q', {}, {}));
    const chunks = events.filter((e: any) => e.type === 'chunk').map((e: any) => e.text);
    expect(chunks).toEqual(['Hello', ' world']);
  });

  it('yields a done event when result message arrives', async () => {
    mockQuery.mockImplementation(async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        result: 'Final answer',
        usage: { input_tokens: 5, output_tokens: 3 },
      };
    });
    const handler = createClaudeAgentsHandler();
    const events = await collectStream(handler.stream?.(baseConfig as any, 'q', {}, {}));
    const done = events.at(-1) as any;
    expect(done.type).toBe('done');
    expect(done.output).toBe('Final answer');
  });

  it('forwards model.parameters.maxTurns alongside includePartialMessages on the streaming path', async () => {
    mockQuery.mockImplementation(async function* () {
      yield { type: 'result', subtype: 'success', result: 'done', usage: {} };
    });
    const config = { ...baseConfig, model: { ...baseConfig.model, parameters: { maxTurns: 5 } } };
    const handler = createClaudeAgentsHandler();
    await collectStream(handler.stream?.(config as any, 'q', {}, {}));
    const { options } = mockQuery.mock.calls[0][0];
    expect(options.maxTurns).toBe(5);
    expect(options.includePartialMessages).toBe(true);
  });

  it('converts a snake_case max_turns to maxTurns on the streaming path', async () => {
    mockQuery.mockImplementation(async function* () {
      yield { type: 'result', subtype: 'success', result: 'done', usage: {} };
    });
    const config = { ...baseConfig, model: { ...baseConfig.model, parameters: { max_turns: 9 } } };
    const handler = createClaudeAgentsHandler();
    await collectStream(handler.stream?.(config as any, 'q', {}, {}));
    const { options } = mockQuery.mock.calls[0][0];
    expect(options.maxTurns).toBe(9);
    expect(options.max_turns).toBeUndefined();
  });

  it('does not let model.parameters override includePartialMessages on the streaming path', async () => {
    mockQuery.mockImplementation(async function* () {
      yield { type: 'result', subtype: 'success', result: 'done', usage: {} };
    });
    const config = {
      ...baseConfig,
      model: { ...baseConfig.model, parameters: { includePartialMessages: false } },
    };
    const handler = createClaudeAgentsHandler();
    await collectStream(handler.stream?.(config as any, 'q', {}, {}));
    const { options } = mockQuery.mock.calls[0][0];
    expect(options.includePartialMessages).toBe(true);
  });

  it('sets span attributes and puts content on attributes when enabled', async () => {
    mockQuery.mockImplementation(async function* () {
      yield { type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 2, output_tokens: 1 } };
    });
    await collectStream(createClaudeAgentsHandler({ captureContent: true }).stream?.(baseConfig as any, 'q', {}, {}));
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.system', 'anthropic');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.prompt.1.content', 'q');
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.completion.0.content', 'ok');
    expect(mockSpan.addEvent).toHaveBeenCalledWith('gen_ai.content.completion', expect.anything());
    expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.OK });
    expect(mockSpan.end).toHaveBeenCalled();
  });

  it('includes cache tokens in streaming input usage', async () => {
    mockQuery.mockImplementation(async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        result: 'ok',
        usage: {
          input_tokens: 3,
          output_tokens: 2,
          cache_read_input_tokens: 40,
          cache_creation_input_tokens: 7,
        },
      };
    });

    const events = await collectStream(createClaudeAgentsHandler().stream?.(baseConfig as any, 'q', {}, {}));

    // Cumulative run usage, so asserted on the root.
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.usage.input_tokens', 50);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.usage.total_tokens', 52);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.usage.cache_read.input_tokens', 40);
    expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.usage.cache_creation.input_tokens', 7);
    expect((events.at(-1) as any).usage).toMatchObject({
      input_tokens: 3,
      cache_read_input_tokens: 40,
      cache_creation_input_tokens: 7,
    });
  });

  it('records exception on error', async () => {
    const err = new Error('query stream error');
    mockQuery.mockImplementation(async function* () {
      throw err;
    });
    await expect(collectStream(createClaudeAgentsHandler().stream?.(baseConfig as any, 'q', {}, {}))).rejects.toThrow(
      'query stream error',
    );
    expect(mockSpan.recordException).toHaveBeenCalledWith(err);
    expect(mockSpan.setStatus).toHaveBeenCalledWith(expect.objectContaining({ code: SpanStatusCode.ERROR }));
  });

  // ── History (structured query prompt, not system-prompt text) ────────────────

  const sampleHistory = [
    { role: 'user' as const, content: 'What is feature flagging?' },
    { role: 'assistant' as const, content: 'Feature flagging is a technique...' },
  ];

  const imageHistory = [
    {
      role: 'user' as const,
      content: [
        { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'abc123' } },
      ],
    },
  ];

  it('history is not stuffed into systemPrompt via buildPrompt', () => {
    const { systemPrompt } = buildPrompt(baseConfig as any, 'q', {}, sampleHistory);
    expect(systemPrompt).toContain('You are helpful.');
    expect(systemPrompt).not.toContain('Conversation History:');
  });

  it('empty history is treated like no history in buildPrompt', () => {
    const { systemPrompt } = buildPrompt(baseConfig as any, 'q', {}, []);
    expect(systemPrompt).not.toContain('Conversation History:');
    expect(systemPrompt).toBe('You are helpful.');
  });

  it('history uses async iterable prompt and keeps instructions as systemPrompt', async () => {
    mockQuery.mockImplementation(makeResultMessage());
    await createClaudeAgentsHandler()(baseConfig as any, 'follow up', {}, {}, sampleHistory);
    const { prompt, options } = mockQuery.mock.calls[0][0];
    expect(options.systemPrompt).toContain('You are helpful.');
    expect(options.systemPrompt).not.toContain('Conversation History:');
    expect(
      typeof prompt === 'string' ? false : prompt != null && typeof prompt[Symbol.asyncIterator] === 'function',
    ).toBe(true);
  });

  it('multimodal image history maps to Anthropic image content blocks on query prompt', async () => {
    mockQuery.mockImplementation(makeResultMessage());
    await createClaudeAgentsHandler()(baseConfig as any, 'describe', {}, {}, imageHistory);
    const { prompt, options } = mockQuery.mock.calls[0][0];
    expect(options.systemPrompt).not.toContain('Conversation History:');
    expect(typeof prompt === 'string').toBe(false);
    const chunks: unknown[] = [];
    for await (const chunk of prompt as AsyncIterable<unknown>) {
      chunks.push(chunk);
    }
    const serialized = JSON.stringify(chunks);
    expect(serialized).toContain('"type":"image"');
    expect(serialized).toContain('abc123');
  });

  it('empty userInput with history ending in user does not append empty turn', async () => {
    mockQuery.mockImplementation(makeResultMessage());
    const fullTurn = [
      {
        role: 'user' as const,
        content: [
          { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'xyz' } },
          { type: 'text' as const, text: 'Analyze this diagram' },
        ],
      },
    ];
    await createClaudeAgentsHandler()(baseConfig as any, '', {}, {}, fullTurn);
    const { prompt } = mockQuery.mock.calls[0][0];
    const chunks: Array<{ message?: { role?: string; content?: unknown } }> = [];
    for await (const chunk of prompt as AsyncIterable<(typeof chunks)[number]>) {
      chunks.push(chunk);
    }
    const userTurns = chunks.filter((c) => c.message?.role === 'user' || (c as { type?: string }).type === 'user');
    expect(userTurns.length).toBe(1);
  });

  // The envelope `type` has to agree with the message role: the CLI takes an `assistant`
  // envelope as a replayed turn and rejects every other envelope whose role is not `user`,
  // exiting with `Expected message role 'user', got 'assistant'`. These mirror the Python
  // SDK's envelope tests so both SDKs stream history the same way.

  const alternatingHistory = [
    { role: 'user' as const, content: 'I am going to share an image with you.' },
    { role: 'assistant' as const, content: 'Sure — go ahead and share it.' },
    {
      role: 'user' as const,
      content: [
        { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'redsquare' } },
        { type: 'text' as const, text: 'What colour is the square?' },
      ],
    },
  ];

  async function streamedEnvelopes(userInput: string, history: Message[]) {
    mockQuery.mockImplementation(makeResultMessage());
    await createClaudeAgentsHandler()(baseConfig as any, userInput, {}, {}, history);
    const { prompt } = mockQuery.mock.calls[0][0];
    const envelopes: Array<{ type: string; message: { role: string; content: unknown } }> = [];
    for await (const envelope of prompt as AsyncIterable<(typeof envelopes)[number]>) {
      envelopes.push(envelope);
    }
    return envelopes;
  }

  function capturedInputMessages() {
    const written = mockSpan.setAttribute.mock.calls.find((c: unknown[]) => c[0] === 'gen_ai.input.messages')?.[1];
    return JSON.parse(String(written)) as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
  }

  it('every envelope satisfies the CLI role contract', async () => {
    const envelopes = await streamedEnvelopes('', alternatingHistory);
    for (const envelope of envelopes) {
      const role = envelope.message.role;
      expect(
        envelope.type === 'assistant' || role === 'user',
        `envelope type ${envelope.type} with role ${role} is rejected by the CLI`,
      ).toBe(true);
      expect(envelope.type).toBe(role);
    }
  });

  it('replays an assistant turn as an assistant envelope', async () => {
    const envelopes = await streamedEnvelopes('', [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
    expect(envelopes[1]).toEqual({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      parent_tool_use_id: null,
    });
  });

  it('keeps user content blocks so images still reach the model natively', async () => {
    const envelopes = await streamedEnvelopes('', alternatingHistory);
    expect(envelopes).toHaveLength(3);
    expect(envelopes[2].message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'redsquare' } },
      { type: 'text', text: 'What colour is the square?' },
    ]);
  });

  it('records the real turn roles as captured input', async () => {
    mockQuery.mockImplementation(makeResultMessage());
    await createClaudeAgentsHandler({ captureContent: true })(baseConfig as any, '', {}, {}, alternatingHistory);
    expect(capturedInputMessages().map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });

  // The streamed run is handed the same composed turns as the blocking one, so its captured input
  // has to report them too — it used to record only the flattened latest `userInput`.

  it('streaming records the composed history turns, not just the latest userInput', async () => {
    mockQuery.mockImplementation(makeResultMessage());
    await collectStream(
      createClaudeAgentsHandler({ captureContent: true }).stream?.(baseConfig as any, '', {}, {}, alternatingHistory),
    );

    const captured = capturedInputMessages();
    expect(captured.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(JSON.stringify(captured)).toContain('Sure — go ahead and share it.');
  });

  it('streaming notes a history image compactly rather than inlining its payload', async () => {
    mockQuery.mockImplementation(makeResultMessage());
    await collectStream(
      createClaudeAgentsHandler({ captureContent: true }).stream?.(baseConfig as any, '', {}, {}, alternatingHistory),
    );

    const parts = capturedInputMessages().at(-1)?.parts ?? [];
    expect(parts).toEqual([
      { type: 'text', content: '[image]' },
      { type: 'text', content: 'What colour is the square?' },
    ]);
    expect(JSON.stringify(capturedInputMessages())).not.toContain('redsquare');
  });

  it('streaming without history still records the one flattened user turn', async () => {
    mockQuery.mockImplementation(makeResultMessage());
    await collectStream(createClaudeAgentsHandler({ captureContent: true }).stream?.(baseConfig as any, 'q', {}, {}));

    expect(capturedInputMessages()).toEqual([{ role: 'user', parts: [{ type: 'text', content: 'q' }] }]);
  });
});

// ─── buildToolMCP ─────────────────────────────────────────────────────────────

describe('buildToolMCP', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws a descriptive error when no handler is registered for a tool', async () => {
    const configTools = {
      search: { name: 'search', type: 'function' as const, parameters: { type: 'object', properties: {} } },
    };
    await buildToolMCP(configTools, {});
    const toolCall = mockTool.mock.calls[0];
    const execute = toolCall[3] as (...args: unknown[]) => Promise<unknown>;
    await expect(execute({ query: 'x' })).rejects.toThrow(/search/i);
  });

  it('does not call a NativeTool, which offline evaluations pass through unwrapped', async () => {
    const configTools = {
      search: { name: 'search', type: 'function' as const, parameters: { type: 'object', properties: {} } },
    };
    await buildToolMCP(configTools, { search: new NativeTool(Symbol('search'), 'WebSearch') });
    const execute = mockTool.mock.calls[0][3] as (...args: unknown[]) => Promise<unknown>;
    await expect(execute({ query: 'x' })).rejects.toThrow('No handler registered for tool "search"');
  });

  // T1: multiple tools
  it('registers all tools when config.tools has multiple entries', async () => {
    const configTools = {
      search: { name: 'search', type: 'function' as const, parameters: { type: 'object', properties: {} } },
      summarize: { name: 'summarize', type: 'function' as const, parameters: { type: 'object', properties: {} } },
      translate: { name: 'translate', type: 'function' as const, parameters: { type: 'object', properties: {} } },
    };
    await buildToolMCP(configTools, { search: vi.fn(), summarize: vi.fn(), translate: vi.fn() });
    expect(mockTool).toHaveBeenCalledTimes(3);
    const registeredNames = mockTool.mock.calls.map((c: any[]) => c[0]);
    expect(registeredNames).toContain('search');
    expect(registeredNames).toContain('summarize');
    expect(registeredNames).toContain('translate');
  });

  // T2: tool handler throws
  it('propagates errors thrown by a tool handler', async () => {
    const configTools = {
      search: { name: 'search', type: 'function' as const, parameters: { type: 'object', properties: {} } },
    };
    const throwingHandler = vi.fn().mockRejectedValue(new Error('tool exploded'));
    await buildToolMCP(configTools, { search: throwingHandler });
    const execute = mockTool.mock.calls[0][3] as (...args: unknown[]) => Promise<unknown>;
    await expect(execute({ query: 'x' })).rejects.toThrow('tool exploded');
  });
});

// ─── streaming additional coverage ────────────────────────────────────────────

describe('streaming additional coverage', () => {
  async function collectStream<T>(gen: AsyncGenerator<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const e of gen) out.push(e);
    return out;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockChildSpans.length = 0;
    for (const key of Object.keys(mockSpan)) {
      (mockSpan as any)[key].mockReset?.();
    }
  });

  // T3: done event carries usage from provider
  it('done event carries the provider usage tokens', async () => {
    mockQuery.mockImplementation(async function* () {
      yield { type: 'result', subtype: 'success', result: 'answer', usage: { input_tokens: 7, output_tokens: 3 } };
    });
    const events = await collectStream(createClaudeAgentsHandler().stream?.(baseConfig as any, 'q', {}, {}));
    const done = events.at(-1) as any;
    expect(done.type).toBe('done');
    expect(done.usage).toMatchObject({ input_tokens: 7, output_tokens: 3 });
  });

  // T4: no chunk events appear after the done event
  it('yields no chunk events after the done event', async () => {
    mockQuery.mockImplementation(async function* () {
      yield {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
      };
      yield { type: 'result', subtype: 'success', result: 'Hello', usage: { input_tokens: 3, output_tokens: 2 } };
    });
    const events = await collectStream(createClaudeAgentsHandler().stream?.(baseConfig as any, 'q', {}, {}));
    const doneIdx = events.findIndex((e: any) => e.type === 'done');
    const chunksAfterDone = events.slice(doneIdx + 1).filter((e: any) => e.type === 'chunk');
    expect(chunksAfterDone).toHaveLength(0);
  });
});

// ── Host options and the built-in tool set ──────────────────────────────────────

describe('createClaudeAgentsHandler — host options and built-in tool set', () => {
  type Path = 'invoke' | 'stream';
  const PATHS: Path[] = ['invoke', 'stream'];

  /** Runs one invoke or stream through `handler` and returns the options `query()` received. */
  async function queryOptions(
    handler: ReturnType<typeof createClaudeAgentsHandler>,
    path: Path,
    config: Record<string, unknown> = baseConfig,
    toolHandlers: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    mockQuery.mockImplementation(makeResultMessage());
    if (path === 'invoke') {
      await handler(config as any, 'q', toolHandlers as any, {});
    } else {
      for await (const _ of handler.stream?.(config as any, 'q', toolHandlers as any, {}) ?? []) {
        // drain
      }
    }
    return mockQuery.mock.calls.at(-1)?.[0].options;
  }

  const nativeStub = (toolName: string) => {
    const stub = () => {};
    (stub as any)[NATIVE_TOOL_KEY] = new NativeTool(Symbol(toolName), toolName);
    return stub;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockChildSpans.length = 0;
    for (const key of Object.keys(mockSpan)) {
      (mockSpan as any)[key].mockReset?.();
    }
  });

  describe.each(PATHS)('%s', (path) => {
    it('forwards cwd and settingSources to query()', async () => {
      const handler = createClaudeAgentsHandler({ cwd: '/srv/app', settingSources: ['project'] });
      const options = await queryOptions(handler, path);
      expect(options.cwd).toBe('/srv/app');
      expect(options.settingSources).toEqual(['project']);
    });

    it('sends settingSources: [] and no cwd when neither option is given', async () => {
      const options = await queryOptions(createClaudeAgentsHandler(), path);
      expect(Object.hasOwn(options, 'cwd')).toBe(false);
      expect(options.settingSources).toEqual([]);
    });

    it('loads host settings only when the application opts in', async () => {
      const all = ['user', 'project', 'local'] as const;
      const options = await queryOptions(createClaudeAgentsHandler({ settingSources: [...all] }), path);
      expect(options.settingSources).toEqual([...all]);
    });

    it('forwards settingSources: [] as an empty list', async () => {
      const options = await queryOptions(createClaudeAgentsHandler({ settingSources: [] }), path);
      expect(Object.hasOwn(options, 'settingSources')).toBe(true);
      expect(options.settingSources).toEqual([]);
    });

    it('claudeAgents sends settingSources: [] unless given, and forwards the host options to the handler', async () => {
      const { claudeAgents } = await import('../handler.js');
      const { configInternal } = await import('@launchdarkly/ai-server');
      const ctx = { kind: 'user' as const, key: 'u' };
      const lastHandler = () =>
        vi.mocked(configInternal).mock.calls.at(-1)?.[0].handler as ReturnType<typeof createClaudeAgentsHandler>;

      await claudeAgents('flag', 'q', ctx);
      const defaults = await queryOptions(lastHandler(), path);
      expect(Object.hasOwn(defaults, 'cwd')).toBe(false);
      expect(defaults.settingSources).toEqual([]);

      await claudeAgents('flag', 'q', ctx, { cwd: '/srv/app', settingSources: ['user'] });
      // Handler options, so they configure the handler and are not passed on to `config()`.
      const args = vi.mocked(configInternal).mock.calls.at(-1)?.[0];
      expect(args).not.toHaveProperty('cwd');
      expect(args).not.toHaveProperty('settingSources');
      const given = await queryOptions(lastHandler(), path);
      expect(given.cwd).toBe('/srv/app');
      expect(given.settingSources).toEqual(['user']);
    });

    it('lets no config set or override a host option', async () => {
      const config = {
        ...baseConfig,
        model: {
          name: 'claude-opus-4-5',
          parameters: {
            cwd: '/from-config',
            setting_sources: ['user'],
            settingSources: ['user'],
            plugins: [{ type: 'local', path: '/from-config' }],
            skills: 'all',
          },
        },
      };
      const fromConfig = await queryOptions(createClaudeAgentsHandler(), path, config);
      for (const key of ['cwd', 'plugins', 'skills']) {
        expect(fromConfig[key]).toBeUndefined();
      }
      // The handler's own default, not the config's `['user']`.
      expect(fromConfig.settingSources).toEqual([]);
      const overridden = await queryOptions(createClaudeAgentsHandler({ cwd: '/srv/app' }), path, config);
      expect(overridden.cwd).toBe('/srv/app');
    });

    it('sends tools: [] when the config has no tools', async () => {
      const options = await queryOptions(createClaudeAgentsHandler(), path);
      expect(Object.hasOwn(options, 'tools')).toBe(true);
      expect(options.tools).toEqual([]);
    });

    it('sends tools: [] with only user-defined tools, which stay allowed through MCP', async () => {
      const config = {
        ...baseConfig,
        tools: { search: { name: 'search', type: 'function', parameters: { type: 'object', properties: {} } } },
      };
      const options = await queryOptions(createClaudeAgentsHandler(), path, config, { search: vi.fn() });
      expect(options.tools).toEqual([]);
      expect(options.allowedTools).toContain('mcp__tool-mcp__search');
    });

    it('sends exactly the provider names of the native tools', async () => {
      const nativeConfig = {
        ...baseConfig,
        tools: {
          read: { name: 'read', type: 'function', parameters: {} },
          bash: { name: 'bash', type: 'function', parameters: {} },
        },
      };
      const options = await queryOptions(createClaudeAgentsHandler(), path, nativeConfig, {
        read: nativeStub('Read'),
        bash: nativeStub('Bash'),
      });
      expect([...(options.tools as string[])].sort()).toEqual(['Bash', 'Read']);
    });
  });
});

// ── outputFormat — best-effort (system prompt injection) ──────────────────────

describe('createClaudeAgentsHandler — outputFormat', () => {
  const outputFormat = { type: 'object', properties: { result: { type: 'string' } } };

  beforeEach(() => {
    vi.clearAllMocks();
    mockChildSpans.length = 0;
    for (const key of Object.keys(mockSpan)) {
      (mockSpan as any)[key].mockReset?.();
    }
  });

  it('appends JSON schema instruction to systemPrompt when outputFormat is set', async () => {
    mockQuery.mockImplementation(async function* () {
      yield { type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } };
    });
    const config = { ...baseConfig, outputFormat };
    await createClaudeAgentsHandler()(config as any, 'hello');
    const callArgs = mockQuery.mock.calls[0][0];
    expect(callArgs.options.systemPrompt).toContain('You are helpful.');
    expect(callArgs.options.systemPrompt).toContain(JSON.stringify(outputFormat));
  });

  it('does not inject schema instruction when outputFormat is absent', async () => {
    mockQuery.mockImplementation(async function* () {
      yield { type: 'result', subtype: 'success', result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } };
    });
    await createClaudeAgentsHandler()(baseConfig as any, 'hello');
    const callArgs = mockQuery.mock.calls[0][0];
    expect(callArgs.options.systemPrompt).toBe('You are helpful.');
    expect(callArgs.options.systemPrompt).not.toContain('"type":"object"');
  });
});
