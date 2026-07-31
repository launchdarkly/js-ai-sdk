import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { ToolDefinitionInput } from '../content.js';
import {
  langChainFinishReasons,
  setInputContentAttributes,
  setOutputContentAttributes,
  setToolCallContentAttributes,
  setToolDefinitionAttributes,
  textMessage,
  toSemconvFinishReason,
} from '../content.js';

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
const tracer = provider.getTracer('content-test');

/** Ends the span so the exporter releases it, then hands back its attributes. */
const attributesOf = (write: (span: ReturnType<typeof tracer.startSpan>) => void) => {
  const span = tracer.startSpan('chat');
  write(span);
  span.end();
  const [recorded] = exporter.getFinishedSpans();
  return recorded.attributes;
};

const searchTool: ToolDefinitionInput[] = [
  {
    name: 'search',
    description: 'Search the corpus',
    parameters: { type: 'object', properties: { q: { type: 'string' } } },
  },
];

// Top level, not inside a `describe`: a provider shut down after the first block would leave every
// later block exporting into a dead pipeline, and those tests fail as "no span recorded".
afterAll(async () => {
  await provider.shutdown();
});

beforeEach(() => {
  exporter.reset();
});

describe('content capture gate', () => {
  it('writes nothing at all when capture is off', () => {
    const attrs = attributesOf((span) => {
      setInputContentAttributes(span, false, {
        systemInstructions: 'You are helpful.',
        messages: [textMessage('user', 'hi')],
        toolDefinitions: searchTool,
      });
      setOutputContentAttributes(span, false, [textMessage('assistant', 'hello')]);
      setToolCallContentAttributes(span, false, { arguments: { q: 'x' }, result: 'y' });
      setToolDefinitionAttributes(span, false, searchTool);
    });

    // Not "no content keys" but "no keys": everything these helpers write is content.
    expect(Object.keys(attrs)).toEqual([]);
  });

  it('leaks no prompt text into any attribute value when capture is off', () => {
    const attrs = attributesOf((span) => {
      setInputContentAttributes(span, false, {
        systemInstructions: 'SYSTEM-SECRET',
        messages: [textMessage('user', 'USER-SECRET')],
      });
      setOutputContentAttributes(span, false, [textMessage('assistant', 'MODEL-SECRET')]);
    });

    const serialized = JSON.stringify(attrs);
    expect(serialized).not.toContain('SECRET');
  });
});

describe('canonical content attributes', () => {
  it('writes input messages in the {role, parts} shape the GenAI schemas define', () => {
    const attrs = attributesOf((span) =>
      setInputContentAttributes(span, true, {
        messages: [textMessage('user', 'What is the weather?')],
      }),
    );

    expect(JSON.parse(String(attrs['gen_ai.input.messages']))).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'What is the weather?' }] },
    ]);
  });

  it('writes system instructions as their own part array', () => {
    const attrs = attributesOf((span) =>
      setInputContentAttributes(span, true, { systemInstructions: 'You are helpful.' }),
    );

    expect(JSON.parse(String(attrs['gen_ai.system_instructions']))).toEqual([
      { type: 'text', content: 'You are helpful.' },
    ]);
  });

  it('carries finish_reason on output messages under its snake_case key', () => {
    const attrs = attributesOf((span) =>
      setOutputContentAttributes(span, true, [
        { role: 'assistant', parts: [{ type: 'text', content: 'Done' }], finishReason: 'stop' },
      ]),
    );

    // `finishReason` is the ergonomic name for handlers; the wire name is what a reader parses.
    expect(JSON.parse(String(attrs['gen_ai.output.messages']))).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: 'Done' }], finish_reason: 'stop' },
    ]);
  });

  it('omits finish_reason entirely rather than emitting null', () => {
    const attrs = attributesOf((span) => setOutputContentAttributes(span, true, [textMessage('assistant', 'Done')]));

    const [message] = JSON.parse(String(attrs['gen_ai.output.messages']));
    expect('finish_reason' in message).toBe(false);
  });

  it('keeps tool calls and their responses as structured parts', () => {
    const attrs = attributesOf((span) =>
      setInputContentAttributes(span, true, {
        messages: [
          { role: 'assistant', parts: [{ type: 'tool_call', id: 'call_1', name: 'search', arguments: { q: 'ld' } }] },
          { role: 'tool', parts: [{ type: 'tool_call_response', id: 'call_1', result: 'found it' }] },
        ],
      }),
    );

    expect(JSON.parse(String(attrs['gen_ai.input.messages']))).toEqual([
      { role: 'assistant', parts: [{ type: 'tool_call', id: 'call_1', name: 'search', arguments: { q: 'ld' } }] },
      { role: 'tool', parts: [{ type: 'tool_call_response', id: 'call_1', result: 'found it' }] },
    ]);
  });

  it('writes the tool catalog with name, description and parameter schema', () => {
    const attrs = attributesOf((span) => setToolDefinitionAttributes(span, true, searchTool));

    expect(JSON.parse(String(attrs['gen_ai.tool.definitions']))).toEqual([
      {
        type: 'function',
        name: 'search',
        description: 'Search the corpus',
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
      },
    ]);
  });

  it('skips the tool catalog attribute when no tools were offered', () => {
    const attrs = attributesOf((span) => setToolDefinitionAttributes(span, true, []));

    expect(attrs['gen_ai.tool.definitions']).toBeUndefined();
  });
});

