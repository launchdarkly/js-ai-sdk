import { type GraphOptions, graph } from '@launchdarkly/ai-server';
import { createOpenAIAgentHandler } from './handler.js';

/**
 * Runs an agent graph with the OpenAI agent handler pre-bound. Equivalent to
 * `graph(key, { ...options, handlers: [createOpenAIAgentHandler()] })`.
 * Use the base `graph()` directly for multi-provider graphs.
 */
export const openaiGraph = (key: string, options: Omit<GraphOptions, 'handlers'>) =>
  graph(key, { ...options, handlers: [createOpenAIAgentHandler()] });
