import { bindConversationId } from './conversation.js';
import { buildJudgeTasksInternal, runJudges } from './judges.js';
import { extractVariation } from './lifecycle.js';
import { resolveHandlers, resolveTools, selectHandler } from './registry.js';
import { reportUsage } from './sdk-usage.js';
import { buildShadowTasks, DEFAULT_SHADOW_TIMEOUT_MS, startShadows, validateShadowTimeout } from './shadows.js';
import { type ExecuteStreamDoneEvent, executeAndStream, executeAndTrack } from './tracking.js';
import type {
  AiConfigRep,
  ConfigArgs,
  LDContext,
  Message,
  ProviderHandler,
  ProviderResponse,
  StreamEvent,
} from './types.js';
import { parseJSONWithPossibleFences } from './utils.js';

function resolveOutputFormatResponse(rawResponse: unknown, outputFormat: Record<string, unknown> | undefined): unknown {
  if (!outputFormat) return rawResponse ?? '';
  if (typeof rawResponse !== 'string') return rawResponse;
  const parsed = parseJSONWithPossibleFences(rawResponse);
  // Best-effort: if the model returns unparseable output (e.g. an agent's mid-loop text),
  // return the raw string rather than throwing. Callers cannot guarantee structured output
  // on every turn.
  return parsed ?? rawResponse;
}

export type { AiConfigRep };

/**
 * {@link config} without the `$ld:ai:sdk:usage` report: the returned `invoke`
 * and `stream` do not report. Package wrappers call this so a wrapper call
 * reports only the wrapper's own helper.
 *
 * @internal Exported for the LaunchDarkly handler packages; applications should
 * call {@link config}.
 */
