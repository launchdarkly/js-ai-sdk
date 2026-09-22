/**
 * LaunchDarkly AI SDK core client for TypeScript.
 */
import { registerAiSdkPackage } from './sdk-info.js';
import { LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION } from './version.js';

// Reporting this package to LaunchDarkly is an import-time side effect on purpose.
registerAiSdkPackage(LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION);

export type { AiConfigRep } from './client.js';
export { config } from './client.js';
export type { ContentCaptureOptions, SpanMessage, SpanMessagePart, ToolDefinitionInput } from './content.js';
export {
  langChainContentText,
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
export type { CanonicalTurn, ConfigTurn } from './history.js';
export {
  anyMultimodal,
  composeHistory,
  contentToText,
  hasMultimodalContent,
  imageBlockToUrl,
  isContentBlocks,
} from './history.js';
export { buildJudgeTasks, runJudge } from './judges.js';
export type { InspectConfigResult } from './lifecycle.js';
export { getClient, initClient, inspectConfig, shutdown, shutdownTelemetry, waitForTelemetry } from './lifecycle.js';
export { compose, globalRegistry, Registry } from './registry.js';
export { registerAiSdkPackage } from './sdk-info.js';
export { makeNodeTrackData } from './tracking.js';
export type {
  ConfigArgs,
  ConfigMessage,
  ContentBlock,
  GraphArgs,
  GraphDefinition,
  GraphEdge,
  GraphNode,
  GraphOptions,
  GraphTopology,
  HandlerStreamEvent,
  ImageContentBlock,
  JudgeCallResult,
  JudgeRunResult,
  JudgeTask,
  LDClientInterface,
  LDContext,
  LDMultiKindContext,
  LDSingleKindContext,
  LDUser,
  Message,
  MessageContent,
  ProviderGraphResponse,
  ProviderHandler,
  ProviderResponse,
  ProviderSetupFn,
  RegistryInput,
  RouteResult,
  RunNodeOptions,
  StreamEvent,
  TextContentBlock,
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
  normalizeModelParameters,
  omitModelStamps,
  parseJSONWithPossibleFences,
  parseTemplate,
  pickForwardedModelParameters,
  setLdSpanAttributes,
  setModelIdentityAttributes,
  setUsageSpanAttributes,
} from './utils.js';
