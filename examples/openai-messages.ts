import { openaiMessages } from '@launchdarkly/ai-openai-messages';
import { fetchLaunchDarklyDocumentation, getPreferences, searchLdDocumentation, webSearch } from './tools';
import { newContext, writeOutput } from './utils';

export async function run(key: string, userInput: string): Promise<void> {
  const response = await openaiMessages(key, userInput, newContext(), {
    toolHandlers: {
      'get-user-preferences': getPreferences,
      'search-ld-documentation': searchLdDocumentation,
      'fetch-ld-documentation': fetchLaunchDarklyDocumentation,
      'fetch-launchdarkly-documentation': fetchLaunchDarklyDocumentation,
      'web-search': webSearch,
    },
    variables: { user_input: userInput },
  });
  writeOutput(response);
}
