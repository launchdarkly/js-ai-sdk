import { createLangChainAgentsHandler } from '@launchdarkly/ai-langchain-agents';
import { createLangChainHandler } from '@launchdarkly/ai-langchain-messages';
import { config } from '@launchdarkly/ai-node';
import { fetchLaunchDarklyDocumentation, getPreferences, searchLdDocumentation, webSearch } from './tools';
import { newContext, writeOutput } from './utils';

export async function run(key: string, userInput: string): Promise<void> {
  const response = await config({
    key,
    handler: [createLangChainHandler(), createLangChainAgentsHandler()],
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
