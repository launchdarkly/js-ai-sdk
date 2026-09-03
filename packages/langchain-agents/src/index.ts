/**
 * LaunchDarkly AI SDK integration for LangChain agents.
 */
import { registerAiSdkPackage } from '@launchdarkly/ai-server';
import { LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION } from './version.js';

registerAiSdkPackage(LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION);

export { langchainGraph } from './graph.js';
export { createLangChainAgentsHandler, langchainAgents } from './handler.js';
export { toLangGraph } from './native-graph.js';
