import { openaiAgents } from '@launchdarkly/ai-openai-agents';
import { fetchLaunchDarklyDocumentation, getPreferences, searchLdDocumentation } from './tools';
import { newContext, writeOutput } from './utils';

export async function run(key: string, userInput: string): Promise<void> {
  const response = await openaiAgents(key, userInput, newContext(), {
    toolHandlers: {
      'get-user-preferences': getPreferences,
      'search-ld-documentation': searchLdDocumentation,
      'fetch-launchdarkly-documentation': fetchLaunchDarklyDocumentation,
    },
  });
  writeOutput(response);
}
