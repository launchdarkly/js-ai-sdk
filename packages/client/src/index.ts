/**
 * LaunchDarkly AI SDK core client for TypeScript.
 */
import { registerAiSdkPackage } from './sdk-info.js';
import { LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION } from './version.js';

// Reporting this package to LaunchDarkly is an import-time side effect on purpose.
// A package that reaches the running application reports itself; a package a bundler
// removes reports nothing, which is correct — an application that does not ship the
// package does not use it.
//
// Do not add "sideEffects": false to this package.json. It lets a bundler drop the call
// below and the package stops reporting, with no build or test failure to show it.
registerAiSdkPackage(LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION);

export type { AiConfigRep } from './client.js';
export { config } from './client.js';
export type { ContentCaptureOptions, SpanMessage, SpanMessagePart, ToolDefinitionInput } from './content.js';
export {
  langChainFinishReasons,
  langChainSpanMessages,
  setInputContentAttributes,
  setOutputContentAttributes,
  setToolCallContentAttributes,
  setToolDefinitionAttributes,
  textMessage,
  toSemconvFinishReason,
} from './content.js';
export {
  ConversationIdSpanProcessor,
  setConversationIdIfAbsent,
  withConversationId,
} from './conversation.js';
export { graph, resolveGraph } from './graph.js';
export { buildJudgeTasks, runJudge } from './judges.js';
export type { InspectConfigResult } from './lifecycle.js';
export { getClient, initClient, inspectConfig, shutdown, shutdownTelemetry, waitForTelemetry } from './lifecycle.js';
export { compose, globalRegistry, Registry } from './registry.js';
export { registerAiSdkPackage } from './sdk-info.js';
export type {
  ConfigArgs,
  GraphArgs,
  GraphDefinition,
  GraphEdge,
  GraphNode,
  GraphOptions,
  GraphTopology,
  HandlerStreamEvent,
  JudgeCallResult,
  JudgeRunResult,
  JudgeTask,
  LDClientInterface,
  LDContext,
  LDMultiKindContext,
  LDSingleKindContext,
  LDUser,
  Message,
  ProviderGraphResponse,
  ProviderHandler,
  ProviderResponse,
  ProviderSetupFn,
  RegistryInput,
  RouteResult,
  RunNodeOptions,
  StreamEvent,
  TokenUsage,
  Tool,
  ToolHandlerFn,
  TrackData,
  TraverseVisitor,
  VariationMeta as LDVariationMeta,
} from './types.js';
export { GraphTopologySchema, NATIVE_TOOL_KEY, NativeTool } from './types.js';
export type { RunUsage, SpanUsage } from './utils.js';
export {
  addCachedTokensToInput,
  collapseMessagesToInstructions,
  createHandler,
  createRunUsage,
  endSpanOnce,
  langChainSpanUsage,
  parseJSONWithPossibleFences,
  parseTemplate,
  setLdSpanAttributes,
  setModelIdentityAttributes,
  setUsageSpanAttributes,
} from './utils.js';
