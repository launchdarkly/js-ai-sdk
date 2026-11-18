/**
 * Adds the tools a variation's skills pin to the `config.tools` its handler is
 * offered, so every handler, native graph and tool allowlist reads one list.
 */

import { isDeepStrictEqual } from 'node:util';
import { skillRefsInternal } from './skills.js';
import { getStore, resolveFromStore, warnOnce } from './skills-core.js';
import type { AiConfigRep, SkillReference, Tool } from './types.js';

const DEFINITION_FIELDS = ['type', 'name', 'description', 'parameters', 'customParameters'] as const;

/** The five definition fields deeply equal, a missing field equal only to a missing one. */
function sameDefinition(a: Tool, b: Tool): boolean {
  return DEFINITION_FIELDS.every(
    (field) => Object.hasOwn(a, field) === Object.hasOwn(b, field) && isDeepStrictEqual(a[field], b[field]),
  );
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * `config` with its skills' tools after its own, in the variation's skills
 * order. An exact duplicate is skipped. A different definition under a key
 * already offered keeps the earlier one (the variation's first) and warns: the
 * server rejects such variations at save, so only older data reaches this.
 *
 * Returns `config` itself when nothing is added: no skill store, no or
 * malformed `skills`, or no skill with tools. A skill that cannot be read adds
 * nothing and warns once. Reads go through core retrieval, not `getSkills`, so a
 * run reports no skills usage.
 */
export function withSkillTools(config: AiConfigRep, configKey: string): AiConfigRep {
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
      warnOnce(
        `unreadable:${ref.key}:${ref.version}`,
        `Skill '${ref.key}' version ${ref.version} adds no tools to AI Config '${configKey}': ${error}.`,
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
      if (sameDefinition(merged[tool.name], tool)) continue;
      const where = held.startsWith('AI Config') ? '' : `, both attached to AI Config '${configKey}',`;
      warnOnce(
        `conflict:${configKey}:${skill.key}:${skill.version}:${tool.name}`,
        `${capitalize(held)} and ${label}${where} both define tool ${JSON.stringify(tool.name)} differently; ` +
          `the definition from ${held} is offered.`,
      );
    }
  }
  const added = Object.keys(merged).length > Object.keys(config.tools ?? {}).length;
  return added ? { ...config, tools: merged } : config;
}
