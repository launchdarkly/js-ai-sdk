import './register';
import { toLangGraph } from '@launchdarkly/ai-langchain-agents';
import { globalRegistry, resolveGraph } from '@launchdarkly/ai-node';
import { newContext, writeOutput } from './utils';

/**
 * Demonstrates toLangGraph() — the LangGraph adapter for LaunchDarkly agent graphs.
 *
 * Resolves the graph flag and executes it using a real LangGraph StateGraph,
 * specifically exercising the StateAnnotation.Root({ reducer: addMessages })
 * wiring that unit tests mock away.
 */
export async function run(key: string, userInput: string): Promise<void> {
  const context = newContext();

  const response = await toLangGraph(resolveGraph(key, { context, registry: globalRegistry }), { context }).invoke(
    userInput,
    { user_id: 'user-123' },
  );
  writeOutput(response);
}
