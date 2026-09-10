import { ChatAnthropic } from '@langchain/anthropic';
import { createLangChainHandler } from '@launchdarkly/ai-langchain-messages';
import { config } from '@launchdarkly/ai-node';
import { fetchLaunchDarklyDocumentation, getPreferences, searchLdDocumentation, webSearch } from './tools';
import { newContext, writeOutput } from './utils';

// Anthropic requires maxTokens to exceed the thinking budget.
const THINKING_BUDGET_TOKENS = 1024;
const MAX_TOKENS = 4096;

/**
 * LangChain messages against a Claude model with extended thinking turned on.
 *
 * With thinking on, Anthropic returns `content` as a list of blocks — a `thinking` block followed
 * by a `text` block — instead of a plain string. A handler that only reads string content reports
 * an empty response for these runs while the tokens are still spent, so this example fails loudly
 * when no text comes back.
 *
 * Anthropic omits thinking from the turn that follows a tool result, so give this a prompt the
 * model can answer on its own — a run that goes through the tool loop ends on a plain string and
 * never reaches the block-shaped content this exercises.
 *
 * The model is built after flag evaluation so `config.model.parameters` can be applied unchanged.
 * Thinking is still merged in here because the Claude messages flag does not enable it on its own.
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
        thinking: { type: 'enabled', budget_tokens: THINKING_BUDGET_TOKENS },
        maxTokens: MAX_TOKENS,
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
