import { type GraphOptions, graphInternal, reportUsage } from '@launchdarkly/ai-server';
import { createClaudeAgentsHandlerInternal } from './handler.js';
import { LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION } from './version.js';

/**
 * Runs an agent graph with the Claude agent handler pre-bound. Equivalent to
 * `graph(key, { ...options, handlers: [createClaudeAgentsHandler()] })`.
 * Use the base `graph()` directly for multi-provider graphs.
 */
export const claudeGraph = (key: string, options: Omit<GraphOptions, 'handlers'>) => {
  reportUsage('claude-agents.claudeGraph', LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION);
  return graphInternal(key, { ...options, handlers: [createClaudeAgentsHandlerInternal()] });
};
