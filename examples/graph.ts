import './register';
import { globalRegistry, graph } from '@launchdarkly/ai-node';
import { newContext, writeOutput } from './utils';

export async function run(key: string, userInput: string): Promise<void> {
  const response = await graph(key, {
    registry: globalRegistry,
  }).invoke(userInput, newContext(), { user_id: 'user-123' });
  writeOutput(response);
}
