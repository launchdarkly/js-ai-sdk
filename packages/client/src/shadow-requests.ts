/**
 * Shadow requests: run another variation of an AI Config on the same input as
 * the served one, track it on the normal `$ld:ai:*` events with
 * `isShadow: true`, and discard its answer. LaunchDarkly sends the shadows in
 * the served variation as `shadowConfiguration`, keyed by the targeting rule
 * or `fallthrough`.
 */
import { createHash } from 'node:crypto';

import { context as otelContext } from '@opentelemetry/api';

import { configFromVariation } from './client.js';
import { currentConversationId, withExactConversationId } from './conversation.js';
import { fetchVariation, parseVariation as parseServedVariation } from './lifecycle.js';
import { findHandler, resolveHandlers } from './registry.js';
import { reportUsage } from './sdk-usage.js';
import { registerShutdownHook } from './shutdown-hooks.js';
import { executeAndTrack, makeRunTrackData } from './tracking.js';
import {
  type AiConfigRep,
  type ConfigArgs,
  type LDContext,
  type Message,
  type ProviderHandler,
  type ProviderResponse,
  parseAiConfig,
  type StreamEvent,
  type TokenUsage,
  type TrackData,
  type VariationMeta,
} from './types.js';
import { contextIdentityFromLdContext, normalizeMode } from './utils.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
const NO_USAGE: TokenUsage = { total: 0, input: 0, output: 0 };

/**
 * Everything needed to run and track one sampled shadow, with no flag
 * evaluation. Plain data, so it survives `structuredClone`. Run it with
 * {@link runShadow}.
 */
export type ShadowTask = {
  configKey: string;
  shadowRequestId: string;
  config: AiConfigRep;
  meta: VariationMeta;
  userInput: string | undefined;
  history: Message[] | undefined;
  variables: Record<string, unknown> | undefined;
  context: LDContext;
  timeoutMs: number;
  trackData: {
    runId: string;
    isShadow: true;
    primaryVariationKey: string;
    shadowRequestId: string;
    ownerKind: string;
    ownerId: string;
  };
  spanAttributes: Record<string, string | boolean>;
  /** The caller's conversation id when the shadow was sampled. {@link runShadow} runs under exactly this id. */
  conversationId?: string;
};

/** The outcome of one shadow run. The answer is discarded, so there is none. */
export type ShadowResult = {
  usage: TokenUsage;
  trackData: TrackData & ShadowTask['trackData'];
  error?: string;
};

export type ShadowConfigArgs = ConfigArgs & {
  /** How long a shadow may run before it is tracked as an error. Default 30000. */
  shadowTimeoutMs?: number;
  /** Run shadows yourself: called once per sampled shadow, instead of running it in the background. */
  onTask?: (task: ShadowTask) => void;
};

type ShadowEntry = {
  id: string;
  variationKey: string;
  samplingRate: number;
  endsAt: number;
  ownerKind?: string;
  ownerId?: string;
};

type Evaluation = {
  config: AiConfigRep;
  meta: VariationMeta;
  runId: string;
  shadowConfiguration: unknown;
  reason: unknown;
};

type Request = {
  userInput: string | undefined;
  context: LDContext;
  variables: Record<string, unknown> | undefined;
  history: Message[] | undefined;
};

const running = new Set<Promise<ShadowResult>>();

registerShutdownHook('Shadow requests', () => running.clear());

/**
 * Like `config()`, and also runs the shadows LaunchDarkly attached to the rule
 * or fallthrough that served the call. Shadows start once the served variation
 * has returned (or its stream has reached `done`), never delay it, and never
 * run when it fails.
 */
