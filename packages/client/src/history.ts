import type { ContentBlock, ImageContentBlock, Message, MessageContent } from './types.js';

/**
 * A conversation turn in LaunchDarkly-canonical form, after history composition.
 * Only `user` / `assistant` roles survive — system-role history is filtered out
 * and belongs on the provider's system prompt, never in the turn list.
 */
export type CanonicalTurn = { role: 'user' | 'assistant'; content: MessageContent };

/** Config conversation messages, already template-applied, in canonical form. */
export type ConfigTurn = { role: 'user' | 'assistant'; content: string };

/**
 * Composes the ordered conversation turns a handler sends to its provider when
 * runtime `history` is present, applying the rules shared by every handler
 * (TESTING.md §1.11):
 *
 *   [config conversation messages] → [history] → [userInput?]
 *
 * - System-role history messages are dropped (system belongs on the system
 *   prompt, derived separately by each handler).
 * - A non-empty `userInput` is always appended as a final user text turn, even
 *   when history already ends with a user turn (image-only history + a separate
 *   question).
 * - An empty / missing `userInput` appends nothing, so history that already
 *   carries the full (possibly multimodal) user turn is sent as-is.
 *
 * Callers only take this structured path when `history` is non-empty; with no
 * history they keep their existing single-string prompt behaviour, so empty
 * history stays byte-for-byte identical to passing none.
 */
export function composeHistory(opts: {
  history: Message[];
  userInput?: string;
  configMessages?: ConfigTurn[];
}): CanonicalTurn[] {
  const { history, userInput, configMessages = [] } = opts;

  const turns: CanonicalTurn[] = [...configMessages];

  for (const message of history) {
    if (message.role === 'system') continue;
    turns.push({ role: message.role, content: message.content });
  }

  if (userInput && userInput.length > 0) {
    turns.push({ role: 'user', content: userInput });
  }

  return turns;
}

/** Type guard for the multimodal content-block array shape. */
export function isContentBlocks(content: MessageContent): content is ContentBlock[] {
  return Array.isArray(content);
}

/** True when a message carries any non-text (e.g. image) content block. */
export function hasMultimodalContent(content: MessageContent): boolean {
  return isContentBlocks(content) && content.some((block) => block.type !== 'text');
}

/** True when any turn in the list carries multimodal content. */
export function anyMultimodal(turns: ReadonlyArray<{ content: MessageContent }>): boolean {
  return turns.some((turn) => hasMultimodalContent(turn.content));
}

/**
 * Flattens a message's content to plain text: a string passes through; a block
 * array contributes only its text blocks. Used by handlers that need a text
 * fallback (e.g. for an assistant turn, or a provider with no image support on
 * that turn role).
 */
export function contentToText(content: MessageContent): string {
  if (typeof content === 'string') return content;
  return content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

/**
 * Builds a `data:<media_type>;base64,<data>` URL for an image block, or returns
 * the URL directly for a URL-sourced block. This is the form OpenAI and
 * LangChain expect (`image_url`); Anthropic keeps `media_type` + `data` split,
 * so its handlers read `block.source` directly instead.
 */
export function imageBlockToUrl(block: ImageContentBlock): string {
  if (block.source.type === 'url') return block.source.url;
  return `data:${block.source.media_type};base64,${block.source.data}`;
}
