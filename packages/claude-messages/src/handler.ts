import Anthropic from '@anthropic-ai/sdk';
import {
  type AiConfigRep,
  addCachedTokensToInput,
  type ConfigTurn,
  type ContentCaptureOptions,
  composeHistory,
  config,
  createHandler,
  endSpanOnce,
  isContentBlocks,
  type LDContext,
  type Message,
  type MessageContent,
  type NativeTool,
  type ProviderHandler,
  parseTemplate,
  type SpanMessage,
  type SpanMessagePart,
  setInputContentAttributes,
  setLdSpanAttributes,
  setModelIdentityAttributes,
  setOutputContentAttributes,
  setToolCallContentAttributes,
  setUsageSpanAttributes,
  type Tool,
  type ToolDefinitionInput,
  toSemconvFinishReason,
} from '@launchdarkly/ai-server';
import { type Context, context, type Span, SpanStatusCode, trace } from '@opentelemetry/api';

const TRACER_NAME = '@launchdarkly/ai-claude-messages';

/**
 * Coerces a provider-reported token count to a finite number, defaulting to 0.
 *
 * Provider SDKs report usage as loosely-typed bags where a field may be absent, null, or a
 * partially-populated streaming value. An emitted `NaN` is worse than an emitted 0: `trackTokens`
 * guards on `total > 0`, and `NaN > 0` is false, so the metric is dropped silently rather than
 * reported low.
 *
 * Deliberately local rather than imported from the core package. It carries no LaunchDarkly or AI
 * meaning, so exporting it would make a generic numeric coercion part of that package's published
 * API and bind it to semver for the life of the SDK.
 */
function numberOrZero(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

type AnthropicTool = Anthropic.Tool;

/**
 * Converts one Anthropic message's content into canonical span message parts.
 *
 * Takes `unknown` on purpose: request content (`ContentBlockParam`) and response content
 * (`ContentBlock`) are separate SDK unions with overlapping members, and every caller here has one
 * or the other. Narrowing structurally on `type` serves both without a cast at each call site, and
 * silently drops block kinds the span has no part for (images, documents) rather than emitting a
 * malformed part.
 */
function toSpanParts(content: unknown): SpanMessagePart[] {
  if (typeof content === 'string') return content ? [{ type: 'text', content }] : [];
  if (!Array.isArray(content)) return [];

  const parts: SpanMessagePart[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    switch (block.type) {
      case 'text':
        parts.push({ type: 'text', content: String(block.text ?? '') });
        break;
      case 'thinking':
        parts.push({ type: 'reasoning', content: String(block.thinking ?? '') });
        break;
      case 'tool_use':
        parts.push({
          type: 'tool_call',
          id: typeof block.id === 'string' ? block.id : undefined,
          name: String(block.name ?? ''),
          arguments: block.input,
        });
        break;
      case 'tool_result':
        parts.push({
          type: 'tool_call_response',
          id: typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined,
          result: block.content,
        });
        break;
    }
  }
  return parts;
}

const toSpanMessages = (messages: ReadonlyArray<{ role: string; content: unknown }>): SpanMessage[] =>
  messages.map((message) => ({ role: message.role, parts: toSpanParts(message.content) }));

/**
 * The semantic conventions name an inference span `{gen_ai.operation.name} {gen_ai.request.model}`,
 * so the model belongs in the name and not only in `gen_ai.request.model`. A bare `chat` — which
 * this emitted for a while — aggregates more neatly but tells a reader nothing about which model
 * ran, which matters most in exactly the case this span exists for: a multi-turn run that switches
 * models partway through.
 */
function startModelSpan(config: AiConfigRep, parentContext: Context): Span {
  const span = trace.getTracer(TRACER_NAME).startSpan(`chat ${config.model.name}`, undefined, parentContext);
  span.setAttribute('gen_ai.operation.name', 'chat');
  setModelIdentityAttributes(span, 'anthropic', config.model.name);
  return span;
}

/**
 * Writes the run-level identity and token totals onto the `invoke_agent` root.
 *
 * The per-turn `chat` children carry the same attributes for their own turn, but the root is
 * the only span carrying `launchdarkly.*` and the `feature_flag` event, so it is the span a
 * config-scoped query finds. Leaving the totals off it means such a query returns nothing at
 * all, and the run-level aggregate would exist on no span — summing children requires already
 * having found them.
 */
function finishRootSpan(span: Span, config: AiConfigRep, rawUsage: Record<string, unknown>): void {
  span.setAttribute('gen_ai.response.model', config.model.name);
  setUsageSpanAttributes(span, addCachedTokensToInput(rawUsage));
}

/** `finishReason` arrives already mapped onto the semconv vocabulary — see the call sites. */
function finishModelSpan(
  span: Span,
  config: AiConfigRep,
  rawUsage: Record<string, unknown>,
  finishReason?: string,
): void {
  span.setAttribute('gen_ai.response.model', config.model.name);
  // An array because a single response may hold several choices; Anthropic returns one.
  if (finishReason) span.setAttribute('gen_ai.response.finish_reasons', [finishReason]);
  setUsageSpanAttributes(span, addCachedTokensToInput(rawUsage));
  span.setStatus({ code: SpanStatusCode.OK });
  span.end();
}

/** The catalog as sent, so the span reports what the model could actually call. */
const toToolDefinitions = (tools: AnthropicTool[]): ToolDefinitionInput[] =>
  tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.input_schema }));

