import { type GraphOptions, graphInternal, reportUsage } from '@launchdarkly/ai-server';
import { createClaudeAgentsHandlerInternal } from './handler.js';

/**
 * Runs an agent graph with the Claude agent handler pre-bound. Equivalent to
 * `graph(key, { ...options, handlers: [createClaudeAgentsHandler()] })`.
 * Use the base `graph()` directly for multi-provider graphs.
 */
export const claudeGraph = (key: string, options: Omit<GraphOptions, 'handlers'>) => {
  reportUsage('claude-agents.claudeGraph');
  return graphInternal(key, { ...options, handlers: [createClaudeAgentsHandlerInternal()] });
};
