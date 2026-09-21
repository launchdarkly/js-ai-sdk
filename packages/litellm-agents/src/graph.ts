import { type GraphOptions, graph } from '@launchdarkly/ai-server';
import { createLiteLLMAgentHandler, type LiteLLMAgentOptions } from './handler.js';

export type LiteLLMGraphOptions = Omit<GraphOptions, 'handlers'> & LiteLLMAgentOptions;

/** Runs a LaunchDarkly graph with a wildcard LiteLLM proxy handler pre-bound. */
export const litellmGraph = (
  key: string,
  { apiKey, baseURL, captureContent, client, clientFactory, ...options }: LiteLLMGraphOptions,
) =>
  graph(key, {
    ...options,
    handlers: [createLiteLLMAgentHandler({ apiKey, baseURL, captureContent, client, clientFactory })],
  });
