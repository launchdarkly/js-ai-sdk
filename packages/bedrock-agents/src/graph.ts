import { type GraphOptions, graphInternal, reportUsage } from '@launchdarkly/ai-server';
import { createBedrockAgentsHandlerInternal } from './handler.js';
import { LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION } from './version.js';

/** Runs a generic LaunchDarkly graph with exactly one Bedrock Strands handler. */
export const bedrockGraph = (key: string, options: Omit<GraphOptions, 'handlers'>) => {
  reportUsage('bedrock-agents.bedrockGraph', LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION);
  return graphInternal(key, { ...options, handlers: [createBedrockAgentsHandlerInternal()] });
};
