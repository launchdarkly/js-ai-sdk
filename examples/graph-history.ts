import './register';
import { globalRegistry, graph } from '@launchdarkly/ai-node';
import { newContext, solidColorPngBase64, writeOutput } from './utils';

const RED_SQUARE = solidColorPngBase64([255, 0, 0]);

const imageBlock = {
  type: 'image' as const,
  source: { type: 'base64' as const, media_type: 'image/png', data: RED_SQUARE },
};

const COLOR_QUESTION = 'What colour is the square in the image I shared? Answer with just the colour name.';

/**
 * Two supported shapes: history that carries only context (the user turn arrives
 * as `userInput`), and history that already ends with the user turn (`userInput`
 * is empty).
 */
const SCENARIOS = [
  {
    name: 'image-in-history + question as userInput',
    history: [{ role: 'user' as const, content: [imageBlock] }],
    userInput: COLOR_QUESTION,
  },
  {
    name: 'history ends with the user turn, empty userInput',
    history: [
      { role: 'user' as const, content: 'I am going to share an image with you.' },
      { role: 'assistant' as const, content: 'Sure — go ahead and share it.' },
      { role: 'user' as const, content: [imageBlock, { type: 'text' as const, text: COLOR_QUESTION }] },
    ],
    userInput: '',
  },
];

export async function run(key: string, userInput: string): Promise<void> {
  const failures: string[] = [];

  for (const scenario of SCENARIOS) {
    const response = await graph(key, { registry: globalRegistry }).invoke(
      userInput || scenario.userInput,
      newContext(),
      { user_id: 'user-123' },
      scenario.history,
    );

    const text = typeof response.response === 'string' ? response.response : JSON.stringify(response.response);
    const sawColor = /\bred\b/i.test(text);

    process.stderr.write(
      `[graph-history-check] ${scenario.name}: model ${sawColor ? 'SAW' : 'DID NOT see'} the image from history\n`,
    );
    if (!sawColor) {
      failures.push(scenario.name);
      process.stderr.write(`[graph-history-check] response was: ${text.slice(0, 300)}\n`);
    }

    writeOutput(response);
  }

  if (failures.length > 0) {
    throw new Error(
      `graph() did not forward history to the root node for: ${failures.join(', ')}. ` +
        'Before the history feature lands this is the expected result.',
    );
  }
}
