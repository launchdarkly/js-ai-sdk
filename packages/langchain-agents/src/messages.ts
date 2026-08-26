import { AIMessage, type BaseMessage, HumanMessage } from '@langchain/core/messages';
import { type CanonicalTurn, contentToText, imageBlockToUrl, type MessageContent } from '@launchdarkly/ai-server';

/**
 * A LangChain user-turn content part. Images travel as `image_url` with a data
 * or remote URL — the standard multimodal shape every LangChain chat model
 * accepts — rather than the LaunchDarkly-canonical `{ type: 'image', source }`
 * block, which no LangChain provider understands.
 */
export type LangChainContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

/** Maps one canonical message's content into LangChain user content parts. */
export function toContentParts(content: MessageContent): LangChainContentPart[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return content.map((block) =>
    block.type === 'text'
      ? { type: 'text' as const, text: block.text }
      : { type: 'image_url' as const, image_url: { url: imageBlockToUrl(block) } },
  );
}

/**
 * Turns composed canonical turns into LangChain messages.
 *
 * A string user turn stays a string-content `HumanMessage`, so text-only
 * callers see exactly the message they saw before history existed. Assistant
 * turns are flattened to text: an `AIMessage` carries the model's own prior
 * reply, which has no image to preserve.
 */
export function toLangChainMessages(turns: CanonicalTurn[]): BaseMessage[] {
  return turns.map((turn) => {
    if (turn.role === 'assistant') return new AIMessage(contentToText(turn.content));
    if (typeof turn.content === 'string') return new HumanMessage(turn.content);
    return new HumanMessage({ content: toContentParts(turn.content) });
  });
}
