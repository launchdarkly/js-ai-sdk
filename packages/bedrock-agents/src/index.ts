/** LaunchDarkly AI SDK integration for Strands Agents on Amazon Bedrock. */
import { registerAiSdkPackage } from '@launchdarkly/ai-server';
import { LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION } from './version.js';

registerAiSdkPackage(LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION);

export { bedrockGraph } from './graph.js';
export {
  type BedrockAgentsHandlerOptions,
  bedrockAgents,
  createBedrockAgentsHandler,
  resolveBedrockModelId,
} from './handler.js';
