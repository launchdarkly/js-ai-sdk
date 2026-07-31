/**
 * Worker-thread entry point for background judge evaluation.
 *
 * Receives a {@link JudgeTask} via `workerData` and handles the full lifecycle
 * autonomously — AI call, LaunchDarkly tracking, and shutdown — so the main
 * thread never needs to block or listen for tracking.
 *
 * Worker threads inherit the parent's environment variables, so `LD_SDK_KEY`
 * is available here without any additional configuration.
 */
import 'dotenv/config';
import { parentPort, workerData } from 'node:worker_threads';
import { createClaudeMessagesHandler } from '@launchdarkly/ai-claude-messages';
import type { JudgeTask } from '@launchdarkly/ai-node';
import { getClient, initClient, runJudge, shutdown } from '@launchdarkly/ai-node';
import { createOpenAIHandler } from '@launchdarkly/ai-openai-messages';

const task = workerData as JudgeTask;
const handlers = [createOpenAIHandler(), createClaudeMessagesHandler()];

async function main(): Promise<void> {
  // Initialize the LD client in this worker so we can track the evaluation
  // metric result without posting it back to the main thread.
  // LD_SDK_KEY is inherited from the parent process environment.
  await initClient();

  const result = await runJudge(task, handlers);

  if (result && task.evaluationMetricKey) {
    getClient().track(task.evaluationMetricKey, task.userContext, result.trackData, result.score);
  }

  // Flush LD events and OTel spans before the worker exits.
  await shutdown();

  // Post result back so callers that opted in to verification can inspect it.
  // In production fire-and-forget usage, this message is never listened to.
  parentPort?.postMessage(result);
}

main().catch((err) => parentPort?.postMessage({ error: String(err) }));
