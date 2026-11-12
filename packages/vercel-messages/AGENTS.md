# Agent Guide — `@launchdarkly/ai-vercel-messages`

This Tier 1 wildcard handler adapts LaunchDarkly AI configs to AI SDK 7 `generateText` and `streamText`.

## Invariants

- Routing metadata is `['*', 'messages']`.
- Build Gateway `creator/model` ids from the evaluated provider and model. Preserve slash-qualified ids; map `xAI` to `spacexai` and split recognized LD dotted creator prefixes once. Do not load `@ai-sdk/<provider>`; injected models remain the Gateway opt-out.
- Bedrock ids drop the `-vN:M` version suffix. A Bedrock `model.region` is an inference-profile prefix: `us`/`eu`/`au`/`jp` reach the Gateway only as `providerOptions.gateway.inferenceRegion.providers.bedrock` (`src/inference-region.ts`), never as a top-level region; `global` or none sends nothing; anything else throws with the same text as the Python SDK. Caller-set Bedrock regions win; nothing else in the caller's `providerOptions` is replaced.
- Handler-owned request fields, credentials, tool catalogs, output settings, and loop bounds cannot be overridden by flag parameters.
- History is composed with `composeHistory`; system history is excluded and image blocks become native AI SDK image parts.
- Only configured tools with callable handlers are exposed.
- Blocking structured output uses `Output.object({ schema: jsonSchema(...) })`; streaming ignores `outputFormat`.
- Provider iterators are closed when consumers stop early.
- Telemetry is owned by this adapter. Keep the `invoke_agent` → `chat <model>` / `execute_tool <name>` hierarchy and gate content behind `captureContent`.

## Files

- `src/inference-region.ts` — Bedrock `model.region` to Gateway `inferenceRegion`.
- `src/handler.ts` — model resolution, message/tool mapping, generation, streaming, telemetry.
- `src/evaluate.ts` — `vercelEvaluate` around `experimental_evaluate` with the same Gateway-or-injected model rules.
- `src/index.ts` — package registration and exports.
- `src/version.ts` — release-please managed package identity.
