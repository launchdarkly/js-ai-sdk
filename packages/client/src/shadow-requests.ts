/**
 * Shadow Requests (experimental).
 *
 * Call `enableShadowRequests()` to run the shadow variations LaunchDarkly
 * attaches to a targeting rule or the fallthrough. Each sampled shadow runs in
 * the background on the same input, and is tracked on the normal `$ld:ai:*`
 * events with `isShadow`. Its response is discarded, and the caller's
 * response, latency and events are unchanged.
 */
import { createHash } from 'node:crypto';

import { selectHandler } from './client.js';
import { type InvocationEvent, registerInvocationHook } from './invocation-hooks.js';
import { reportUsage } from './sdk-usage.js';
import { registerShutdownHook } from './shutdown-hooks.js';
import { executeAndTrack, makeRunTrackData, modelStampsFromMeta } from './tracking.js';
import {
  type AiConfigRep,
  type LDContext,
  type Message,
  type ProviderHandler,
  parseAiConfig,
  type TokenUsage,
  type TrackData,
  type VariationMeta,
} from './types.js';
import { contextIdentityFromLdContext } from './utils.js';

const FEATURE = 'Shadow Requests';
const FALLTHROUGH = 'fallthrough';
const STRIPPED_KEYS = new Set(['_ldMeta', 'tools', 'judgeConfiguration', 'shadowConfiguration']);
const BUCKET_SCALE = 2 ** 60;
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * Everything needed to run and track one sampled shadow, with no flag
 * evaluation. Plain data, so it survives `structuredClone` and JSON. Run it
 * with `runShadow(task, handlers)`.
 */
export type ShadowTask = {
  configKey: string;
  shadowRequestId: string;
  shadowConfig: AiConfigRep;
  shadowMeta: VariationMeta;
  userInput: string | undefined;
  history: Message[] | undefined;
  variables: Record<string, unknown> | undefined;
  userContext: LDContext;
  timeoutMs: number;
  trackData: Record<string, unknown>;
  spanAttributes: Record<string, unknown>;
};

/** The outcome of one shadow run. There is no response text: it is discarded. */
export type ShadowResult = {
  usage: TokenUsage;
  trackData: TrackData;
  error?: string;
};

export type EnableShadowRequestsOptions = {
  /** How long a shadow may run before it is abandoned and tracked as an error. Default 30000. */
  timeoutMs?: number;
  /**
   * Run shadows yourself instead of in the background. Receives a
   * {@link ShadowTask} for each sampled shadow, before the real handler runs,
   * and must only enqueue it.
   */
  onTask?: (task: ShadowTask) => void;
};

type Settings = { timeoutMs: number; onTask?: (task: ShadowTask) => void };

let settings: Settings | undefined;
const pending = new Set<Promise<ShadowResult>>();

/** Turns Shadow Requests on for this process. Calling it again replaces the settings. */
export function enableShadowRequests(options: EnableShadowRequestsOptions = {}): void {
  reportUsage('experimental.enableShadowRequests');
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= MAX_TIMEOUT_MS)) {
    throw new RangeError(`timeoutMs must be greater than 0 and at most ${MAX_TIMEOUT_MS}`);
  }
  settings = { timeoutMs, onTask: options.onTask };
  registerInvocationHook(FEATURE, onInvocation);
}

/** Turns Shadow Requests off. Shadows already running finish. */
export function disableShadowRequests(): void {
  settings = undefined;
  registerInvocationHook(FEATURE, undefined);
}

/** Runs one {@link ShadowTask}. Never rejects; a failure is returned in `error`. */
export async function runShadow(task: ShadowTask, handlers: ProviderHandler[]): Promise<ShadowResult> {
  reportUsage('experimental.runShadow');
  return run(task, handlers);
}

registerShutdownHook(FEATURE, () => {
  pending.clear();
  disableShadowRequests();
});

/** @internal */
export async function waitForShadowsForTesting(): Promise<void> {
  while (pending.size > 0) {
    await Promise.allSettled(pending);
  }
}

/** @internal */
export function inSample(shadowId: string, context: LDContext, samplingRate: number): boolean {
  const identity = contextIdentityFromLdContext(context);
  if (!identity) {
    return false;
  }
  const digest = createHash('sha1').update(`${shadowId}.${identity.canonical}`).digest('hex');
  return Number.parseInt(digest.slice(0, 15), 16) / BUCKET_SCALE < samplingRate;
}

function slot(reason: unknown): string | undefined {
  if (!reason || typeof reason !== 'object') {
    return undefined;
  }
  const r = reason as Record<string, unknown>;
  if (r.kind === 'FALLTHROUGH') {
    return FALLTHROUGH;
  }
  if (r.kind === 'RULE_MATCH' && typeof r.ruleId === 'string') {
    return r.ruleId;
  }
  return undefined;
}

