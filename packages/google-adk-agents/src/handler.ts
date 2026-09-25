/**
 * Google ADK agent handler.
 *
 * Gemini Developer API is the default transport. Vertex is an explicit opt-in and
 * never shares an API key with that path. TypeScript @google/adk 2.1 has no LiteLLM
 * adapter, so a non-Gemini provider throws unless the caller injects a model.
 */

import * as adk from '@google/adk';
import { BasePlugin, createEvent, FunctionTool, Gemini, InMemoryRunner, isFinalResponse, LlmAgent } from '@google/adk';
import {
  type AiConfigRep,
  type ContentCaptureOptions,
  config,
  createHandler,
  type HandlerStreamEvent,
  type LDContext,
  type Message,
  NATIVE_TOOL_KEY,
  NativeTool,
  type ProviderHandler,
  parseTemplate,
  type SpanUsage,
  setInputContentAttributes,
  setOutputContentAttributes,
  setToolCallContentAttributes,
  textMessage,
} from '@launchdarkly/ai-server';
import type { Context, Span } from '@opentelemetry/api';
import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import {
  abandonOpenSpans as abandonToolSpans,
  failSpan,
  finishModelSpan,
  finishRootSpan,
  startModelSpan,
  startRootSpan,
  startToolSpan,
  succeedSpan,
} from './spans.js';

const GOOGLE_PROVIDERS = new Set(['google', 'gemini', 'vertex', 'google-genai', 'gcp.gemini']);
const APP_NAME = 'launchdarkly';

export type AdkPart = { text?: string; inlineData?: { mimeType: string; data: string } };
export type AdkContent = { role: string; parts: AdkPart[] };

export interface GoogleAdkAgentsOptions {
  apiKey?: string;
  useVertexai?: boolean;
  project?: string;
  location?: string;
  /** An ADK model instance, or `(config) => model`. Skips Gemini and the non-Gemini guard. */
  model?: unknown;
  captureContent?: boolean;
}

type ToolFn = ((...args: unknown[]) => unknown) | NativeTool;
type Usage = { input: number; output: number; total: number };
type Vertex = { project: string; location: string };

class LaunchDarklyTelemetryPlugin extends BasePlugin {
  private readonly toolSpans = new Map<string, Span>();
  private nativeStubs = new Map<string, () => unknown>();
  private instruction = '';
  private userText = '';

  constructor(
    private readonly ldConfig: AiConfigRep,
    private readonly parent: Context | undefined,
    private readonly captureContent: boolean,
  ) {
    super('launchdarkly');
  }

  bindTurn(instruction: string, userText: string, handlers: Record<string, ToolFn> | undefined): void {
    this.instruction = instruction;
    this.userText = userText;
    this.nativeStubs = nativeStubs(handlers);
  }

  override async afterModelCallback({
    llmResponse,
  }: {
    llmResponse: { usageMetadata?: unknown; content?: { parts?: Array<{ text?: string }> } };
  }): Promise<undefined> {
    const span = startModelSpan(this.ldConfig, this.parent);
    const output = (llmResponse?.content?.parts ?? []).map((part) => part.text ?? '').join('');
    setInputContentAttributes(span, this.captureContent, {
      systemInstructions: this.instruction || undefined,
      messages: this.userText ? [textMessage('user', this.userText)] : [],
    });
    if (output) setOutputContentAttributes(span, this.captureContent, [textMessage('assistant', output)]);
    finishModelSpan(span, this.ldConfig, toSpanUsage(readUsage(llmResponse?.usageMetadata)));
    return undefined;
  }

  override async beforeToolCallback({
    tool,
    toolContext,
  }: {
    tool: { name: string };
    toolContext?: { functionCallId?: string; function_call_id?: string };
  }): Promise<undefined> {
    const id = callId(toolContext, tool.name);
    this.toolSpans.set(id, startToolSpan(tool.name, id, this.parent));
    const stub = this.nativeStubs.get(tool.name);
    if (stub) stub();
    return undefined;
  }

  override async afterToolCallback({
    tool,
    toolArgs,
    toolContext,
    result,
  }: {
    tool: { name: string };
    toolArgs?: unknown;
    toolContext?: { functionCallId?: string; function_call_id?: string };
    result?: unknown;
  }): Promise<undefined> {
    const id = callId(toolContext, tool.name);
    const span = this.toolSpans.get(id);
    this.toolSpans.delete(id);
    if (span) setToolCallContentAttributes(span, this.captureContent, { arguments: toolArgs, result });
    if (span && typeof span.setStatus === 'function') span.setStatus({ code: SpanStatusCode.OK });
    succeedSpan(span);
    return undefined;
  }

