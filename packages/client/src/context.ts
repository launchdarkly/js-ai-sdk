import type { LDContext, LDMultiKindContext, LDSingleKindContext } from './types.js';

/**
 * Escapes the two characters that are ambiguous inside a canonical key: `%`
 * (the escape character itself) and `:` (the kind/key separator).
 *
 * Ported from the observability browser SDK's LaunchDarkly integration
 * (`integrations/launchdarkly/index.ts`) so every LaunchDarkly emitter produces
 * byte-identical canonical keys. `%` is replaced first so an escape sequence is
 * never double-escaped, and the whole thing is skipped when neither character
 * is present.
 */
function encodeKey(key: string): string {
  if (key.includes('%') || key.includes(':')) {
    return key.replace(/%/g, '%25').replace(/:/g, '%3A');
  }
  return key;
}

function isMultiKind(context: LDContext): context is LDMultiKindContext {
  return (context as { kind?: unknown }).kind === 'multi';
}

/**
 * The `[kind, key]` pairs of a multi-kind context, sorted by kind, skipping any
 * kind whose sub-context has no usable string key.
 *
 * Both exported functions go through this, so the canonical key and the
 * per-kind map can never disagree about which kinds are present.
 */
function multiKindPairs(context: LDMultiKindContext): [string, string][] {
  const pairs: [string, string][] = [];
  for (const kind of Object.keys(context).sort()) {
    if (kind === 'kind') continue;
    const key = (context[kind] as LDSingleKindContext | undefined)?.key;
    if (typeof key === 'string' && key !== '') pairs.push([kind, key]);
  }
  return pairs;
}

/**
 * The per-kind keys of a context, as `{ <kind>: <key> }`. Keys are raw — only
 * the canonical key is escaped.
 *
 * A legacy user (no `kind`) reports as kind `user`, matching every other
 * LaunchDarkly integration.
 */
export function getContextKeys(context: LDContext): Record<string, string> {
  if (isMultiKind(context)) return Object.fromEntries(multiKindPairs(context));
  const key = (context as { key?: unknown }).key;
  if (typeof key !== 'string' || key === '') return {};
  const kind = (context as { kind?: unknown }).kind;
  return { [typeof kind === 'string' && kind !== '' ? kind : 'user']: key };
}

/**
 * The canonical key of a context — the same value the Go SDK's `ldotel` hook
 * puts on `feature_flag.context.id` via `Context().FullyQualifiedKey()`.
 *
 * Stable and consistent, not for presentation: it is what links a span to a
 * context instance.
 */
export function getCanonicalKey(context: LDContext): string {
  if (isMultiKind(context)) {
    return multiKindPairs(context)
      .map(([kind, key]) => `${kind}:${encodeKey(key)}`)
      .join(':');
  }
  const key = (context as { key?: unknown }).key;
  if (typeof key !== 'string' || key === '') return '';
  const kind = (context as { kind?: unknown }).kind;
  // A legacy user (no kind) and an explicit `user` kind both canonicalise to
  // the bare key, with no `user:` prefix.
  if (typeof kind !== 'string' || kind === '' || kind === 'user') return key;
  return `${kind}:${encodeKey(key)}`;
}

/**
 * The span-safe identity of a context: its canonical key and its per-kind keys,
 * or `undefined` when there is no usable identity.
 *
 * Never throws. This runs on the emit path of every AI run, so a malformed
 * context must degrade to emitting nothing rather than break the caller's call.
 */
export function contextIdentity(
  context: unknown,
): { canonicalKey: string; contextKeys: Record<string, string> } | undefined {
  if (context === null || typeof context !== 'object') return undefined;
  try {
    const contextKeys = getContextKeys(context as LDContext);
    const canonicalKey = getCanonicalKey(context as LDContext);
    if (!canonicalKey || Object.keys(contextKeys).length === 0) return undefined;
    return { canonicalKey, contextKeys };
  } catch {
    return undefined;
  }
}
