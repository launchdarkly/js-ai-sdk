import './register';
import { config, globalRegistry, withConversationId } from '@launchdarkly/ai-node';
import { newContext, newConversationId } from './utils';

/**
 * Demonstrates config().stream() — tokens are printed to the terminal as they
 * arrive, then the final usage + judge results are logged when the stream ends.
 *
 * Also the end-to-end check for call-time conversation binding: the generator is built inside
 * `withConversationId` and iterated *outside* it, which is what a chat app does when it hands the
 * stream to a transport. An `async function*` body does not run until the first `next()`, so
 * before `stream()` bound at call time this produced spans with no `gen_ai.conversation.id` at
 * all — silently. Every span of this run should carry the id printed below.
 */
export async function run(key: string, userInput: string): Promise<void> {
  const conversationId = newConversationId('streaming-example');
  process.stderr.write(`[conversation] ${conversationId}\n`);

  const stream = withConversationId(conversationId, () =>
    config({
      key,
      registry: globalRegistry,
    }).stream(userInput, newContext()),
  );

  for await (const event of stream) {
    if (event.type === 'chunk') {
      process.stdout.write(event.text);
    } else {
      // Final event — full response + normalized usage
      process.stdout.write('\n\n');
      process.stderr.write(`[debug] done event response length: ${event.response?.length ?? 0}\n`);
      process.stderr.write(`[debug] done event response preview: ${String(event.response).slice(0, 100)}\n`);

      if (event.judgeResults) {
        process.stderr.write(`[judges] ${JSON.stringify(event.judgeResults)}\n`);
      }
    }
  }
}