export const configInternal = ({
  key,
  handler,
  toolHandlers,
  registry,
  skipJudges = false,
  skipShadows = false,
  shadowTimeoutMs = DEFAULT_SHADOW_TIMEOUT_MS,
}: ConfigArgs) => {
  validateShadowTimeout(shadowTimeoutMs);

  const normalizeHandlers = (): ProviderHandler[] | undefined => {
    if (handler === undefined) return undefined;
    return Array.isArray(handler) ? handler : [handler];
  };

  async function invoke<T = string>(
    userInput: string | undefined,
    context: LDContext,
    variables?: Record<string, unknown>,
    history?: Message[],
  ): Promise<ProviderResponse<T>> {
    const resolvedHandlerArray = resolveHandlers(registry, normalizeHandlers());
    const resolvedTools = resolveTools(registry, toolHandlers);

    const { config: aiConfig, meta, raw, reason } = await extractVariation(key, context, { withReason: true });
    const resolvedHandler = selectHandler(aiConfig, meta, resolvedHandlerArray);
    const runId = crypto.randomUUID();
    const shadowTasks = buildShadowTasks({
      configKey: key,
      rawVariation: raw,
      reason,
      primaryVariationKey: meta.variationKey ?? '',
      context,
      userInput,
      history,
      variables,
      handlers: resolvedHandlerArray,
      runId,
      timeoutMs: shadowTimeoutMs,
    });
    if (!skipShadows) startShadows(shadowTasks, resolvedHandlerArray ?? []);

    const {
      response: rawResponse,
      usage: llmUsage,
      trackData: baseTrackData,
      trajectory,
    } = await executeAndTrack({
      configKey: key,
      config: aiConfig,
      meta,
      userContext: context,
      handler: resolvedHandler,
      userInput,
      toolHandlers: resolvedTools,
      variables,
      history,
      runId,
    });

    const parsedResponse = resolveOutputFormatResponse(rawResponse, aiConfig.outputFormat);

    const llmResponseStr = typeof parsedResponse === 'string' ? parsedResponse : JSON.stringify(parsedResponse);

    if (skipJudges) {
      const judgeTasks = await buildJudgeTasksInternal({
        config: aiConfig,
        userContext: context,
        handler: resolvedHandler,
        handlers: resolvedHandlerArray,
        llmResponse: llmResponseStr,
        baseTrackData,
        userInput,
        trajectory,
      });
      return {
        response: parsedResponse as T,
        usage: llmUsage,
        trackData: baseTrackData,
        judgeTasks,
        ...(skipShadows ? { shadowTasks } : {}),
      };
    }

    const judgeResults = await runJudges({
      config: aiConfig,
      userContext: context,
      handler: resolvedHandler,
      handlers: resolvedHandlerArray,
      userInput,
      llmResponse: llmResponseStr,
      baseTrackData,
      toolHandlers: resolvedTools,
      trajectory,
    });

    return {
      response: parsedResponse as T,
      usage: llmUsage,
      judgeResults,
      trackData: baseTrackData,
      ...(skipShadows ? { shadowTasks } : {}),
    };
  }

  /**
   * Not an `async function*`: the body of a generator does not run until the first `next()`, by
   * which point a `withConversationId` scope wrapped around this call has already exited. Binding
   * here — at call time — is what lets a caller hand the generator off and iterate it later.
   */
  function stream(
    userInput: string | undefined,
    context: LDContext,
    variables?: Record<string, unknown>,
    history?: Message[],
  ): AsyncGenerator<StreamEvent> {
    return bindConversationId(streamEvents(userInput, context, variables, history));
  }

  async function* streamEvents(
    userInput: string | undefined,
    context: LDContext,
    variables?: Record<string, unknown>,
    history?: Message[],
  ): AsyncGenerator<StreamEvent> {
    const resolvedHandlerArray = resolveHandlers(registry, normalizeHandlers());
    const resolvedTools = resolveTools(registry, toolHandlers);

    const { config: aiConfig, meta, raw, reason } = await extractVariation(key, context, { withReason: true });
    const resolvedHandler = selectHandler(aiConfig, meta, resolvedHandlerArray);
    const runId = crypto.randomUUID();
    const shadowTasks = buildShadowTasks({
      configKey: key,
      rawVariation: raw,
      reason,
      primaryVariationKey: meta.variationKey ?? '',
      context,
      userInput,
      history,
      variables,
      handlers: resolvedHandlerArray,
      runId,
      timeoutMs: shadowTimeoutMs,
    });
    if (!skipShadows) startShadows(shadowTasks, resolvedHandlerArray ?? []);

    let doneEvent: ExecuteStreamDoneEvent | undefined;

    for await (const event of executeAndStream({
      configKey: key,
      config: aiConfig,
      meta,
      userContext: context,
      handler: resolvedHandler,
      userInput,
      toolHandlers: resolvedTools,
      variables,
      history,
      runId,
    })) {
      if (event.type === 'chunk') {
        yield event;
      } else {
        doneEvent = event;
      }
    }

    if (doneEvent) {
      const judgeResults = skipJudges
        ? {}
        : await runJudges({
            config: aiConfig,
            userContext: context,
            handler: resolvedHandler,
            handlers: resolvedHandlerArray,
            userInput,
            llmResponse: doneEvent.response,
            baseTrackData: doneEvent.trackData,
            toolHandlers: resolvedTools,
            trajectory: doneEvent.trajectory,
          });
      yield {
        type: 'done',
        response: doneEvent.response,
        usage: doneEvent.usage,
        judgeResults: Object.keys(judgeResults).length > 0 ? judgeResults : undefined,
        ...(skipShadows ? { shadowTasks } : {}),
      };
    }
  }

  return { invoke, stream };
};

export const config = (args: ConfigArgs) => {
  const inner = configInternal(args);

  async function invoke<T = string>(
    userInput: string | undefined,
    context: LDContext,
    variables?: Record<string, unknown>,
    history?: Message[],
  ): Promise<ProviderResponse<T>> {
    reportUsage('client.config.invoke');
    return inner.invoke<T>(userInput, context, variables, history);
  }

  /** Reports at call time, before any iteration; the internal stream binds the conversation id. */
  function stream(
    userInput: string | undefined,
    context: LDContext,
    variables?: Record<string, unknown>,
    history?: Message[],
  ): AsyncGenerator<StreamEvent> {
    reportUsage('client.config.stream');
    return inner.stream(userInput, context, variables, history);
  }

  return { invoke, stream };
};
