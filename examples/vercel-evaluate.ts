import { vercelEvaluate, vercelMessages } from '@launchdarkly/ai-vercel-messages';
import { fetchLaunchDarklyDocumentation, getPreferences, searchLdDocumentation, webSearch } from './tools';
import { newContext, writeOutput } from './utils';

/**
 * Demonstrates experimental_evaluate() — the AI SDK evaluation API.
 *
 * Runs the AI Config through the Vercel messages handler, then grades that
 * answer with typed evaluation questions. Evaluation needs an evaluation-capable
 * model, which a chat config normally is not, so the model id is supplied here.
 * Drop it to use the AI Config's own model.
 *
 * Usage:
 *   yarn start vercel-evaluate <flag-key> "<user input>"
 */
const EVALUATION_MODEL = 'typesafe-ai/jev';

export async function run(key: string, userInput: string): Promise<void> {
  const context = newContext();

  const generated = await vercelMessages(key, userInput, context, {
    toolHandlers: {
      'get-user-preferences': getPreferences,
      'search-ld-documentation': searchLdDocumentation,
      'fetch-ld-documentation': fetchLaunchDarklyDocumentation,
      'fetch-launchdarkly-documentation': fetchLaunchDarklyDocumentation,
      'web-search': webSearch,
    },
    variables: { user_input: userInput },
  });

  const answer = typeof generated.response === 'string' ? generated.response : JSON.stringify(generated.response);

  const evaluation = await vercelEvaluate(key, { question: userInput, answer }, context, {
    model: EVALUATION_MODEL,
    questions: {
      answersTheQuestion: {
        type: 'boolean',
        instructions: 'Does the answer address the question that was asked?',
      },
      quality: {
        type: 'score',
        instructions: 'How useful is the answer?',
        criteria: ['Unusable', 'Partially useful', 'Complete and accurate'],
      },
    },
  });

  process.stdout.write(`[evaluate] ${JSON.stringify(evaluation.answers)}\n`);

  writeOutput({
    response: generated.response,
    usage: generated.usage,
    answers: evaluation.answers,
    evaluationUsage: evaluation.usage,
  });
}
