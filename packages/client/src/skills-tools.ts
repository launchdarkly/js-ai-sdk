/**
 * Adds the tools a variation's skills pin to the `config.tools` its handler is
 * offered, so every handler, native graph and tool allowlist reads one list.
 */

import { isDeepStrictEqual } from 'node:util';
import { skillRefsInternal } from './skills.js';
import { getStore, loggableToolName, resolveFromStore, storeIsInitialized, warnOnce } from './skills-core.js';
import type { AiConfigRep, SkillReference, Tool } from './types.js';

const DEFINITION_FIELDS = ['type', 'name', 'description', 'parameters', 'customParameters'] as const;

/** The five definition fields deeply equal, a missing field equal only to a missing one. */
function sameDefinition(a: Tool, b: Tool): boolean {
  return DEFINITION_FIELDS.every(
    (field) => Object.hasOwn(a, field) === Object.hasOwn(b, field) && isDeepStrictEqual(a[field], b[field]),
  );
}

/**
 * Marks a config `withSkillTools` has returned. Non-enumerable and a symbol, so
 * it is not public, not serialized and not compared by deep equality.
 */
const SKILL_TOOLS_MERGED = Symbol('launchdarkly.skillToolsMerged');

function isMerged(config: AiConfigRep): boolean {
  return Object.hasOwn(config, SKILL_TOOLS_MERGED);
}

function markMerged(config: AiConfigRep): AiConfigRep {
  if (Object.isExtensible(config) && !isMerged(config)) {
    Object.defineProperty(config, SKILL_TOOLS_MERGED, { value: true });
  }
  return config;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * `config` with its skills' tools after its own, in the variation's skills
 * order. An exact duplicate between two skills is skipped. A key a skill
 * shares with the variation always warns, even with an identical definition,
 * and a different definition under a key two skills share warns too; the
 * earlier one (the variation's first) is offered. The server rejects both at
 * save, so only older data reaches this.
 *
 * The result is marked as merged, and a marked config is returned unchanged,
 * with no store read and no warning, so a merge never runs twice.
 *
 * Returns `config` itself when nothing is added: no skill store, no or
 * malformed `skills`, or no skill with tools. A skill that cannot be read adds
 * nothing and warns once. Reads go through core retrieval, not `getSkills`, so a
 * run reports no skills usage.
 */
export function withSkillTools(config: AiConfigRep, configKey: string): AiConfigRep {
  if (isMerged(config)) return config;
  return markMerged(mergeSkillTools(config, configKey));
}

function mergeSkillTools(config: AiConfigRep, configKey: string): AiConfigRep {
  if (config.skills === undefined) return config;
  const store = getStore();
  if (store === null) return config;

  let refs: SkillReference[];
  try {
    refs = skillRefsInternal(config);
  } catch (error) {
    warnOnce(`skills:${configKey}`, `AI Config '${configKey}' is offered no skill tools: ${(error as Error).message}.`);
    return config;
  }

  const merged: Record<string, Tool> = { ...(config.tools ?? {}) };
  // Where each offered tool came from, for the conflict warning.
  const origin = new Map<string, string>(Object.keys(merged).map((name) => [name, `AI Config '${configKey}'`]));
  for (const ref of refs) {
    const { skill, error } = resolveFromStore(store, ref.key, ref.version);
    if (!skill) {
      // A miss before the store has its data warns under its own key, so it does not use up the warning for a real absence.
      const ready = storeIsInitialized(store);
      warnOnce(
        `${ready ? 'unreadable' : 'unready'}:${ref.key}:${ref.version}`,
        `Skill '${ref.key}' version ${ref.version} adds no tools to AI Config '${configKey}': ${error}` +
          `${ready ? '' : ' (the skill store has not finished initializing)'}.`,
      );
      continue;
    }
    const label = `skill '${skill.key}' version ${skill.version}`;
    for (const tool of skill.tools) {
      const held = origin.get(tool.name);
      if (held === undefined) {
        // defineProperty, so a tool named `__proto__` is an own key like any other.
        Object.defineProperty(merged, tool.name, {
          value: structuredClone(tool),
          enumerable: true,
          writable: true,
          configurable: true,
        });
        origin.set(tool.name, label);
        continue;
      }
      const fromVariation = held.startsWith('AI Config');
      // The server forbids any key a variation shares with its skills, so that always warns.
      if (!fromVariation && sameDefinition(merged[tool.name], tool)) continue;
      const where = fromVariation ? '' : `, both attached to AI Config '${configKey}',`;
      warnOnce(
        `conflict:${configKey}:${skill.key}:${skill.version}:${tool.name}`,
        `${capitalize(held)} and ${label}${where} both define tool ${loggableToolName(tool.name) ?? 'with a name that cannot be shown'}${fromVariation ? '' : ' differently'}; ` +
          `the definition from ${held} is offered.`,
      );
    }
  }
  const added = Object.keys(merged).length > Object.keys(config.tools ?? {}).length;
  return added ? { ...config, tools: merged } : config;
}
