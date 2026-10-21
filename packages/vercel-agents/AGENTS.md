# Agent Guide — `@launchdarkly/ai-vercel-agents`

This Tier 1 wildcard handler adapts LaunchDarkly agent configs and graphs to AI SDK 7 `ToolLoopAgent`.

## Invariants

- Routing metadata is `['*', 'agent']`.
- Every invocation constructs the stable `ToolLoopAgent`; do not replace it with a messages-only loop.
- Build Gateway `creator/model` ids from the evaluated provider and model. Preserve slash-qualified ids; map `xAI` to `spacexai` and split recognized LD dotted creator prefixes once. Do not load `@ai-sdk/<provider>` from `config.provider.name`.
- Only callable tools are exposed, and AI SDK owns their execution loop.
- Structured history remains on the native messages path; it is never flattened into instructions.
- Streaming closes the provider iterator and root span on completion, error, or early consumer exit.
- `vercelGraph` always replaces caller-supplied handlers with exactly one Vercel wildcard handler.
- `toVercelAgents` creates one agent per node. Handoff tools select a target explicitly, caller history is root-only, path entries are unique, and usage is accumulated.
- Native graph LaunchDarkly tracking requires `options.context`; no context means no tracking.

## Files

- `src/handler.ts` — ToolLoopAgent construction and handler contract.
- `src/graph.ts` — LaunchDarkly graph convenience wrapper.
- `src/native-graph.ts` — selected-handoff native graph runner.
- `src/index.ts` / `src/version.ts` — registration, exports, and package identity.
