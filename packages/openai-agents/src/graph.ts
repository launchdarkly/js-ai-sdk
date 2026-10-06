import { type GraphOptions, graph, reportUsage, withinSdk } from '@launchdarkly/ai-server';
import { createOpenAIAgentHandler } from './handler.js';

/**
 * Runs an agent graph with the OpenAI agent handler pre-bound. Equivalent to
 * `graph(key, { ...options, handlers: [createOpenAIAgentHandler()] })`.
 * Use the base `graph()` directly for multi-provider graphs.
 */
export const openaiGraph = (key: string, options: Omit<GraphOptions, 'handlers'>) => {
  reportUsage('openai-agents.openaiGraph');
  return withinSdk(() => graph(key, { ...options, handlers: [createOpenAIAgentHandler()] }));
};
