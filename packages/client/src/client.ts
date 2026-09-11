import { bindConversationId } from './conversation.js';
import { buildJudgeTasks, resolveJudgeContext, runJudges } from './judges.js';
import { extractVariation } from './lifecycle.js';
import { resolveHandlers, resolveTools } from './registry.js';
import { type ExecuteStreamDoneEvent, executeAndStream, executeAndTrack } from './tracking.js';
import type {
  AiConfigRep,
  ConfigArgs,
  JsonValue,
  LDContext,
  Message,
  ProviderHandler,
  ProviderResponse,
  StreamEvent,
  VariationMeta,
} from './types.js';
import { normalizeMode, parseJSONWithPossibleFences } from './utils.js';

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
 * Selects a handler from `resolvedHandlers` based on the variation's provider
 * and mode. Throws if no match is found.
 */
function selectHandler(
  config: AiConfigRep,
  meta: VariationMeta,
  resolvedHandlers: ProviderHandler[] | undefined,
): ProviderHandler {
  const provider = config.provider?.name;
  const mode = meta.mode;

  if (!provider) throw new Error('Provider not found');
  const normalizedMode = normalizeMode(mode);

  const exact = resolvedHandlers?.find((h) => h.providesFor?.[0] === provider && h.providesFor?.[1] === normalizedMode);
  if (exact) return exact;

  const wildcard = resolvedHandlers?.find((h) => h.providesFor?.[0] === '*' && h.providesFor?.[1] === normalizedMode);
  if (wildcard) return wildcard;

  if (!resolvedHandlers?.some((h) => h.providesFor?.[0] === provider || h.providesFor?.[0] === '*')) {
    throw new Error(`Handler for provider ${provider} not found`);
  }
  throw new Error(`Handler for provider ${provider} with mode ${normalizedMode} not found`);
}

