import { withJudgeEvaluation } from './conversation.js';
import { extractVariation, getClient } from './lifecycle.js';
import { executeAndTrack } from './tracking.js';
import type {
  AiConfigRep,
  JudgeRunResult,
  JudgeTask,
  LDContext,
  NativeTool,
  ProviderHandler,
  ProviderResponse,
  ToolHandlerFn,
  TrackData,
} from './types.js';
import { collapseMessagesToInstructions, normalizeMode, parseJSONWithPossibleFences } from './utils.js';

export const FORMATTING_INSTRUCTIONS = [
  'Your response MUST be in valid JSON format with the following structure:',
  '{ "score": <number, 0-1>, "reasoning": <string> }',
  'The output must be valid, parseable JSON. Do not include additional tags, comments, formatting, or newlines.',
  'It should be returned in a format that is immediately parseable by a JSON parsing function. Do not include ```json tags.',
].join('\n');

/**
 * Runs any judges configured on `config.judgeConfiguration` against the produced
 * output. Each judge is itself a tracked AI call. When `graphKey` is supplied,
 * judge node events and the evaluation-metric event are attributed to the graph.
 * Shared by `config().invoke()` and per-node graph execution.
 */
/**
 * A judge is prompted for a number but can return anything. Only a finite number goes on the span:
 * semconv defines `gen_ai.evaluation.score.value` as a double, and OTel drops a null attribute with
 * a diagnostic while happily exporting a string, which breaks numeric aggregation downstream.
 */
export const isFiniteScore = (score: unknown): score is number => typeof score === 'number' && Number.isFinite(score);

