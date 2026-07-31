import './register';
import { config, globalRegistry } from '@launchdarkly/ai-node';
import { newContext } from './utils';

/**
 * Demonstrates config().stream() — tokens are printed to the terminal as they
 * arrive, then the final usage + judge results are logged when the stream ends.
 */
export async function run(key: string, userInput: string): Promise<void> {
  const stream = config({
    key,
    registry: globalRegistry,
  }).stream(userInput, newContext());

  for await (const event of stream) {
    if (event.type === 'chunk') {
      process.stdout.write(event.text);
    } else {
      // Final event — full response + normalized usage
      process.stdout.write('\n\n');
      process.stderr.write(`[debug] done event response length: ${event.response?.length ?? 0}\n`);
      process.stderr.write(`[debug] done event response preview: ${String(event.response).slice(0, 100)}\n`);

      if (event.judgeResults) {
      }
    }
  }
}
