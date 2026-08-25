# Agent Guide — `@launchdarkly/ai-server` (Core Client)

This document describes what the core client package owns, what it exports, and what invariants agents must respect when modifying it or reading its contracts to implement handler packages.

---

## Role

This is **Tier 0** — the foundation. It owns:
- The LaunchDarkly client singleton and lifecycle
- The telemetry pipeline (OTel via `@opentelemetry/sdk-trace-node` + `@opentelemetry/exporter-trace-otlp-http`)
- All shared TypeScript types (`AiConfigRep`, `Tool`, `ProviderHandler`, etc.)
- The primary runtime entry point: `config()`
- Utility helpers: `parseTemplate`, `parseJSONWithPossibleFences`

No other `@launchdarkly/ai-*` package may define or duplicate these. They import from here.

---

## File Map

| File | Responsibility |
|---|---|
| `src/lifecycle.ts` | `initClient` (options or BYOC overloads), `getClient`, `shutdown`, `waitForTelemetry`, `shutdownTelemetry`, `extractVariation` |
| `src/client.ts` | `config()` |
| `src/tracking.ts` | `executeAndTrack`, `executeAndStream`, `wrapToolHandlers` |
| `src/graph.ts` | `graph()`, `resolveGraph()` |
| `src/types.ts` | All shared TypeScript types — including owned `LDContext`, `LDClientInterface`, `LDClientInterface` — plus the Agent Skills value types, their freezing factories, and `parseAiConfig`'s validators |
| `src/utils.ts` | `parseTemplate`, `parseJSONWithPossibleFences`, `createHandler` |
| `src/registry.ts` | `Registry`, `globalRegistry`, `compose` |
| `src/skills-core.ts` | Agent Skills internals shared by the two layers above it: the store and telemetry seams, module state, integrity verification, store resolution |
| `src/skills.ts` | `skillRefs`, the content accessors, `InMemorySkillStore`, and the documented test-injection hooks |
| `src/skills-fs.ts` | `writeSkills` — the manifest format, on-disk filenames, and reconcile semantics |
| `src/safe-fs.ts` | Symlink-refusing filesystem primitives. Knows nothing about skills; owns the single interceptable rename and unlink call sites |
| `src/index.ts` | Public barrel — the only surface handler packages import from |

The Agent Skills modules are a deliberate split, and the dependencies run **one way only**: `types` ← `skills-core` ← `skills`, and `types` + `safe-fs` + `skills-core` ← `skills-fs`. `skills-core.ts` imports neither `skills.ts` nor `skills-fs.ts`. Do not add an edge that closes a cycle; the reason the store and the emitter live in `skills-core.ts` is so the accessor layer and the filesystem layer cannot disagree about whether one is configured.

---

## Public Exports (`src/index.ts`)

```ts
export type { InspectConfigResult } from './lifecycle.js';
export { getClient, initClient, inspectConfig, shutdown, shutdownTelemetry, waitForTelemetry } from './lifecycle.js';
export type { LDContext, LDClientInterface, LDSingleKindContext, LDMultiKindContext, LDUser } from './types.js';
export { config } from './client.js';
export type { AiConfigRep } from './client.js';
export type {
  Tool, VariationMeta as LDVariationMeta, ProviderHandler, ProviderSetupFn, ProviderResponse,
  ConfigArgs, TrackData,
  GraphTopology, GraphEdge, GraphNode, GraphDefinition, GraphOptions, GraphArgs,
  HandlerStreamEvent, StreamEvent, ProviderGraphResponse,
} from './types.js';
export { GraphTopologySchema, NativeTool, NATIVE_TOOL_KEY } from './types.js';
export { Registry, globalRegistry, compose } from './registry.js';
export { parseTemplate, parseJSONWithPossibleFences, createHandler } from './utils.js';
export { graph, resolveGraph } from './graph.js';
export { parseUsage, normalizeMode, parseAiConfig } from './tracking.js';

// Agent Skills
export { skillRefs, getSkill, getSkillResult, getSkills, allSkills, InMemorySkillStore } from './skills.js';
export { SKILL_OBJECT_KIND, MAX_SKILL_CONTENT_BYTES } from './skills-core.js';
export { writeSkills, SKILL_FILENAME, MANIFEST_FILENAME, MANIFEST_VERSION } from './skills-fs.js';
export type { WriteSkillsOptions } from './skills-fs.js';
export { createSkill, createSkillOutcome, createSkillReference } from './types.js';
export type {
  Skill, SkillOutcome, SkillOutcomeReason, SkillReference, SkillStore, RawSkillObject,
  ReconcileAction, ReconcileActionKind, ReconcileReport, OnUnavailable,
} from './types.js';
```

