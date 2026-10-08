/** LaunchDarkly AI SDK integration for LiteLLM messages. */
import { registerAiSdkPackage } from '@launchdarkly/ai-server';
import { LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION } from './version.js';

registerAiSdkPackage(LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION);

export {
  createLiteLLMMessagesHandler,
  type LiteLLMMessagesOptions,
  litellmMessages,
} from './handler.js';