type ShadowEntry = {
  id: string;
  variationKey: string;
  samplingRate: number;
  endsAt: number;
  ownerKind?: string;
  ownerId?: string;
};

function isEntry(entry: unknown): entry is ShadowEntry {
  if (!entry || typeof entry !== 'object') {
    return false;
  }
  const e = entry as Record<string, unknown>;
  return (
    typeof e.samplingRate === 'number' &&
    typeof e.endsAt === 'number' &&
    typeof e.id === 'string' &&
    e.id !== '' &&
    typeof e.variationKey === 'string' &&
    e.variationKey !== ''
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function parseVariation(raw: unknown): { config: AiConfigRep; meta: VariationMeta } | undefined {
  const value = asRecord(raw);
  const ldMeta = asRecord(value?._ldMeta);
  if (!value || !ldMeta?.enabled) {
    return undefined;
  }
  const parsed = parseAiConfig(Object.fromEntries(Object.entries(value).filter(([k]) => !STRIPPED_KEYS.has(k))));
  if (!parsed.success) {
    return undefined;
  }
  const meta = {
    enabled: true,
    variationKey: typeof ldMeta.variationKey === 'string' ? ldMeta.variationKey : '',
    version: typeof ldMeta.version === 'number' ? ldMeta.version : 1,
    mode: ldMeta.mode,
    ...modelStampsFromMeta(ldMeta as VariationMeta),
  } as VariationMeta;
  return { config: parsed.data, meta };
}

function onInvocation(event: InvocationEvent): void {
  const current = settings;
  if (!current) {
    return;
  }
  const key = slot(event.reason);
  const configuration = asRecord(event.value.shadowConfiguration);
  const shadows = asRecord(configuration?.shadows);
  const variations = asRecord(configuration?.variations);
  if (!key || !shadows || !variations) {
    return;
  }
  const entries = shadows[key];
  if (!Array.isArray(entries)) {
    return;
  }

  const now = Date.now();
  for (const entry of entries) {
    if (!isEntry(entry) || entry.endsAt <= now) {
      continue;
    }
    if (!inSample(entry.id, event.context, entry.samplingRate)) {
      continue;
    }
    const parsed = parseVariation(variations[entry.variationKey]);
    if (!parsed) {
      continue;
    }
    try {
      selectHandler(parsed.config, parsed.meta, event.handlers);
    } catch {
      continue;
    }
    const task: ShadowTask = {
      configKey: event.configKey,
      shadowRequestId: entry.id,
      shadowConfig: parsed.config,
      shadowMeta: parsed.meta,
      userInput: event.userInput,
      history: event.history ? [...event.history] : undefined,
      variables: event.variables ? { ...event.variables } : undefined,
      userContext: { ...event.context } as LDContext,
      timeoutMs: current.timeoutMs,
      trackData: {
        runId: event.runId,
        isShadow: true,
        primaryVariationKey: event.variationKey,
        shadowRequestId: entry.id,
        ownerKind: entry.ownerKind ?? '',
        ownerId: entry.ownerId ?? '',
      },
      spanAttributes: {
        'launchdarkly.is_shadow': true,
        'launchdarkly.shadow.request.id': entry.id,
        'launchdarkly.shadow.primary.variation.key': event.variationKey,
      },
    };
    if (current.onTask) {
      try {
        current.onTask(task);
      } catch (err) {
        // biome-ignore lint/suspicious/noConsole: this package has no logger abstraction; a failed callback must be visible
        console.warn('[LaunchDarkly] The Shadow Requests onTask callback failed.', err);
      }
      continue;
    }
    const running = run(task, event.handlers);
    pending.add(running);
    void running.finally(() => pending.delete(running));
  }
}

const NO_USAGE: TokenUsage = { total: 0, input: 0, output: 0 };

async function run(task: ShadowTask, handlers: ProviderHandler[]): Promise<ShadowResult> {
  const { runId, ...extraTrackData } = task.trackData;
  const trackData = makeRunTrackData({
    configKey: task.configKey,
    config: task.shadowConfig,
    meta: task.shadowMeta,
    runId: typeof runId === 'string' ? runId : undefined,
    extraTrackData,
  });
  let handler: ProviderHandler;
  try {
    handler = selectHandler(task.shadowConfig, task.shadowMeta, handlers);
  } catch (err) {
    return { usage: NO_USAGE, trackData, error: String(err) };
  }

  try {
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
    return { usage: NO_USAGE, trackData, error: err instanceof Error ? err.message : String(err) };
  }
}

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