  override async onToolErrorCallback({
    tool,
    toolContext,
    error,
  }: {
    tool: { name: string };
    toolContext?: { functionCallId?: string; function_call_id?: string };
    error: Error;
  }): Promise<Record<string, unknown>> {
    const id = callId(toolContext, tool.name);
    const span = this.toolSpans.get(id) ?? startToolSpan(tool.name, id, this.parent);
    this.toolSpans.delete(id);
    failSpan(span, error);
    return { error: error.message };
  }

  closeOpenSpans(error: unknown): void {
    for (const span of this.toolSpans.values()) failSpan(span, error);
    this.toolSpans.clear();
  }

  abandonOpenSpans(): void {
    abandonToolSpans([...this.toolSpans.values()], new Set());
    this.toolSpans.clear();
  }
}

export function historyContents(history: Array<{ role: string; content: unknown }> | undefined): AdkContent[] {
  return (history ?? []).map((message) => ({
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: partsOf(message.content),
  }));
}

export function createGoogleAdkAgentsHandler(options: GoogleAdkAgentsOptions = {}): ProviderHandler {
  const vertex = resolveVertex(options);

  const run = async (
    ldConfig: AiConfigRep,
    userInput?: string,
    toolHandlers?: Record<string, ToolFn>,
    variables?: Record<string, unknown>,
    history?: Message[],
  ) => {
    const root = startRootSpan(ldConfig, variables);
    const plugin = new LaunchDarklyTelemetryPlugin(ldConfig, parentOf(root), options.captureContent ?? false);
    try {
      const { output, usage } = await collect(
        ldConfig,
        userInput,
        toolHandlers,
        variables,
        history,
        plugin,
        options,
        vertex,
        ldConfig.outputFormat,
      );
      finishRootSpan(root, ldConfig, toSpanUsage(usage));
      endSpan(root);
      return { output, usage };
    } catch (error) {
      plugin.closeOpenSpans(error);
      failSpan(root, error);
      throw error;
    } finally {
      plugin.abandonOpenSpans();
    }
  };

  async function* stream(
    ldConfig: AiConfigRep,
    userInput?: string,
    toolHandlers?: Record<string, ToolFn>,
    variables?: Record<string, unknown>,
    history?: Message[],
  ): AsyncGenerator<HandlerStreamEvent> {
    const root = startRootSpan(ldConfig, variables);
    const plugin = new LaunchDarklyTelemetryPlugin(ldConfig, parentOf(root), options.captureContent ?? false);
    try {
      const runner = await openRun(
        ldConfig,
        userInput,
        toolHandlers,
        variables,
        history,
        plugin,
        options,
        vertex,
        undefined,
      );
      let output = '';
      let usage = zeroUsage();
      for await (const event of runner.runAsync({
        userId: userId(variables),
        sessionId: runner.sessionId,
        newMessage: userMessage(userInput),
      })) {
        const text = eventText(event);
        if (event.partial) {
          if (text) yield { type: 'chunk', text };
          continue;
        }
        if (isFinalResponse(event)) {
          output = text;
          usage = addUsage(usage, event.usageMetadata);
        }
      }
      yield { type: 'done', output, usage };
      finishRootSpan(root, ldConfig, toSpanUsage(usage));
      endSpan(root);
    } catch (error) {
      plugin.closeOpenSpans(error);
      failSpan(root, error);
      throw error;
    } finally {
      plugin.abandonOpenSpans();
    }
  }

  return createHandler(['*', 'agent'], run, stream, options.captureContent ?? false);
}

export const googleAdkAgents = (
  configKey: string,
  userInput: string,
  ldContext: LDContext,
  {
    captureContent,
    variables,
    apiKey,
    useVertexai,
    project,
    location,
    model,
    ...rest
  }: Omit<Parameters<typeof config>[0], 'handler' | 'key'> &
    ContentCaptureOptions &
    GoogleAdkAgentsOptions & { variables?: Record<string, unknown> } = {},
) =>
  config({
    ...rest,
    key: configKey,
    handler: createGoogleAdkAgentsHandler({ apiKey, useVertexai, project, location, model, captureContent }),
  }).invoke(userInput, ldContext, variables);

function parentOf(span: Span | undefined): Context | undefined {
  if (!span || typeof trace.setSpan !== 'function') return undefined;
  try {
    return trace.setSpan(context.active(), span);
  } catch {
    return undefined;
  }
}

function endSpan(span: Span | undefined): void {
  if (span && typeof span.end === 'function') span.end();
}

