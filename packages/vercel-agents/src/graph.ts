import { type GraphOptions, graph, reportUsage, withinSdk } from '@launchdarkly/ai-server';
import { createVercelAgentsHandler, type VercelAgentsOptions } from './handler.js';

export type VercelGraphOptions = Omit<GraphOptions, 'handlers'> & VercelAgentsOptions;

export const vercelGraph = (key: string, { model, modelFactory, captureContent, ...options }: VercelGraphOptions) => {
  reportUsage('vercel-agents.vercelGraph');
  return withinSdk(() =>
    graph(key, {
      ...options,
      handlers: [createVercelAgentsHandler({ model, modelFactory, captureContent })],
    }),
  );
};
