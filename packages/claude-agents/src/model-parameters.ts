import type { Options } from '@anthropic-ai/claude-agent-sdk';
import {
  type AiConfigRep,
  camelizeModelParameters,
  normalizeModelParameters,
  pickForwardedModelParameters,
} from '@launchdarkly/ai-server';

/**
 * `query()` options this package takes from `config.model.parameters`, after camelizing the
 * bag (`max_turns` becomes `maxTurns`). Every other key is dropped.
 *
 * This is an allowlist because `model.parameters` comes from the AI Config, not from the
 * application, and most `query()` options configure the host process rather than the model:
 * which executable runs (`pathToClaudeCodeExecutable`, `executable`, `executableArgs`,
 * `extraArgs`), its environment and working directory (`env`, `cwd`, `additionalDirectories`),
 * what it may do without asking (`permissionMode`, `allowDangerouslySkipPermissions`, `sandbox`,
 * `settings`, `settingSources`, `plugins`, `hooks`, `canUseTool`), which remote tools it connects
 * to (`mcpServers`), and which session it resumes (`resume`, `sessionId`, `forkSession`,
 * `continue`). None of those can come from a config.
 *
 * `outputFormat` is not forwarded either: structured output belongs to the config's own
 * `outputFormat`, which the handler applies itself, so a schema in
 * `model.parameters` would only fight it.
 *
 * `max_tokens` is read too, but it is not a `query()` option: see `MAX_OUTPUT_TOKENS_ENV`.
 */
const FORWARDED_QUERY_OPTION_KEYS = [
  'betas',
  'effort',
  'fallbackModel',
  'maxBudgetUsd',
  'maxThinkingTokens',
  'maxTurns',
  'thinking',
] as const satisfies ReadonlyArray<keyof Options>;

/**
 * The variable the CLI reads its output-token limit from. `query()` takes no output-token option,
 * so the config's `max_tokens` reaches the CLI as this variable in its environment, the only value
 * this package writes there. Without it the CLI sends its own default (32000 on
 * `claude-haiku-4-5`) whatever the config asks for.
 */
const MAX_OUTPUT_TOKENS_ENV = 'CLAUDE_CODE_MAX_OUTPUT_TOKENS';

type ThinkingType = NonNullable<Options['thinking']>['type'];

/** The `thinking` types the Claude Agent SDK knows (`ThinkingConfig`). */
const THINKING_TYPES = ['adaptive', 'enabled', 'disabled'] as const satisfies ReadonlyArray<ThinkingType>;
// Fails to compile if the SDK adds a thinking type that is not listed above.
const _thinkingTypesExhaustive: Record<Exclude<ThinkingType, (typeof THINKING_TYPES)[number]>, never> = {} as Record<
  never,
  never
>;

/** The `display` values the SDK takes for adaptive and enabled thinking. */
const THINKING_DISPLAYS: ReadonlyArray<unknown> = ['summarized', 'omitted'];

/**
 * `thinking` as the Claude Agent SDK reads it. The LaunchDarkly UI writes the Messages API shape,
 * `{ type: 'enabled', budget_tokens: 1024 }`, but the SDK's `ThinkingEnabled` reads
 * `budgetTokens`, so a snake_case budget would be ignored. Only `type`, the budget, and `display`
 * are kept. It is dropped unless its `type` is one the SDK knows, and an `enabled` thinking is
 * dropped without a numeric budget: the SDK would quietly run it as adaptive, and the Python SDK
 * cannot run it at all, so both SDKs drop it. `display` is kept only for a type that takes it and
 * only with a value the SDK knows.
 */
function toThinkingOption(value: unknown): Options['thinking'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const type = THINKING_TYPES.find((known) => known === source.type);
  if (!type) return undefined;
  const thinking: Record<string, unknown> = { type };
  if (type === 'enabled') {
    const budgetTokens = source.budget_tokens ?? source.budgetTokens;
    if (typeof budgetTokens !== 'number') return undefined;
    thinking.budgetTokens = budgetTokens;
  }
  if (type !== 'disabled' && THINKING_DISPLAYS.includes(source.display)) thinking.display = source.display;
  return thinking as Options['thinking'];
}

/**
 * `config.model.parameters` as `query()` options: camelized, narrowed to
 * `FORWARDED_QUERY_OPTION_KEYS`, with `thinking` rebuilt in the shape the SDK reads.
 *
 * Two options are set even though the config does not name them. `thinking` is
 * `{ type: 'disabled' }` unless the config sets `thinking` or `maxThinkingTokens`, because the
 * CLI otherwise picks thinking itself (a 31,999-token budget on `claude-haiku-4-5`). And a
 * positive integer `max_tokens` becomes `env`: the inherited environment plus
 * `MAX_OUTPUT_TOKENS_ENV`. The SDK replaces the child's environment with `env` rather than
 * merging it, so `process.env` is spread first; with no `max_tokens`, `env` is left unset and the
 * child inherits `process.env` as before.
 */
export function buildModelParameterQueryOptions(
  parameters: AiConfigRep['model']['parameters'] | unknown,
): Partial<Options> {
  const camelized = camelizeModelParameters(normalizeModelParameters(parameters));
  const options = pickForwardedModelParameters(camelized, FORWARDED_QUERY_OPTION_KEYS);
  if (options.thinking !== undefined) {
    const thinking = toThinkingOption(options.thinking);
    if (thinking) options.thinking = thinking;
    else delete options.thinking;
  }
  if (options.thinking === undefined && options.maxThinkingTokens == null) {
    options.thinking = { type: 'disabled' };
  }
  const { maxTokens } = camelized;
  if (typeof maxTokens === 'number' && Number.isSafeInteger(maxTokens) && maxTokens > 0) {
    options.env = { ...process.env, [MAX_OUTPUT_TOKENS_ENV]: String(maxTokens) };
  }
  return options as Partial<Options>;
}
