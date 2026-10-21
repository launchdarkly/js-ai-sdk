import { type GraphOptions, graphInternal, reportUsage } from '@launchdarkly/ai-server';
import { createLiteLLMAgentsHandlerInternal, type LiteLLMAgentsOptions } from './handler.js';
import { LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION } from './version.js';

export type LiteLLMGraphOptions = Omit<GraphOptions, 'handlers'> & LiteLLMAgentsOptions;

/** Runs a LaunchDarkly graph with a wildcard LiteLLM proxy handler pre-bound. */
export const litellmGraph = (
  key: string,
  { apiKey, baseURL, captureContent, client, clientFactory, ...options }: LiteLLMGraphOptions,
) => {
  reportUsage('litellm-agents.litellmGraph', LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION);
  return graphInternal(key, {
    ...options,
    handlers: [createLiteLLMAgentsHandlerInternal({ apiKey, baseURL, captureContent, client, clientFactory })],
  });
};
