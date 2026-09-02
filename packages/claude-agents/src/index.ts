/**
 * LaunchDarkly AI SDK integration for Claude agents.
 */
import { registerAiSdkPackage } from '@launchdarkly/ai-server';
import { LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION } from './version.js';

registerAiSdkPackage(LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION);

export {
  ClaudeBash,
  ClaudeEdit,
  ClaudeGlob,
  ClaudeGrep,
  ClaudeNotebookEdit,
  ClaudeRead,
  ClaudeTodoWrite,
  ClaudeWebFetch,
  ClaudeWebSearch,
  ClaudeWrite,
} from './builtins.js';
export { claudeGraph } from './graph.js';
export { claudeAgents, createClaudeAgentsHandler } from './handler.js';
export { toClaudeAgents } from './native-graph.js';