function resolveVertex(options: GoogleAdkAgentsOptions): Vertex | undefined {
  if (!options.useVertexai) return undefined;
  const project = options.project ?? process.env.GOOGLE_CLOUD_PROJECT;
  const location = options.location ?? process.env.GOOGLE_CLOUD_LOCATION;
  if (!project || !location) {
    throw new Error(
      'Vertex mode requires a Google Cloud project and location (GOOGLE_CLOUD_PROJECT / GOOGLE_CLOUD_LOCATION)',
    );
  }
  return { project, location };
}

async function collect(
  ldConfig: AiConfigRep,
  userInput: string | undefined,
  toolHandlers: Record<string, ToolFn> | undefined,
  variables: Record<string, unknown> | undefined,
  history: Message[] | undefined,
  plugin: LaunchDarklyTelemetryPlugin,
  options: GoogleAdkAgentsOptions,
  vertex: Vertex | undefined,
  outputSchema: AiConfigRep['outputFormat'],
): Promise<{ output: string; usage: Usage }> {
  const runner = await openRun(
    ldConfig,
    userInput,
    toolHandlers,
    variables,
    history,
    plugin,
    options,
    vertex,
    outputSchema,
  );
  let output = '';
  let usage = zeroUsage();
  for await (const event of runner.runAsync({
    userId: userId(variables),
    sessionId: runner.sessionId,
    newMessage: userMessage(userInput),
  })) {
    if (!isFinalResponse(event)) continue;
    output = eventText(event);
    usage = addUsage(usage, event.usageMetadata);
  }
  return { output, usage };
}

async function openRun(
  ldConfig: AiConfigRep,
  userInput: string | undefined,
  toolHandlers: Record<string, ToolFn> | undefined,
  variables: Record<string, unknown> | undefined,
  history: Message[] | undefined,
  plugin: LaunchDarklyTelemetryPlugin,
  options: GoogleAdkAgentsOptions,
  vertex: Vertex | undefined,
  outputSchema: AiConfigRep['outputFormat'] | undefined,
) {
  const agent = new LlmAgent({
    name: 'agent',
    model: resolveModel(ldConfig, options, vertex) as string,
    instruction: instructionOf(ldConfig, variables),
    tools: toolsOf(ldConfig, toolHandlers) as never,
    ...(outputSchema ? { outputSchema: geminiSchema(outputSchema as Record<string, unknown>) as never } : {}),
  });
  plugin.bindTurn(instructionOf(ldConfig, variables), userInput ?? '', toolHandlers);
  const runner = new InMemoryRunner({ agent, appName: APP_NAME, plugins: [plugin] });
  const session = await runner.sessionService.createSession({
    appName: APP_NAME,
    userId: userId(variables),
  });
  for (const content of historyContents(history)) {
    await runner.sessionService.appendEvent({
      session,
      event: createEvent({ author: content.role, content: content as never }),
    });
  }
  return { runAsync: runner.runAsync.bind(runner), sessionId: session.id };
}

function resolveModel(ldConfig: AiConfigRep, options: GoogleAdkAgentsOptions, vertex: Vertex | undefined): unknown {
  if (options.model !== undefined) {
    return typeof options.model === 'function' ? options.model(ldConfig) : options.model;
  }
  const provider = ldConfig.provider?.name ?? '';
  const name = ldConfig.model?.name ?? '';
  if (!GOOGLE_PROVIDERS.has(provider.toLowerCase()) || name.includes('/')) {
    throw new Error('TypeScript @google/adk has no LiteLLM adapter. Inject a model for non-Gemini providers.');
  }
  if (vertex) {
    return new Gemini({ model: name, vertexai: true, project: vertex.project, location: vertex.location });
  }
  if (options.apiKey) return new Gemini({ model: name, apiKey: options.apiKey });
  return new Gemini({ model: name });
}

function instructionOf(ldConfig: AiConfigRep, variables: Record<string, unknown> | undefined): string {
  let raw = ldConfig.instructions;
  if (!raw) {
    raw = (ldConfig.messages ?? [])
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');
  }
  return parseTemplate(raw ?? '', variables ?? {});
}

function toolsOf(ldConfig: AiConfigRep, handlers: Record<string, ToolFn> | undefined): unknown[] {
  const built: unknown[] = [];
  for (const [key, spec] of Object.entries(ldConfig.tools ?? {})) {
    const fn = handlers?.[spec.name] ?? handlers?.[key];
    if (!fn) continue;
    const native = nativeOf(fn);
    if (native) {
      const exported = (adk as unknown as Record<string, unknown>)[native.toolName];
      if (exported && exported !== FunctionTool) built.push(exported);
      continue;
    }
    if (typeof fn !== 'function') continue;
    built.push(
      new FunctionTool({
        name: spec.name || key,
        description: spec.description ?? '',
        parameters: spec.parameters as never,
        execute: async (input: unknown) => fn(input),
      }),
    );
  }
  return built;
}

