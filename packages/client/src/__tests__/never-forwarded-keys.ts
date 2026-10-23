/**
 * The never-forwarded `model.parameters` keys every handler package tests against (ai-sdks-monorepo
 * TESTING.md §1.12, "Never forwarded"). Each package's `__tests__/never-forwarded.ts` builds its bag
 * from this list with `createNeverForwarded`, adding the keys only its own handler drops, so the
 * bags cannot drift apart. This file is test code: packages import it by relative path, the same
 * way their `sdk-usage` tests read `client/src/version.ts`, so it adds no runtime dependency and is
 * not part of any published build.
 */
import { expect } from 'vitest';

/**
 * The value every never-forwarded key carries in the bag. A handler that passes any of those keys
 * on, under any name or nested anywhere, leaves this string somewhere in the options it builds,
 * which is what `expectNoNeverForwardedValue` looks for.
 */
export const NEVER_FORWARDED = 'NEVER_FORWARDED';

/**
 * Keys from every §1.12 never-forward category, in both the snake_case the LaunchDarkly UI writes
 * and the camelCase the TypeScript frameworks read. No handler forwards any of them, so every
 * package's bag includes all of them.
 */
export const SHARED_NEVER_FORWARDED_KEYS = [
  // credentials
  'api_key',
  'apiKey',
  'openai_api_key',
  'openAIApiKey',
  'anthropic_api_key',
  'anthropicApiKey',
  'bedrock_api_key',
  'bedrockApiKey',
  'bedrock_api_secret',
  'bedrockApiSecret',
  'credentials',
  'auth_token',
  'authToken',
  'access_token',
  'accessToken',
  'aws_access_key_id',
  'awsAccessKeyId',
  'aws_secret_access_key',
  'awsSecretAccessKey',
  'aws_session_token',
  'awsSessionToken',
  'vertex_credentials',
  'vertexCredentials',
  // endpoints and connection settings
  'organization',
  'base_url',
  'baseURL',
  'baseUrl',
  'api_base',
  'apiBase',
  'anthropic_api_url',
  'anthropicApiUrl',
  'endpoint',
  'endpoint_host',
  'endpointHost',
  'endpoint_url',
  'endpointUrl',
  'custom_llm_provider',
  'customLlmProvider',
  'api_version',
  'apiVersion',
  'deployment_id',
  'deploymentId',
  'model_list',
  'modelList',
  'configuration',
  'client_options',
  'clientOptions',
  'default_headers',
  'defaultHeaders',
  'default_query',
  'defaultQuery',
  'timeout',
  'request_timeout',
  'requestTimeout',
  'max_retries',
  'maxRetries',
  'num_retries',
  'numRetries',
  'fallbacks',
  'retry',
  'fetch',
  'http_client',
  'httpClient',
  'http_agent',
  'httpAgent',
  'proxy',
  'proxies',
  'client',
  // request injection
  'headers',
  'extra_headers',
  'extraHeaders',
  'extra_body',
  'extraBody',
  'extra_query',
  'extraQuery',
  'model_kwargs',
  'modelKwargs',
  'invocation_kwargs',
  'invocationKwargs',
  'additional_model_request_fields',
  'additionalModelRequestFields',
  'provider_data',
  'providerData',
  'provider_options',
  'providerOptions',
  'mock_response',
  'mockResponse',
  // remote tool attachment
  'mcp_servers',
  'mcpServers',
  // data location and retention
  'region',
  'region_name',
  'regionName',
  'aws_region_name',
  'awsRegionName',
  'inference_geo',
  'inferenceGeo',
  'store',
  'zdr_enabled',
  'zdrEnabled',
  'prompt_cache_retention',
  'promptCacheRetention',
  // server-side state
  'container',
  'reuse_last_container',
  'reuseLastContainer',
  'previous_response_id',
  'previousResponseId',
  'response_id',
  'responseId',
  'starting_after',
  'startingAfter',
  'conversation',
  // identity and attribution
  'user',
  'safety_identifier',
  'safetyIdentifier',
  'user_profile_id',
  'userProfileId',
  'metadata',
  'request_metadata',
  'requestMetadata',
  // handler and runtime wiring
  'streaming',
  'stream_usage',
  'streamUsage',
  'disable_streaming',
  'disableStreaming',
  'include_usage',
  'includeUsage',
  'output_version',
  'outputVersion',
  'tags',
  'verbose',
  'use_responses_api',
  'useResponsesApi',
  'supports_tool_choice_values',
  'supportsToolChoiceValues',
  'include',
  'response_include',
  'responseInclude',
  'truncation',
  'context_management',
  'contextManagement',
  'audio',
  'modalities',
  // prompt content beyond the config's instructions
  'system',
  'prefix_messages',
  'prefixMessages',
  'instructions',
  // safety configuration
  'guardrails',
  'guardrail_config',
  'guardrailConfig',
  'guard_last_turn_only',
  'guardLastTurnOnly',
  'moderation',
  // Claude Agents host-process settings
  'path_to_claude_code_executable',
  'pathToClaudeCodeExecutable',
  'cli_path',
  'cliPath',
  'executable',
  'executable_args',
  'executableArgs',
  'extra_args',
  'extraArgs',
  'env',
  'cwd',
  'additional_directories',
  'additionalDirectories',
  'add_dirs',
  'addDirs',
  'permission_mode',
  'permissionMode',
  'allow_dangerously_skip_permissions',
  'allowDangerouslySkipPermissions',
  'settings',
  'setting_sources',
  'settingSources',
  'managed_settings',
  'managedSettings',
  'plugins',
  'sandbox',
  'resume',
  'resume_session_at',
  'resumeSessionAt',
  'session_id',
  'sessionId',
  'fork_session',
  'forkSession',
  'continue',
  'continue_conversation',
  'continueConversation',
  'hooks',
  // callables and live objects
  'callbacks',
  'can_use_tool',
  'canUseTool',
  'stderr',
  'rate_limiter',
  'rateLimiter',
  'shared_session',
  'sharedSession',
  'abort_controller',
  'abortController',
  'spawn_claude_code_process',
  'spawnClaudeCodeProcess',
] as const;

