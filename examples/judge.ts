/**
 * Demonstrates background judge evaluation using invoke() with skipJudges: true.
 *
 * The example:
 *   1. Makes a single config() call with skipJudges: true — no judge key is ever
 *      specified by the caller. Judge keys are auto-discovered from the main
 *      config's judgeConfiguration at invocation time.
 *   2. invoke() returns judgeTasks: JudgeTask[] alongside the LLM response. Each
 *      task is a pre-packaged, fully-serialisable object ready for a worker thread.
 *   3. One worker thread is spawned per task. The worker handles the AI call AND
 *      the LaunchDarkly tracking event autonomously — the main thread does not
 *      need to block or listen.
 *   4. In production, omit the await so the main thread continues immediately.
 *      This example awaits for verification purposes only.
 *
 * Usage:
 *   npx ts-node main.ts judge <flag-key> "<user input>"
 */
import './register';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { JudgeRunResult, JudgeTask } from '@launchdarkly/ai-node';
import { config, globalRegistry } from '@launchdarkly/ai-node';
import { newMultiContext, writeOutput } from './utils';

function spawnJudgeWorker(task: JudgeTask, workerUrl: string): Promise<JudgeRunResult | null> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, { workerData: task });
    worker.once('message', (msg: JudgeRunResult | { error: string } | null) => {
      if (!msg || 'error' in msg) {
        process.stderr.write(`[judge] worker error: ${msg ? (msg as { error: string }).error : 'null result'}\n`);
        resolve(null);
      } else {
        resolve(msg);
      }
    });
    worker.once('error', reject);
  });
}

export async function run(key: string, userInput: string): Promise<void> {
  const ctx = newMultiContext();
  process.stderr.write(`[context] ${JSON.stringify(ctx)}\n`);

  // Single config() call — the caller never touches a judge key.
  // skipJudges: true suppresses automatic inline evaluation so we control when
  // judging happens and on which thread.
  const { invoke } = config({ key, registry: globalRegistry, skipJudges: true });

  // invoke() calls the LLM, then auto-discovers judges from judgeConfiguration
  // and returns them as pre-packaged JudgeTask objects. No AI call yet for judges.
  const { response, judgeTasks } = await invoke(userInput, ctx);
  const llmResponse = typeof response === 'string' ? response : JSON.stringify(response);
  process.stdout.write(`[invoke] response: ${llmResponse.slice(0, 120)}\n\n`);

  const workerUrl = fileURLToPath(new URL('./judge-worker.js', import.meta.url));

  // Spawn one worker per task. Each worker handles the judge AI call and
  // LaunchDarkly tracking autonomously — no listener needed in production.
  //
  // In production, replace `await Promise.all(...)` with a fire-and-forget loop:
  //   for (const task of judgeTasks ?? []) new Worker(workerUrl, { workerData: task });
  const judgeResults = await Promise.all(
    (judgeTasks ?? []).map((task) => {
      process.stdout.write(`[judge] spawning worker (judge: ${task.configKey})\n`);
      return spawnJudgeWorker(task, workerUrl);
    }),
  );

  // ── Verification (example only) ─────────────────────────────────────────────
  process.stdout.write('\n── verification ──────────────────────────────────────\n');
  for (const result of judgeResults) {
    if (result) {
      const scoreOk = typeof result.score === 'number' && result.score >= 0 && result.score <= 1;
      const reasoningOk = typeof result.response === 'string' && result.response.length > 0;
      const usageOk = typeof result.usage.input === 'number' && typeof result.usage.output === 'number';
      const runIdOk = Boolean(result.trackData.runId);
      process.stdout.write(`score ∈ [0,1]:      ${scoreOk ? '✓' : '✗'} (${result.score})\n`);
      process.stdout.write(`reasoning present:  ${reasoningOk ? '✓' : '✗'} (${result.response.slice(0, 60)})\n`);
      process.stdout.write(
        `usage tokens:       ${usageOk ? '✓' : '✗'} (in=${result.usage.input} out=${result.usage.output})\n`,
      );
      process.stdout.write(`trackData.runId:    ${runIdOk ? '✓' : '✗'} (${result.trackData.runId?.slice(0, 8)}...)\n`);
    } else {
      process.stderr.write('[judge] result was null — check that a handler matches the judge config\n');
    }
  }

  writeOutput({ response, judgeResults });
}
