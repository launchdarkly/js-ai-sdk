/**
 * Experimental features of the LaunchDarkly AI SDK core client.
 *
 * Import from `@launchdarkly/ai-server/experimental`. Every name here is
 * published, but may change in a minor release. None of these names is
 * exported from the package root.
 *
 * Current experimental features:
 *
 * - **Agent Skills** — version-pinned skill references on AI Configs, verified
 *   skill content, and materialization to disk.
 */

// ---------------------------------------------------------------------------
// Agent Skills
// ---------------------------------------------------------------------------

export {
  allSkills,
  getSkill,
  getSkillResult,
  getSkills,
  InMemorySkillStore,
  setSkillStore,
  skillRefs,
} from './skills.js';
export type { FDv2Mode, FDv2SkillStoreOptions, StoreDiagnostics } from './skills-fdv2.js';
export { FDv2SkillStore, SKILLS_DEFAULT_BASE_URI, SKILLS_DEFAULT_STREAM_URI } from './skills-fdv2.js';
export type { WriteSkillsOptions } from './skills-fs.js';
export { MANIFEST_FILENAME, MANIFEST_VERSION, SKILL_FILENAME, writeSkills } from './skills-fs.js';
export type { WatchSkillsOptions } from './skills-watch.js';
export { SKILLS_DEFAULT_DEBOUNCE_MS, SkillWatcher, watchSkills } from './skills-watch.js';
export type {
  OnUnavailable,
  RawSkillObject,
  ReconcileAction,
  ReconcileActionKind,
  ReconcileReport,
  Skill,
  SkillOutcome,
  SkillOutcomeReason,
  SkillReference,
  SkillStore,
} from './types.js';
export { createSkill, createSkillOutcome, createSkillReference } from './types.js';
