import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { type GraphOptions, graph } from '@launchdarkly/ai-server';
import { createLangChainAgentsHandler } from './handler.js';

/**
 * Runs an agent graph with the LangChain agent handler pre-bound. Equivalent to
 * `graph(key, { ...options, handlers: [createLangChainAgentsHandler(llm)] })`.
 * Use the base `graph()` directly for multi-provider graphs.
 */
export const langchainGraph = (key: string, options: Omit<GraphOptions, 'handlers'>, llm?: BaseChatModel) =>
  graph(key, { ...options, handlers: [createLangChainAgentsHandler(llm)] });
