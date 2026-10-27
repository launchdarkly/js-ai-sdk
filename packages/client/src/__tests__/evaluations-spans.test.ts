/**
 * Evaluations from Code: the spans `run()` exports. Each row is one trace on
 * the tracer provider already registered, here an in-memory exporter behind
 * the SDK's span processor. Requests go through a recording fake; the SDK
 * client is a stub injected by mocking the core client's initialization.
 */

import { context, type HrTime, type Span, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setInputContentAttributes, setOutputContentAttributes, textMessage } from '../content.js';
import { ConversationIdSpanProcessor, GEN_AI_CONVERSATION_ID, withConversationId } from '../conversation.js';
import {
  conversationIdForEvaluationRow,
  LD_EVALUATION_RUN_ID,
  LD_EVALUATION_RUN_ROW_INDEX,
  withEvaluationRow,
} from '../evaluations-spans.js';
import { EvalTool, Judge, type RunOptions, Scorer } from '../experimental.js';
import { flushTracerProvider } from '../lifecycle.js';
import type { ProviderHandler } from '../types.js';
import { createHandlerInternal } from '../utils.js';
import {
  datasetRow,
  FakeApi,
  judgeReply,
  makeModule,
  routeHostedRun,
  type StubClient,
  servedJudge,
  stubClient,
} from './evaluations-fakes.js';

const lifecycle = vi.hoisted(() => ({
  client: undefined as unknown,
  init: vi.fn(),
  resolve: vi.fn(),
  /** Overrides whether the SDK's span processor is on the active provider. */
  processorActive: undefined as boolean | undefined,
}));
const otlp = vi.hoisted(() => ({ constructed: 0 }));

vi.mock('../lifecycle.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lifecycle.js')>();
  return {
    ...original,
    sdkSpanProcessorIsActive: () => lifecycle.processorActive ?? original.sdkSpanProcessorIsActive(),
    getClient: () => {
      if (!lifecycle.client) throw new Error('LaunchDarkly client not initialized.');
      return lifecycle.client;
    },
    initClient: (...args: unknown[]) => lifecycle.init(...args),
    extractVariation: (...args: unknown[]) => lifecycle.resolve(...args),
  };
});

vi.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: class {
    constructor() {
      otlp.constructed++;
    }
  },
}));

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({
  resource: resourceFromAttributes({ 'launchdarkly.project_id': 'sdk-key' }),
  spanProcessors: [new ConversationIdSpanProcessor(), new SimpleSpanProcessor(exporter)],
});
const contextManager = new AsyncLocalStorageContextManager();

let client: StubClient;
let log: string[];
let warn: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  contextManager.enable();
  context.setGlobalContextManager(contextManager);
  trace.setGlobalTracerProvider(provider);
});

afterAll(async () => {
  context.disable();
  await provider.shutdown();
});

beforeEach(() => {
  exporter.reset();
  log = [];
  client = stubClient(log);
  lifecycle.client = client;
  lifecycle.init.mockReset();
  lifecycle.resolve.mockReset();
  lifecycle.resolve.mockImplementation(async () => JUDGE);
  lifecycle.processorActive = undefined;
  vi.spyOn(provider, 'forceFlush').mockImplementation(async () => {
    log.push('forceFlush');
  });
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  warn.mockRestore();
});

const RUN_ID = 'run-1';
const ROW_ID = conversationIdForEvaluationRow(RUN_ID, 0);
const INPUT = 'What is the capital of France?';
const ANSWER = 'The capital of France is Paris.';

const JUDGE = servedJudge({
  provider: { name: 'Anthropic' },
  model: { name: 'claude-judge' },
  messages: [
    { role: 'system', content: 'You grade answers about {{topic}}.' },
    { role: 'user', content: '{{message_history}}' },
  ],
});

const GENERATION = {
  provider: 'OpenAI',
  model: 'gpt-4o',
  mode: 'completion' as const,
  messages: [
    { role: 'system' as const, content: 'You answer questions for {{name}}.' },
    { role: 'user' as const, content: 'Topic: {{topic}}' },
  ],
};

