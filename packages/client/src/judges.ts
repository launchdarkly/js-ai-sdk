import { withJudgeEvaluation } from './conversation.js';
import { buildMessageHistory, numericScore, withoutOutputFormat } from './judge-scoring.js';
import { extractVariation, getClient } from './lifecycle.js';
import { reportUsage } from './sdk-usage.js';
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
  VariationMeta,
} from './types.js';
import {
  collapseMessagesToInstructions,
  normalizeMode,
  parseJSONWithPossibleFences,
  selectModeHandler,
  wildcardCovers,
} from './utils.js';

function parentCovers(handler: ProviderHandler, provider: string | undefined): boolean {
  if (provider !== undefined && handler.providesFor?.[0] === provider) return true;
  return wildcardCovers(handler, provider);
}

/** Exact provider+mode, then the best wildcard of that mode, then an agent-mode fallback for a messages judge. */
function selectJudgeExecution(
  handlers: readonly ProviderHandler[],
  provider: string | undefined,
  mode: 'agent' | 'messages',
): { handler: ProviderHandler; collapseMessages: boolean } | undefined {
  const chosen = selectModeHandler(handlers, provider, mode);
  if (chosen) return { handler: chosen, collapseMessages: false };
  if (mode === 'messages') {
    const agentFallback = selectModeHandler(handlers, provider, 'agent');
    if (agentFallback) return { handler: agentFallback, collapseMessages: true };
  }
  return undefined;
}

/**
 * Resolves a judge's own AI Config, returning `null` instead of throwing when it
 * cannot be resolved.
 *
 * Judges grade a response that has already been produced, so by the time one runs
 * the provider call is finished and billed. Letting a judge's own config failure
 * propagate would throw that response away — the caller pays for a completion and
 * receives an exception. The most common cause is benign and deliberate: someone
 * toggles a judge's AI Config off in LaunchDarkly, which makes `extractVariation`
 * throw for every request the judge is attached to.
 *
 * So a judge that cannot be resolved is skipped and logged, matching how this file
 * already treats a judge with no compatible handler.
 */
const resolveJudge = async (
  key: string,
  userContext: LDContext,
): Promise<{ config: AiConfigRep; meta: VariationMeta; value: unknown } | null> => {
  try {
    return await extractVariation(key, userContext);
  } catch (err) {
    // biome-ignore lint/suspicious/noConsole: judges are non-fatal; say why one was skipped
    console.error(`Judge '${key}' skipped:`, err instanceof Error ? err.message : err);
    return null;
  }
};

export { FORMATTING_INSTRUCTIONS } from './judge-scoring.js';

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

