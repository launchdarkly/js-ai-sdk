import { ClaudeWebSearch, createClaudeAgentsHandler } from '@launchdarkly/ai-claude-agents';
import { createClaudeMessagesHandler } from '@launchdarkly/ai-claude-messages';
import { createLangChainAgentsHandler } from '@launchdarkly/ai-langchain-agents';
import { createLangChainHandler } from '@launchdarkly/ai-langchain-messages';
import { globalRegistry } from '@launchdarkly/ai-node';
import { createOpenAIAgentHandler } from '@launchdarkly/ai-openai-agents';
import { createOpenAIHandler } from '@launchdarkly/ai-openai-messages';
import { fetchLaunchDarklyDocumentation, getPreferences, searchLdDocumentation } from './tools';

globalRegistry.register({
  handlers: [
    createOpenAIHandler(),
    createOpenAIAgentHandler(),
    createClaudeAgentsHandler(),
    createClaudeMessagesHandler(),
    createLangChainHandler(),
    createLangChainAgentsHandler(),
  ],
  tools: {
    'web-search': ClaudeWebSearch,
    'get-user-preferences': getPreferences,
    'search-ld-documentation': searchLdDocumentation,
    'fetch-ld-documentation': fetchLaunchDarklyDocumentation,
  },
});
