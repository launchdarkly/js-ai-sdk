import { type GraphOptions, graph } from '@launchdarkly/ai-server';
import { createLiteLLMAgentsHandler, type LiteLLMAgentsOptions } from './handler.js';

export type LiteLLMGraphOptions = Omit<GraphOptions, 'handlers'> & LiteLLMAgentsOptions;

/** Runs a LaunchDarkly graph with a wildcard LiteLLM proxy handler pre-bound. */
export const litellmGraph = (
  key: string,
  { apiKey, baseURL, captureContent, client, clientFactory, ...options }: LiteLLMGraphOptions,
) =>
  graph(key, {
    ...options,
    handlers: [createLiteLLMAgentsHandler({ apiKey, baseURL, captureContent, client, clientFactory })],
  });
