import { type GraphOptions, graphInternal, reportUsage } from '@launchdarkly/ai-server';
import { createVercelAgentsHandlerInternal, type VercelAgentsOptions } from './handler.js';

export type VercelGraphOptions = Omit<GraphOptions, 'handlers'> & VercelAgentsOptions;

export const vercelGraph = (key: string, { model, modelFactory, captureContent, ...options }: VercelGraphOptions) => {
  reportUsage('vercel-agents.vercelGraph');
  return graphInternal(key, {
    ...options,
    handlers: [createVercelAgentsHandlerInternal({ model, modelFactory, captureContent })],
  });
};
