import { registerAiSdkPackage } from '@launchdarkly/ai-server';
import { LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION } from './version.js';

registerAiSdkPackage(LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION);

export { type VercelGraphOptions, vercelGraph } from './graph.js';
export {
  createVercelAgentsHandler,
  type VercelAgentsOptions,
  vercelAgents,
} from './handler.js';
export { toVercelAgents, type VercelNativeGraphOptions } from './native-graph.js';