function startToolSpan(toolName: string, toolUseId: string, parentContext: Context): Span {
  const span = trace.getTracer(TRACER_NAME).startSpan(`execute_tool ${toolName}`, undefined, parentContext);
  span.setAttribute('gen_ai.operation.name', 'execute_tool');
  span.setAttribute('gen_ai.tool.name', toolName);
  span.setAttribute('gen_ai.tool.call.id', toolUseId);
  return span;
}

/**
 * `endedSpans` is passed only from the streaming path, where a `finally` may race this to the
 * same span; elsewhere there is exactly one end and the tracker is unnecessary.
 */
function failSpan(span: Span, error: unknown, endedSpans?: Set<Span>): void {
  const exception = error instanceof Error ? error : new Error(String(error));
  span.recordException(exception);
  span.setStatus({ code: SpanStatusCode.ERROR, message: exception.message });
  if (endedSpans) endSpanOnce(span, endedSpans);
  else span.end();
}

/**
 * The run's accumulated usage, in Anthropic's own field names.
 *
 * Kept unfolded — cache figures beside the input total rather than added into it — so `parseUsage`
 * can fold once and derive `inputDetails`. Pre-folding here would hide the cache breakdown from
 * callers, and `addCachedTokensToInput` would then count it twice.
 *
 * That is also why this is not the core package's `createRunUsage`: that one accumulates `SpanUsage`,
 * whose `input` is already cache-inclusive, and handing one back as this handler's return value would
 * double-count the cache downstream. Deliberately named `RawRunUsage` rather than `RunUsage` so the
 * two cannot be mistaken for the same thing — they differ in exactly the way that matters.
 *
 * Created by the caller that owns the `invoke_agent` root rather than by the tool loop, so that a
 * loop which throws still leaves the run's spend somewhere the root can read it. `reported`
 * separates "no call completed" from "a call completed and reported zero"; only the latter may be
 * written to a span, since all-zero attributes assert the run cost nothing.
 */
interface RawRunUsage {
  readonly total: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
  readonly reported: boolean;
  addTurn(rawUsage: Record<string, unknown>): void;
}

function createRawRunUsage(): RawRunUsage {
  const total = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  let turns = 0;
  return {
    total,
    get reported() {
      return turns > 0;
    },
    addTurn(rawUsage: Record<string, unknown>) {
      turns++;
      total.input_tokens += numberOrZero(rawUsage.input_tokens);
      total.output_tokens += numberOrZero(rawUsage.output_tokens);
      total.cache_read_input_tokens += numberOrZero(rawUsage.cache_read_input_tokens);
      total.cache_creation_input_tokens += numberOrZero(rawUsage.cache_creation_input_tokens);
    },
  };
}

