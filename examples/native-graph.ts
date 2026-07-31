import './register';
import { toClaudeAgents } from '@launchdarkly/ai-claude-agents';
import { globalRegistry, resolveGraph } from '@launchdarkly/ai-node';
import { newContext, writeOutput } from './utils';

export async function run(key: string, userInput: string): Promise<void> {
  const context = newContext();

  const response = await toClaudeAgents(resolveGraph(key, { context, registry: globalRegistry }), { context }).invoke(
    userInput,
    { user_id: 'user-123' },
  );
  writeOutput(response);
}
