import { claudeMessages } from '@launchdarkly/ai-claude-messages';
import { fetchLaunchDarklyDocumentation, getPreferences, searchLdDocumentation } from './tools';
import { newContext, writeOutput } from './utils';

export async function run(key: string, userInput: string): Promise<void> {
  const response = await claudeMessages(key, userInput, newContext(), {
    toolHandlers: {
      'get-user-preferences': getPreferences,
      'search-ld-documentation': searchLdDocumentation,
      'fetch-launchdarkly-documentation': fetchLaunchDarklyDocumentation,
    },
    variables: { user_input: userInput },
  });
  writeOutput(response);
}
