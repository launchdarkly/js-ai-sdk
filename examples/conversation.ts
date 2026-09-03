/**
 * Demonstrates a multi-turn conversation grouped under one `gen_ai.conversation.id`, with inline
 * judge evaluation on every turn.
 *
 * This is the end-to-end check for O11Y-1888. Run it, then open the printed conversation id in
 * LaunchDarkly's Conversations view and confirm:
 *
 *   1. One conversation, three turns — not three conversations. Every span of every turn carries
 *      the same id: root, `chat`, `execute_tool`, and the judge's own `invoke_agent`.
 *   2. Each turn shows a score badge, sourced from the `gen_ai.evaluation.result` span event on
 *      the judge span.
 *   3. No judge reasoning anywhere in the telemetry. The score and the judge's config key are
 *      exported; the explanation is not, because it is model prose about the user's conversation
 *      and content attributes require `captureContent`. The reasoning IS printed below, straight
 *      from `judgeResults` — that is the caller's copy, and it is unaffected.
 *
 * The flag key must point at an AI Config with a `judgeConfiguration`, otherwise there are no
 * judge turns to look at.
 *
 * Usage:
 *   yarn start conversation <flag-key> "<opening message>"
 */
import './register';
import type { Message } from '@launchdarkly/ai-node';
import { config, globalRegistry, withConversationId } from '@launchdarkly/ai-node';
import { newConversationId, newMultiContext } from './utils';

const FOLLOW_UPS = [
  'Can you give me a concrete example of that?',
  'What is the most common mistake teams make with it?',
];

export async function run(key: string, userInput: string): Promise<void> {
  const conversationId = newConversationId('conversation-example');
  const ctx = newMultiContext();
  process.stderr.write(`[context] ${JSON.stringify(ctx)}\n`);
  const history: Message[] = [];

  process.stderr.write(`[conversation] ${conversationId}\n`);

  const turns = [userInput || 'What is a feature flag?', ...FOLLOW_UPS];

  for (const [index, prompt] of turns.entries()) {
    // One binding per turn, same id every time — that is what makes them one conversation rather
    // than three. Re-binding per turn is the realistic shape: each turn is usually a separate
    // inbound request that looks the id up from its own thread/session.
    const response = await withConversationId(conversationId, () =>
      config({ key, registry: globalRegistry }).invoke(prompt, ctx, undefined, history),
    );

    const text = typeof response.response === 'string' ? response.response : JSON.stringify(response.response);

    process.stdout.write(`\n─── turn ${index + 1} ───\n> ${prompt}\n${text}\n`);

    for (const [judgeKey, result] of Object.entries(response.judgeResults ?? {})) {
      // `response` here is the judge's reasoning. It reaches the caller and is deliberately
      // absent from the span — see the header comment.
      process.stderr.write(`[judge] ${judgeKey} score=${result.score} reasoning=${result.response}\n`);
    }
    if (!response.judgeResults || Object.keys(response.judgeResults).length === 0) {
      process.stderr.write('[judge] no judges ran — does this AI Config have a judgeConfiguration?\n');
    }

    history.push({ role: 'user', content: prompt }, { role: 'assistant', content: text });
  }

  process.stderr.write(`\n[conversation] done — open ${conversationId} in the Conversations view\n`);
}