const GEMINI_TYPES: Record<string, string> = {
  object: 'OBJECT',
  string: 'STRING',
  number: 'NUMBER',
  integer: 'INTEGER',
  boolean: 'BOOLEAN',
  array: 'ARRAY',
};

export function geminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const raw = String(schema.type ?? 'object').toLowerCase();
  const type = GEMINI_TYPES[raw] ?? raw.toUpperCase();
  const properties = schema.properties;
  if (!properties || typeof properties !== 'object') return { ...schema, type };
  const entries = Object.entries(properties as Record<string, Record<string, unknown>>);
  return {
    type,
    properties: Object.fromEntries(entries.map(([key, value]) => [key, geminiSchema(value)])),
    required: Array.isArray(schema.required) ? schema.required : entries.map(([key]) => key),
  };
}

function nativeOf(fn: ToolFn): NativeTool | undefined {
  if (fn instanceof NativeTool) return fn;
  const attached = (fn as { [NATIVE_TOOL_KEY]?: unknown })[NATIVE_TOOL_KEY];
  return attached instanceof NativeTool ? attached : undefined;
}

function nativeStubs(handlers: Record<string, ToolFn> | undefined): Map<string, () => unknown> {
  const stubs = new Map<string, () => unknown>();
  for (const [key, fn] of Object.entries(handlers ?? {})) {
    const native = nativeOf(fn);
    if (!native || typeof fn !== 'function') continue;
    stubs.set(native.toolName, fn as () => unknown);
    stubs.set(key, fn as () => unknown);
  }
  return stubs;
}

function callId(
  toolContext: { functionCallId?: string; function_call_id?: string } | undefined,
  fallback: string,
): string {
  return toolContext?.functionCallId || toolContext?.function_call_id || fallback;
}

function userId(variables: Record<string, unknown> | undefined): string {
  const ldContext = variables?.ldContext;
  if (ldContext && typeof ldContext === 'object' && 'key' in ldContext && ldContext.key) {
    return String(ldContext.key);
  }
  return 'user';
}

function userMessage(userInput: string | undefined) {
  return { role: 'user', parts: [{ text: userInput ?? '' }] } as never;
}

function eventText(event: { content?: { parts?: Array<{ text?: string }> } }): string {
  return (event.content?.parts ?? []).map((part) => part.text ?? '').join('');
}

function zeroUsage(): Usage {
  return { input: 0, output: 0, total: 0 };
}

function addUsage(usage: Usage, metadata: unknown): Usage {
  const next = readUsage(metadata);
  return {
    input: usage.input + next.input,
    output: usage.output + next.output,
    total: usage.total + next.total,
  };
}

function readUsage(metadata: unknown): Usage {
  const prompt = usageField(metadata, 'promptTokenCount', 'prompt_token_count');
  const candidates = usageField(metadata, 'candidatesTokenCount', 'candidates_token_count');
  let total = usageField(metadata, 'totalTokenCount', 'total_token_count');
  if (total === 0 && (prompt || candidates)) total = prompt + candidates;
  return { input: prompt, output: candidates, total };
}

function usageField(metadata: unknown, ...keys: string[]): number {
  if (!metadata || typeof metadata !== 'object') return 0;
  const bag = metadata as Record<string, unknown>;
  for (const key of keys) {
    if (key in bag && bag[key] != null) {
      const parsed = Number(bag[key]);
      return Number.isFinite(parsed) ? parsed : 0;
    }
  }
  return 0;
}

function toSpanUsage(usage: Usage): SpanUsage {
  return { input: usage.input, output: usage.output, cacheRead: 0, cacheCreation: 0 };
}

function partsOf(content: unknown): AdkPart[] {
  if (typeof content === 'string') return [{ text: content }];
  if (!Array.isArray(content)) return [{ text: '' }];
  const parts: AdkPart[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const typed = block as { type?: string; text?: string; source?: { media_type?: string; data?: string } };
    if (typed.type === 'text') parts.push({ text: typed.text ?? '' });
    else if (typed.type === 'image' && typed.source?.data) {
      parts.push({
        inlineData: { mimeType: typed.source.media_type ?? 'image/png', data: typed.source.data },
      });
    }
  }
  return parts;
}
