/**
 * Experimental features of `@launchdarkly/ai-claude-agents`.
 *
 * Import from `@launchdarkly/ai-claude-agents/experimental`. Every name here is published, but may
 * change in a minor release. None of these names is exported from the package root.
 *
 * Current experimental features:
 *
 * - **Agent Skills for Claude Agents** — a handler that gives each run the skills attached to its
 *   variation.
 */
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AiConfigRep,
  type ContentCaptureOptions,
  type ProviderHandler,
  registerAiSdkPackage,
  reportUsage,
} from '@launchdarkly/ai-server';
import {
  type ReconcileReport,
  type SkillReference,
  skillRefs,
  writeSkills,
} from '@launchdarkly/ai-server/experimental';
import { type ClaudeAgentsHostOptions, createClaudeAgentsHandlerInternal, type QueryPreparation } from './handler.js';
import { LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION } from './version.js';

export type { ClaudeAgentsHostOptions } from './handler.js';

registerAiSdkPackage(LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION);

/**
 * The local plugin's directory name, and so its name: the CLI names a plugin with no manifest
 * after its directory, and lists its skills as `launchdarkly:<key>`.
 */
const PLUGIN_NAME = 'launchdarkly';

/** Prefix of each per-invoke directory under `skillsTempDir`. */
const RUN_DIR_PREFIX = 'ld-skills-';

/** Options for {@link createClaudeAgentsSkillsHandler}: the core factory's, plus where runs keep their skills. */
export type ClaudeAgentsSkillsHandlerOptions = ContentCaptureOptions &
  ClaudeAgentsHostOptions & {
    /**
     * Parent of the directory each invoke writes its skills into. Defaults to the OS temp
     * directory. Each invoke creates its own directory here and removes it when the run ends.
     */
    skillsTempDir?: string;
  };

/**
 * Why a run did not start, naming each skill that could not be written. Built from the report's
 * action errors, which carry no skill content. A run-level error carries an empty key, so the
 * requested keys are named as well.
 */
function materializationError(report: ReconcileReport, refs: ReadonlyArray<SkillReference>): Error {
  const failures = report.errors.map((action) => (action.key ? `${action.key}: ${action.error}` : `${action.error}`));
  const requested = refs.map((ref) => ref.key).join(', ');
  return new Error(
    `Claude agent run not started: the skills its variation references could not be written ` +
      `(requested: ${requested}). ${failures.join('; ')}`,
  );
}

/** Removes one run's directory. A failure is logged, never thrown over the run's own outcome. */
async function removeRunDirectory(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (error) {
    // biome-ignore lint/suspicious/noConsole: a leaked skills directory is worth an operator's attention
    console.warn(`[LaunchDarkly] could not remove the Claude agent skills directory ${dir}: ${String(error)}`);
  }
}

/**
 * Writes the variation's skills into a directory private to this run, and returns the options
 * that hand it to `query()` as a local plugin. `undefined` when the variation has no skills, so
 * that run is exactly the core handler's.
 *
 * Fails closed: if any skill cannot be written, the run does not start. The variation names that
 * skill, so running without it would run a different agent from the one configured.
 */
async function prepareSkills(config: AiConfigRep, parent: string): Promise<QueryPreparation | undefined> {
  const refs = skillRefs(config);
  if (refs.length === 0) return undefined;

  // Resolve the parent first: a realpath failure after mkdtemp would leak the new directory.
  const dir = await mkdtemp(join(await realpath(parent), RUN_DIR_PREFIX));
  const cleanup = () => removeRunDirectory(dir);
  try {
    const pluginRoot = join(dir, PLUGIN_NAME);
    await mkdir(pluginRoot);
    // A fresh directory: there is nothing to prune, and nothing else writes here.
    const report = await writeSkills(refs, join(pluginRoot, 'skills'), { prune: false });
    if (!report.ok) throw materializationError(report, refs);
    return {
      options: {
        plugins: [{ type: 'local', path: pluginRoot, skipMcpDiscovery: true }],
        // Qualified: a bare name would also match a host plugin's skill of the same name.
        skills: refs.map((ref) => `${PLUGIN_NAME}:${ref.key}`),
      },
      extraBuiltins: ['Skill'],
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/**
 * A Claude Agents handler that gives each run the skills attached to its variation.
 *
 * On every invoke and stream, the variation's `skills` are written with `writeSkills`, through the
 * store configured with `setSkillStore`, into a new directory under `skillsTempDir`. That directory
 * is passed to `query()` as a local plugin, only those skills are enabled, the `Skill` tool is
 * turned on, and the directory is removed when the run ends. A variation with no skills runs
 * exactly as with `createClaudeAgentsHandler`.
 *
 * If any of the variation's skills cannot be written, because no store is configured, the store
 * has not received its first payload, a skill fails verification, or a pinned version is absent,
 * the run throws before the model is called.
 *
 * ```ts
 * import { config } from '@launchdarkly/ai-server';
 * import { FDv2SkillStore, setSkillStore } from '@launchdarkly/ai-server/experimental';
 * import { createClaudeAgentsSkillsHandler } from '@launchdarkly/ai-claude-agents/experimental';
 *
 * const store = new FDv2SkillStore(process.env.LD_SDK_KEY!).start();
 * await store.waitForSkills({ timeoutSeconds: 10 });
 * setSkillStore(store);
 *
 * const triage = config({ key: 'triage-agent', handler: createClaudeAgentsSkillsHandler() });
 * ```
 */
export function createClaudeAgentsSkillsHandler(options: ClaudeAgentsSkillsHandlerOptions = {}): ProviderHandler {
  reportUsage('experimental.createClaudeAgentsSkillsHandler', LD_AI_PACKAGE_NAME, LD_AI_PACKAGE_VERSION);
  const { skillsTempDir, ...handlerOptions } = options;
  return createClaudeAgentsHandlerInternal(handlerOptions, {
    prepare: (config) => prepareSkills(config, skillsTempDir ?? tmpdir()),
  });
}
