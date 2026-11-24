import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

/**
 * The Gemini API key from the environment: `GOOGLE_API_KEY`, or `GEMINI_API_KEY` when
 * `GOOGLE_API_KEY` is unset or empty. `ChatGoogleGenerativeAI` reads only `GOOGLE_API_KEY`, so
 * the handler passes the key itself when it comes from `GEMINI_API_KEY`, and returns `undefined`
 * otherwise so the class keeps reading its own variable. Throws before any request is sent when
 * neither is set.
 */
export function geminiApiKey(): string | undefined {
  if (process.env.GOOGLE_API_KEY) return undefined;
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  throw new Error('Using Gemini models requires an API key. Set GOOGLE_API_KEY or GEMINI_API_KEY.');
}

type UsageMetadata = { input_tokens?: number; output_tokens?: number; total_tokens?: number };

/**
 * Adds the thinking tokens to `output_tokens`. `ChatGoogleGenerativeAI` counts only
 * `candidatesTokenCount` as output, while its `total_tokens` is Gemini's `totalTokenCount`, which
 * also holds `thoughtsTokenCount`. The rest of the total is the thinking. It can also hold
 * `toolUsePromptTokenCount`, which is zero here because the handler never turns on Gemini's
 * built-in tools. On a stream each chunk carries the change since the last one, so the same
 * correction per chunk sums to the same counts as `invoke`.
 */
function addThinkingTokens(usage: UsageMetadata | undefined): void {
  if (!usage) return;
  const thinking = (usage.total_tokens ?? 0) - (usage.input_tokens ?? 0) - (usage.output_tokens ?? 0);
  if (thinking > 0) usage.output_tokens = (usage.output_tokens ?? 0) + thinking;
}

/**
 * A streamed reply chunk with a `content` on every candidate. Gemini sends a blocked reply as a
 * candidate with a finish reason such as `SAFETY` and no `content`, and `@langchain/google-genai`
 * 2.1 reads `candidate.content.parts` unguarded on its stream path, so without this the stream
 * throws instead of finishing with `content_filter` and empty output, as `invoke` does.
 */
async function* withContentOnEveryCandidate(stream: AsyncIterable<{ candidates?: Array<{ content?: unknown }> }>) {
  for await (const response of stream) {
    for (const candidate of response.candidates ?? []) candidate.content ??= { role: 'model', parts: [] };
    yield response;
  }
}

/**
 * The `ChatGoogleGenerativeAI` the handler builds, adapted to the Gemini route's contract:
 * - Its reported usage is corrected by `addThinkingTokens` on `invoke` and `stream`. The class's
 *   own generate and stream methods are wrapped on the instance, so tool binding and every caller
 *   that reads `usage_metadata` see the corrected counts.
 * - A streamed blocked reply finishes instead of throwing (see `withContentOnEveryCandidate`).
 */
export function adaptGeminiModel<T extends BaseChatModel>(model: T): T {
  // biome-ignore lint/suspicious/noExplicitAny: the generate and stream internals are not in the public types
  const internals = model as any;
  if (typeof internals._generate !== 'function' || typeof internals._streamResponseChunks !== 'function') {
    return model;
  }
  const generate = internals._generate.bind(model);
  internals._generate = async (...args: unknown[]) => {
    const result = await generate(...args);
    for (const generation of result.generations ?? []) addThinkingTokens(generation.message?.usage_metadata);
    const tokenUsage = result.llmOutput?.tokenUsage;
    if (tokenUsage) {
      const usage = {
        input_tokens: tokenUsage.promptTokens,
        output_tokens: tokenUsage.completionTokens,
        total_tokens: tokenUsage.totalTokens,
      };
      addThinkingTokens(usage);
      tokenUsage.completionTokens = usage.output_tokens;
    }
    return result;
  };
  const client = internals.client;
  if (client && typeof client.generateContentStream === 'function') {
    const generateContentStream = client.generateContentStream.bind(client);
    client.generateContentStream = async (...args: unknown[]) => {
      const result = await generateContentStream(...args);
      return { ...result, stream: withContentOnEveryCandidate(result.stream) };
    };
  }
  const streamChunks = internals._streamResponseChunks.bind(model);
  internals._streamResponseChunks = async function* (...args: unknown[]) {
    for await (const chunk of streamChunks(...args)) {
      addThinkingTokens(chunk.message?.usage_metadata);
      yield chunk;
    }
  };
  return model;
}
