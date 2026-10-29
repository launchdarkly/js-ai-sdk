/**
 * Agent Skills — a requested set read from an AI Config.
 *
 * `configSkills(key, context)` builds the {@link SkillSource} for the common
 * case: the skills one AI Config pins for one context. Under `watchSkills` it
 * is read again whenever that config changes, so a config moving a skill from
 * v2 to v3 replaces the file, and a config dropping a skill prunes it.
 *
 * Every way an evaluation can fail is a failed read, never `[]`: an empty
 * answer prunes every managed skill, so only an answer from LaunchDarkly (a
 * disabled variation, or a config with no `skills`) may produce one.
 */

import { getClient } from './lifecycle.js';
import { reportUsage } from './sdk-usage.js';
import { skillRefsInternal } from './skills.js';
import type { LDClientInterface, LDContext, SkillReference, SkillSource } from './types.js';
import { createSkillSource, parseAiConfig } from './types.js';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}

/**
 * Evaluates `key` for `context` and returns the skill references it pins.
 *
 * The default passed to `variation` is `null`, not the `{ enabled: false }`
 * that config invocation uses: that default reads as a disabled variation,
 * which here answers "no skills", so a client that is not ready yet would
 * prune everything.
 */
async function readConfigSkills(key: string, context: LDContext): Promise<SkillReference[]> {
  const failed = (cause: string) => new Error(`configSkills could not read AI Config '${key}': ${cause}`);

  // Never initializes the client: a watcher's reconcile is the wrong place to
  // build a base client as a side effect.
  let client: LDClientInterface;
  try {
    client = getClient();
  } catch {
    throw failed('no AI client is initialized. Call initClient() before reading the skill source.');
  }

  let value: unknown;
  try {
    value = await client.variation(key, context, null);
  } catch (cause) {
    throw failed(`variation threw: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  if (!isObject(value)) {
    // Flag not found, client not ready and evaluation error all arrive as the default.
    throw failed(
      value === null || value === undefined
        ? 'the evaluation returned the default, so the config was not found, the client is not ready, or the evaluation failed'
        : `the evaluation returned ${describe(value)}, not an AI Config object`,
    );
  }

  const meta = value._ldMeta;
  if (!isObject(meta) || typeof meta.enabled !== 'boolean') {
    throw failed('the value has no _ldMeta object with a boolean enabled, so it is not an AI Config');
  }
  // A disabled variation is an answer from LaunchDarkly: its skills leave disk.
  if (!meta.enabled) return [];

  const parsed = parseAiConfig(value);
  if (!parsed.success) throw failed(`the config failed to parse: ${parsed.error.message}`);
  try {
    return skillRefsInternal(parsed.data);
  } catch (cause) {
    throw failed(cause instanceof Error ? cause.message : String(cause));
  }
}

/**
 * The skills AI Config `key` pins for `context`, as a {@link SkillSource}.
 *
 * Pass it to `watchSkills` to keep the files on disk in step with the config:
 *
 * ```ts
 * await initClient();
 * setSkillStore(new LaunchDarklySkillStore(process.env.LD_SDK_KEY!).start());
 * const { watcher } = await watchSkills(configSkills('support-agent', context), '.claude/skills');
 * ```
 *
 * Each read evaluates the config afresh with the base client's
 * `variation(key, context, null)`, which records an evaluation event, as
 * `inspectConfig` does. Under a watcher that is once per reconcile. A read
 * sends no AI telemetry.
 *
 * A read fails, and the reconcile changes nothing on disk, when no AI client
 * is initialized (this never initializes one), when `variation` throws or
 * returns its default, when the value is not an AI Config, or when an enabled
 * config fails to parse or has a malformed `skills` field. A disabled
 * variation reads as `[]`, and so does an enabled config with no `skills`.
 *
 * For several configs, or a client with no `variation`-based config, build a
 * source by hand with `createSkillSource`.
 *
 * @throws TypeError if `key` is not a non-empty string.
 */
export function configSkills(key: string, context: LDContext): SkillSource {
  reportUsage('client.configSkills');
  if (typeof key !== 'string' || key.length === 0) {
    throw new TypeError(`configSkills needs a non-empty AI Config key, got ${JSON.stringify(key) ?? typeof key}`);
  }
  return createSkillSource({ refs: () => readConfigSkills(key, context), configKeys: [key] });
}
