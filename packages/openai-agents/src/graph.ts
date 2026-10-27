import { type GraphOptions, graphInternal, reportUsage } from '@launchdarkly/ai-server';
import { createOpenAIAgentsHandlerInternal } from './handler.js';
import { LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION } from './version.js';

/**
 * Runs an agent graph with the OpenAI agent handler pre-bound. Equivalent to
 * `graph(key, { ...options, handlers: [createOpenAIAgentsHandler()] })`.
 * Use the base `graph()` directly for multi-provider graphs.
 */
export const openaiGraph = (key: string, options: Omit<GraphOptions, 'handlers'>) => {
  reportUsage('openai-agents.openaiGraph', LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION);
  return graphInternal(key, { ...options, handlers: [createOpenAIAgentsHandlerInternal()] });
};
