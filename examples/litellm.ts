import { createLiteLLMAgentHandler } from '@launchdarkly/ai-litellm-agents';
import { createLiteLLMMessagesHandler } from '@launchdarkly/ai-litellm-messages';
import { config } from '@launchdarkly/ai-node';
import { fetchLaunchDarklyDocumentation, getPreferences, searchLdDocumentation, webSearch } from './tools';
import { newContext, writeOutput } from './utils';

/**
 * Runs either a messages-mode or agent-mode AI Config through a LiteLLM proxy.
 *
 * The handlers read LITELLM_BASE_URL and optional LITELLM_API_KEY. Explicit
 * handler options can override either value.
 */
export async function run(key: string, userInput: string): Promise<void> {
  const response = await config({
    key,
    handler: [createLiteLLMMessagesHandler(), createLiteLLMAgentHandler()],
    toolHandlers: {
      'get-user-preferences': getPreferences,
      'search-ld-documentation': searchLdDocumentation,
      'fetch-ld-documentation': fetchLaunchDarklyDocumentation,
      'fetch-launchdarkly-documentation': fetchLaunchDarklyDocumentation,
      'web-search': webSearch,
    },
  }).invoke(userInput, newContext(), { user_input: userInput });

  writeOutput(response);
}