const lookupCapital = new EvalTool(
  'lookup_capital',
  ({ country }: { country: string }) => (country === 'France' ? 'Paris' : 'unknown'),
  { type: 'object', properties: { country: { type: 'string' } } },
  'Look up a country capital',
);

type Impl = (...args: Parameters<ProviderHandler>) => Promise<unknown>;

/** A plain function: it opens no span of its own. */
const plain = (provider: string, impl: Impl, captureContent?: boolean) => {
  const fn = vi.fn(impl);
  return createHandlerInternal([provider, 'messages'], fn as never, undefined, captureContent) as ProviderHandler &
    typeof fn;
};

const callsTool: Impl = async (_config, _input, tools) => {
  await (tools?.lookup_capital as (args: unknown) => Promise<string>)({ country: 'France' });
  return { output: ANSWER, usage: { input_tokens: 11, output_tokens: 7 } };
};

const judgeHandler = (captureContent?: boolean, reply = judgeReply(0.9, 'Names the right capital.')) =>
  plain('Anthropic', async () => reply, captureContent);

const options = (overrides: Record<string, unknown> = {}) =>
  ({
    key: 'eval-key',
    dataset: 'ds',
    generation: GENERATION,
    tools: [lookupCapital],
    criteria: [new Judge('accuracy')],
    pollIntervalSeconds: 0,
    pollTimeoutSeconds: 5,
    ...overrides,
  }) as RunOptions;

const ROW = datasetRow(0, { input: INPUT, variables: { name: 'Ada', topic: 'geography' } });

async function runWith(overrides: Record<string, unknown>) {
  const api = routeHostedRun(new FakeApi(), [ROW]);
  return makeModule(api).run(options(overrides));
}

const spans = () => exporter.getFinishedSpans();
const named = (name: string) => spans().filter((span) => span.name === name);
const only = (name: string): ReadableSpan => {
  const found = named(name);
  expect(found, name).toHaveLength(1);
  return found[0];
};
const parentOf = (span: ReadableSpan) => span.parentSpanContext?.spanId;
const nanos = ([seconds, ns]: HrTime) => BigInt(seconds) * 1_000_000_000n + BigInt(ns);
const json = (span: ReadableSpan, key: string) => JSON.parse(String(span.attributes[key]));
const resultEvent = (span: ReadableSpan) => span.events.find((event) => event.name === 'gen_ai.evaluation.result');

/** Every attribute that carries conversation content. */
const CONTENT_KEYS = [
  'gen_ai.system_instructions',
  'gen_ai.input.messages',
  'gen_ai.output.messages',
  'gen_ai.tool.definitions',
  'gen_ai.tool.call.arguments',
  'gen_ai.tool.call.result',
  'gen_ai.evaluation.explanation',
];

const contentOn = (span: ReadableSpan): string[] => [
  ...Object.keys(span.attributes).filter(
    (key) => CONTENT_KEYS.includes(key) || key.startsWith('gen_ai.prompt.') || key.startsWith('gen_ai.completion.'),
  ),
  ...span.events.filter((event) => event.name.startsWith('gen_ai.content.')).map((event) => event.name),
  ...Object.keys(resultEvent(span)?.attributes ?? {}).filter((key) => key === 'gen_ai.evaluation.explanation'),
];

// ---------------------------------------------------------------------------
// The row binding
// ---------------------------------------------------------------------------

describe('evaluation row conversation id', () => {
  it('is the UUIDv5 of {runId}:{rowIndex} in the evaluation namespace', () => {
    expect(conversationIdForEvaluationRow('run-id', 3)).toBe('faa03308-8fe7-5805-8c07-f82a3dbdb3f1');
    expect(conversationIdForEvaluationRow('run-id', 0)).toBe('8b90044e-ac6d-5af1-88a3-b75fbb9c8268');
  });
});

