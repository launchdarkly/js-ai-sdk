import { buildJudgeTasks, runJudges } from './judges.js';
import { extractVariation } from './lifecycle.js';
import { resolveHandlers, resolveTools } from './registry.js';
import { type ExecuteStreamDoneEvent, executeAndStream, executeAndTrack } from './tracking.js';
import type {
  AiConfigRep,
  ConfigArgs,
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

export const config = ({ key, handler, toolHandlers, registry, skipJudges = false }: ConfigArgs) => {
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

    const parsedResponse = resolveOutputFormatResponse(rawResponse, aiConfig.outputFormat);

    const llmResponseStr = typeof parsedResponse === 'string' ? parsedResponse : JSON.stringify(parsedResponse);

    if (skipJudges) {
      const judgeTasks = await buildJudgeTasks({
        config: aiConfig,
        userContext: context,
        handler: resolvedHandler,
        handlers: resolvedHandlerArray,
        llmResponse: llmResponseStr,
        baseTrackData,
      });
      return {
        response: parsedResponse as T,
        usage: llmUsage,
        trackData: baseTrackData,
        judgeTasks,
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
    });

    return {
      response: parsedResponse as T,
      usage: llmUsage,
      judgeResults,
      trackData: baseTrackData,
    };
  }

  async function* stream(
    userInput: string | undefined,
    context: LDContext,
    variables?: Record<string, unknown>,
    history?: Message[],
  ): AsyncGenerator<StreamEvent> {
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
          });
      yield {
        type: 'done',
        response: doneEvent.response,
        usage: doneEvent.usage,
        judgeResults: Object.keys(judgeResults).length > 0 ? judgeResults : undefined,
      };
    }
  }

  return { invoke, stream };
};