export const runJudges = async ({
  config,
  userContext,
  handler,
  handlers,
  userInput,
  llmResponse,
  baseTrackData,
  toolHandlers: _toolHandlers,
  graphKey,
}: {
  config: AiConfigRep;
  userContext: LDContext;
  handler: ProviderHandler;
  /** When supplied, re-selects the handler for each judge based on its own provider. */
  handlers?: ProviderHandler[];
  userInput?: string;
  llmResponse: string;
  baseTrackData: TrackData;
  toolHandlers?: Record<string, ToolHandlerFn | NativeTool>;
  graphKey?: string;
}): Promise<NonNullable<ProviderResponse['judgeResults']>> => {
  const judgeResults: NonNullable<ProviderResponse['judgeResults']> = {};

  const judges = config.judgeConfiguration?.judges ?? [];
  const hasActiveJudge = judges.some((j: { samplingRate: number }) => j.samplingRate > 0);
  if (judges.length === 0 || !hasActiveJudge) {
    return judgeResults;
  }

  for (const judge of judges) {
    if (Math.random() >= judge.samplingRate) continue;

    const { config: judgeConfig, meta: judgeMeta } = await extractVariation(judge.key, userContext);

    const judgeProvider = judgeConfig.provider?.name;
    const judgeMode = normalizeMode(judgeMeta.mode);

    // Pick the handler matching the judge's own provider/mode. Priority:
    //   1. Exact provider + mode match
    //   2. Wildcard provider (`*`) + same mode (e.g. LangChain agents handler)
    //   3. Same provider, any mode (agent handler for the same provider)
    //   4. Wildcard provider, any mode — agent-handler fallback for any provider
    //   5. Parent node's handler, if it covers the same provider (or is a wildcard)
    //   6. Skip — crossing providers would send the wrong model to an incompatible API.
    // When falling back to an agent-mode handler for a messages-mode judge config
    // (cases 2–5), messages are collapsed into a single instructions string so the
    // agent handler receives a well-formed prompt without a separate messages client.
    let judgeHandler: ProviderHandler;
    let collapseMessages = false;
    if (handlers) {
      const matchesProvider = (h: ProviderHandler) =>
        h.providesFor?.[0] === judgeProvider || h.providesFor?.[0] === '*';

      const exactMatch = handlers.find((h) => matchesProvider(h) && h.providesFor?.[1] === judgeMode);
      const agentFallback =
        judgeMode === 'messages'
          ? handlers.find((h) => matchesProvider(h) && h.providesFor?.[1] === 'agent')
          : undefined;

      if (exactMatch) {
        judgeHandler = exactMatch;
      } else if (agentFallback) {
        judgeHandler = agentFallback;
        collapseMessages = true;
      } else if (handler.providesFor?.[0] === judgeProvider || handler.providesFor?.[0] === '*') {
        judgeHandler = handler;
        collapseMessages = judgeMode === 'messages' && handler.providesFor?.[1] === 'agent';
      } else {
        // No compatible handler found — skip this judge rather than calling the
        // wrong provider's API with an incompatible model name.
        continue;
      }
    } else {
      judgeHandler = handler;
    }

    const effectiveJudgeConfig = collapseMessages ? collapseMessagesToInstructions(judgeConfig) : judgeConfig;

    const messageHistory = [userInput, llmResponse, FORMATTING_INSTRUCTIONS].filter(Boolean).join('\n\n');

    // `executeAndTrack` stays outside the `try`, as it was before judge evaluations existed: a
    // provider/auth/network failure must reject out of `runJudges` rather than be swallowed and
    // logged as a parse failure. Only parsing and recording are caught.
    await withJudgeEvaluation(judge.key, async (recordEvaluation) => {
      const { usage, response: rawJudgeResponse } = await executeAndTrack({
        configKey: judge.key,
        config: effectiveJudgeConfig,
        meta: judgeMeta,
        userContext,
        handler: judgeHandler,
        userInput: llmResponse,
        toolHandlers: undefined,
        graphKey,
        variables: {
          message_history: messageHistory,
          response_to_evaluate: llmResponse,
        },
      });
      const judgeResponse = typeof rawJudgeResponse === 'string' ? rawJudgeResponse : JSON.stringify(rawJudgeResponse);

      try {
        const parsed = parseJSONWithPossibleFences<{ score: number; reasoning: string }>(judgeResponse);
        if (!parsed) {
          throw new Error('Invalid JSON');
        }

        const { score, reasoning } = parsed;
        judgeResults[judge.key] = { usage, response: reasoning, score };
        if (isFiniteScore(score)) recordEvaluation(score);

        if (judgeConfig.evaluationMetricKey && score !== undefined) {
          getClient().track(
            judgeConfig.evaluationMetricKey,
            userContext,
            { ...baseTrackData, judgeConfigKey: judge.key },
            score,
          );
        }
      } catch (err) {
        // biome-ignore lint/suspicious/noConsole: intentional error logging for judge parse failures
        console.error(`Judge '${judge.key}' failed:`, err);
      }
    });
  }

  return judgeResults;
};

/**
 * Resolves all judges configured on `config.judgeConfiguration` into
 * serialisable {@link JudgeTask} objects without executing any AI calls.
 *
 * Mirrors the iteration and handler-selection logic of {@link runJudges} but
 * returns tasks instead of running them. Use the returned array as `workerData`
 * for a `worker_threads.Worker` that calls `runJudge(task, handlers)`.
 *
 * - Sampling is applied here (same as `runJudges`): judges whose `samplingRate`
 *   causes them to be skipped are excluded from the array.
 * - Returns an empty array when no active judges are configured.
 */
