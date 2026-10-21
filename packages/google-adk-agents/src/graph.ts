/**
 * Graph convenience wrapper. Callers cannot replace the pre-wired ADK handler.
 */
import { type GraphOptions, graphInternal, reportUsage } from '@launchdarkly/ai-server';
import { createGoogleAdkAgentsHandlerInternal, type GoogleAdkAgentsOptions } from './handler.js';
import { LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION } from './version.js';

export type GoogleAdkGraphOptions = Omit<GraphOptions, 'handlers'> &
  GoogleAdkAgentsOptions & {
    /** Ignored. This wrapper always installs its own wildcard handler. */
    handlers?: unknown;
  };

export function googleAdkGraph(key: string, options: GoogleAdkGraphOptions = {}) {
  reportUsage('google-adk-agents.googleAdkGraph', LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION);
  const { handlers: _handlers, apiKey, useVertexai, project, location, model, captureContent, ...rest } = options;
  return graphInternal(key, {
    ...rest,
    handlers: [createGoogleAdkAgentsHandlerInternal({ apiKey, useVertexai, project, location, model, captureContent })],
  });
}
