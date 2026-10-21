import {
  type AiConfigRep,
  camelizeModelParameters,
  normalizeModelParameters,
  pickForwardedModelParameters,
} from '@launchdarkly/ai-server';
import type { ModelSettings } from '@openai/agents';

/**
 * `ModelSettings` fields this package takes from `config.model.parameters`, after camelizing the
 * bag (`top_p` becomes `topP`). Every other key is dropped.
 */
const FORWARDED_MODEL_SETTINGS_KEYS = [
  'contextManagement',
  'frequencyPenalty',
  'maxTokens',
  'parallelToolCalls',
  'presencePenalty',
  'promptCacheRetention',
  'reasoning',
  'store',
  'temperature',
  'text',
  'toolChoice',
  'topP',
  'truncation',
] as const satisfies ReadonlyArray<keyof ModelSettings>;

/**
 * `ModelSettings` fields that are never taken from a config:
 *
 * - `providerData` is merged into the Responses API request as written, and carries the Agents
 *   SDK's transport overrides (`extraHeaders`, `extraBody`, `extraQuery`), so a config could
 *   replace the request's headers (including authorization) or body.
 * - `retry` is client retry policy, not a model setting.
 */
type ExcludedModelSettingsKeys = 'providerData' | 'retry';
// If the Agents SDK adds a ModelSettings field and it is not classified above as forwarded or
// excluded, this type resolves to something other than `never` and the assignment below fails to
// compile, naming the unclassified key.
type UndecidedModelSettingsKeys = Exclude<
  keyof ModelSettings,
  ExcludedModelSettingsKeys | (typeof FORWARDED_MODEL_SETTINGS_KEYS)[number]
>;
const _modelSettingsKeysExhaustive: Record<UndecidedModelSettingsKeys, never> = {} as Record<never, never>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Keeps only the named keys of a nested object, or returns `undefined` if none are set. */
function pickNested(value: unknown, keys: ReadonlyArray<string>): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) return undefined;
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    if (value[key] !== undefined) picked[key] = value[key];
  }
  return Object.keys(picked).length > 0 ? picked : undefined;
}

/**
 * `context_management` as `ModelSettings.contextManagement`: each entry is rebuilt as
 * `{ type, compactThreshold }`, accepting `compact_threshold` (the Responses API spelling the UI
 * writes) or `compactThreshold`. The Agents SDK snake-cases every key of an entry into the
 * request, so any other key is dropped rather than passed along. Entries without a string `type`
 * are dropped.
 */
function toContextManagement(value: unknown): ModelSettings['contextManagement'] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value.flatMap((entry) => {
    if (!isPlainObject(entry) || typeof entry.type !== 'string') return [];
    const threshold = entry.compact_threshold ?? entry.compactThreshold;
    return [{ type: entry.type, ...(typeof threshold === 'number' ? { compactThreshold: threshold } : {}) }];
  });
  return entries.length > 0 ? entries : undefined;
}

/**
 * `config.model.parameters` as the Agents SDK's `ModelSettings`: camelized, narrowed to
 * `FORWARDED_MODEL_SETTINGS_KEYS`, with nested values rebuilt in the shapes the SDK reads:
 *
 * - `reasoning` keeps `effort` and `summary`.
 * - `text` keeps `verbosity`. A top-level `verbosity` (the name the UI and the Python SDK use)
 *   becomes `text.verbosity`; an explicit `text.verbosity` wins.
 * - `context_management` entries are rebuilt by `toContextManagement`.
 *
 * `max_turns` is not a `ModelSettings` field; see `buildMaxTurns`. A config that sets none of
 * these produces `undefined`, so the Agent is constructed exactly as it always has been.
 */
export function buildModelSettings(
  parameters: AiConfigRep['model']['parameters'] | unknown,
): ModelSettings | undefined {
  const camelized = camelizeModelParameters(normalizeModelParameters(parameters));
  const settings = pickForwardedModelParameters(camelized, FORWARDED_MODEL_SETTINGS_KEYS);

  const reasoning = pickNested(settings.reasoning, ['effort', 'summary']);
  if (reasoning) settings.reasoning = reasoning;
  else delete settings.reasoning;

  const text = pickNested({ verbosity: camelized.verbosity, ...pickNested(settings.text, ['verbosity']) }, [
    'verbosity',
  ]);
  if (text) settings.text = text;
  else delete settings.text;

  const contextManagement = toContextManagement(settings.contextManagement);
  if (contextManagement) settings.contextManagement = contextManagement;
  else delete settings.contextManagement;

  return Object.keys(settings).length > 0 ? (settings as ModelSettings) : undefined;
}

/**
 * `maxTurns` is a `Runner.run` option, not a `ModelSettings` field: it caps the agentic loop
 * rather than tuning any single model call, so it is read out of `model.parameters` separately
 * and forwarded to `run()` instead of the `Agent` constructor. Both `max_turns` (the UI's
 * spelling) and `maxTurns` are read.
 */
export function buildMaxTurns(parameters: AiConfigRep['model']['parameters'] | unknown): number | undefined {
  const maxTurns = camelizeModelParameters(normalizeModelParameters(parameters)).maxTurns;
  return typeof maxTurns === 'number' ? maxTurns : undefined;
}
