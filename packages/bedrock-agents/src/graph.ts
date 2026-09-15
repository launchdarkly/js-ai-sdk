import { type GraphOptions, graph } from '@launchdarkly/ai-server';
import { createBedrockAgentsHandler } from './handler.js';

/** Runs a generic LaunchDarkly graph with exactly one Bedrock Strands handler. */
export const bedrockGraph = (key: string, options: Omit<GraphOptions, 'handlers'>) =>
  graph(key, { ...options, handlers: [createBedrockAgentsHandler()] });
