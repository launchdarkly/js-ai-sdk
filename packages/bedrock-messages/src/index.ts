/** LaunchDarkly AI SDK integration for Amazon Bedrock Converse. */
import { registerAiSdkPackage } from '@launchdarkly/ai-server';
import { LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION } from './version.js';

registerAiSdkPackage(LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION);

export {
  type BedrockMessagesHandlerOptions,
  bedrockMessages,
  createBedrockMessagesHandler,
  resolveBedrockModelId,
} from './handler.js';
