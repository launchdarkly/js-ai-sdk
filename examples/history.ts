import './register';
import { config, globalRegistry, withConversationId } from '@launchdarkly/ai-node';
import { newContext, writeOutput } from './utils';

const history = [
  { role: 'user' as const, content: 'What is LaunchDarkly?' },
  {
    role: 'assistant' as const,
    content:
      'LaunchDarkly is a feature management platform that enables teams to safely deploy, manage, and measure the impact of feature flags and software releases.',
  },
  { role: 'user' as const, content: 'How does it help with AI features specifically?' },
  {
    role: 'assistant' as const,
    content:
      'LaunchDarkly provides an AI SDK that allows you to manage AI model configurations, prompts, and parameters through feature flags, enabling safe experimentation and rollout of AI-powered features.',
  },
];

const HISTORY_PROMPT =
  'Based on what you told me about LaunchDarkly and its AI SDK, what are the key benefits of using feature flags for AI rollouts? Reference our earlier discussion.';

export async function run(key: string, userInput: string): Promise<void> {
  const prompt = userInput || HISTORY_PROMPT;
  const response = await withConversationId('history-example', () =>
    config({
      key,
      registry: globalRegistry,
    }).invoke(prompt, newContext(), undefined, history),
  );

  const text = typeof response.response === 'string' ? response.response : JSON.stringify(response.response);
  const referencesHistory = /launchdarkly|feature flag|feature management|ai sdk/i.test(text) && text.length > 20;

  process.stderr.write(
    `[history-check] Model ${referencesHistory ? 'REFERENCED' : 'DID NOT reference'} prior conversation history\n`,
  );
  if (!referencesHistory) {
    process.stderr.write(
      `[history-check] WARNING: Response may not reflect conversation history. Inspect output manually.\n`,
    );
  }

  writeOutput(response);
}