export const buildJudgeTasks = async ({
  config,
  userContext,
  handler,
  handlers,
  llmResponse,
  baseTrackData,
}: {
  config: AiConfigRep;
  userContext: LDContext;
  handler: ProviderHandler;
  handlers?: ProviderHandler[];
  llmResponse: string;
  baseTrackData: TrackData;
}): Promise<JudgeTask[]> => {
  const judges = config.judgeConfiguration?.judges ?? [];
  const hasActiveJudge = judges.some((j: { samplingRate: number }) => j.samplingRate > 0);
  if (judges.length === 0 || !hasActiveJudge) return [];

  const tasks: JudgeTask[] = [];

  for (const judge of judges) {
    if (Math.random() >= judge.samplingRate) continue;

    const { config: judgeConfig, meta: judgeMeta } = await extractVariation(judge.key, userContext);

    const judgeProvider = judgeConfig.provider?.name;
    const judgeMode = normalizeMode(judgeMeta.mode);

    let collapseMessages = false;
    if (handlers) {
      const matchesProvider = (h: ProviderHandler) =>
        h.providesFor?.[0] === judgeProvider || h.providesFor?.[0] === '*';

      const exactMatch = handlers.find((h) => matchesProvider(h) && h.providesFor?.[1] === judgeMode);
      const agentFallback =
        judgeMode === 'messages'
          ? handlers.find((h) => matchesProvider(h) && h.providesFor?.[1] === 'agent')
          : undefined;

      if (exactMatch) {
        collapseMessages = false;
      } else if (agentFallback) {
        collapseMessages = true;
      } else if (handler.providesFor?.[0] === judgeProvider || handler.providesFor?.[0] === '*') {
        collapseMessages = judgeMode === 'messages' && handler.providesFor?.[1] === 'agent';
      } else {
        // No compatible handler — skip, same as runJudges.
        continue;
      }
    }

    tasks.push({
      configKey: judge.key,
      judgeConfig,
      judgeMeta,
      actualOutput: llmResponse,
      userContext,
      judgeProvider,
      judgeMode,
      collapseMessages,
      evaluationMetricKey: judgeConfig.evaluationMetricKey,
      parentTrackData: baseTrackData,
    });
  }

  return tasks;
};

/**
 * Executes a judge evaluation from a pre-resolved {@link JudgeTask}.
 *
 * Designed to run in a worker thread or background process: it requires no
 * LaunchDarkly client (no variation fetch, no `track()` call) and no global
 * registry — only the explicit `handlers` array the caller provides.
 *
 * The returned {@link JudgeRunResult} includes `trackData` with `judgeConfigKey`
 * already merged in, ready to hand to `getClient().track()` on the main thread.
 *
 * Returns `null` when no compatible handler is found or the response cannot be
 * parsed as `{ score, reasoning }`.
 */
export const runJudge = async (task: JudgeTask, handlers: ProviderHandler[]): Promise<JudgeRunResult | null> => {
  const {
    judgeConfig,
    judgeMeta,
    actualOutput,
    userContext,
    variables,
    judgeProvider,
    judgeMode,
    collapseMessages,
    parentTrackData,
    configKey,
  } = task;

  const matchesProvider = (h: ProviderHandler) => h.providesFor?.[0] === judgeProvider || h.providesFor?.[0] === '*';

  const exactMatch = handlers.find((h) => matchesProvider(h) && h.providesFor?.[1] === judgeMode);
  const agentFallback =
    judgeMode === 'messages' && !exactMatch
      ? handlers.find((h) => matchesProvider(h) && h.providesFor?.[1] === 'agent')
      : undefined;

  const judgeHandler = exactMatch ?? agentFallback;
  if (!judgeHandler) return null;

  const effectiveConfig = collapseMessages ? collapseMessagesToInstructions(judgeConfig) : judgeConfig;

  const messageHistory = [actualOutput, FORMATTING_INSTRUCTIONS].join('\n\n');

  return withJudgeEvaluation(configKey, async (recordEvaluation) => {
    const {
      usage,
      response: rawResponse,
      trackData,
    } = await executeAndTrack({
      configKey,
      config: effectiveConfig,
      meta: judgeMeta,
      userContext,
      handler: judgeHandler,
      userInput: actualOutput,
      toolHandlers: undefined,
      variables: {
        ...variables,
        message_history: messageHistory,
        response_to_evaluate: actualOutput,
      },
    });

    const judgeResponse = typeof rawResponse === 'string' ? rawResponse : JSON.stringify(rawResponse);
    const parsed = parseJSONWithPossibleFences<{ score: number; reasoning: string }>(judgeResponse);
    if (!parsed) return null;

    const { score, reasoning } = parsed;
    if (isFiniteScore(score)) recordEvaluation(score);

    return {
      score,
      response: reasoning,
      usage,
      trackData: { ...parentTrackData, ...trackData, judgeConfigKey: configKey },
    };
  });
};
