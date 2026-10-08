import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { type GraphOptions, graph } from '@launchdarkly/ai-server';
import { createLangChainAgentsHandler } from './handler.js';

/**
 * Runs an agent graph with the LangChain agent handler pre-bound. Equivalent to
 * `graph(key, { ...options, handlers: [createLangChainAgentsHandler(llm)] })`.
 * Use the base `graph()` directly for multi-provider graphs.
 */
export const langchainGraph = (
  key: string,
  options: Omit<GraphOptions, 'handlers'> & { providers?: readonly string[] },
  llm?: BaseChatModel,
) => {
  const { providers, ...graphOptions } = options;
  const handler =
    providers === undefined ? createLangChainAgentsHandler(llm) : createLangChainAgentsHandler(llm, { providers });
  return graph(key, { ...graphOptions, handlers: [handler] });
};