export type TypesafeJudgeEntry = { key: string; score: number; eventKey: string; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A TypeSafe handler returns one Jev call as `{kind: "typesafe", results: [...]}`.
 * Returns `undefined` for every other judge payload so `{score, reasoning}` stays unchanged.
 */
export function typesafeJudgeEntries(raw: unknown): TypesafeJudgeEntry[] | undefined {
  const parsed = typeof raw === 'string' ? parseJSONWithPossibleFences<unknown>(raw) : raw;
  if (!isRecord(parsed) || parsed.kind !== 'typesafe') return undefined;
  if (!Array.isArray(parsed.results) || parsed.results.length === 0) {
    throw new Error('TypeSafe judge output is missing results');
  }
  return parsed.results.map((item) => {
    if (!isRecord(item) || typeof item.key !== 'string' || item.key === '') {
      throw new Error('TypeSafe judge result is missing a key');
    }
    if (!isFiniteScore(item.score)) {
      throw new Error(`TypeSafe judge result '${item.key}' is missing a finite score`);
    }
    if (typeof item.eventKey !== 'string' || item.eventKey === '') {
      throw new Error(`TypeSafe judge result '${item.key}' is missing an eventKey`);
    }
    return {
      key: item.key,
      score: item.score,
      eventKey: item.eventKey,
      reason: typeof item.reason === 'string' ? item.reason : '',
    };
  });
}

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
  trajectory,
}: {
  config: AiConfigRep;
  userContext: LDContext;
  handler: ProviderHandler;
  /** When supplied, re-selects the handler for each judge based on its own provider. */
  handlers?: ProviderHandler[];
  userInput?: string;
  llmResponse: string;
  /** The invocation's rendered tool-call trajectory. Omitted for a graph-level judge, which grades no single node. */
  trajectory?: string;
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

    const resolved = await resolveJudge(judge.key, userContext);
    if (!resolved) continue;
    const { config: judgeConfig, meta: judgeMeta, value: judgeValue } = resolved;

    const judgeProvider = judgeConfig.provider?.name;
    const judgeMode = normalizeMode(judgeMeta.mode);

    // Pick the handler matching the judge's own provider/mode. Priority:
    //   1. Exact provider + mode match
    //   2. Wildcard provider (`*`) + same mode (e.g. LangChain agents handler) whose
    //      `providers` list, if any, contains the judge's provider; the shortest list wins
    //   3. Same provider, any mode (agent handler for the same provider)
    //   4. Wildcard provider, any mode, under the same `providers` rule — agent-handler fallback
    //   5. Parent node's handler, if it names the provider or is a wildcard whose list allows it
    //   6. Skip — crossing providers would send the wrong model to an incompatible API.
    // When falling back to an agent-mode handler for a messages-mode judge config
    // (cases 2–5), messages are collapsed into a single instructions string so the
    // agent handler receives a well-formed prompt without a separate messages client.
    let judgeHandler: ProviderHandler;
    let collapseMessages = false;
    if (handlers) {
      const selected = selectJudgeExecution(handlers, judgeProvider, judgeMode);
      if (selected) {
        judgeHandler = selected.handler;
        collapseMessages = selected.collapseMessages;
      } else if (parentCovers(handler, judgeProvider)) {
        judgeHandler = handler;
        collapseMessages = judgeMode === 'messages' && handler.providesFor?.[1] === 'agent';
      } else {
        // No compatible handler found — skip this judge rather than calling the
        // wrong provider's API with an incompatible model name.
        // biome-ignore lint/suspicious/noConsole: judges are non-fatal; say why one was skipped
        console.warn(`Judge '${judge.key}' skipped: no handler covers provider ${judgeProvider}`);
        continue;
      }
    } else {
      judgeHandler = handler;
    }

    const effectiveJudgeConfig = withoutOutputFormat(
      collapseMessages ? collapseMessagesToInstructions(judgeConfig) : judgeConfig,
      judge.key,
    );

    const messageHistory = buildMessageHistory({ userInput, trajectory, output: llmResponse });

    // `executeAndTrack` stays outside the `try`, as it was before judge evaluations existed: a
    // provider/auth/network failure must reject out of `runJudges` rather than be swallowed and
    // logged as a parse failure. Only parsing and recording are caught.
    await withJudgeEvaluation(judge.key, async (recordEvaluation) => {
      const { usage, response: rawJudgeResponse } = await executeAndTrack({
        configKey: judge.key,
        config: effectiveJudgeConfig,
        meta: judgeMeta,
        evaluatedValue: judgeValue,
        userContext,
        handler: judgeHandler,
        userInput: llmResponse,
        toolHandlers: undefined,
        graphKey,
        variables: {
          message_history: messageHistory,
          response_to_evaluate: llmResponse,
          ...(userInput ? { input: userInput } : {}),
        },
      });
      const judgeResponse = typeof rawJudgeResponse === 'string' ? rawJudgeResponse : JSON.stringify(rawJudgeResponse);

      try {
        const typesafe = typesafeJudgeEntries(judgeResponse);
        if (typesafe) {
          // One Jev call. Every label is returned with that call's full usage,
          // and each label is tracked under its own eventKey.
          typesafe.forEach((entry) => {
            const resultKey = `${judge.key}.${entry.key}`;
            judgeResults[resultKey] = {
              usage,
              response: entry.reason,
              score: entry.score,
              eventKey: entry.eventKey,
            };
            recordEvaluation(entry.score, undefined, resultKey);
            getClient().track(
              entry.eventKey,
              userContext,
              { ...baseTrackData, judgeConfigKey: resultKey },
              entry.score,
            );
          });
          return;
        }

        const parsed = parseJSONWithPossibleFences<{ score: number; reasoning: string }>(judgeResponse);
        if (!parsed) {
          throw new Error('Invalid JSON');
        }

        const { score, reasoning } = parsed as { score: number; reasoning: string };
        judgeResults[judge.key] = { usage, response: reasoning, score };
        // The reasoning reaches telemetry only when the judge's own handler captures content.
        // It is model prose about the user's conversation, so it follows the content gate.
        const metricScore = numericScore(score);
        if (metricScore !== undefined) {
          recordEvaluation(metricScore, judgeHandler.captureContent ? reasoning : undefined);
        }

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

type BuildJudgeTasksArgs = {
  config: AiConfigRep;
  userContext: LDContext;
  handler: ProviderHandler;
  handlers?: ProviderHandler[];
  llmResponse: string;
  baseTrackData: TrackData;
  userInput?: string;
  /** The originating invocation's rendered tool-call trajectory, carried on each task. */
  trajectory?: string;
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
export const buildJudgeTasks = async (args: BuildJudgeTasksArgs): Promise<JudgeTask[]> => {
  reportUsage('client.buildJudgeTasks');
  return buildJudgeTasksInternal(args);
};

/**
 * {@link buildJudgeTasks} without the `$ld:ai:sdk:usage` report. `config().invoke`
 * with `skipJudges` calls this.
 *
 * @internal
 */
export const buildJudgeTasksInternal = async ({
  config,
  userContext,
  handler,
  handlers,
  llmResponse,
  baseTrackData,
  userInput,
  trajectory,
}: BuildJudgeTasksArgs): Promise<JudgeTask[]> => {
  const judges = config.judgeConfiguration?.judges ?? [];
  const hasActiveJudge = judges.some((j: { samplingRate: number }) => j.samplingRate > 0);
  if (judges.length === 0 || !hasActiveJudge) return [];

  const tasks: JudgeTask[] = [];

  for (const judge of judges) {
    if (Math.random() >= judge.samplingRate) continue;

    const resolved = await resolveJudge(judge.key, userContext);
    if (!resolved) continue;
    const { config: judgeConfig, meta: judgeMeta, value: judgeValue } = resolved;

    const judgeProvider = judgeConfig.provider?.name;
    const judgeMode = normalizeMode(judgeMeta.mode);

    let collapseMessages = false;
    if (handlers) {
      const selected = selectJudgeExecution(handlers, judgeProvider, judgeMode);
      if (selected) {
        collapseMessages = selected.collapseMessages;
      } else if (parentCovers(handler, judgeProvider)) {
        collapseMessages = judgeMode === 'messages' && handler.providesFor?.[1] === 'agent';
      } else {
        // No compatible handler — skip, same as runJudges.
        // biome-ignore lint/suspicious/noConsole: judges are non-fatal; say why one was skipped
        console.warn(`Judge '${judge.key}' skipped: no handler covers provider ${judgeProvider}`);
        continue;
      }
    }

    tasks.push({
      configKey: judge.key,
      judgeConfig: withoutOutputFormat(judgeConfig, judge.key),
      judgeMeta,
      judgeValue,
      actualOutput: llmResponse,
      userInput,
      trajectory,
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
  reportUsage('client.runJudge');
  const {
    judgeConfig,
    judgeMeta,
    judgeValue,
    actualOutput,
    userInput,
    trajectory,
    userContext,
    variables,
    judgeProvider,
    judgeMode,
    collapseMessages,
    parentTrackData,
    configKey,
  } = task;

  const selected = selectJudgeExecution(handlers, judgeProvider, judgeMode);
  if (!selected) return null;
  const judgeHandler = selected.handler;

  // Defensive: an older serialized `JudgeTask` (e.g. from a worker queue built before this fix)
  // may still carry `outputFormat` on `judgeConfig`, so strip it here too rather than trust the caller.
  const effectiveConfig = withoutOutputFormat(
    collapseMessages ? collapseMessagesToInstructions(judgeConfig) : judgeConfig,
    configKey,
  );

  // The same history the inline path builds: input, trajectory, output.
  const messageHistory = buildMessageHistory({ userInput, trajectory, output: actualOutput });

  return withJudgeEvaluation(configKey, async (recordEvaluation) => {
    const { usage, response: rawResponse } = await executeAndTrack({
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
        ...(userInput ? { input: userInput } : {}),
      },
      evaluatedValue: judgeValue,
    });

    const judgeResponse = typeof rawResponse === 'string' ? rawResponse : JSON.stringify(rawResponse);
    let typesafe: TypesafeJudgeEntry[] | undefined;
    try {
      typesafe = typesafeJudgeEntries(judgeResponse);
    } catch {
      return null;
    }
    if (typesafe) {
      const first = typesafe[0];
      const firstKey = `${configKey}.${first.key}`;
      const results: NonNullable<ProviderResponse['judgeResults']> = {};
      const metrics: NonNullable<JudgeRunResult['metrics']> = [];
      for (const entry of typesafe) {
        const resultKey = `${configKey}.${entry.key}`;
        results[resultKey] = { score: entry.score, response: entry.reason, usage, eventKey: entry.eventKey };
        metrics.push({ eventKey: entry.eventKey, score: entry.score, judgeConfigKey: resultKey });
        recordEvaluation(entry.score, undefined, resultKey);
      }
      return {
        score: first.score,
        response: first.reason,
        usage,
        eventKey: first.eventKey,
        results,
        metrics,
        // The score belongs to the evaluated config. Each metric carries its own judgeConfigKey.
        trackData: { ...parentTrackData, judgeConfigKey: firstKey },
      };
    }

    const parsed = parseJSONWithPossibleFences<{ score: number; reasoning: string }>(judgeResponse);
    if (!parsed) return null;

    const { score, reasoning } = parsed as { score: number; reasoning: string };
    const metricScore = numericScore(score);
    if (metricScore !== undefined) {
      recordEvaluation(metricScore, judgeHandler.captureContent ? reasoning : undefined);
    }

    return {
      score,
      response: reasoning,
      usage,
      // The score belongs to the evaluated (parent) config, exactly as in the inline path.
      trackData: { ...parentTrackData, judgeConfigKey: configKey },
    };
  });
};