const buildTools = (
  configTools: Record<string, Tool>,
  toolHandlers: Record<string, ((...args: unknown[]) => unknown) | NativeTool>,
): AnthropicTool[] =>
  Object.entries(configTools)
    .filter(([name]) => typeof toolHandlers[name] === 'function')
    .map(([name, toolConfig]) => ({
      name,
      description: toolConfig.description ?? '',
      input_schema: toolConfig.parameters as Anthropic.Tool.InputSchema,
    }));

type MessageParam = Anthropic.MessageParam;

/**
 * Maps LaunchDarkly-canonical message content to Anthropic's native block shape.
 *
 * Anthropic accepts image URLs directly, but inline images retain separate
 * `media_type` and `data` fields rather than being converted to data URLs.
 */
const toAnthropicContent = (content: MessageContent): MessageParam['content'] => {
  if (!isContentBlocks(content)) return content;

  return content.map((block): Anthropic.ContentBlockParam => {
    if (block.type === 'text') {
      return { type: 'text', text: block.text };
    }
    if (block.source.type === 'url') {
      return { type: 'image', source: { type: 'url', url: block.source.url } };
    }
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: block.source.media_type as Anthropic.Base64ImageSource['media_type'],
        data: block.source.data,
      },
    };
  });
};

/** Normalizes Anthropic message content to a block list for merging. */
const toBlockList = (content: MessageParam['content']): Anthropic.ContentBlockParam[] => {
  if (typeof content !== 'string') return content;
  return content ? [{ type: 'text', text: content }] : [];
};

/**
 * Merges consecutive same-role turns into a single multi-block message.
 *
 * Anthropic's Messages API requires strictly alternating user/assistant roles.
 * Composed history can place an image-only user turn immediately before the
 * appended `userInput` question, which would otherwise send two consecutive user
 * turns and be rejected. Merging keeps both as one user message.
 */
const mergeAdjacentSameRole = (messages: MessageParam[]): MessageParam[] => {
  const merged: MessageParam[] = [];
  for (const message of messages) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === message.role) {
      prev.content = [...toBlockList(prev.content), ...toBlockList(message.content)];
    } else {
      merged.push({ role: message.role, content: message.content });
    }
  }
  return merged;
};

const buildMessages = (
  config: AiConfigRep,
  userInput: string,
  variables: Record<string, unknown>,
  history?: Message[],
  { includeOutputFormat = true }: { includeOutputFormat?: boolean } = {},
): { messages: MessageParam[]; system?: string } => {
  let system: string | undefined;
  const messages: MessageParam[] = [];
  const configMessages: ConfigTurn[] = [];

  if (config.messages && config.messages.length > 0) {
    const systemMessages = config.messages.filter((m) => m.role === 'system');
    const conversationMessages = config.messages.filter((m) => m.role !== 'system');

    if (systemMessages.length > 0) {
      system = parseTemplate(systemMessages.map((m) => m.content).join('\n'), variables);
    }

    for (const msg of conversationMessages) {
      const role = msg.role as 'user' | 'assistant';
      configMessages.push({ role, content: parseTemplate(msg.content, variables) });
    }
  } else if (config.instructions) {
    system = parseTemplate(config.instructions, variables);
  }

  if (history && history.length > 0) {
    const turns = composeHistory({ history, userInput, configMessages });
    messages.push(
      ...mergeAdjacentSameRole(turns.map((turn) => ({ role: turn.role, content: toAnthropicContent(turn.content) }))),
    );
  } else {
    messages.push(...configMessages);
    const lastMsg = messages[messages.length - 1];
    if (lastMsg?.role !== 'user') {
      messages.push({ role: 'user', content: userInput });
    }
  }

  if (includeOutputFormat && config.outputFormat) {
    const schemaInstruction = `Respond with valid JSON matching this schema:\n${JSON.stringify(config.outputFormat)}`;
    system = system ? `${system}\n\n${schemaInstruction}` : schemaInstruction;
  }

  return { messages, system };
};

