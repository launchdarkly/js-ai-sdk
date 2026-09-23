import './register';
import { globalRegistry, graph, withConversationId } from '@launchdarkly/ai-node';
import { newContext, newConversationId } from './utils';

/**
 * Demonstrates `graph().stream()` — the streaming counterpart to `examples/graph.ts`. Model text
 * goes to stdout; node boundaries go to stderr so stdout stays a clean transcript.
 *
 * Like `examples/streaming.ts`, the generator is built inside `withConversationId` and iterated
 * *outside* it. That is the shape a server produces when it hands a stream to a transport, and it
 * is what exercises call-time binding: an `async function*` body does not run until the first
 * `next()`, so both the conversation id and the `ld.ai.graph` span's OTel parent have to be
 * captured when `stream()` is called, not when iteration starts.
 *
 * Writes no JSON output file, same as the single-config streaming example.
 */
export async function run(key: string, userInput: string): Promise<void> {
  const conversationId = newConversationId('graph-streaming-example');
  process.stderr.write(`[conversation] ${conversationId}\n`);

  const stream = withConversationId(conversationId, () =>
    graph(key, {
      registry: globalRegistry,
    }).stream(userInput, newContext(), { user_id: 'user-123' }),
  );

  for await (const event of stream) {
    if (event.type === 'chunk') {
      process.stdout.write(event.text);
    } else if (event.type === 'node_start') {
      process.stderr.write(`\n[node_start] ${event.nodeKey}\n`);
    } else if (event.type === 'node_done') {
      process.stderr.write(`\n[node_done] ${event.nodeKey} usage=${JSON.stringify(event.usage)}\n`);
    } else if (event.type === 'handoff') {
      process.stderr.write(`[handoff] ${event.sourceKey} -> ${event.targetKey}\n`);
    } else {
      // Final event — usage aggregated across nodes, plus graph judge results when configured.
      process.stdout.write('\n\n');
      process.stdout.write(`Usage: ${JSON.stringify(event.usage, null, 2)}\n`);
      if (event.judgeResults) {
        process.stdout.write(`Judge results: ${JSON.stringify(event.judgeResults, null, 2)}\n`);
      }
      process.stdout.write('\n');
    }
  }
}
