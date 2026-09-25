import {
  type AiConfigRep,
  type ContentCaptureOptions,
  getClient,
  inspectConfig,
  type LDContext,
  setInputContentAttributes,
  setLdSpanAttributes,
  setModelIdentityAttributes,
  setOutputContentAttributes,
  setUsageSpanAttributes,
  type TrackData,
  textMessage,
} from '@launchdarkly/ai-server';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { type Experimental_EvaluationModel, type Experimental_EvaluationQuestion, experimental_evaluate } from 'ai';
import { gatewayModelId } from './model-id.js';

const TRACER_NAME = '@launchdarkly/ai-vercel-messages';

type InspectedMeta = Awaited<ReturnType<typeof inspectConfig>>['meta'];
type EvaluateRequest = Parameters<typeof experimental_evaluate>[0];

export interface VercelEvaluateOptions<
  QUESTIONS extends Record<string, Experimental_EvaluationQuestion> = Record<string, Experimental_EvaluationQuestion>,
> extends ContentCaptureOptions {
  questions: QUESTIONS;
  model?: Experimental_EvaluationModel;
  modelFactory?: (config: AiConfigRep) => Experimental_EvaluationModel | Promise<Experimental_EvaluationModel>;
  maxRetries?: number;
  abortSignal?: AbortSignal;
  headers?: Record<string, string>;
  providerOptions?: EvaluateRequest['providerOptions'];
}

export interface VercelEvaluateResult<
  QUESTIONS extends Record<string, Experimental_EvaluationQuestion> = Record<string, Experimental_EvaluationQuestion>,
> {
  answers: Awaited<ReturnType<typeof experimental_evaluate<QUESTIONS>>>['answers'];
  usage: { input: number; output: number; total: number };
  warnings: Awaited<ReturnType<typeof experimental_evaluate<QUESTIONS>>>['warnings'];
  trackData: TrackData;
  response: Awaited<ReturnType<typeof experimental_evaluate<QUESTIONS>>>['response'];
}

function numberOrZero(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeUsage(usage: unknown): { input: number; output: number; total: number } {
  const raw = (usage ?? {}) as Record<string, unknown>;
  const input = numberOrZero(raw.inputTokens ?? raw.input_tokens ?? raw.input);
  const output = numberOrZero(raw.outputTokens ?? raw.output_tokens ?? raw.output);
  return { input, output, total: numberOrZero(raw.totalTokens ?? raw.total_tokens) || input + output };
}

function servingProvider(config: AiConfigRep): string {
  return (config.provider?.name || 'unknown').toLowerCase();
}

function modelStampsFromMeta(meta: InspectedMeta): Pick<TrackData, 'modelKey' | 'modelVersion'> {
  const stamps: Pick<TrackData, 'modelKey' | 'modelVersion'> = {};
  const modelKey: unknown = meta?.modelKey;
  if (typeof modelKey === 'string' && modelKey.length > 0) stamps.modelKey = modelKey;
  const raw: unknown = meta?.modelVersion;
  if (typeof raw === 'number' || (typeof raw === 'string' && raw.trim().length > 0)) {
    const version = Number(raw);
    if (Number.isInteger(version)) stamps.modelVersion = version;
  }
  return stamps;
}

function assertQuestions(
  questions: Record<string, Experimental_EvaluationQuestion> | undefined,
): asserts questions is Record<string, Experimental_EvaluationQuestion> {
  if (!questions || typeof questions !== 'object' || Object.keys(questions).length === 0) {
    throw new Error('vercelEvaluate requires a nonempty questions map');
  }
}

async function resolveModel(
  config: AiConfigRep,
  options: VercelEvaluateOptions,
): Promise<Experimental_EvaluationModel> {
  if (options.modelFactory) return options.modelFactory(config);
  if (options.model) return options.model;
  return gatewayModelId(config);
}

function makeTrackData(configKey: string, config: AiConfigRep, meta: InspectedMeta): TrackData {
  return {
    runId: crypto.randomUUID(),
    configKey,
    variationKey: meta?.variationKey ?? '',
    version: meta?.version ?? 1,
    modelName: config.model.name ?? '',
    providerName: config.provider?.name ?? '',
    ...modelStampsFromMeta(meta),
  };
}

async function resolveConfig(
  configKey: string,
  context: LDContext,
): Promise<{ config: AiConfigRep; meta: InspectedMeta }> {
  const inspected = await inspectConfig(configKey, context);
  if (!inspected.enabled) {
    throw new Error(`Variation ${configKey} is not enabled`);
  }
  if (!inspected.config) {
    throw new Error(`Invalid AI config for "${configKey}"`);
  }
  return { config: inspected.config, meta: inspected.meta };
}

export async function vercelEvaluate<const QUESTIONS extends Record<string, Experimental_EvaluationQuestion>>(
  configKey: string,
  state: EvaluateRequest['state'],
  context: LDContext,
  options: VercelEvaluateOptions<QUESTIONS>,
): Promise<VercelEvaluateResult<QUESTIONS>> {
  assertQuestions(options.questions);
  const { config, meta } = await resolveConfig(configKey, context);
  const captureContent = options.captureContent ?? false;
  const trackData = makeTrackData(configKey, config, meta);
  const model = await resolveModel(config, options);
  const startTime = Date.now();

  return trace.getTracer(TRACER_NAME).startActiveSpan('evaluate', async (span) => {
    span.setAttribute('gen_ai.operation.name', 'evaluate');
    setModelIdentityAttributes(span, servingProvider(config), config.model.name);
    setLdSpanAttributes(span, {});
    const payload = JSON.stringify({ state, questions: options.questions });
    setInputContentAttributes(span, captureContent, {
      messages: [textMessage('user', payload)],
    });

    try {
      const result = await experimental_evaluate({
        model,
        state,
        questions: options.questions,
        ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
        ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
        ...(options.headers ? { headers: options.headers } : {}),
        ...(options.providerOptions ? { providerOptions: options.providerOptions } : {}),
      });
      const usage = normalizeUsage(result.usage);
      setOutputContentAttributes(span, captureContent, [textMessage('assistant', JSON.stringify(result.answers))]);
      setUsageSpanAttributes(span, { input: usage.input, output: usage.output, cacheRead: 0, cacheCreation: 0 });
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();

      const client = getClient();
      client.track('$ld:ai:duration:total', context, trackData, Date.now() - startTime);
      client.track('$ld:ai:generation:success', context, trackData, 1);
      if (usage.total > 0) client.track('$ld:ai:tokens:total', context, trackData, usage.total);
      if (usage.input > 0) client.track('$ld:ai:tokens:input', context, trackData, usage.input);
      if (usage.output > 0) client.track('$ld:ai:tokens:output', context, trackData, usage.output);

      return {
        answers: result.answers,
        usage,
        warnings: result.warnings,
        trackData,
        response: result.response,
      };
    } catch (error) {
      const exception = error instanceof Error ? error : new Error(String(error));
      span.recordException(exception);
      span.setStatus({ code: SpanStatusCode.ERROR, message: exception.message });
      span.end();
      const client = getClient();
      client.track('$ld:ai:duration:total', context, trackData, Date.now() - startTime);
      client.track('$ld:ai:generation:error', context, trackData, 1);
      throw error;
    }
  });
}
