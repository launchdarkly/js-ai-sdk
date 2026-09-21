/** LaunchDarkly AI SDK integration for LiteLLM agents. */
import { registerAiSdkPackage } from '@launchdarkly/ai-server';
import { LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION } from './version.js';

registerAiSdkPackage(LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION);

export { type LiteLLMGraphOptions, litellmGraph } from './graph.js';
export {
  createLiteLLMAgentHandler,
  type LiteLLMAgentOptions,
  litellmAgents,
} from './handler.js';
export { type LiteLLMNativeGraphOptions, toLiteLLMAgents } from './native-graph.js';