function findNeverForwarded(value: unknown, path: string, seen: Set<unknown>): string | undefined {
  if (value === NEVER_FORWARDED) return path || '(root)';
  if (!value || typeof value !== 'object' || seen.has(value)) return undefined;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    const found = findNeverForwarded(child, path ? `${path}.${key}` : key, seen);
    if (found) return found;
  }
  return undefined;
}

/**
 * One package's never-forward bag: `SHARED_NEVER_FORWARDED_KEYS` plus `extraKeys`, the keys that
 * package's handler also drops under its own §1.12 table (for example `reasoning` for the
 * LangChain `ChatOpenAI` list). An extra key must be one the handler never forwards.
 */
export function createNeverForwarded(extraKeys: ReadonlyArray<string> = []) {
  const keys: ReadonlyArray<string> = [...new Set([...SHARED_NEVER_FORWARDED_KEYS, ...extraKeys])];

  /** A `model.parameters` bag that sets every key to `NEVER_FORWARDED`. */
  const parameters: Record<string, unknown> = Object.fromEntries(keys.map((key) => [key, NEVER_FORWARDED]));

  /**
   * Asserts that no `NEVER_FORWARDED` value appears anywhere in `options`, and that none of the
   * keys the handler does not own itself is set on it. `handlerOwned` lists the keys the handler
   * legitimately sets from its own state (Claude Agents sets `mcpServers` and `hooks`, for
   * example); those must still not carry the config's value.
   */
  function expectNoNeverForwardedValue(options: unknown, handlerOwned: ReadonlyArray<string> = []): void {
    expect(findNeverForwarded(options, '', new Set())).toBeUndefined();
    const record = options as Record<string, unknown>;
    const leaked = keys.filter((key) => !handlerOwned.includes(key) && record[key] !== undefined);
    expect(leaked).toEqual([]);
  }

  return { keys, parameters, expectNoNeverForwardedValue };
}
