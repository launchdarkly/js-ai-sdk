import { type GraphOptions, graph } from '@launchdarkly/ai-server';
import { createClaudeAgentsHandler } from './handler.js';

/**
 * Runs an agent graph with the Claude agent handler pre-bound. Equivalent to
 * `graph(key, { ...options, handlers: [createClaudeAgentsHandler()] })`.
 * Use the base `graph()` directly for multi-provider graphs.
 */
export const claudeGraph = (key: string, options: Omit<GraphOptions, 'handlers'>) =>
  graph(key, { ...options, handlers: [createClaudeAgentsHandler()] });
