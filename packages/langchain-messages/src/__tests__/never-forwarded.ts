import { expect } from 'vitest';

/**
 * The value every never-forwarded key carries in `NEVER_FORWARDED_PARAMETERS`. A handler that
 * passes any of those keys on, under any name or nested anywhere, leaves this string somewhere in
 * the options it builds, which is what `expectNoNeverForwardedValue` looks for.
 */
export const NEVER_FORWARDED = 'NEVER_FORWARDED';

/**
 * Keys that must never reach a provider, framework or host-process option from
 * `model.parameters`, in both the snake_case the LaunchDarkly UI writes and the camelCase the
 * frameworks read: credentials, endpoints and connection settings, request injection, remote
 * tools, and Claude Agents host-process settings, plus the keys this package's handler does not
 * forward under the cross-SDK allowlists (ai-sdks-monorepo TESTING.md §1.12).
 */
export const NEVER_FORWARDED_KEYS = [
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
  'organization',
  // endpoints and connection
  'base_url',
  'baseURL',
  'baseUrl',
  'anthropic_api_url',
  'anthropicApiUrl',
  'endpoint',
  'endpoint_host',
  'endpointHost',
  'endpoint_url',
  'endpointUrl',
  'region',
  'region_name',
  'regionName',
  'configuration',
  'client_options',
  'clientOptions',
  'default_headers',
  'defaultHeaders',
  'timeout',
  'max_retries',
  'maxRetries',
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
  // remote tools
  'mcp_servers',
  'mcpServers',
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
  'hooks',
  'can_use_tool',
  'canUseTool',
  'stderr',
  'abort_controller',
  'abortController',
  'spawn_claude_code_process',
  'spawnClaudeCodeProcess',
  // not on the cross-SDK LangChain lists: wiring, logging, response shape, streaming, data
  // location and retention, server-side state, guardrails, attribution
  'audio',
  'context_management',
  'contextManagement',
  'disable_streaming',
  'disableStreaming',
  'guardrail_config',
  'guardrailConfig',
  'inference_geo',
  'inferenceGeo',
  'metadata',
  'modalities',
  'output_version',
  'outputVersion',
  'prompt_cache_retention',
  'promptCacheRetention',
  'reasoning',
  'stream_usage',
  'streamUsage',
  'streaming',
  'supports_tool_choice_values',
  'supportsToolChoiceValues',
  'tags',
  'use_responses_api',
  'useResponsesApi',
  'user',
  'verbose',
  'zdr_enabled',
  'zdrEnabled',
] as const;

/** A `model.parameters` bag that sets every key in `NEVER_FORWARDED_KEYS` to `NEVER_FORWARDED`. */
export const NEVER_FORWARDED_PARAMETERS: Record<string, unknown> = Object.fromEntries(
  NEVER_FORWARDED_KEYS.map((key) => [key, NEVER_FORWARDED]),
);

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
 * Asserts that no `NEVER_FORWARDED` value appears anywhere in `options`, and that none of the
 * `NEVER_FORWARDED_KEYS` the handler does not own itself is set on it. `handlerOwned` lists the
 * keys the handler legitimately sets from its own state (Claude Agents sets `mcpServers` and
 * `hooks`, for example); those must still not carry the config's value.
 */
export function expectNoNeverForwardedValue(options: unknown, handlerOwned: ReadonlyArray<string> = []): void {
  expect(findNeverForwarded(options, '', new Set())).toBeUndefined();
  const record = options as Record<string, unknown>;
  const leaked = NEVER_FORWARDED_KEYS.filter((key) => !handlerOwned.includes(key) && record[key] !== undefined);
  expect(leaked).toEqual([]);
}
