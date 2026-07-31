import { langchainAgents } from '@launchdarkly/ai-langchain-agents';
import { fetchLaunchDarklyDocumentation, getPreferences, searchLdDocumentation, webSearch } from './tools';
import { newContext, writeOutput } from './utils';

export async function run(key: string, userInput: string): Promise<void> {
  const response = await langchainAgents(key, userInput, newContext(), {
    toolHandlers: {
      'get-user-preferences': getPreferences,
      'search-ld-documentation': searchLdDocumentation,
      'fetch-ld-documentation': fetchLaunchDarklyDocumentation,
      'fetch-launchdarkly-documentation': fetchLaunchDarklyDocumentation,
      'web-search': webSearch,
    },
  });
  writeOutput(response);
}
