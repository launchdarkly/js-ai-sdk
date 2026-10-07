import type { AiConfigRep, Message, ProviderHandler } from '@launchdarkly/ai-server';
import {
  createHandler,
  setInputContentAttributes,
  setLdSpanAttributes,
  setModelIdentityAttributes,
  setOutputContentAttributes,
  setUsageSpanAttributes,
  textMessage,
} from '@launchdarkly/ai-server';
import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import type { EntryType, Question, Questions, ScoreCriteria } from '@typesafe-ai/sdk';
import { choice, noul, score, TypeSafeClient } from '@typesafe-ai/sdk';
import {
  buildTypesafeState,
  type ExtractedQuestion,
  extractTypesafeQuestions,
  reasonFromAnswer,
  scoreFromAnswer,
  typesafeOutput,
} from './questions.js';

export type TypesafeHandlerOptions = {
  captureContent?: boolean;
};

type SystemOneUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
};

type SystemOneResponse = {
  answers?: Record<string, unknown>;
  usage?: SystemOneUsage | null;
};

function toSdkQuestion(question: ExtractedQuestion): Question {
  if (question.type === 'noul') {
    return question.criteria
      ? noul(question.instructions, question.criteria as { true?: string | null; false?: string | null })
      : noul(question.instructions);
  }
  if (question.type === 'choice') {
    return choice(question.instructions, question.criteria as Record<string, string | null>);
  }
  return score(question.instructions, question.criteria as unknown as ScoreCriteria);
}

function usageOf(usage: SystemOneUsage | null | undefined): { input_tokens: number; output_tokens: number } {
  const input = usage?.input_tokens ?? usage?.inputTokens ?? 0;
  const output = usage?.output_tokens ?? usage?.outputTokens ?? 0;
  return { input_tokens: input ?? 0, output_tokens: output ?? 0 };
}

/**
 * Handler for a TypeSafe Jev judge. `providesFor` is `['TypeSafe', 'messages']`,
 * which is what a judge variation selects: judge mode normalizes to messages.
 *
 * Questions come from {@link extractTypesafeQuestions}. The handler does not
 * ask Jev for the SDK's `{score, reasoning}` JSON.
 */
export function createTypesafeHandler(options: TypesafeHandlerOptions = {}): ProviderHandler {
  const captureContent = options.captureContent ?? false;
  const tracer = trace.getTracer('@launchdarkly/ai-typesafe');

  return createHandler(
    ['TypeSafe', 'messages'],
    async (
      config: AiConfigRep,
      userInput?: string,
      _toolHandlers?: unknown,
      variables?: Record<string, unknown>,
      history?: Message[],
    ) => {
      const extracted = extractTypesafeQuestions(config);
      const state = JSON.parse(JSON.stringify(buildTypesafeState({ userInput, variables, history }))) as EntryType;
      const questions: Questions = {};
      for (const question of extracted) questions[question.key] = toSdkQuestion(question);
      const modelName = config.model?.name || 'jev';
      const root = tracer.startSpan('invoke_agent');
      const chat = tracer.startSpan(`chat ${modelName}`, undefined, trace.setSpan(context.active(), root));
      setLdSpanAttributes(root, variables);
      setModelIdentityAttributes(root, 'typesafe', modelName);
      setModelIdentityAttributes(chat, 'typesafe', modelName);
      if (captureContent) {
        setInputContentAttributes(chat, true, {
          messages: [textMessage('user', JSON.stringify(state))],
        });
      }

      try {
        const client = new TypeSafeClient();
        const response = (await client.systemOne({
          state,
          questions,
          ...(config.model?.name ? { model: config.model.name } : {}),
        })) as SystemOneResponse;
        const results = extracted.map((question) => {
          const answer = response.answers?.[question.key];
          return {
            key: question.key,
            eventKey: question.eventKey,
            score: scoreFromAnswer(question, answer),
            reason: reasonFromAnswer(question, answer),
          };
        });
        const output = typesafeOutput(results);
        const usage = usageOf(response.usage);
        const spanUsage = { input: usage.input_tokens, output: usage.output_tokens, cacheRead: 0, cacheCreation: 0 };
        setUsageSpanAttributes(chat, spanUsage);
        setUsageSpanAttributes(root, spanUsage);
        if (captureContent) setOutputContentAttributes(chat, true, [textMessage('assistant', output)]);
        chat.setStatus({ code: SpanStatusCode.OK });
        root.setStatus({ code: SpanStatusCode.OK });
        return { output, usage };
      } catch (err) {
        chat.recordException(err as Error);
        root.recordException(err as Error);
        chat.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
        root.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
        throw err;
      } finally {
        chat.end();
        root.end();
      }
    },
    undefined,
    captureContent,
  );
}