When adding a new export, add it here. Handler packages must never import from sub-paths (e.g. `@launchdarkly/ai-server/dist/client`).

---

## Key Types

### `ProviderHandler`

The callable type every handler package must produce:

```ts
type ProviderHandler = ((
  config: AiConfigRep,
  userInput?: string,
  toolHandlers?: Record<string, Function | NativeTool>,
  variables?: Record<string, any>
) => Promise<{ output?: string; usage?: Record<string, any> }>)
& { providesFor?: [provider: string, type: 'agent' | 'messages'] };
```

- The function signature is the call contract.
- `providesFor` is the routing key for `config()`. It must match `config.provider.name` and `meta.mode` exactly.

### `AiConfigRep`

Validated with `parseAiConfig` in `extractVariation`. At least one of `instructions` or a non-empty `messages` array must be present. Do not relax this constraint.

### Token usage normalization

`executeAndTrack` calls `parseUsage(response.usage)` which accepts any of these key variants:
- `input_tokens` / `output_tokens`
- `inputTokens` / `outputTokens`
- `input` / `output`

Handlers may return any of these — the client normalizes them before emitting LD telemetry events.

---

## `config()` Behavior

1. Accepts a single `ProviderHandler` or an array of `ProviderHandler`s as `handler`.
2. On `.invoke(userInput, context, variables?, history?)`:
   a. Calls `extractVariation(key, context)` → validates the flag is enabled and parses `AiConfigRep`.
   b. Finds the handler whose `providesFor[0] === provider` and `providesFor[1] === normalized mode`. When a single handler is provided and it does not match, throws immediately. When an array is provided, throws if no handler matches.
   c. Calls `executeAndTrack(...)` which:
      - Records wall-clock duration, emits `$ld:ai:duration:total`
      - Calls `handler(config, userInput, toolHandlers, variables, history)`
      - On success: emits `$ld:ai:generation:success` + token tracks
      - On error: emits `$ld:ai:generation:error` then re-throws
3. If `judgeConfiguration.judges` is present, runs each judge handler (sampled by `samplingRate`) against the primary response and tracks `evaluationMetricKey`.
4. Returns `ProviderResponse`: `{ response: string, usage: { input, output, total }, trackData: TrackData, judgeResults?: Record<string, JudgeCallResult>, judgeTasks?: JudgeTask[] }`. `judgeResults` is populated when `skipJudges` is `false` (default) and judges ran; `judgeTasks` is populated when `skipJudges: true`.

---

## OTel Setup

The core client owns all OTel initialization. `initClient()` sets up a `NodeTracerProvider` with a `BatchSpanProcessor` and an OTLP HTTP exporter when the optional OTel peer deps are installed.

**Required packages (via `@launchdarkly/ai-otel` or installed manually):**

```sh
npm install @launchdarkly/ai-otel
# or individually:
npm install @opentelemetry/sdk-trace-node @opentelemetry/sdk-trace-base \
  @opentelemetry/exporter-trace-otlp-http @opentelemetry/otlp-exporter-base \
  @opentelemetry/resources @opentelemetry/context-async-hooks @opentelemetry/core
```

