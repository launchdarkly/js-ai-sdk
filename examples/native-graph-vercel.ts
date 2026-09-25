import { resolveGraph } from '@launchdarkly/ai-node';
import { toVercelAgents } from '@launchdarkly/ai-vercel-agents';
import { getPreferences, webSearch } from './tools';
import { newContext, writeOutput } from './utils';

/** Demonstrates the framework-native Vercel ToolLoopAgent graph runner. */
export async function run(key: string, userInput: string): Promise<void> {
  const context = newContext();
  const response = await toVercelAgents(resolveGraph(key, { context }), {
    context,
    toolHandlers: {
      'user-preferences-lookup': getPreferences,
      'web-search-tool': webSearch,
    },
  }).invoke(userInput, { user_id: 'user-123' });

  writeOutput(response);
}
