import './register';
import { config, globalRegistry } from '@launchdarkly/ai-node';
import { newContext, writeOutput } from './utils';

export async function run(key: string, userInput: string): Promise<void> {
  const response = await config({
    key,
    registry: globalRegistry,
  }).invoke(userInput, newContext());
  writeOutput(response);
}
