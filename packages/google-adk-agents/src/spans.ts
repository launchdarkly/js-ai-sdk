/**
 * Span construction for the Google ADK agents handler.
 *
 * `invoke_agent` root, one `chat {model}` child per model turn, one `execute_tool {name}`
 * child per tool call. `gen_ai.system` is the framework (`google_adk`). `gen_ai.provider.name`
 * is who served the model. Google-family providers normalize to `gcp.gemini`.
 */

import {
  type AiConfigRep,
  endSpanOnce,
  type SpanUsage,
  setLdSpanAttributes,
  setModelIdentityAttributes,
  setUsageSpanAttributes,
} from '@launchdarkly/ai-server';
import { type Context, context, type Span, SpanStatusCode, trace } from '@opentelemetry/api';

const TRACER_NAME = '@launchdarkly/ai-google-adk-agents';

const GOOGLE_PROVIDERS = new Set(['google', 'gemini', 'vertex', 'google-genai', 'gcp.gemini']);

export function modelName(config: AiConfigRep): string {
  return config.model?.name ?? '';
}

export function servingProvider(config: AiConfigRep): string {
  const name = (config.provider?.name ?? '').toLowerCase();
  if (!name || GOOGLE_PROVIDERS.has(name)) return 'gcp.gemini';
  return name;
}

export function startRootSpan(config: AiConfigRep, variables: Record<string, unknown> | undefined): Span {
  const span = trace.getTracer(TRACER_NAME).startSpan('invoke_agent');
  span.setAttribute('gen_ai.operation.name', 'invoke_agent');
  setModelIdentityAttributes(span, servingProvider(config), modelName(config), 'google_adk');
  setLdSpanAttributes(span, variables);
  return span;
}

export function parentContextOf(span: Span | undefined): Context | undefined {
  if (!span) return undefined;
  return trace.setSpan(context.active(), span);
}

export function startModelSpan(config: AiConfigRep, parent: unknown): Span {
  const name = modelName(config);
  const span = trace.getTracer(TRACER_NAME).startSpan(`chat ${name}`, undefined, parent as never);
  span.setAttribute('gen_ai.operation.name', 'chat');
  setModelIdentityAttributes(span, servingProvider(config), name, 'google_adk');
  return span;
}

export function startToolSpan(toolName: string, toolCallId: string, parent: unknown): Span {
  const span = trace.getTracer(TRACER_NAME).startSpan(`execute_tool ${toolName}`, undefined, parent as never);
  span.setAttribute('gen_ai.operation.name', 'execute_tool');
  span.setAttribute('gen_ai.tool.name', toolName);
  span.setAttribute('gen_ai.tool.call.id', toolCallId);
  return span;
}

export function finishRootSpan(span: Span | undefined, config: AiConfigRep, usage: SpanUsage): void {
  if (!span) return;
  span.setAttribute('gen_ai.response.model', modelName(config));
  setUsageSpanAttributes(span, usage);
}

export function succeedSpan(span: Span | undefined): void {
  if (!span) return;
  span.setStatus({ code: SpanStatusCode.OK });
  span.end();
}

export function finishModelSpan(span: Span | undefined, config: AiConfigRep, usage: SpanUsage): void {
  if (!span) return;
  span.setAttribute('gen_ai.response.model', modelName(config));
  setUsageSpanAttributes(span, usage);
  span.setStatus({ code: SpanStatusCode.OK });
  span.end();
}

export function failSpan(span: Span | undefined, error: unknown, tracker?: Set<Span>): void {
  if (!span) return;
  const err = error instanceof Error ? error : new Error(String(error));
  span.recordException(err);
  span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
  if (tracker) endSpanOnce(span, tracker);
  else span.end();
}

export function abandonOpenSpans(spans: Span[], ended: Set<Span>): void {
  for (const span of spans) endSpanOnce(span, ended, true);
}

export function usageCounts(metadata: unknown): { input: number; output: number; total: number } {
  const prompt = field(metadata, 'promptTokenCount', 'prompt_token_count');
  const candidates = field(metadata, 'candidatesTokenCount', 'candidates_token_count');
  let total = field(metadata, 'totalTokenCount', 'total_token_count');
  if (total === 0 && (prompt || candidates)) total = prompt + candidates;
  return { input: prompt, output: candidates, total };
}

function field(metadata: unknown, ...keys: string[]): number {
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