export const config = <JudgeContext extends JsonValue = JsonValue>({
  key,
  handler,
  toolHandlers,
  registry,
  skipJudges = false,
  judgeContext: judgeContextCallback,
  judgeTimeoutMs,
}: ConfigArgs<JudgeContext>) => {
  const normalizeHandlers = (): ProviderHandler[] | undefined => {
    if (handler === undefined) return undefined;
    return Array.isArray(handler) ? handler : [handler];
  };

  async function invoke<T = string>(
    userInput: string | undefined,
    context: LDContext,
    variables?: Record<string, unknown>,
    history?: Message[],
  ): Promise<ProviderResponse<T, JudgeContext>> {
    const resolvedHandlerArray = resolveHandlers(registry, normalizeHandlers());
    const resolvedTools = resolveTools(registry, toolHandlers);

    const { config: aiConfig, meta } = await extractVariation(key, context);
    const resolvedHandler = selectHandler(aiConfig, meta, resolvedHandlerArray);

    const {
      response: rawResponse,
      usage: llmUsage,
      trackData: baseTrackData,
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
    });

    // Freeze the caller's judge context immediately after the primary handler succeeds, and
    // before output-format parsing. Every request with a configured callback resolves it exactly
    // once here — sampling controls which judges run, never this boundary.
    const contextResolution = await resolveJudgeContext(judgeContextCallback);
    const contextDiagnostics = contextResolution.diagnostic ? [contextResolution.diagnostic] : [];

    const parsedResponse = resolveOutputFormatResponse(rawResponse, aiConfig.outputFormat);

    const llmResponseStr = typeof parsedResponse === 'string' ? parsedResponse : JSON.stringify(parsedResponse);

    if (skipJudges) {
      const { judgeTasks, judgeDiagnostics: buildDiagnostics } = contextResolution.failed
        ? { judgeTasks: [], judgeDiagnostics: [] }
        : await buildJudgeTasks({
            config: aiConfig,
            userContext: context,
            handler: resolvedHandler,
            handlers: resolvedHandlerArray,
            llmResponse: llmResponseStr,
            baseTrackData,
            judgeContext: contextResolution.judgeContext,
          });
      const diagnostics = [...contextDiagnostics, ...buildDiagnostics];
      return {
        response: parsedResponse as T,
        usage: llmUsage,
        trackData: baseTrackData,
        judgeTasks,
        ...(contextResolution.judgeContext !== undefined ? { judgeContext: contextResolution.judgeContext } : {}),
        ...(diagnostics.length > 0 ? { judgeDiagnostics: diagnostics } : {}),
      };
    }

    const judgeRun = contextResolution.failed
      ? { judgeResults: {}, judgeDiagnostics: [] }
      : await runJudges({
          config: aiConfig,
          userContext: context,
          handler: resolvedHandler,
          handlers: resolvedHandlerArray,
          userInput,
          llmResponse: llmResponseStr,
          baseTrackData,
          toolHandlers: resolvedTools,
          judgeContext: contextResolution.judgeContext,
          judgeContextJson: contextResolution.serialized,
          judgeTimeoutMs,
        });
    const diagnostics = [...contextDiagnostics, ...judgeRun.judgeDiagnostics];

    return {
      response: parsedResponse as T,
      usage: llmUsage,
      ...(contextResolution.judgeContext !== undefined ? { judgeContext: contextResolution.judgeContext } : {}),
      judgeResults: judgeRun.judgeResults,
      trackData: baseTrackData,
      ...(diagnostics.length > 0 ? { judgeDiagnostics: diagnostics } : {}),
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
  ): AsyncGenerator<StreamEvent<JudgeContext>> {
    return bindConversationId(streamEvents(userInput, context, variables, history));
  }

  async function* streamEvents(
    userInput: string | undefined,
    context: LDContext,
    variables?: Record<string, unknown>,
    history?: Message[],
  ): AsyncGenerator<StreamEvent<JudgeContext>> {
    const resolvedHandlerArray = resolveHandlers(registry, normalizeHandlers());
    const resolvedTools = resolveTools(registry, toolHandlers);

    const { config: aiConfig, meta } = await extractVariation(key, context);
    const resolvedHandler = selectHandler(aiConfig, meta, resolvedHandlerArray);

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
    })) {
      if (event.type === 'chunk') {
        yield event;
      } else {
        doneEvent = event;
      }
    }

    // Reached only when the caller kept iterating through the last chunk: an async generator's
    // `.return()` between chunks converts this resumption into an early return instead, so a
    // stream abandoned before the primary finishes never resolves context or runs judges.
    if (doneEvent) {
      const contextResolution = await resolveJudgeContext(judgeContextCallback);
      const contextDiagnostics = contextResolution.diagnostic ? [contextResolution.diagnostic] : [];

      const judgeRun =
        skipJudges || contextResolution.failed
          ? { judgeResults: {}, judgeDiagnostics: [] }
          : await runJudges({
              config: aiConfig,
              userContext: context,
              handler: resolvedHandler,
              handlers: resolvedHandlerArray,
              userInput,
              llmResponse: doneEvent.response,
              baseTrackData: doneEvent.trackData,
              toolHandlers: resolvedTools,
              judgeContext: contextResolution.judgeContext,
              judgeContextJson: contextResolution.serialized,
              judgeTimeoutMs,
            });
      const diagnostics = [...contextDiagnostics, ...judgeRun.judgeDiagnostics];

      yield {
        type: 'done',
        response: doneEvent.response,
        usage: doneEvent.usage,
        ...(contextResolution.judgeContext !== undefined ? { judgeContext: contextResolution.judgeContext } : {}),
        judgeResults: Object.keys(judgeRun.judgeResults).length > 0 ? judgeRun.judgeResults : undefined,
        ...(diagnostics.length > 0 ? { judgeDiagnostics: diagnostics } : {}),
      };
    }
  }

  return { invoke, stream };
};
