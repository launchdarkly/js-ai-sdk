/**
 * LaunchDarkly AI SDK integration for Google ADK agents.
 */
import { registerAiSdkPackage } from '@launchdarkly/ai-server';
import { LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION } from './version.js';

registerAiSdkPackage(LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION);

export { googleAdkGraph } from './graph.js';
export {
  createGoogleAdkAgentsHandler,
  type GoogleAdkAgentsOptions,
  googleAdkAgents,
  historyContents,
} from './handler.js';
export { toAdkAgents } from './native-graph.js';