**OTLP endpoint configuration** (evaluated in this order):
1. `options.otlpEndpoint` passed to `initClient()`
2. `OTEL_EXPORTER_OTLP_ENDPOINT` env var
3. Default: `https://otel.observability.app.launchdarkly.com` (LaunchDarkly's hosted collector)

**Other env vars / options read by `initClient()`:**
- `LD_SERVICE_NAME` / `options.serviceName` — sets `service.name` resource attribute (default: `'nodejs-sdk'`)
- `LD_ENVIRONMENT` / `options.environment` — sets `deployment.environment` resource attribute

**Graceful degradation:** if any OTel package cannot be imported, telemetry is silently skipped and a `console.warn` is emitted with the install command. The LD client still initializes and all AI API calls work normally.

**Handler spans:** handler packages (e.g. `@launchdarkly/ai-claude-agents`) create spans using `@opentelemetry/api`. Those spans are picked up by the tracer provider registered here — no additional setup is required in the handler packages themselves.

---

## `inspectConfig(key, context)`

Reads an AI Config variation **without invoking the model**. Use for health checks, logging, feature-gate probes, or any case where you need to know the current config state without spending AI API quota.

```ts
const result = await inspectConfig('my-flag', context);
// result: { enabled: boolean; config: AiConfigRep | null; meta: VariationMeta | null }
```

**Key guarantees:**
- Never throws — returns `{ enabled: false, config: null, meta: null }` on any error (network, bad key, unparseable config).
- Does not emit LD telemetry events.
- Does not call any AI provider.
- Lazily initializes the LD client when `LD_SDK_KEY` is set (same as other lifecycle functions).

When `enabled` is `false`, `config` is always `null`. When `enabled` is `true` but `config` is `null`, the flag variation failed schema validation.

---

## `initClient()` — When to Call It

**You do not need to call `initClient()` explicitly.** Every entry point (`config().invoke()`, `graph()`, etc.) lazily initializes the LD client on the first call, as long as `LD_SDK_KEY` is set in the environment.

**Call `initClient()` explicitly when you need to:**

- **Pass custom options** — `serviceName`, `environment`, or a custom `otlpEndpoint`:
  ```ts
  await initClient({ serviceName: 'my-service', environment: 'production' });
  ```
- **Use an edge runtime (BYOC path)** — pass any pre-initialized client that satisfies `LDClientInterface`:
  ```ts
  const ldClient = await createYourEdgeSdkClient(process.env.LD_SDK_KEY!);
  await initClient(ldClient);
  ```
- **Pre-warm the connection** — call at startup to eliminate cold-start latency on the first request.

`initClient()` is idempotent — calling it twice is a no-op. It returns `Promise<LDClientInterface>`; the return value may be discarded. See full invariants below.

---

## Lifecycle Invariants

- **Lazy initialization.** Importing the package does not initialize the LD client. The first API call that needs LaunchDarkly (`extractVariation`, graph resolution, etc.) calls `initClient()` internally, provided `LD_SDK_KEY` is set.
- **Explicit initialization — Node SDK path.** `initClient(options?)` dynamically imports `@launchdarkly/node-server-sdk` at runtime (optional peer dep). If the package is not installed it throws with a clear message.
- **Explicit initialization — BYOC path.** `initClient(client, options?)` accepts any pre-initialized object that satisfies `LDClientInterface` — this is the path for Vercel, Cloudflare, or other edge runtimes whose SDK has different init semantics. No `@launchdarkly/node-server-sdk` is required. The optional second argument carries the same options bag as the other overload, which is how a BYOC caller configures `skillStore`.
- **`skillStore` is the one option applied on every call.** Every other option is ignored once the client singleton exists. `skillStore` is applied *before* the idempotency check, so a client that initialized lazily — or without a store — can be given one afterwards. A nullish `skillStore` never clears a configured store; only `shutdown()` does that, and it clears the skills state unconditionally, ahead of its own early return, because that state can exist without a client.
- **Return value.** `initClient()` returns `Promise<LDClientInterface>`. Callers that don't need the instance may discard the return value — this is a non-breaking change from the previous `Promise<void>` signature.
- `getClient()` throws if `initClient()` has not resolved — any code that calls `getClient()` directly must ensure initialization has occurred.
- `shutdown()` must be called before process exit. It flushes OTel spans, flushes LD events, and closes the LD client. `client.close()` runs even when `flush()` throws.

---

## Dependencies

Tier 0, so the runtime surface is deliberately tiny: two hard dependencies, and everything else either optional or dev-only. Nothing here may grow without a reason recorded in this table.

### Runtime (`dependencies`)

| Package | Why |
|---|---|
| `@opentelemetry/api` | The tracer/span API used on every instrumented path (`tracking.ts`, `graph.ts`, `content.ts`, `utils.ts`). API-only — the *SDK* half is an optional peer, so a consumer that never configures OTel still gets no-op spans rather than a crash. |
| `dotenv` | `.env` loading for `LD_SDK_KEY` and the OTel endpoint variables, imported as `dotenv/config` from `lifecycle.ts`. |

### Optional peers (`peerDependencies`, every one `optional: true`)

| Package | Why |
|---|---|
| `@launchdarkly/node-server-sdk` | The default Node client, imported dynamically by `initClient()`'s options overload. Optional because the BYOC overload (`initClient(client)`) targets edge runtimes that supply their own client, and requiring it would force an unused Node SDK into every Vercel/Cloudflare install. Absent ⇒ a clear throw, only on the path that needs it. |
| `@opentelemetry/sdk-trace-node`, `@opentelemetry/sdk-trace-base`, `@opentelemetry/resources`, `@opentelemetry/core`, `@opentelemetry/context-async-hooks` | Tracer provider, span processor, resource attributes, propagators, and async context — loaded dynamically by `setupTelemetry()`. Optional so telemetry is opt-in; see [OTel Setup](#otel-setup) for the install command. |
| `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/otlp-exporter-base` | OTLP/HTTP export and its compression enum. Same optionality, same loader. |

### Dev-only (`devDependencies`) — the ones with a contract attached

| Package | Why |
|---|---|
| the optional peers, mirrored | Each optional peer is repeated here so the test suite can import it. A peer that is *only* a peer would not be installed in this workspace and its tests could not run. |
| `vitest`, `typescript`, `@types/node` | Test runner, compiler, and Node type definitions. |

---

## Common Pitfalls

### 1. Calling `getClient()` before `initClient()` resolves

`getClient()` throws if no client has been initialized. Any code that calls `getClient()` directly (e.g. handler packages emitting LD tracking events) must only do so inside a handler call — by the time a handler runs, `config().invoke()` has already validated the flag variation, which requires an initialized client. Never call `getClient()` at module load time or in a package constructor.

### 2. Double-calling `shutdown()` in process-exit handlers

`shutdown()` is idempotent — calling it a second time is a no-op. However, if `client.flush()` throws during the first call, the singleton is still cleared so a second `shutdown()` call will not re-attempt the flush or throw. Ensure your process-exit handler does not assume `shutdown()` will re-try a failed flush. If you need guaranteed delivery, call `client.flush()` yourself and handle the error before calling `shutdown()`.

### 3. Interpreting skill content anywhere in the SDK

`Skill.content` is a `Uint8Array` — the verified verbatim bytes, exactly what was hashed — and the SDK treats it as opaque. There is deliberately no frontmatter accessor, no YAML dependency, and no decode step outside integrity verification (which encodes the wire string to bytes exactly once, in `skills-core.ts`). Do not add a parser, a convenience accessor, or an encoding assumption; consumers who want structure parse the bytes themselves. This is a cross-language contract with the Python SDK.

### 4. Assuming `writeSkills`'s `timeout` is in milliseconds

It is in **seconds**, defaulting to `10`. The signature is a cross-language contract that must match the Python SDK exactly, so the usual TypeScript `timeoutMs` instinct is wrong here.

### 5. Relaxing a path or manifest check in `skills-fs.ts`

`keyRejectionReason` and `unsafePathReason` are shared by the write and prune paths precisely so the two cannot disagree about which paths this SDK may destroy, and both are **non-relaxable**. The same goes for the manifest rules: a destructive operation is permitted only on a path the manifest lists under a matching key, and a corrupt manifest suppresses every destructive action. Each of these has a dedicated abuse-case test in `src/__tests__/skills-fs.test.ts`; if one starts failing, the defense is what changed, not the test.

Three specifics inside those two functions that a later contributor is most likely to widen:

- **The 22 Windows reserved device names** — `con`, `prn`, `aux`, `nul`, `com1`–`com9`, `lpt1`–`lpt9` — are rejected by `keyRejectionReason`, unconditionally on every platform. Do not add a `process.platform === 'win32'` gate: a managed root written by a Linux container and read from a Windows host is an ordinary deployment, so the on-disk result must not depend on which OS ran the reconcile, and with no Windows CI runner in either repo a platform branch would be untestable. Do not move the check into `isValidSkillKey` or `SKILL_KEY_PATTERN` either. `parseAiConfig` fails closed on a bad `skills` entry, so a grammar-level rejection would invalidate the *whole* AI Config — model, provider, instructions, tools — for a customer who never touches Windows, and `skillRefs` would silently drop the reference, which lets `writeSkills` prune the skill's on-disk copy. That turns "fails to write on Windows" into "gets deleted on Linux". The 255-byte path-component bound lives in this layer for the same reason. The set is exactly the reserved names: `com0` and `lpt0` are not reserved, and no case folding or suffix stripping is needed because the key grammar admits no uppercase, no `.`, and no `$`.
- **The adoption rule is a narrowing of the clobber refusal, not a hole in it.** A file at a managed path with no manifest entry is adopted — recorded, and reported `skipped_current` — only when its on-disk sha256 equals the resolved content hash, which is what lets a reconcile killed between the content writes and the final manifest write heal itself instead of wedging those skills forever. Adopt on anything weaker than an exact hash match and the guarantee is gone. `skipped_current` is reused deliberately: adding a member to `ReconcileActionKind` would break every consumer with an exhaustive `switch`.
- **`readRegularFile` is what makes that read safe**, and every part of it is load-bearing: `O_NONBLOCK`, because opening a FIFO with no writer blocks forever and would hang the reconcile along with the event loop; `O_NOFOLLOW`; and an `fstat` on the *handle* rather than a `stat` on the path, refusing anything that is not a regular file. A failed read is a refusal and never a fall-through to the write. There is no `O_BINARY` — Node does no CRLF translation — which is the one place this deliberately differs from the Python twin.

### 6. Bypassing `fsOps` for a destructive filesystem call

`safe-fs.ts` routes the final rename and the managed-file unlink through the `fsOps` record so tests can intercept exactly those two operations. The orphaned-temp sweep goes through `unlinkNoFollow` for the same reason, and derives its filename pattern from `tempNamePattern` in `safe-fs.ts` rather than carrying a copy: that sweep is only entitled to unlink a file because the *name* identifies it as one this SDK created, so two spellings of the naming rule would eventually let it either miss orphans or remove something it did not write. Calling `fs.rename`/`fs.unlink` directly makes the operation invisible to the atomicity and "no operation was attempted" assertions, which then pass vacuously. Note also the limitation those tests document: Node exposes no `renameat`/`unlinkat`, so `SUPPORTS_DIR_FD` is `false` and the TOCTOU swap-race tests are skipped — the residual exposure is real and recorded, not fixed.

---

## Adding a New Export

1. Implement the function/type in the appropriate `src/*.ts` file.
2. Add a named export to `src/index.ts`.
3. Rebuild: `yarn build` from this directory.
4. All handler packages pick up the change automatically via the local `file:../client` dependency.

## Invariants to Preserve

- Do not add dependencies on any `@launchdarkly/ai-*` handler package. This package has no upward dependencies.
- Do not add a hard dependency on `@launchdarkly/node-server-sdk` or any other LD SDK. The node SDK must remain an optional peer, discovered via dynamic `import()`.
- Handler packages and consumer code must import `LDContext` from `@launchdarkly/ai-server` — not directly from any LD SDK. The owned definition in `src/types.ts` is structurally compatible with all LD SDK versions.
- Do not weaken the `parseAiConfig` validation — handler packages rely on `config` being valid when they receive it. The `skills` array in particular fails **closed**: one malformed reference fails the whole parse, because silently dropping it would materialize a partial skill set without telling anyone.
- Do not interpret skill content anywhere — no frontmatter parsing, no YAML dependency, no encoding assumption beyond the one wire-string encode inside integrity verification. See pitfall 3.
- Skills telemetry goes through the private emitter seam in `skills-core.ts` and nowhere else. **Never** call `client.track()` for a skills operation: these are LaunchDarkly product-analytics signals, not customer analytics, and `track()` would require an LD context, spend the customer's event volume, and land in their data export. Exactly three signal names exist (`AgentControl Skill Integrity Failure`, `AgentControl Skill Materialized`, `AgentControl Skill Revoked Received`) and they are an allowlist, not a floor — in particular, `AgentControl Skill SDK Reference Returned` and `AgentControl Skill Content Retrieved` must **never** be emitted. Every signal is constructed by a `record*` function in `skills-core.ts`, so the allowlist is enforceable by reading one section of one file.
- No filesystem paths and no skill content in telemetry — hashes and byte counts only. Paths belong in the `ReconcileReport`, which is user-facing API.
- The `ld.skills.integrity_failure` log record is a **documented customer-facing contract**, not a debug line. It is constructed in exactly one place — `recordIntegrityFailure` — and written to `console.error` on every failure, unconditionally, because it is the only detection surface a customer with telemetry off has and the only one that can exist where no telemetry destination is reachable. Its keys are inserted in **alphabetical order** so `JSON.stringify` is byte-identical to the Python SDK's `json.dumps(record, sort_keys=True, separators=(",", ":"))` for the same failure, modulo `language`; do not reorder them. Absent optional fields are omitted, never emitted as `null`. Renaming the event, renaming or dropping a field, or emitting a null is a breaking change to a security control — the README documents this record for customers to alert on.
- `reason_code` is a **closed eight-token vocabulary**, one token per call site of `recordIntegrityFailure`: `hash_mismatch`, `invalid_key`, `invalid_version`, `missing_content`, `missing_content_hash`, `not_an_object`, `not_utf8`, `over_size_cap`. A ninth token means adding it in the Python SDK, in the README's `reason_code` table, and in the vocabulary test in `src/__tests__/skills.test.ts`, in the same change — a token that exists on one side only silently breaks a customer's cross-language alert rule. `reason_code` deliberately stays **out** of the telemetry properties: the three signals' property keys are the allowlist above, and the vocabulary belongs to the customer-owned detection path rather than to LaunchDarkly's counter.
- `SkillOutcomeReason` is a **closed five-token vocabulary** and the public half of what `resolveFromStore` decides: `absent`, `integrity_failure`, `ok`, `store_unavailable`, `wrong_version`. It is published by `getSkillResult` as API, customers branch on it, and the Python SDK publishes the same five for the same conditions — so a sixth token is a cross-language change, and it means adding it in the Python SDK, in the README's `reason` table, and in the union-exhaustiveness test in `src/__tests__/skills.test.ts`, in the same change. Note this is a **different and coarser** vocabulary from `IntegrityReasonCode`: the eight integrity tokens say *which check failed* and go to the operator through the log record; the five outcome tokens say *what the caller got* and are the actionable programmatic surface. `verifyRawSkill` returns `null` and does not surface which integrity token fired, deliberately — plumbing the finer token into `SkillOutcome` would change that function's return type for a detail the operator already has.
- `Resolution.reason` is set **explicitly at every construction site**, never derived from `Resolution.error`. Pattern-matching a prose string to decide what a customer's fail-closed branch sees is the fragility the typed outcome exists to remove, and the field is required precisely so a new internal outcome has to pick a public token rather than inherit `'absent'` by omission. The mapping today:

  | Where the resolution is built | `reason` |
  |---|---|
  | `resolveFromStore` — the store threw (also sets `unavailable`) | `store_unavailable` |
  | `resolveFromStore` — `raw` is not an object (null, an array, a scalar) | `absent` |
  | `resolveFromStore` — `verifyRawSkill` returned `null` | `integrity_failure` |
  | `resolveFromStore` — `skill.version !== wantedVersion` | `wrong_version` |
  | `resolveFromStore` — success | `ok` |
  | `skills-fs.ts` `resolveReference` — deadline exhausted, or no store configured (both set `unavailable`) | `store_unavailable` |

  Adding a seventh row means answering "which of the five does a caller see?" before writing the code. `unavailable` stays a separate field rather than folding into `reason`: it is narrower, it is what suppresses pruning, and the two bottom rows above never reach an accessor at all.
- `wantedVersion` is passed **into** `SkillStore.getObject(kind, key, version)`, and the post-hoc `skill.version !== wantedVersion` check is kept anyway. The parameter is there because a store may hold several versions of one key and only the store can pick between them; the equality check is a **defense**, not the selection mechanism, because the store is untrusted. Removing either one is wrong: without the parameter a satisfiable pin gets reported as `wrong_version`, and without the check a lying store gets its answer through. `InMemorySkillStore` holds one object per key and so ignores the parameter by design — it answers with what it has rather than with `null`, so a pin it cannot satisfy reports `wrong_version` rather than `absent`. Giving it real multi-version semantics is a separate change that pulls in `allObjects` and `allSkills`.
- `getSkill`'s contract — "resolves to `null`, never rejects; throws only when no store is configured" — is **frozen**. It is documented in its JSDoc and in the README, and every existing caller treats that `null` as "no skill", so a reason must be added *alongside* it (as `getSkillResult` was) and never by changing what `getSkill` returns. `getSkillResult` is a projection of the same `Resolution` and shares the single throw; it records no telemetry and writes no log record of its own, because the integrity record already fired inside verification before the resolution returned and reporting it again would double-count one failure. `getSkills` and `allSkills` deliberately have no reporting equivalents yet.
- This package has no logger abstraction — every `console.*` call site carries a `biome-ignore` saying so. Introducing a `logger` option is a package-wide API decision affecting unrelated call sites, not a skills change; until one exists, the integrity record has to be self-describing in the string it logs, which is why the event name appears both in the prefix and in the JSON.
- Signal names, property keys, wire field names (`contentHash`), the manifest filename and format, and the exported constants are **identical strings** to the Python SDK. A polyglot fleet has to reconcile the same directory identically, so changing one of these is a cross-language breaking change.
- `parseUsage` must continue to accept `input_tokens/output_tokens`, `inputTokens/outputTokens`, and `input/output` as all existing handlers return one of these variants.