describe('withEvaluationRow', () => {
  const sdk = () => trace.getTracer('@launchdarkly/ai-openai-agents');

  it('stamps the conversation id and both run attributes on SDK spans', () => {
    withEvaluationRow('run-id', 3, () => sdk().startSpan('invoke_agent').end());
    const { attributes } = spans()[0];
    expect(attributes[GEN_AI_CONVERSATION_ID]).toBe('faa03308-8fe7-5805-8c07-f82a3dbdb3f1');
    expect(attributes[LD_EVALUATION_RUN_ID]).toBe('run-id');
    expect(attributes[LD_EVALUATION_RUN_ROW_INDEX]).toBe(3);
    expect(attributes['launchdarkly.run.id']).toBeUndefined();
  });

  it('shadows an outer conversation id', () => {
    withConversationId('caller-thread', () =>
      withEvaluationRow('run-id', 0, () => sdk().startSpan('invoke_agent').end()),
    );
    expect(spans()[0].attributes[GEN_AI_CONVERSATION_ID]).toBe('8b90044e-ac6d-5af1-88a3-b75fbb9c8268');
  });

  it('leaves a span from another tracer alone', () => {
    withEvaluationRow('run-id', 0, () => trace.getTracer('some-orm').startSpan('SELECT 1').end());
    const { attributes } = spans()[0];
    expect(attributes[GEN_AI_CONVERSATION_ID]).toBeUndefined();
    expect(attributes[LD_EVALUATION_RUN_ID]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// A plain function, capture on
// ---------------------------------------------------------------------------

describe('a plain function that calls a tool, with one judge, capture on', () => {
  let generation: ReturnType<typeof plain>;
  let judge: ReturnType<typeof plain>;

  beforeEach(async () => {
    generation = plain('OpenAI', callsTool, true);
    judge = judgeHandler(true);
    await runWith({ handlers: [generation, judge] });
  });

  it('exports exactly the row root, chat, execute_tool, evaluate and judge chat, in one trace, all OK', () => {
    expect(
      spans()
        .map((span) => span.name)
        .sort(),
    ).toEqual(
      [
        'chat claude-judge',
        'chat gpt-4o',
        'evaluate accuracy',
        'execute_tool lookup_capital',
        'launchdarkly.dataset_row',
      ].sort(),
    );
    const root = only('launchdarkly.dataset_row');
    expect(parentOf(root)).toBeUndefined();
    expect(parentOf(only('chat gpt-4o'))).toBe(root.spanContext().spanId);
    expect(parentOf(only('execute_tool lookup_capital'))).toBe(root.spanContext().spanId);
    expect(parentOf(only('evaluate accuracy'))).toBe(root.spanContext().spanId);
    expect(parentOf(only('chat claude-judge'))).toBe(only('evaluate accuracy').spanContext().spanId);
    for (const span of spans()) {
      expect(span.spanContext().traceId).toBe(root.spanContext().traceId);
      expect(span.status.code, span.name).toBe(1);
      expect(span.attributes[GEN_AI_CONVERSATION_ID], span.name).toBe(ROW_ID);
      expect(span.attributes[LD_EVALUATION_RUN_ID], span.name).toBe(RUN_ID);
      expect(span.attributes[LD_EVALUATION_RUN_ROW_INDEX], span.name).toBe(0);
      expect(span.attributes['launchdarkly.run.id'], span.name).toBeUndefined();
    }
  });

  it('names no gen_ai operation and no evaluation on the row root', () => {
    const root = only('launchdarkly.dataset_row');
    expect(root.attributes['gen_ai.operation.name']).toBeUndefined();
    expect(root.name).not.toMatch(/evaluat/);
  });

  it('times every span inside its parent, and the tool call inside the generation chat', () => {
    const byId = new Map(spans().map((span) => [span.spanContext().spanId, span]));
    for (const span of spans()) {
      expect(nanos(span.endTime) > nanos(span.startTime), `${span.name} has a duration`).toBe(true);
      const parent = byId.get(parentOf(span) ?? '');
      if (!parent) continue;
      expect(nanos(span.startTime) >= nanos(parent.startTime), `${span.name} starts inside its parent`).toBe(true);
      expect(nanos(span.endTime) <= nanos(parent.endTime), `${span.name} ends inside its parent`).toBe(true);
    }
    const chat = only('chat gpt-4o');
    const tool = only('execute_tool lookup_capital');
    expect(nanos(tool.startTime) >= nanos(chat.startTime)).toBe(true);
    expect(nanos(tool.endTime) <= nanos(chat.endTime)).toBe(true);
  });

  it('describes the generation: rendered prompt, row input, model, provider, usage and output', () => {
    const chat = only('chat gpt-4o');
    expect(chat.attributes['gen_ai.operation.name']).toBe('chat');
    expect(chat.attributes['gen_ai.provider.name']).toBe('openai');
    expect(chat.attributes['gen_ai.request.model']).toBe('gpt-4o');
    expect(chat.attributes['gen_ai.usage.input_tokens']).toBe(11);
    expect(chat.attributes['gen_ai.usage.output_tokens']).toBe(7);
    expect(json(chat, 'gen_ai.system_instructions')).toEqual([
      { type: 'text', content: 'You answer questions for Ada.' },
    ]);
    expect(json(chat, 'gen_ai.input.messages')).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'Topic: geography' }] },
      { role: 'user', parts: [{ type: 'text', content: INPUT }] },
    ]);
    expect(json(chat, 'gen_ai.tool.definitions')).toEqual([
      {
        type: 'function',
        name: 'lookup_capital',
        description: 'Look up a country capital',
        parameters: { type: 'object', properties: { country: { type: 'string' } } },
      },
    ]);
    const [output] = json(chat, 'gen_ai.output.messages');
    expect(output.role).toBe('assistant');
    expect(output.parts).toEqual([
      { type: 'tool_call', id: 'call_1', name: 'lookup_capital', arguments: '{"country":"France"}' },
      { type: 'text', content: ANSWER },
    ]);
  });

  it('ties the tool_call part to the execute_tool span by call id', () => {
    const tool = only('execute_tool lookup_capital');
    expect(tool.attributes['gen_ai.tool.name']).toBe('lookup_capital');
    expect(tool.attributes['gen_ai.tool.call.id']).toBe('call_1');
    expect(tool.attributes['gen_ai.tool.call.arguments']).toBe('{"country":"France"}');
    expect(tool.attributes['gen_ai.tool.call.result']).toBe('Paris');
  });

  it('describes the judge call from the judge config and the judge variables', () => {
    const chat = only('chat claude-judge');
    expect(chat.attributes['gen_ai.provider.name']).toBe('anthropic');
    expect(chat.attributes['gen_ai.request.model']).toBe('claude-judge');
    expect(json(chat, 'gen_ai.system_instructions')).toEqual([
      { type: 'text', content: 'You grade answers about geography.' },
    ]);
    const messages = json(chat, 'gen_ai.input.messages') as Array<{ role: string; parts: { content: string }[] }>;
    expect(messages).toHaveLength(2);
    const history = messages[0].parts[0].content;
    expect(messages[0].role).toBe('user');
    expect(history).toContain(INPUT);
    expect(history).toContain('lookup_capital');
    expect(history).toContain(ANSWER);
    expect(history).not.toContain('{{message_history}}');
    expect(messages[1]).toEqual({ role: 'user', parts: [{ type: 'text', content: ANSWER }] });
    expect(json(chat, 'gen_ai.output.messages')).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: judgeReply(0.9, 'Names the right capital.').output }] },
    ]);
  });

  it('records the result with name, score and explanation, and no verdict', () => {
    const evaluate = only('evaluate accuracy');
    expect(evaluate.attributes['gen_ai.operation.name']).toBe('evaluate');
    expect(evaluate.attributes['gen_ai.provider.name']).toBe('anthropic');
    expect(evaluate.attributes['gen_ai.request.model']).toBe('claude-judge');
    const events = evaluate.events.filter((event) => event.name === 'gen_ai.evaluation.result');
    expect(events).toHaveLength(1);
    expect(events[0].attributes).toEqual({
      'gen_ai.evaluation.name': 'accuracy',
      'gen_ai.evaluation.score.value': 0.9,
      'gen_ai.evaluation.explanation': 'Names the right capital.',
    });
    expect(evaluate.attributes['gen_ai.evaluation.score.value']).toBe(0.9);
    for (const key of Object.keys(evaluate.attributes)) {
      expect(key).not.toMatch(/score\.label|verdict|passed|success_?direction/i);
    }
    // The evaluate span carries no prompt, completion or tool payload: those are on its chat child.
    expect(contentOn(evaluate).filter((key) => key !== 'gen_ai.evaluation.explanation')).toEqual([]);
  });

  it('leaves the tracked payloads without the transcript', () => {
    const forbidden = /tool|transcript|input\.messages|output\.messages|prompt|completion|arguments|lookup_capital/i;
    for (const { data } of client.tracked) {
      for (const key of Object.keys(data)) expect(key).not.toMatch(forbidden);
      expect(JSON.stringify(data)).not.toContain('lookup_capital');
      expect(JSON.stringify(data)).not.toContain('"France"');
    }
  });

  it("force-flushes the tracer provider after the client's flush, with no new exporter", () => {
    expect(log.lastIndexOf('forceFlush')).toBeGreaterThan(log.lastIndexOf('flush'));
    expect(log.at(-1)).toBe('forceFlush');
    expect(otlp.constructed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The content gate
// ---------------------------------------------------------------------------

describe('content capture follows the one gate', () => {
  /** A span that is not an evaluation span, written through the shared content helpers. */
  const helperSpan = (capture: boolean): ReadableSpan => {
    exporter.reset();
    const span = trace.getTracer('@launchdarkly/ai-server').startSpan('chat m');
    setInputContentAttributes(span, capture, { systemInstructions: 'sys', messages: [textMessage('user', 'hi')] });
    setOutputContentAttributes(span, capture, [textMessage('assistant', 'hello')]);
    span.end();
    return spans()[0];
  };

  it('omits every content field on the runner-written spans under the built-in default', async () => {
    await runWith({ handlers: [plain('OpenAI', callsTool), judgeHandler()] });
    expect(spans()).toHaveLength(5);
    for (const span of spans()) expect(contentOn(span), span.name).toEqual([]);
    // Name and score stay.
    expect(resultEvent(only('evaluate accuracy'))?.attributes).toEqual({
      'gen_ai.evaluation.name': 'accuracy',
      'gen_ai.evaluation.score.value': 0.9,
    });
    // The model, usage and tool name are not content.
    expect(only('chat gpt-4o').attributes['gen_ai.request.model']).toBe('gpt-4o');
    expect(only('chat gpt-4o').attributes['gen_ai.usage.output_tokens']).toBe(7);
    expect(only('execute_tool lookup_capital').attributes['gen_ai.tool.name']).toBe('lookup_capital');
    // A non-evaluation span written with the same resolved default.
    expect(contentOn(helperSpan(false))).toEqual([]);
  });

  it('exports content on a non-evaluation span with an explicit true', () => {
    expect(contentOn(helperSpan(true))).toEqual(
      expect.arrayContaining(['gen_ai.system_instructions', 'gen_ai.input.messages', 'gen_ai.output.messages']),
    );
  });

  it('applies each handler its own setting: generation captured, judge not', async () => {
    await runWith({ handlers: [plain('OpenAI', callsTool, true), judgeHandler(false)] });
    expect(contentOn(only('chat gpt-4o'))).toEqual(expect.arrayContaining(['gen_ai.input.messages']));
    expect(contentOn(only('execute_tool lookup_capital'))).toEqual(
      expect.arrayContaining(['gen_ai.tool.call.arguments', 'gen_ai.tool.call.result']),
    );
    expect(contentOn(only('chat claude-judge'))).toEqual([]);
    expect(contentOn(only('evaluate accuracy'))).toEqual([]);
  });

  it('applies each handler its own setting: judge captured, generation not', async () => {
    await runWith({ handlers: [plain('OpenAI', callsTool, false), judgeHandler(true)] });
    expect(contentOn(only('chat gpt-4o'))).toEqual([]);
    expect(contentOn(only('execute_tool lookup_capital'))).toEqual([]);
    expect(contentOn(only('chat claude-judge'))).toEqual(expect.arrayContaining(['gen_ai.input.messages']));
    expect(contentOn(only('evaluate accuracy'))).toEqual([
      'gen_ai.evaluation.explanation',
      'gen_ai.evaluation.explanation',
    ]);
  });
});

// ---------------------------------------------------------------------------
// A row whose handler raised
// ---------------------------------------------------------------------------

describe('a plain function that calls a tool and then raises, with one judge', () => {
  it('marks the root and chat ERROR, keeps the tool result, and is never scored', async () => {
    const generation = plain(
      'OpenAI',
      async (_config, _input, tools) => {
        await (tools?.lookup_capital as (args: unknown) => Promise<string>)({ country: 'France' });
        throw new RangeError('the model went away');
      },
      true,
    );
    const judge = judgeHandler(true);
    await runWith({ handlers: [generation, judge] });

    const root = only('launchdarkly.dataset_row');
    expect(root.status.code).toBe(2);
    expect(root.attributes['error.type']).toBe('RangeError');

    const chat = only('chat gpt-4o');
    expect(chat.status.code).toBe(2);
    expect(chat.attributes['error.type']).toBe('RangeError');
    expect(chat.attributes['gen_ai.input.messages']).toBeDefined();
    expect(chat.attributes['gen_ai.output.messages']).toBeUndefined();

    const tool = only('execute_tool lookup_capital');
    expect(tool.attributes['gen_ai.tool.call.result']).toBe('Paris');
    for (const span of spans()) expect(span.spanContext().traceId).toBe(root.spanContext().traceId);

    expect(named('evaluate accuracy')).toEqual([]);
    expect(named('chat claude-judge')).toEqual([]);
    expect(judge).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Criterion outcomes
// ---------------------------------------------------------------------------

describe('criterion spans', () => {
  it('makes an ERROR criterion an ERROR span with its cause, and no result event', async () => {
    await runWith({ handlers: [plain('OpenAI', callsTool), judgeHandler(true, { output: 'not json' })] });
    const evaluate = only('evaluate accuracy');
    expect(evaluate.status.code).toBe(2);
    expect(evaluate.attributes['error.type']).toBe('invalid_judge_output');
    expect(resultEvent(evaluate)).toBeUndefined();
  });

  it('wraps a scorer in its own evaluate span, with a score and no explanation', async () => {
    await runWith({ handlers: [plain('OpenAI', callsTool, true)], criteria: [new Scorer('exact', () => 1)] });
    const evaluate = only('evaluate exact');
    expect(evaluate.status.code).toBe(1);
    expect(parentOf(evaluate)).toBe(only('launchdarkly.dataset_row').spanContext().spanId);
    expect(resultEvent(evaluate)?.attributes).toEqual({
      'gen_ai.evaluation.name': 'exact',
      'gen_ai.evaluation.score.value': 1,
    });
  });
});

describe('a failed tool call', () => {
  it('is an ERROR execute_tool span with error.type tool_error', async () => {
    const failing = new EvalTool(
      'lookup_capital',
      () => {
        throw new Error('no such country');
      },
      {},
    );
    const generation = plain(
      'OpenAI',
      async (_config, _input, tools) => {
        try {
          await (tools?.lookup_capital as (args: unknown) => Promise<string>)({ country: 'Atlantis' });
        } catch {
          // The handler recovers and answers anyway.
        }
        return { output: 'I do not know.' };
      },
      true,
    );
    await runWith({ handlers: [generation], tools: [failing], criteria: [] });
    const tool = only('execute_tool lookup_capital');
    expect(tool.status.code).toBe(2);
    expect(tool.attributes['error.type']).toBe('tool_error');
    expect(tool.attributes['gen_ai.tool.call.result']).toBeUndefined();
    expect(only('chat gpt-4o').status.code).toBe(1);
  });
});

describe('a provider without the SDK span processor', () => {
  it('gets no runner-written chat or execute_tool, since a handler span could not be counted', async () => {
    lifecycle.processorActive = false;
    await runWith({ handlers: [plain('OpenAI', callsTool, true), judgeHandler(true)] });
    expect(
      spans()
        .map((span) => span.name)
        .sort(),
    ).toEqual(['evaluate accuracy', 'launchdarkly.dataset_row']);
  });
});

// ---------------------------------------------------------------------------
// A handler that traces itself
// ---------------------------------------------------------------------------

describe('a handler that opens its own spans', () => {
  it('stamps its spans with the row, and the runner writes no chat or execute_tool of its own', async () => {
    const sdk = trace.getTracer('@launchdarkly/ai-openai-agents');
    const traced = plain('OpenAI', async (_config, _input, tools) =>
      sdk.startActiveSpan('invoke_agent', async (agent: Span) => {
        sdk.startSpan('chat gpt-4o').end();
        const result = await sdk.startActiveSpan('execute_tool lookup_capital', async (tool: Span) => {
          const value = await (tools?.lookup_capital as (args: unknown) => Promise<string>)({ country: 'France' });
          tool.setAttributes({
            'gen_ai.tool.name': 'lookup_capital',
            'gen_ai.tool.call.arguments': '{"country":"France"}',
            'gen_ai.tool.call.result': value,
          });
          tool.end();
          return value;
        });
        trace.getTracer('some-orm').startSpan('SELECT capitals').end();
        agent.end();
        return { output: `The capital is ${result}.` };
      }),
    );
    await runWith({ handlers: [traced], criteria: [] });

    const root = only('launchdarkly.dataset_row');
    for (const name of ['invoke_agent', 'chat gpt-4o', 'execute_tool lookup_capital']) {
      const span = only(name);
      expect(span.spanContext().traceId).toBe(root.spanContext().traceId);
      expect(span.attributes[GEN_AI_CONVERSATION_ID], name).toBe(ROW_ID);
      expect(span.attributes[LD_EVALUATION_RUN_ID], name).toBe(RUN_ID);
      expect(span.attributes[LD_EVALUATION_RUN_ROW_INDEX], name).toBe(0);
      expect(span.attributes['launchdarkly.run.id'], name).not.toBe(RUN_ID);
    }
    expect(parentOf(only('invoke_agent'))).toBe(root.spanContext().spanId);
    const tool = only('execute_tool lookup_capital');
    expect(tool.attributes['gen_ai.tool.call.arguments']).toBe('{"country":"France"}');
    expect(tool.attributes['gen_ai.tool.call.result']).toBe('Paris');

    const foreign = only('SELECT capitals');
    expect(foreign.attributes[GEN_AI_CONVERSATION_ID]).toBeUndefined();
    expect(foreign.attributes[LD_EVALUATION_RUN_ID]).toBeUndefined();
    expect(foreign.attributes[LD_EVALUATION_RUN_ROW_INDEX]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Flushing
// ---------------------------------------------------------------------------

describe('tracer flush', () => {
  it('runs, and the row roots end, when the evaluation phase throws', async () => {
    let flushes = 0;
    client.flush.mockImplementation(async () => {
      log.push('flush');
      flushes++;
      throw new Error(`flush ${flushes} failed`);
    });
    await expect(runWith({ handlers: [plain('OpenAI', callsTool), judgeHandler()] })).rejects.toThrow('flush');
    expect(log.at(-1)).toBe('forceFlush');
    expect(named('launchdarkly.dataset_row')).toHaveLength(1);
    expect(named('evaluate accuracy')).toEqual([]);
  });

  it('is a no-op for a provider with no forceFlush', async () => {
    const bare = { getTracer: () => trace.getTracer('x') };
    vi.spyOn(trace, 'getTracerProvider').mockReturnValue(bare as never);
    await expect(flushTracerProvider()).resolves.toBeUndefined();
  });

  it('reaches the provider behind the global proxy', async () => {
    await flushTracerProvider();
    expect(provider.forceFlush).toHaveBeenCalledTimes(1);
  });
});
