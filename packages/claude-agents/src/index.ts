/**
 * LaunchDarkly AI SDK integration for Claude agents.
 */
import { registerAiSdkPackage } from '@launchdarkly/ai-server';
import { LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION } from './version.js';

// Reporting this package to LaunchDarkly is an import-time side effect on purpose.
// A package that reaches the running application reports itself; a package a bundler
// removes reports nothing, which is correct — an application that does not ship the
// package does not use it.
//
// Do not add "sideEffects": false to this package.json. It lets a bundler drop the call
// below and the package stops reporting, with no build or test failure to show it.
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
