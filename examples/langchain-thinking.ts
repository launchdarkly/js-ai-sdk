import { ChatAnthropic } from '@langchain/anthropic';
import { createLangChainHandler } from '@launchdarkly/ai-langchain-messages';
import { config } from '@launchdarkly/ai-node';
import { fetchLaunchDarklyDocumentation, getPreferences, searchLdDocumentation, webSearch } from './tools';
import { newContext, writeOutput } from './utils';

/**
 * LangChain messages against a Claude model with extended thinking turned on.
 *
 * Point this at a flag whose `model.parameters` enable thinking (and whose `max_tokens` exceeds
 * the thinking budget). Anthropic then returns `content` as a list of blocks — a `thinking` block
 * followed by a `text` block — instead of a plain string. A handler that only reads string content
 * reports an empty response for these runs while the tokens are still spent, so this example fails
 * loudly when no text comes back.
 *
 * Anthropic omits thinking from the turn that follows a tool result, so give this a prompt the
 * model can answer on its own — a run that goes through the tool loop ends on a plain string and
 * never reaches the block-shaped content this exercises.
 *
 * The model is built after flag evaluation so `config.model.parameters` can be applied unchanged.
 */
export async function run(key: string, userInput: string): Promise<void> {
  const response = await config({
    key,
    handler: createLangChainHandler((aiConfig) => {
      const parameters =
        aiConfig.model.parameters && typeof aiConfig.model.parameters === 'object' ? aiConfig.model.parameters : {};
      return new ChatAnthropic({
        ...parameters,
        model: aiConfig.model.name,
      });
    }),
    toolHandlers: {
      'get-user-preferences': getPreferences,
      'search-ld-documentation': searchLdDocumentation,
      'fetch-ld-documentation': fetchLaunchDarklyDocumentation,
      'fetch-launchdarkly-documentation': fetchLaunchDarklyDocumentation,
      'web-search': webSearch,
    },
  }).invoke(userInput, newContext(), { user_input: userInput });

  if (!response.response?.trim()) {
    throw new Error(
      'Model returned no text. A thinking-enabled model returns content as a list of blocks, and the handler dropped it.',
    );
  }

  writeOutput(response);
}
