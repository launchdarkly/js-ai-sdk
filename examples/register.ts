import { ClaudeWebSearch, createClaudeAgentsHandler } from '@launchdarkly/ai-claude-agents';
import { createClaudeMessagesHandler } from '@launchdarkly/ai-claude-messages';
import { createLangChainAgentsHandler } from '@launchdarkly/ai-langchain-agents';
import { createLangChainMessagesHandler } from '@launchdarkly/ai-langchain-messages';
import { globalRegistry } from '@launchdarkly/ai-node';
import { createOpenAIAgentsHandler } from '@launchdarkly/ai-openai-agents';
import { createOpenAIMessagesHandler } from '@launchdarkly/ai-openai-messages';
import { createTypesafeHandler } from '@launchdarkly/ai-typesafe';
import { fetchLaunchDarklyDocumentation, getPreferences, searchLdDocumentation } from './tools';

globalRegistry.register({
  handlers: [
    createOpenAIMessagesHandler(),
    createOpenAIAgentsHandler(),
    createClaudeAgentsHandler(),
    createClaudeMessagesHandler(),
    createLangChainMessagesHandler(),
    createLangChainAgentsHandler(),
    createTypesafeHandler(),
  ],
  tools: {
    'web-search': ClaudeWebSearch,
    'get-user-preferences': getPreferences,
    'search-ld-documentation': searchLdDocumentation,
    'fetch-ld-documentation': fetchLaunchDarklyDocumentation,
  },
});
