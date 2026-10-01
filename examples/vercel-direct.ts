import { openai } from '@ai-sdk/openai';
import { vercelMessages } from '@launchdarkly/ai-vercel-messages';
import { fetchLaunchDarklyDocumentation, getPreferences, searchLdDocumentation, webSearch } from './tools';
import { newContext, writeOutput } from './utils';

/**
 * Injects a constructed OpenAI LanguageModel so the Vercel adapter skips AI Gateway.
 *
 * Usage:
 *   yarn start vercel-direct launch-darkly-documentation-summarizer-messages-openai "What is the LaunchDarkly AI SDK?"
 */
export async function run(key: string, userInput: string): Promise<void> {
  const response = await vercelMessages(key, userInput, newContext(), {
    modelFactory: (config) => openai(config.model.name),
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
