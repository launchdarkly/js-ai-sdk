/**
 * Shadow requests: run another variation of the AI Config on the same input,
 * report it on the normal `$ld:ai:*` events with `isShadow: true`, and discard
 * its response. LaunchDarkly sends them in the served variation as
 * `shadowConfiguration`, keyed by the targeting rule or `fallthrough`.
 */
import { createHash } from 'node:crypto';

import { selectHandler } from './registry.js';
import { reportUsage } from './sdk-usage.js';
import { registerShutdownHook } from './shutdown-hooks.js';
import { executeAndTrack, makeRunTrackData } from './tracking.js';
import {
  type AiConfigRep,
  type LDContext,
  type Message,
  type ProviderHandler,
  parseAiConfig,
  type ShadowResult,
  type ShadowTask,
  type VariationMeta,
} from './types.js';
import { contextIdentityFromLdContext } from './utils.js';

export const DEFAULT_SHADOW_TIMEOUT_MS = 30_000;
export const MAX_SHADOW_TIMEOUT_MS = 2 ** 31 - 1;

const running = new Set<Promise<ShadowResult>>();

registerShutdownHook('Shadow requests', () => running.clear());

type ShadowEntry = {
  id: string;
  variationKey: string;
  samplingRate: number;
  endsAt: number;
  ownerKind?: string;
  ownerId?: string;
};

export function validateShadowTimeout(timeoutMs: number): void {
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= MAX_SHADOW_TIMEOUT_MS)) {
    throw new RangeError(`shadowTimeoutMs must be greater than 0 and at most ${MAX_SHADOW_TIMEOUT_MS}`);
  }
}

/**
 * Returns a task for each shadow request on the rule or fallthrough that served
 * this call, skipping entries that have ended, are not sampled for this context,
 * or have no matching handler.
 */
export function buildShadowTasks(args: {
  configKey: string;
  rawVariation: Record<string, unknown> | undefined;
  reason: unknown;
  primaryVariationKey: string;
  context: LDContext;
  userInput: string | undefined;
  history: Message[] | undefined;
  variables: Record<string, unknown> | undefined;
  handlers: ProviderHandler[] | undefined;
  runId: string;
  timeoutMs: number;
}): ShadowTask[] {
  const configuration = asRecord(args.rawVariation?.shadowConfiguration);
  const variations = asRecord(configuration?.variations) ?? {};
  const slot = slotFor(args.reason);
  const entries = slot ? asRecord(configuration?.shadows)?.[slot] : undefined;
  if (!Array.isArray(entries)) {
    return [];
  }

  const tasks: ShadowTask[] = [];
  for (const entry of entries) {
    if (!isEntry(entry) || entry.endsAt <= Date.now()) {
      continue;
    }
    if (!inSample(entry.id, args.context, entry.samplingRate)) {
      continue;
    }
    const shadow = parseShadowVariation(variations[entry.variationKey]);
    if (!shadow) {
      continue;
    }
    try {
      selectHandler(shadow.config, shadow.meta, args.handlers);
    } catch (err) {
      // biome-ignore lint/suspicious/noConsole: this package has no logger abstraction
      console.debug(`[LaunchDarkly] Skipping shadow request ${entry.id}: ${(err as Error).message}`);
      continue;
    }
    tasks.push({
      configKey: args.configKey,
      shadowRequestId: entry.id,
      shadowConfig: shadow.config,
      shadowMeta: shadow.meta,
      userInput: args.userInput,
      history: args.history ? [...args.history] : undefined,
      variables: args.variables ? { ...args.variables } : undefined,
      userContext: args.context,
      timeoutMs: args.timeoutMs,
      trackData: {
        runId: args.runId,
        isShadow: true,
        primaryVariationKey: args.primaryVariationKey,
        shadowRequestId: entry.id,
        ownerKind: entry.ownerKind ?? '',
        ownerId: entry.ownerId ?? '',
      },
      spanAttributes: {
        'launchdarkly.is_shadow': true,
        'launchdarkly.shadow.request.id': entry.id,
        'launchdarkly.shadow.primary.variation.key': args.primaryVariationKey,
      },
    });
  }
  return tasks;
}

/** Runs each task in the background, after the caller's own handler has started. */
export function startShadows(tasks: ShadowTask[], handlers: ProviderHandler[]): void {
  for (const task of tasks) {
    const result = Promise.resolve().then(() => execute(task, handlers));
    running.add(result);
    void result.finally(() => running.delete(result));
  }
}

/** Runs one {@link ShadowTask}. Never rejects: a failure is returned in `error`. */
export async function runShadow(task: ShadowTask, handlers: ProviderHandler[]): Promise<ShadowResult> {
  reportUsage('client.runShadow');
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

async function execute(task: ShadowTask, handlers: ProviderHandler[]): Promise<ShadowResult> {
  const { runId, ...extraTrackData } = task.trackData;
  const trackData = makeRunTrackData({
    configKey: task.configKey,
    config: task.shadowConfig,
    meta: task.shadowMeta,
    runId,
    extraTrackData,
  });
  try {
    const handler = selectHandler(task.shadowConfig, task.shadowMeta, handlers);
    const result = await executeAndTrack({
      configKey: task.configKey,
      config: task.shadowConfig,
      meta: task.shadowMeta,
      userContext: task.userContext,
      handler: withDeadline(handler, task.timeoutMs),
      userInput: task.userInput,
      variables: task.variables,
      history: task.history ? [...task.history] : undefined,
      runId: trackData.runId,
      extraTrackData,
      spanAttributes: task.spanAttributes,
    });
    return { usage: result.usage, trackData: result.trackData };
  } catch (err) {
    return {
      usage: { total: 0, input: 0, output: 0 },
      trackData,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** The handler rejects with `timeout` once `timeoutMs` passes. A promise cannot be cancelled, so a late result is ignored. */
function withDeadline(handler: ProviderHandler, timeoutMs: number): ProviderHandler {
  const timed: ProviderHandler = async (...args) => {
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
  };
  timed.providesFor = handler.providesFor;
  timed.captureContent = handler.captureContent;
  return timed;
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

function parseShadowVariation(value: unknown): { config: AiConfigRep; meta: VariationMeta } | undefined {
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