describe('OpenLLMetry carrier', () => {
  it('mirrors the messages into the shape the trace view reads today', () => {
    // LaunchDarkly's LLM trace view parses only `gen_ai.prompt.{i}.*` / `gen_ai.completion.{i}.*`.
    // Canonical attributes alone would render as an empty transcript.
    const attrs = attributesOf((span) => {
      setInputContentAttributes(span, true, {
        systemInstructions: 'You are helpful.',
        messages: [textMessage('user', 'hi')],
      });
      setOutputContentAttributes(span, true, [textMessage('assistant', 'hello')]);
    });

    expect(attrs['gen_ai.prompt.0.role']).toBe('system');
    expect(attrs['gen_ai.prompt.0.content']).toBe('You are helpful.');
    expect(attrs['gen_ai.prompt.1.role']).toBe('user');
    expect(attrs['gen_ai.prompt.1.content']).toBe('hi');
    expect(attrs['gen_ai.completion.0.role']).toBe('assistant');
    expect(attrs['gen_ai.completion.0.content']).toBe('hello');
  });

  it('numbers messages from zero when there are no system instructions', () => {
    const attrs = attributesOf((span) =>
      setInputContentAttributes(span, true, { messages: [textMessage('user', 'hi')] }),
    );

    expect(attrs['gen_ai.prompt.0.role']).toBe('user');
    expect(attrs['gen_ai.prompt.1.role']).toBeUndefined();
  });

  it('flattens structured parts to text so the OpenLLMetry carrier is never empty', () => {
    const attrs = attributesOf((span) =>
      setInputContentAttributes(span, true, {
        messages: [{ role: 'tool', parts: [{ type: 'tool_call_response', id: 'c1', result: { ok: true } }] }],
      }),
    );

    expect(attrs['gen_ai.prompt.0.content']).toBe('{"ok":true}');
  });
});

describe('tool call I/O', () => {
  it('stringifies an argument bag and passes a string result through unchanged', () => {
    const attrs = attributesOf((span) =>
      setToolCallContentAttributes(span, true, { arguments: { q: 'ld' }, result: 'plain text' }),
    );

    expect(attrs['gen_ai.tool.call.arguments']).toBe('{"q":"ld"}');
    expect(attrs['gen_ai.tool.call.result']).toBe('plain text');
  });

  it('distinguishes an absent result from a null one', () => {
    const absent = attributesOf((span) => setToolCallContentAttributes(span, true, { arguments: {} }));
    expect(absent['gen_ai.tool.call.result']).toBeUndefined();

    exporter.reset();
    const explicitNull = attributesOf((span) => setToolCallContentAttributes(span, true, { result: null }));
    // A tool that genuinely returned nothing is a fact worth recording; dropping it would read the
    // same as a tool that never ran.
    expect(explicitNull['gen_ai.tool.call.result']).toBe('null');
  });
});