export function shadowConfig({ shadowTimeoutMs = DEFAULT_TIMEOUT_MS, onTask, ...args }: ShadowConfigArgs) {
  reportUsage('experimental.shadowConfig');
  if (!(Number.isFinite(shadowTimeoutMs) && shadowTimeoutMs > 0 && shadowTimeoutMs <= MAX_TIMEOUT_MS)) {
    throw new RangeError(`shadowTimeoutMs must be greater than 0 and at most ${MAX_TIMEOUT_MS}`);
  }
  const localHandlers = args.handler === undefined ? undefined : [args.handler].flat();

  function primary() {
    const state: { evaluation?: Evaluation } = {};
    const run = configFromVariation(args, async (context) => {
      state.evaluation = await evaluate(args.key, context);
      return state.evaluation;
    });
    const startShadows = (request: Request) => {
      if (!state.evaluation) {
        return;
      }
      const handlers = resolveHandlers(args.registry, localHandlers) ?? [];
      let tasks: ShadowTask[];
      try {
        tasks = buildTasks(args.key, state.evaluation, request, handlers, shadowTimeoutMs);
      } catch (err) {
        // biome-ignore lint/suspicious/noConsole: this package has no logger abstraction; a skipped shadow must be visible
        console.warn('[LaunchDarkly] Skipping shadow requests: they could not be prepared.', err);
        return;
      }
      for (const task of tasks) {
        if (onTask) {
          try {
            onTask(task);
          } catch (err) {
            // biome-ignore lint/suspicious/noConsole: this package has no logger abstraction; a failed callback must be visible
            console.warn('[LaunchDarkly] The shadow requests onTask callback failed.', err);
          }
        } else {
          const result = execute(task, handlers);
          running.add(result);
          void result.finally(() => running.delete(result));
        }
      }
    };
    return { run, startShadows };
  }

  async function invoke<T = string>(
    userInput: string | undefined,
    context: LDContext,
    variables?: Record<string, unknown>,
    history?: Message[],
  ): Promise<ProviderResponse<T>> {
    const { run, startShadows } = primary();
    const response = await run.invoke<T>(userInput, context, variables, history);
    startShadows({ userInput, context, variables, history });
    return response;
  }

  function stream(
    userInput: string | undefined,
    context: LDContext,
    variables?: Record<string, unknown>,
    history?: Message[],
  ): AsyncGenerator<StreamEvent> {
    const { run, startShadows } = primary();
    const callerContext = otelContext.active();
    const events = run.stream(userInput, context, variables, history);
    return (async function* () {
      for await (const event of events) {
        if (event.type === 'done') {
          otelContext.with(callerContext, () => startShadows({ userInput, context, variables, history }));
        }
        yield event;
      }
    })();
  }

  return { invoke, stream };
}

/** Runs one {@link ShadowTask}. Never rejects: a failure is returned in `error`. */
export async function runShadow(task: ShadowTask, handlers: ProviderHandler[]): Promise<ShadowResult> {
  reportUsage('experimental.runShadow');
  return execute(task, handlers);
}

/** @internal Resolves once no background shadow is running. */
export async function waitForShadowsForTesting(): Promise<void> {
  while (running.size > 0) {
    await Promise.allSettled(running);
  }
}

/** @internal Sticky per context: the same shadow id and context always give the same answer. */
export function inSample(shadowId: string, context: LDContext, samplingRate: number): boolean {
  const identity = contextIdentityFromLdContext(context);
  if (!identity) {
    return false;
  }
  const digest = createHash('sha1').update(`${shadowId}.${identity.canonical}`).digest('hex');
  return Number.parseInt(digest.slice(0, 15), 16) / 2 ** 60 < samplingRate;
}

async function evaluate(key: string, context: LDContext): Promise<Evaluation> {
  const { value, reason } = await fetchVariation(key, context, { withReason: true });
  const { shadowConfiguration, ...variation } = asRecord(value) ?? {};
  return { ...parseServedVariation(key, variation), runId: crypto.randomUUID(), shadowConfiguration, reason };
}

