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
| `src/frontmatter.ts` | Bounded, safe YAML parsing for `Skill.frontmatter()` — the *only* place `yaml` is loaded, and only via dynamic `import()` |
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
export { skillRefs, getSkill, getSkills, allSkills, InMemorySkillStore } from './skills.js';
export { SKILL_OBJECT_KIND, MAX_SKILL_CONTENT_BYTES } from './skills-core.js';
export { writeSkills, SKILL_FILENAME, MANIFEST_FILENAME, MANIFEST_VERSION } from './skills-fs.js';
export type { WriteSkillsOptions } from './skills-fs.js';
export { createSkill, createSkillReference } from './types.js';
export type {
  Skill, SkillReference, SkillStore, RawSkillObject,
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
| `yaml` | Parses `SKILL.md` frontmatter for `Skill.frontmatter()`. **Dev-only on purpose, and it must stay that way** — a YAML library is a non-dependency in every language implementation of Agent Skills, so `src/frontmatter.ts` reaches it through a dynamic `import()` and returns `null` when it is absent. Promoting it to `dependencies` or `peerDependencies` breaks that contract; a test asserts it appears in neither. See pitfall 3 — this is also what makes the accessor `async`. |
| the optional peers, mirrored | Each optional peer is repeated here so the test suite can import it. A peer that is *only* a peer would not be installed in this workspace and its tests could not run. |
| `vitest`, `typescript`, `@types/node` | Test runner, compiler, and Node type definitions. |

---

## Common Pitfalls

### 1. Calling `getClient()` before `initClient()` resolves

`getClient()` throws if no client has been initialized. Any code that calls `getClient()` directly (e.g. handler packages emitting LD tracking events) must only do so inside a handler call — by the time a handler runs, `config().invoke()` has already validated the flag variation, which requires an initialized client. Never call `getClient()` at module load time or in a package constructor.

### 2. Double-calling `shutdown()` in process-exit handlers

`shutdown()` is idempotent — calling it a second time is a no-op. However, if `client.flush()` throws during the first call, the singleton is still cleared so a second `shutdown()` call will not re-attempt the flush or throw. Ensure your process-exit handler does not assume `shutdown()` will re-try a failed flush. If you need guaranteed delivery, call `client.flush()` yourself and handle the error before calling `shutdown()`.

### 3. Importing `yaml` anywhere but inside `frontmatter()`

`yaml` is a **devDependency** and must stay one. `src/frontmatter.ts` loads it with a dynamic `import()` inside the parse function, and every failure — including the import rejecting — degrades to `null`. A module-scope `import 'yaml'` anywhere in this package makes it a de-facto runtime dependency for every consumer, and the failure is silent until someone installs without dev deps. This is also why `Skill.frontmatter()` is `async` where its Python counterpart is synchronous: dynamic `import()` is the only lazy load an ESM package has.

### 4. Assuming `writeSkills`'s `timeout` is in milliseconds

It is in **seconds**, defaulting to `10`. The signature is a cross-language contract that must match the Python SDK exactly, so the usual TypeScript `timeoutMs` instinct is wrong here.

### 5. Relaxing a path or manifest check in `skills-fs.ts`

`keyRejectionReason` and `unsafePathReason` are shared by the write and prune paths precisely so the two cannot disagree about which paths this SDK may destroy, and both are **non-relaxable**. The same goes for the manifest rules: a destructive operation is permitted only on a path the manifest lists under a matching key, and a corrupt manifest suppresses every destructive action. Each of these has a dedicated abuse-case test in `src/__tests__/skills-fs.test.ts`; if one starts failing, the defense is what changed, not the test.

### 6. Bypassing `fsOps` for a destructive filesystem call

`safe-fs.ts` routes the final rename and the managed-file unlink through the `fsOps` record so tests can intercept exactly those two operations. Calling `fs.rename`/`fs.unlink` directly makes the operation invisible to the atomicity and "no operation was attempted" assertions, which then pass vacuously. Note also the limitation those tests document: Node exposes no `renameat`/`unlinkat`, so `SUPPORTS_DIR_FD` is `false` and the TOCTOU swap-race tests are skipped — the residual exposure is real and recorded, not fixed.

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
- Do not make `yaml` a runtime dependency, and do not import it at module scope. See pitfall 3.
- Skills telemetry goes through the private emitter seam in `skills-core.ts` and nowhere else. **Never** call `client.track()` for a skills operation: these are LaunchDarkly product-analytics signals, not customer analytics, and `track()` would require an LD context, spend the customer's event volume, and land in their data export. Exactly three signal names exist (`AgentControl Skill Integrity Failure`, `AgentControl Skill Materialized`, `AgentControl Skill Revoked Received`) and they are an allowlist, not a floor — in particular, `AgentControl Skill SDK Reference Returned` and `AgentControl Skill Content Retrieved` must **never** be emitted. Every signal is constructed by a `record*` function in `skills-core.ts`, so the allowlist is enforceable by reading one section of one file.
- No filesystem paths and no skill content in telemetry — hashes and byte counts only. Paths belong in the `ReconcileReport`, which is user-facing API.
- Signal names, property keys, wire field names (`contentHash`), the manifest filename and format, and the exported constants are **identical strings** to the Python SDK. A polyglot fleet has to reconcile the same directory identically, so changing one of these is a cross-language breaking change.
- `parseUsage` must continue to accept `input_tokens/output_tokens`, `inputTokens/outputTokens`, and `input/output` as all existing handlers return one of these variants.
