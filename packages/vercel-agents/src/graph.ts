import { type GraphOptions, graph } from '@launchdarkly/ai-server';
import { createVercelAgentsHandler, type VercelAgentsOptions } from './handler.js';

export type VercelGraphOptions = Omit<GraphOptions, 'handlers'> & VercelAgentsOptions;

export const vercelGraph = (key: string, { model, modelFactory, captureContent, ...options }: VercelGraphOptions) =>
  graph(key, {
    ...options,
    handlers: [createVercelAgentsHandler({ model, modelFactory, captureContent })],
  });