const MAX_STEPS = 10;

export function createClaudeMessagesHandler({ captureContent = false }: ContentCaptureOptions = {}): ProviderHandler {
  const anthropic = new Anthropic();

  async function runToolLoop(
    config: AiConfigRep,
    messages: MessageParam[],
    system: string | undefined,
    toolHandlers: Record<string, ((...args: unknown[]) => unknown) | NativeTool>,
    parentContext: Context,
    runUsage: RawRunUsage,
  ) {
    const tools = config.tools ? buildTools(config.tools, toolHandlers) : [];
    const maxTokens = (config.model.parameters?.max_tokens as number | undefined) ?? 1024;
    const conversation: MessageParam[] = [...messages];
    // Owned by the caller, not by this loop, so a throw does not take the run's spend with it.
    const usage = runUsage.total;
    let output = '';
    let steps = 0;

    const toolDefinitions = toToolDefinitions(tools);

    while (true) {
      const modelSpan = startModelSpan(config, parentContext);
      // Written before the call, so an in-flight or failed turn still shows what it was asked.
      // `conversation` grows with each turn, which is what makes a `chat` span self-contained.
      if (captureContent) {
        setInputContentAttributes(modelSpan, captureContent, {
          systemInstructions: system,
          messages: toSpanMessages(conversation),
          toolDefinitions,
        });
      }
      let response: Anthropic.Message;
      try {
        response = await anthropic.messages.create({
          model: config.model.name,
          max_tokens: maxTokens,
          ...(system ? { system } : {}),
          messages: conversation,
          ...(tools.length > 0 ? { tools } : {}),
        });
      } catch (err) {
        failSpan(modelSpan, err);
        throw err;
      }
      const rawUsage = response.usage as unknown as Record<string, unknown>;
      // Mapped once, into a local, so the span attribute and the output message cannot disagree:
      // Anthropic's `end_turn` is semconv's `stop`, and this handler is not the only one whose
      // spans a consumer groups by that value.
      const finishReason = toSemconvFinishReason(response.stop_reason);
      if (captureContent) {
        setOutputContentAttributes(modelSpan, captureContent, [
          { role: 'assistant', parts: toSpanParts(response.content), finishReason },
        ]);
      }
      finishModelSpan(modelSpan, config, rawUsage, finishReason);
      runUsage.addTurn(rawUsage);

      if (response.stop_reason !== 'tool_use') {
        output = response.content
          .filter((block): block is Anthropic.TextBlock => block.type === 'text')
          .map((block) => block.text)
          .join('');
        break;
      }

      if (steps++ >= MAX_STEPS) {
        throw new Error(`Tool loop exceeded the maximum number of steps (${MAX_STEPS})`);
      }

      conversation.push({ role: 'assistant', content: response.content });
      const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
        response.content
          .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
          .map(async (toolUse) => {
            const toolSpan = startToolSpan(toolUse.name, toolUse.id, parentContext);
            setToolCallContentAttributes(toolSpan, captureContent, { arguments: toolUse.input });
            try {
              const handlerFn = toolHandlers[toolUse.name];
              if (!handlerFn || typeof handlerFn !== 'function') {
                throw new Error(`No handler registered for tool "${toolUse.name}"`);
              }
              const result = await handlerFn(toolUse.input);
              setToolCallContentAttributes(toolSpan, captureContent, { result });
              toolSpan.setStatus({ code: SpanStatusCode.OK });
              toolSpan.end();
              return { type: 'tool_result' as const, tool_use_id: toolUse.id, content: String(result) };
            } catch (err) {
              failSpan(toolSpan, err);
              throw err;
            }
          }),
      );
      conversation.push({ role: 'user', content: toolResults });
    }
    return { output, usage };
  }

  return createHandler(
    ['Anthropic', 'messages'],
    async (
      config: AiConfigRep,
      userInput = '',
      toolHandlers: Record<string, ((...args: unknown[]) => unknown) | NativeTool> = {},
      variables: Record<string, unknown> = {},
      history?: Message[],
    ) => {
      return trace.getTracer(TRACER_NAME).startActiveSpan('invoke_agent', async (span) => {
        span.setAttribute('gen_ai.operation.name', 'invoke_agent');
        setModelIdentityAttributes(span, 'anthropic', config.model.name);
        setLdSpanAttributes(span, variables);
        // Explicit rather than a bare `context.active()`: the active context only carries this
        // span while an OTel ContextManager is registered, so a host app that installs its own
        // TracerProvider without one would otherwise get a flat trace.
        const parentContext = trace.setSpan(context.active(), span);

        const { messages, system } = buildMessages(config, userInput, variables, history);
        setInputContentAttributes(span, captureContent, {
          systemInstructions: system,
          messages: toSpanMessages(messages),
        });

        const runUsage = createRawRunUsage();
        try {
          const { output, usage } = await runToolLoop(config, messages, system, toolHandlers, parentContext, runUsage);
          setOutputContentAttributes(span, captureContent, [
            { role: 'assistant', parts: [{ type: 'text', content: output }] },
          ]);
          finishRootSpan(span, config, usage);
          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
          // Raw usage, cache fields intact — see the note in runToolLoop.
          return { output, usage };
        } catch (err) {
          // The turns that completed were billed, and the root is the only span a config-scoped
          // cost query can find them on.
          if (runUsage.reported) finishRootSpan(span, config, runUsage.total);
          failSpan(span, err);
          throw err;
        }
      });
    },
    async function* streamHandler(
      config: AiConfigRep,
      userInput = '',
      toolHandlers: Record<string, ((...args: unknown[]) => unknown) | NativeTool> = {},
      variables: Record<string, unknown> = {},
      history?: Message[],
    ) {
      const span = trace.getTracer(TRACER_NAME).startSpan('invoke_agent');
      span.setAttribute('gen_ai.operation.name', 'invoke_agent');
      setModelIdentityAttributes(span, 'anthropic', config.model.name);
      setLdSpanAttributes(span, variables);
      const parentContext = trace.setSpan(context.active(), span);

      // A consumer that `break`s out of `for await`, or throws inside the loop body, makes this
      // generator run `finally` without ever entering `catch`. Without the cleanup there the root
      // span is never ended, so it is never exported, and the whole run disappears from AI Config
      // Monitoring along with the `feature_flag` event it carries. `endedSpans` stops the success,
      // failure and abandonment paths from ending the same span twice.
      const endedSpans = new Set<Span>();
      let openModelSpan: Span | undefined;
      // Outside the `try`, so the failure and abandonment paths can still report the spend.
      const runUsage = createRawRunUsage();

      const { messages, system } = buildMessages(config, userInput, variables, history, { includeOutputFormat: false });
      setInputContentAttributes(span, captureContent, {
        systemInstructions: system,
        messages: toSpanMessages(messages),
      });

      try {
        const tools = config.tools ? buildTools(config.tools, toolHandlers) : [];
        const maxTokens = (config.model.parameters?.max_tokens as number | undefined) ?? 1024;
        const conversation: MessageParam[] = [...messages];
        // Accumulated per category and yielded unfolded — see the note on RawRunUsage.
        const usage = runUsage.total;
        let fullOutput = '';
        let steps = 0;

        const toolDefinitions = toToolDefinitions(tools);

        while (true) {
          const modelSpan = startModelSpan(config, parentContext);
          if (captureContent) {
            setInputContentAttributes(modelSpan, captureContent, {
              systemInstructions: system,
              messages: toSpanMessages(conversation),
              toolDefinitions,
            });
          }
          openModelSpan = modelSpan;
          let finalMsg: Anthropic.Message;
          try {
            const stream = anthropic.messages.stream({
              model: config.model.name,
              max_tokens: maxTokens,
              ...(system ? { system } : {}),
              messages: conversation,
              ...(tools.length > 0 ? { tools } : {}),
            });

            // Yield text deltas for this turn
            for await (const event of stream) {
              if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
                yield { type: 'chunk' as const, text: event.delta.text };
                fullOutput += event.delta.text;
              }
            }

            finalMsg = await stream.finalMessage();
          } catch (err) {
            // The tracker matters here: the outer `catch` also fails `openModelSpan`, which still
            // points at this span because the line that clears it is unreachable on this path.
            failSpan(modelSpan, err, endedSpans);
            throw err;
          }
          const rawUsage = finalMsg.usage as unknown as Record<string, unknown>;
          // Mapped once, for the same reason as the blocking path above.
          const finishReason = toSemconvFinishReason(finalMsg.stop_reason);
          if (captureContent) {
            setOutputContentAttributes(modelSpan, captureContent, [
              { role: 'assistant', parts: toSpanParts(finalMsg.content), finishReason },
            ]);
          }
          finishModelSpan(modelSpan, config, rawUsage, finishReason);
          openModelSpan = undefined;
          runUsage.addTurn(rawUsage);

          if (finalMsg.stop_reason !== 'tool_use') break;

          if (steps++ >= MAX_STEPS) {
            throw new Error(`Tool loop exceeded the maximum number of steps (${MAX_STEPS})`);
          }

          conversation.push({ role: 'assistant', content: finalMsg.content });
          const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
            finalMsg.content
              .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
              .map(async (toolUse) => {
                const toolSpan = startToolSpan(toolUse.name, toolUse.id, parentContext);
                setToolCallContentAttributes(toolSpan, captureContent, { arguments: toolUse.input });
                try {
                  const handlerFn = toolHandlers[toolUse.name];
                  if (!handlerFn || typeof handlerFn !== 'function') {
                    throw new Error(`No handler registered for tool "${toolUse.name}"`);
                  }
                  const result = await handlerFn(toolUse.input);
                  setToolCallContentAttributes(toolSpan, captureContent, { result });
                  toolSpan.setStatus({ code: SpanStatusCode.OK });
                  toolSpan.end();
                  return { type: 'tool_result' as const, tool_use_id: toolUse.id, content: String(result) };
                } catch (err) {
                  failSpan(toolSpan, err);
                  throw err;
                }
              }),
          );
          conversation.push({ role: 'user', content: toolResults });
        }

        setOutputContentAttributes(span, captureContent, [
          { role: 'assistant', parts: [{ type: 'text', content: fullOutput }] },
        ]);
        finishRootSpan(span, config, usage);
        span.setStatus({ code: SpanStatusCode.OK });
        endSpanOnce(span, endedSpans);

        yield {
          type: 'done' as const,
          output: fullOutput,
          usage,
        };
      } catch (err) {
        if (openModelSpan) failSpan(openModelSpan, err, endedSpans);
        if (runUsage.reported) finishRootSpan(span, config, runUsage.total);
        failSpan(span, err, endedSpans);
        throw err;
      } finally {
        // A no-op on the success and failure paths; on abandonment it is the only chance to
        // close the tree — and to report what the completed turns already cost.
        if (openModelSpan) endSpanOnce(openModelSpan, endedSpans, true);
        if (!endedSpans.has(span) && runUsage.reported) finishRootSpan(span, config, runUsage.total);
        endSpanOnce(span, endedSpans, true);
      }
    },
  );
}

export const claudeMessages = (
  configKey: string,
  userInput: string,
  context: LDContext,
  // Both `captureContent` and `variables` are lifted out of `options`: the first configures the
  // handler, the second belongs to the invocation. Passing either through to `config()` drops it —
  // which is how a `{{user_input}}` placeholder used to reach the model unsubstituted whenever a
  // caller used one of these wrappers instead of `config().invoke()`.
  {
    captureContent,
    variables,
    ...options
  }: Omit<Parameters<typeof config>[0], 'handler' | 'key'> &
    ContentCaptureOptions & {
      /** Template variables for the config's prompt. Forwarded to `invoke`, not to `config`. */
      variables?: Record<string, unknown>;
    } = {},
) =>
  config({ ...options, key: configKey, handler: createClaudeMessagesHandler({ captureContent }) }).invoke(
    userInput,
    context,
    variables,
  );