function buildTasks(
  configKey: string,
  evaluation: Evaluation,
  request: Request,
  handlers: ProviderHandler[],
  timeoutMs: number,
): ShadowTask[] {
  const configuration = asRecord(evaluation.shadowConfiguration);
  const variations = asRecord(configuration?.variations) ?? {};
  const slot = slotFor(evaluation.reason);
  const entries = slot ? asRecord(configuration?.shadows)?.[slot] : undefined;
  if (!Array.isArray(entries)) {
    return [];
  }

  const primaryVariationKey = evaluation.meta.variationKey ?? '';
  const conversationId = currentConversationId();
  const tasks: ShadowTask[] = [];
  for (const entry of entries) {
    if (!isEntry(entry) || entry.endsAt <= Date.now() || !inSample(entry.id, request.context, entry.samplingRate)) {
      continue;
    }
    const shadow = parseVariation(variations[entry.variationKey]);
    if (!shadow) {
      continue;
    }
    if (!handlerFor(shadow.config, shadow.meta, handlers)) {
      // biome-ignore lint/suspicious/noConsole: this package has no logger abstraction
      console.debug(`[LaunchDarkly] Skipping shadow request ${entry.id}: no handler for its provider.`);
      continue;
    }
    tasks.push({
      configKey,
      shadowRequestId: entry.id,
      config: shadow.config,
      meta: shadow.meta,
      userInput: request.userInput,
      history: request.history ? [...request.history] : undefined,
      variables: request.variables ? { ...request.variables } : undefined,
      context: structuredClone(request.context),
      timeoutMs,
      trackData: {
        runId: evaluation.runId,
        isShadow: true,
        primaryVariationKey,
        shadowRequestId: entry.id,
        ownerKind: entry.ownerKind ?? '',
        ownerId: entry.ownerId ?? '',
      },
      spanAttributes: {
        'launchdarkly.is_shadow': true,
        'launchdarkly.shadow.request.id': entry.id,
        'launchdarkly.shadow.primary.variation.key': primaryVariationKey,
      },
      ...(conversationId && { conversationId }),
    });
  }
  return tasks;
}

async function execute(task: ShadowTask, handlers: ProviderHandler[]): Promise<ShadowResult> {
  const { runId, ...extraTrackData } = task.trackData;
  const trackData = {
    ...makeRunTrackData({ configKey: task.configKey, config: task.config, meta: task.meta }),
    ...task.trackData,
  };
  const handler = handlerFor(task.config, task.meta, handlers);
  if (!handler) {
    return { usage: NO_USAGE, trackData, error: `No handler for provider ${task.config.provider?.name}` };
  }
  try {
    const result = await withExactConversationId(task.conversationId, () =>
      executeAndTrack({
        configKey: task.configKey,
        config: task.config,
        meta: task.meta,
        userContext: task.context,
        handler: withDeadline(handler, task.timeoutMs),
        userInput: task.userInput,
        variables: task.variables,
        history: task.history ? [...task.history] : undefined,
        runId,
        extraTrackData,
        spanAttributes: task.spanAttributes,
        featureFlagEvent: false,
      }),
    );
    return { usage: result.usage, trackData: { ...result.trackData, ...task.trackData } };
  } catch (err) {
    return { usage: NO_USAGE, trackData, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The handler rejects with `timeout` once `timeoutMs` passes. A promise cannot be cancelled, so a late result is ignored. */
function withDeadline(handler: ProviderHandler, timeoutMs: number): ProviderHandler {
  const timed = (async (...args: Parameters<ProviderHandler>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([handler(...args), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }) as ProviderHandler;
  timed.providesFor = handler.providesFor;
  if (handler.captureContent !== undefined) {
    timed.captureContent = handler.captureContent;
  }
  return timed;
}

function handlerFor(
  config: AiConfigRep,
  meta: VariationMeta,
  handlers: ProviderHandler[],
): ProviderHandler | undefined {
  const provider = config.provider?.name;
  return provider ? findHandler(handlers, provider, normalizeMode(meta.mode)) : undefined;
}

function slotFor(reason: unknown): string | undefined {
  const r = asRecord(reason);
  if (r?.kind === 'FALLTHROUGH') {
    return 'fallthrough';
  }
  if (r?.kind === 'RULE_MATCH' && typeof r.ruleId === 'string') {
    return r.ruleId;
  }
  return undefined;
}

function isEntry(value: unknown): value is ShadowEntry {
  const e = asRecord(value);
  return (
    typeof e?.id === 'string' &&
    e.id !== '' &&
    typeof e.variationKey === 'string' &&
    e.variationKey !== '' &&
    typeof e.samplingRate === 'number' &&
    typeof e.endsAt === 'number'
  );
}

function parseVariation(value: unknown): { config: AiConfigRep; meta: VariationMeta } | undefined {
  const variation = asRecord(value);
  const meta = asRecord(variation?._ldMeta);
  if (!variation || meta?.enabled !== true) {
    return undefined;
  }
  const { _ldMeta, tools: _tools, judgeConfiguration: _judges, shadowConfiguration: _shadows, ...config } = variation;
  const parsed = parseAiConfig(config);
  return parsed.success ? { config: parsed.data, meta: meta as VariationMeta } : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