describe('langChainFinishReasons', () => {
  // langchain-agents finishes a turn from an LLMResult; langchain-messages from the AIMessage
  // that invoke() returned. One reader has to handle both or the two packages drift apart.
  it('reads an LLMResult generationInfo, as OpenAI reports it', () => {
    const result = { generations: [[{ generationInfo: { finish_reason: 'length' }, message: {} }]] };
    expect(langChainFinishReasons(result)).toEqual(['length']);
  });

  it('reads a bare AIMessage response_metadata, as Anthropic reports it', () => {
    expect(langChainFinishReasons({ response_metadata: { stop_reason: 'tool_use' } })).toEqual(['tool_calls']);
  });

  it('prefers generationInfo over response_metadata when a generation carries both', () => {
    const result = {
      generations: [
        [{ generationInfo: { finish_reason: 'stop' }, message: { response_metadata: { stop_reason: 'x' } } }],
      ],
    };
    expect(langChainFinishReasons(result)).toEqual(['stop']);
  });

  it('collects one reason per generation', () => {
    const result = {
      generations: [[{ generationInfo: { finish_reason: 'stop' } }], [{ generationInfo: { finish_reason: 'length' } }]],
    };
    expect(langChainFinishReasons(result)).toEqual(['stop', 'length']);
  });

  // Undefined, not []: the caller leaves the attribute off rather than asserting that a turn
  // finished for no reason. An empty array would read as a reported absence.
  it('returns undefined when nothing reports a reason', () => {
    expect(langChainFinishReasons({ generations: [[{ message: {} }]] })).toBeUndefined();
    expect(langChainFinishReasons({ response_metadata: {} })).toBeUndefined();
    expect(langChainFinishReasons(undefined)).toBeUndefined();
    // A non-string reason is a provider shape this code does not understand; dropping it beats
    // stringifying it onto the span.
    expect(langChainFinishReasons({ response_metadata: { finish_reason: 3 } })).toBeUndefined();
  });

  // Routes through toSemconvFinishReason rather than emitting the vendor's own word. The mapping is
  // covered exhaustively below; this only pins that LangChain's reader is wired into it.
  it('maps the provider spelling onto the semconv vocabulary', () => {
    expect(langChainFinishReasons({ response_metadata: { stop_reason: 'end_turn' } })).toEqual(['stop']);
  });
});

describe('toSemconvFinishReason', () => {
  // One row per vendor spelling this SDK has actually seen, so a regression in the table is a test
  // failure rather than a subtly wrong dashboard.
  it.each([
    // Anthropic
    ['end_turn', 'stop'],
    ['stop_sequence', 'stop'],
    ['max_tokens', 'length'],
    ['tool_use', 'tool_calls'],
    ['refusal', 'content_filter'],
    // OpenAI Chat Completions
    ['stop', 'stop'],
    ['length', 'length'],
    ['tool_calls', 'tool_calls'],
    ['content_filter', 'content_filter'],
    ['function_call', 'tool_calls'],
    // Case-insensitively, so a provider that shouts its enum is still mapped.
    ['END_TURN', 'stop'],
    ['Tool_Use', 'tool_calls'],
  ])('maps %s onto %s', (raw, expected) => {
    expect(toSemconvFinishReason(raw)).toBe(expected);
  });

  // An unrecognised spelling is passed through as itself. Coercing it to `stop` would assert an
  // outcome no provider reported, and dropping it would lose the only clue that the table needs a
  // new row. `pause_turn` is the live example: Anthropic means "has not finished", and no semconv
  // value says that.
  it('passes an unrecognised reason through verbatim', () => {
    expect(toSemconvFinishReason('pause_turn')).toBe('pause_turn');
    expect(toSemconvFinishReason('some_future_reason')).toBe('some_future_reason');
  });

  it('returns undefined for an absent or empty reason', () => {
    expect(toSemconvFinishReason(undefined)).toBeUndefined();
    expect(toSemconvFinishReason(null)).toBeUndefined();
    expect(toSemconvFinishReason('')).toBeUndefined();
  });
});
