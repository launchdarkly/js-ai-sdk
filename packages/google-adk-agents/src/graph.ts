/**
 * Graph convenience wrapper. Callers cannot replace the pre-wired ADK handler.
 */
import { type GraphOptions, graph } from '@launchdarkly/ai-server';
import { createGoogleAdkAgentsHandler, type GoogleAdkAgentsOptions } from './handler.js';

export type GoogleAdkGraphOptions = Omit<GraphOptions, 'handlers'> &
  GoogleAdkAgentsOptions & {
    /** Ignored. This wrapper always installs its own wildcard handler. */
    handlers?: unknown;
  };

export function googleAdkGraph(key: string, options: GoogleAdkGraphOptions = {}) {
  const { handlers: _handlers, apiKey, useVertexai, project, location, model, captureContent, ...rest } = options;
  return graph(key, {
    ...rest,
    handlers: [createGoogleAdkAgentsHandler({ apiKey, useVertexai, project, location, model, captureContent })],
  });
}
