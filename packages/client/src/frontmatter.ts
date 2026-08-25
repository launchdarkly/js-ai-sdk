/**
 * `SKILL.md` frontmatter parsing.
 *
 * A lazy convenience for `Skill.frontmatter()`, and deliberately nothing more:
 * this is **never** part of the integrity path. It lives in its own module
 * rather than in `types.ts` because `types.ts`
 * is the package's shared declarative type surface — imported by every handler
 * package — and a YAML loading strategy has no business riding along with
 * `LDContext`.
 *
 * Parsing is bounded on every axis a hostile document could exploit: the block is
 * at most 8 KB, nesting at most 10 levels deep, alias/anchor resolution is
 * disabled outright, and unresolved tags are rejected so no type construction can
 * occur. Every failure degrades to `null`; nothing here throws.
 */

/** Upper bound on the leading frontmatter block handed to the YAML parser. */
const FRONTMATTER_MAX_BYTES = 8 * 1024;

/** Upper bound on frontmatter nesting depth. */
const FRONTMATTER_MAX_DEPTH = 10;

/**
 * Returns the body of the leading `---` block, or `null`.
 *
 * Delimiters are anchored at column 0 and compared with a right-trim, not a full
 * trim. Every convention this format follows (Jekyll, gray-matter,
 * python-frontmatter, the agentskills.io `SKILL.md` layout) anchors them that
 * way, and YAML itself only recognises a document marker at column 0. Trimming
 * the *left* side would let an indented `---` or `...` — which is ordinary text
 * inside a block scalar — terminate the block early and return a truncated
 * mapping the caller could not distinguish from the real one. The right-trim
 * still tolerates a trailing `\r` (CRLF files) and trailing spaces.
 */
export function extractBlock(content: string): string | null {
  const firstNewline = content.indexOf('\n');
  if (firstNewline === -1 || content.slice(0, firstNewline).trimEnd() !== '---') return null;

  const rest = content.slice(firstNewline + 1);
  let offset = 0;
  for (const line of rest.split('\n')) {
    const marker = line.trimEnd();
    if (marker === '---' || marker === '...') {
      const block = rest.slice(0, offset);
      return Buffer.byteLength(block, 'utf-8') > FRONTMATTER_MAX_BYTES ? null : block;
    }
    offset += line.length + 1;
  }
  return null; // unterminated block
}

/**
 * Deepest container nesting in `value`. A scalar is 0; a map or array is one
 * more than its deepest child.
 *
 * The `yaml` package has no depth option, so the depth bound is applied here.
 * Iterative rather than recursive: the parser rejects pathological depth on its
 * own (`RESOURCE_EXHAUSTION`), but a walk that recursed would be the one thing in
 * this module able to overflow the stack on input the parser had accepted.
 */
function containerDepth(value: unknown): number {
  let deepest = 0;
  const pending: Array<{ node: unknown; depth: number }> = [{ node: value, depth: 0 }];

  while (pending.length > 0) {
    // biome-ignore lint/style/noNonNullAssertion: guarded by the loop condition
    const { node, depth } = pending.pop()!;
    if (node === null || typeof node !== 'object') continue;
    const here = depth + 1;
    if (here > deepest) deepest = here;
    if (here > FRONTMATTER_MAX_DEPTH) return here; // no point walking further
    for (const child of Array.isArray(node) ? node : Object.values(node)) {
      pending.push({ node: child, depth: here });
    }
  }
  return deepest;
}

/**
 * Safe, bounded YAML parse of an already-size-checked frontmatter block.
 *
 * Everything — the dynamic import, the parse, and the conversion — sits inside
 * one guard, because this accessor is documented to return `null` rather than
 * throw. The `yaml` package is a development-only dependency, so the import is
 * dynamic and its rejection is just another `null`.
 *
 * Why `parseDocument` and not `parse`: `parse` gets the alias rule right on its
 * own but silently accepts what the other two bounds must refuse.
 * An unresolved tag — `!!python/object/apply:...`, or any custom `!Tag` — is
 * reported as a *warning* rather than an error, and `parse` discards warnings to
 * the console, so it would return the underlying value where PyYAML's
 * `SafeLoader` raises. Treating a non-empty `warnings` array as a parse failure
 * is what keeps the two languages agreeing on the same hostile input.
 */
export async function parseBlock(block: string): Promise<Record<string, unknown> | null> {
  try {
    // Imported here, not at module scope: `yaml` is a development-only
    // dependency and must never become a runtime one.
    const { parseDocument } = await import('yaml');

    const doc = parseDocument(block);
    if (doc.errors.length > 0 || doc.warnings.length > 0) return null;

    // maxAliasCount: 0 disallows *all* alias nodes, so a single alias is
    // disqualifying — matching Python, where aliases are refused outright rather
    // than counted. Note that -1, not 0, is this option's "no limit" value.
    //
    // It belongs on toJS, not parseDocument: aliases are resolved on conversion,
    // so this is both where the option is accepted and where the rule fires
    // (as a thrown ReferenceError, which the guard below turns into null).
    const parsed: unknown = doc.toJS({ maxAliasCount: 0 });
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (containerDepth(parsed) > FRONTMATTER_MAX_DEPTH) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
