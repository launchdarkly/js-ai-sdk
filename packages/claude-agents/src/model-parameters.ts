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
 */
const FORWARDED_QUERY_OPTION_KEYS = [
  'betas',
  'effort',
  'fallbackModel',
  'maxBudgetUsd',
  'maxThinkingTokens',
  'maxTurns',
  'outputFormat',
  'thinking',
] as const satisfies ReadonlyArray<keyof Options>;

/**
 * `thinking` as the Claude Agent SDK reads it. The LaunchDarkly UI writes the Messages API shape,
 * `{ type: 'enabled', budget_tokens: 1024 }`, but the SDK's `ThinkingEnabled` reads
 * `budgetTokens`, so a snake_case budget would be ignored. Only `type`, the budget, and `display`
 * are kept; anything that is not an object with a string `type` is dropped.
 */
function toThinkingOption(value: unknown): Options['thinking'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  if (typeof source.type !== 'string') return undefined;
  const thinking: Record<string, unknown> = { type: source.type };
  const budgetTokens = source.budget_tokens ?? source.budgetTokens;
  if (typeof budgetTokens === 'number') thinking.budgetTokens = budgetTokens;
  if (typeof source.display === 'string') thinking.display = source.display;
  return thinking as Options['thinking'];
}

/**
 * `outputFormat` as the Claude Agent SDK reads it: `{ type: 'json_schema', schema }`, with the
 * schema passed through as written. Anything else is dropped.
 */
function toOutputFormatOption(value: unknown): Options['outputFormat'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  if (source.type !== 'json_schema' || !source.schema || typeof source.schema !== 'object') return undefined;
  return { type: 'json_schema', schema: source.schema as Record<string, unknown> };
}

/**
 * `config.model.parameters` as `query()` options: camelized, narrowed to
 * `FORWARDED_QUERY_OPTION_KEYS`, with `thinking` and `outputFormat` rebuilt in the shapes the SDK
 * reads. A config that sets none of them produces `{}`.
 */
export function buildModelParameterQueryOptions(
  parameters: AiConfigRep['model']['parameters'] | unknown,
): Partial<Options> {
  const options = pickForwardedModelParameters(
    camelizeModelParameters(normalizeModelParameters(parameters)),
    FORWARDED_QUERY_OPTION_KEYS,
  );
  if (options.thinking !== undefined) {
    const thinking = toThinkingOption(options.thinking);
    if (thinking) options.thinking = thinking;
    else delete options.thinking;
  }
  if (options.outputFormat !== undefined) {
    const outputFormat = toOutputFormatOption(options.outputFormat);
    if (outputFormat) options.outputFormat = outputFormat;
    else delete options.outputFormat;
  }
  return options as Partial<Options>;
}
