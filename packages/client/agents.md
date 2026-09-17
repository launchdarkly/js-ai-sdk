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
| `src/skills-fdv2.ts` | Agent Skills delivery transport — the FDv2 protocol, the wire-key/`version` translation, the held object set, and `FDv2SkillStore`. Sits **below** the store seam; imports `skills-core` only, and nothing imports it |
| `src/skills-watch.ts` | Agent Skills eager re-reconcile — `watchSkills` / `SkillWatcher`, wiring the store's change listener to `writeSkills`. Sits **above** `skills-fs` and modifies none of it |
| `src/skills-fs.ts` | `writeSkills` — the manifest format, on-disk filenames, and reconcile semantics |
| `src/safe-fs.ts` | Symlink-refusing filesystem primitives. Knows nothing about skills; owns the single interceptable rename and unlink call sites |
| `src/index.ts` | Public barrel — the only surface handler packages import from |

The Agent Skills modules are a deliberate split, and the dependencies run **one way only**: `types` ← `skills-core` ← `skills`, and `types` + `safe-fs` + `skills-core` ← `skills-fs`. `skills-core.ts` imports neither `skills.ts` nor `skills-fs.ts`. The two later modules extend the same shape: `skills-fdv2.ts` sits *below* the seam and imports only `skills-core` + `types` — nothing imports it — and `skills-watch.ts` sits *above* `skills-fs` and imports it without being imported back. Do not add an edge that closes a cycle; the reason the store and the emitter live in `skills-core.ts` is so the accessor layer and the filesystem layer cannot disagree about whether one is configured.

---

## Agent Skills — the delivery transport, and the one field that will bite you

`FDv2SkillStore` speaks LaunchDarkly's SDK-facing FDv2 channel (`GET /sdk/poll`, `GET /sdk/stream`, server-side SDK key in `Authorization`, a `basis` param once a payload has committed, `If-None-Match`/304). It lives below the seam and produces raw objects in the shape `SkillStore` documents; **nothing above the seam knows it exists**. If a transport change ever seems to require editing an accessor, verification, or `writeSkills`, the adapter boundary is wrong.

**The skill's version is in the object's `key`. `version` is the payload's.** Each version of a skill is its own object on the wire, identified as `<key>:<version>`:

```json
{"key":"pdf-extraction:3","kind":"skill","version":42,
 "object":{"contentType":"text/markdown","content":"…","contentHash":"…","name":"…"}}
```

The `3` after the delimiter is what a `{key, version}` reference pins and what becomes the seam's `version`, under the seam key `pdf-extraction`. `version` (42) is the version of the *payload* the object arrived in — it moves when anything in the environment moves, including a flag with nothing to do with skills. Reading it as the skill's version fails **silently**: the object verifies, the hash matches, and the caller gets content under a version number that means nothing. There is no separate field for the skill's version: the agent-skill payload is a *generic* payload, and generic objects carry only `key`, `kind`, `version` and `object`, exactly like a flag. `splitWireKey` is the only place the wire key is read, `seamObjectFromPut` and `tombstoneFromDelete` both go through it, and the `version translation` suite asserts the translation in both directions. A wire key that will not split cleanly is *held*, not dropped — version-less, or with the offending text as its version — so verification withholds it with `invalid_version` under a key the caller recognises; only a key with nothing before the delimiter is dropped, since there is no identity to hold it under.

**Skills are identified by `kind === 'skill'`; everything else is ignored, not rejected.** Object kinds on the SDK-facing channel are open strings, and the agent-skill payload is classified `generic`, so a skill arrives under the kind its producer registered — the bare category name — not under a broader wrapper kind with a narrowing field. An environment's payload assignment carries its flag payload alongside its agent-skill payload, so flag and segment objects arrive as a matter of course. Throwing on an unrecognised kind is the unknown-kind reconnect loop this feature must not reproduce — a flag-delivery outage caused by a skills rollout.

**No `mv` parameter, deliberately.** It selects the *flag* data model, the connection rejects any value but the flag default, and the generic agent-skill payload is served regardless of it. Sending `mv=1` — the skill payload's own model version — gets the whole connection refused.

**Polling and streaming have different default hosts.** `GET /sdk/poll` is served from `DEFAULT_BASE_URI` (`sdk.launchdarkly.com`) and `GET /sdk/stream` from `DEFAULT_STREAM_URI` (`stream.launchdarkly.com`), matching the base server-side SDK. Sending the stream request to the polling host fails against a real environment, and the fake endpoint cannot catch it because it serves both from one origin. `baseUri` given alone therefore applies to both, since a relay or private instance usually serves both from one host; only the LaunchDarkly defaults split them, and `streamUri` overrides the stream origin on its own.

**Changes commit at `payload-transferred`, not as objects arrive.** A payload version is the unit of consistency: a half-applied full transfer would publish a state the server never described, and would briefly empty the store — which, with pruning on, is the difference between a reconcile and deleting a customer's skill files. An interrupted transfer therefore leaves last known good intact, and listeners fire at commit — once per changed object, all of them at `payload-transferred` (which is why `watchSkills` debounces: a per-object notification does not coalesce a payload on its own).

**`objectsRevoked` counts revocations, not tombstones.** A full transfer revokes by omission, so `payloadTransferred` diffs the committed set against the pending one and pushes the departures into `changes` as tombstones at `(key, version)` granularity — a listener that reads versions needs both halves of a version move. The *counter* is coarser on purpose: only a key the payload dropped altogether counts, because a key surviving under a new version was never revoked, and this is a field operators alert on. `keysFullyRevoked` is where the two granularities part.

**The first payload intent is read, and is assumed to be the skill payload.** Delivery provides one payload per credential and the protocol requires a client to ignore all but the first payload intent, so `payloads[0]` is both what arrives and what the protocol says to read. The cost of that assumption is that an `xfer-full` for somebody *else's* payload would start an empty pending set, and the next `payload-transferred` would publish it — every skill reported revoked, and with pruning on, a customer's files deleted. `ProtocolReader` therefore learns which payload skills arrive on, from the intent's `id` or from the `(p:<id>:<version>)` selector, and declines to apply a transfer of any other: once at warning level, counted in `diagnostics.payloadsIgnored`, holding last known good. A transfer that names no payload is applied, since one-payload delivery is the common case. The residual is the first transfer of a connection — before a skill has arrived there is nothing to compare against — which is what the separate warning on a multi-payload intent is for.

**A hashless object is held, not dropped.** Verification withholds it with `missing_content_hash`; the transport's job is to make that loud (an error per object, a summary each time the held store becomes wholly hashless or its withheld set changes, `diagnostics.hashlessObjects`) rather than to work around it. Neither error repeats for a payload re-delivered unchanged, which matters most in polling mode, where the same payload arrives on every interval; each `ProtocolReader` holds its own `HashlessMemory` of what has been said (exposed to tests as `_warnedHashless`), per store rather than module-scoped so two stores in one process do not suppress each other's reports, and capped so a frequently versioned environment cannot accumulate an entry per version. Dropping it at the transport would report `absent` — indistinguishable from "no such skill" — and would let a prune delete the last known-good copy on disk. Never synthesize a hash from the delivered content: that certifies the content against itself and verifies nothing.

**`SkillObjectSet.snapshot` collapses to one object per key, keyed by the bare skill key.** `<root>/<key>/SKILL.md` is a single path, so a whole-store consumer must see one object per key or a `'*'` reconcile writes the same path twice and `allSkills` returns two versions of one skill. Both consumers also collapse for themselves through `newestByKey`, because the seam admits any store — this is the transport holding up its end, not the only guard. The keys must be skill keys, not wire `key:version` keys, because `writeSkills('*')` derives its prune keep-set from them. `getObject` still resolves a pinned version out of the full set.

**There is one network timeout, not two.** `readTimeoutMs` is applied through a `ReadDeadline` composed with the store's own abort signal, so connect, headers and each body read share it. Its default is per mode: `DEFAULT_POLL_TIMEOUT_MS` bounds a whole poll request, `DEFAULT_STREAM_READ_TIMEOUT_MS` bounds the gap between reads on a stream, and tripping it on a stream that has gone quiet *reconnects* — the `timeouts` suite measures the bound against a socket that accepts and never answers. Do not add a separate connect timeout.

**A body read that fails is recoverable; a protocol-reader or dispatch error is not.** `iterSse` wraps the read itself — a reset, a truncated chunk, the read deadline — as `RecoverableTransportError`, because a live stream dies mid-body far more often than it refuses to open, and the delivery loop reads anything else as a bug and stops for the process lifetime. Whatever the consumer's loop body throws while the generator is suspended at a `yield` passes through untouched, so a bug still surfaces as one. Every retry delay is clamped to `maxBackoffMs` and floored at `initialBackoffMs` — a server asking for no delay with `Retry-After: 0` would otherwise reconnect in a loop and burn the whole retry bound in milliseconds, and a blank `Retry-After` must read as "no delay given" rather than as zero, because `Number("")` is `0` and finite.

**What resets the failure counter, and what escapes it.** The counter resets on a completed exchange only — a payload that committed, or a `none` intent — not when a connection returns: a stream only ever ends by being dropped, so resetting on return would count every healthy, server-recycled connection as a failure. Waiting for a *commit* alone is not enough either, because a reconnect whose basis is already current is answered with the `none` intent and commits nothing, which would expire an environment whose skills never change. But a parsed `xfer-full` or `xfer-changes` intent does **not** reset it: an announced transfer is a promise, not a delivery, and a server that announces one and drops before `payload-transferred`, every time, has delivered nothing — counting the announcement as health would retry it forever at the initial backoff (the `gives up on a server that announces a transfer and drops` test pins this). A non-catastrophic `goodbye` is exempt from the counter, but only on a connection that had completed such an exchange, which is what `reachedServer` tracks per attempt: a server that says goodbye having sent no intent delivered nothing, and exempting it would let it reconnect without limit and without any of it reaching `diagnostics` or `failed`. Keep both halves — the reset and the `reachedServer` qualifier — or one of those two failures comes back.

**HTTP 400 is recoverable exactly once, and only when there was state to drop.** The `basis` selector and the `If-None-Match` etag are the only client state in the request, and a selector the server no longer accepts is the one rejection the adapter can act on — so a 400 on a request that carried either arrives as `StaleRequestStateError`, the state is dropped, and a full transfer is requested from scratch; a second 400 is fatal. A 400 for a request carrying neither is the request itself being refused: retrying would send the byte-identical request, so it is fatal at once with no retry. Do not make 400 unconditionally fatal again: that strands delivery for the process lifetime on a stale selector. 405, 406, 414 and 501 stay fatal, since none of them is about client state.

**`close` aborts the signal, it does not just set a flag.** The delivery task spends its life awaiting a stream read, and a flag it never checks would leave a healthy stream running until the process exited. The store's signal is the parent of every `ReadDeadline`, so one abort reaches a pending connect and a pending read alike, and a store closing is passed through rather than reported as a failure. Every backoff timer, deadline timer and the `waitForSkills` timer are `unref`ed for the same reason: a background store must not be why `node` stays up.

**The store refuses two things loudly rather than degrading.** `addListener` throws for any kind but `'skill'`, in `FDv2SkillStore` and `InMemorySkillStore` alike: neither notifies anything else, and a listener accepted on another kind would silently never fire — indistinguishable from one whose objects never changed, which is the failure `watchSkills` already refuses. `removeListener` has no such constraint, so a consumer can detach unconditionally. And `close` is final: `start` throws afterwards rather than opening a second delivery loop, because a store that looks live and is not is worse than one that plainly refuses. Closing leaves `failed` as `null` — it is the caller's decision, not a delivery failure — and both a closed store and one that gave up answer `waitForSkills` immediately rather than waiting out a timeout for a payload that cannot arrive.

---

## Public Exports (`src/index.ts`)

This block is **generated from `src/index.ts`, verbatim and in its order** — it is not a curated
summary. Regenerate it rather than hand-editing, or it drifts: it has previously listed a
`./tracking.js` re-export that `index.ts` does not have, while omitting a dozen names it does.

```ts
export type { AiConfigRep } from './client.js';
export { config } from './client.js';
export type { ContentCaptureOptions, SpanMessage, SpanMessagePart, ToolDefinitionInput } from './content.js';
export {
  langChainFinishReasons,
  langChainSpanMessages,
  setInputContentAttributes,
  setOutputContentAttributes,
  setToolCallContentAttributes,
  setToolDefinitionAttributes,
  textMessage,
  toSemconvFinishReason,
} from './content.js';
export { graph, resolveGraph } from './graph.js';
export { buildJudgeTasks, runJudge } from './judges.js';
export type { InspectConfigResult } from './lifecycle.js';
export { getClient, initClient, inspectConfig, shutdown, shutdownTelemetry, waitForTelemetry } from './lifecycle.js';
export { compose, globalRegistry, Registry } from './registry.js';
export { allSkills, getSkill, getSkillResult, getSkills, InMemorySkillStore, skillRefs } from './skills.js';
export type { FDv2Mode, FDv2SkillStoreOptions, StoreDiagnostics } from './skills-fdv2.js';
export { DEFAULT_BASE_URI, DEFAULT_STREAM_URI, FDv2SkillStore } from './skills-fdv2.js';
export type { WriteSkillsOptions } from './skills-fs.js';
export { MANIFEST_FILENAME, MANIFEST_VERSION, SKILL_FILENAME, writeSkills } from './skills-fs.js';
export type { WatchSkillsOptions } from './skills-watch.js';
export { DEFAULT_DEBOUNCE_MS, SkillWatcher, watchSkills } from './skills-watch.js';
export type {
  ConfigArgs,
  GraphArgs,
  GraphDefinition,
  GraphEdge,
  GraphNode,
  GraphOptions,
  GraphTopology,
  HandlerStreamEvent,
  JudgeCallResult,
  JudgeRunResult,
  JudgeTask,
  LDClientInterface,
  LDContext,
  LDMultiKindContext,
  LDSingleKindContext,
  LDUser,
  Message,
  OnUnavailable,
  ProviderGraphResponse,
  ProviderHandler,
  ProviderResponse,
  ProviderSetupFn,
  RawSkillObject,
  ReconcileAction,
  ReconcileActionKind,
  ReconcileReport,
  RegistryInput,
  RouteResult,
  RunNodeOptions,
  Skill,
  SkillOutcome,
  SkillOutcomeReason,
  SkillReference,
  SkillStore,
  StreamEvent,
  TokenUsage,
  Tool,
  ToolHandlerFn,
  TrackData,
  TraverseVisitor,
  VariationMeta as LDVariationMeta,
} from './types.js';
export {
  createSkill,
  createSkillOutcome,
  createSkillReference,
  GraphTopologySchema,
  NATIVE_TOOL_KEY,
  NativeTool,
} from './types.js';
export type { RunUsage, SpanUsage } from './utils.js';
export {
  addCachedTokensToInput,
  collapseMessagesToInstructions,
  createHandler,
  createRunUsage,
  endSpanOnce,
  langChainSpanUsage,
  parseJSONWithPossibleFences,
  parseTemplate,
  setLdSpanAttributes,
  setModelIdentityAttributes,
  setUsageSpanAttributes,
} from './utils.js';
```

When adding a new export, add it here. Handler packages must never import from sub-paths (e.g. `@launchdarkly/ai-server/dist/client`).

`MAX_SKILL_CONTENT_BYTES` and `SKILL_OBJECT_KIND` are deliberately **not** among them, and that
absence is a contract with an absence assertion behind it — do not re-export either from
`index.ts`. The cap is a local enforcement bound on content the platform produces, not a value this
SDK defines, so exporting it would semver-lock a number this side does not own; the `over_size_cap`
reason string already reports the bound when it is what withheld content. The kind is the string
this SDK hands a `SkillStore`, and an adapter maps whatever its transport calls a skill onto it, so
publishing it would advertise an SDK-side seam as the wire format — a claim this side cannot make
and could not walk back once a caller depended on it. Both stay internal to `skills-core.ts`.

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
- **Explicit initialization — BYOC path.** `initClient(client, options?)` accepts any pre-initialized object that satisfies `LDClientInterface` — this is the path for Vercel, Cloudflare, or other edge runtimes whose SDK has different init semantics. No `@launchdarkly/node-server-sdk` is required. The optional second argument carries the same options bag as the other overload and is passed through to telemetry setup whole, so `otlpEndpoint`, `serviceName` and `environment` mean the same thing here — and it is how a BYOC caller configures `skillStore`.
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

### 4a. Passing `debounceMs` and `timeout` in the same unit

`WatchSkillsOptions` is `WriteSkillsOptions` plus two fields, so one options bag carries `debounceMs` in **milliseconds** (the TypeScript convention) beside `timeout` in **seconds** (the cross-language contract from pitfall 4). `{ debounceMs: 500, timeout: 10 }` is the sane pair; `{ debounceMs: 0.5, timeout: 10_000 }` is a 1 ms coalescing window and a nearly three-hour reconcile budget. Both are guarded for sign and finiteness, not for plausibility.

### 4b. Reading "no `removed` action" as "nothing is stale"

Prune is **suppressed** — not merely empty — whenever the run cannot tell what is still current: an incomplete retrieval (a reference that did not resolve, a store that threw, an exhausted timeout), a store whose `isInitialized()` answers `false` (delivery has not sent a payload yet), a withholding that could not be attributed to a key (the `'*'` form's run-level `error`), or a corrupt manifest. In every one of those cases the report carries an `error` action and `ok` is `false`, and nothing has been pruned — including skills that genuinely were revoked. A caller that wants to know whether revocation has taken effect reads `ok` and `errors` first, not the absence of `removed`.

### 4c. Two watchers on one root, or `writeSkills` on a watched root

A reconcile's contract is one root, one reconcile at a time: two interleaved runs read the same manifest, each writes it back from its own picture, and the loser's entries vanish while the files it wrote stay on disk unmanaged. `SkillWatcher` chains its own reconciles so they never overlap, but it cannot see a second watcher on the same root or a caller's own `writeSkills` against it. Do neither.

### 5. Relaxing a path or manifest check in `skills-fs.ts`

`keyRejectionReason` and `unsafePathReason` are shared by the write and prune paths precisely so the two cannot disagree about which paths this SDK may destroy, and both are **non-relaxable**. The same goes for the manifest rules: a destructive operation is permitted only on a path the manifest lists under a matching key, and a corrupt manifest suppresses every destructive action. Each of these has a dedicated abuse-case test in `src/__tests__/skills-fs.test.ts`; if one starts failing, the defense is what changed, not the test.

Three specifics inside those two functions that a later contributor is most likely to widen:

- **The 22 Windows reserved device names** — `con`, `prn`, `aux`, `nul`, `com1`–`com9`, `lpt1`–`lpt9` — are rejected by `keyRejectionReason`, unconditionally on every platform. Do not add a `process.platform === 'win32'` gate: a managed root written by a Linux container and read from a Windows host is an ordinary deployment, so the on-disk result must not depend on which OS ran the reconcile, and with no Windows CI runner in either repo a platform branch would be untestable. Do not move the check into `isValidSkillKey` or `SKILL_KEY_PATTERN` either. `parseAiConfig` fails closed on a bad `skills` entry, so a grammar-level rejection would invalidate the *whole* AI Config — model, provider, instructions, tools — for a customer who never touches Windows, and `skillRefs` would drop the reference — with a warning, but still shortening the projection it hands `writeSkills`, which lets `prune` take the skill's on-disk copy with it. That turns "fails to write on Windows" into "gets deleted on Linux". The 255-byte path-component bound lives in this layer for the same reason. The set is exactly the reserved names: `com0` and `lpt0` are not reserved, and no case folding or suffix stripping is needed because the key grammar admits no uppercase, no `.`, and no `$`.
- **The adoption rule is a narrowing of the clobber refusal, not a hole in it.** A file at a managed path with no manifest entry is adopted — recorded, and reported `skipped_current` — only when its on-disk sha256 equals the resolved content hash, which is what lets a reconcile killed between the content writes and the final manifest write heal itself instead of wedging those skills forever. Adopt on anything weaker than an exact hash match and the guarantee is gone. `skipped_current` is reused deliberately: adding a member to `ReconcileActionKind` would break every consumer with an exhaustive `switch`.
- **`readRegularFile` is what makes that read safe**, and every part of it is load-bearing: `O_NONBLOCK`, because opening a FIFO with no writer blocks forever and would hang the reconcile along with the event loop; `O_NOFOLLOW`; and an `fstat` on the *handle* rather than a `stat` on the path, refusing anything that is not a regular file. A failed read is a refusal and never a fall-through to the write. There is no `O_BINARY` — Node does no CRLF translation — which is the one place this deliberately differs from the Python twin.

### 6. Bypassing `fsOps` for a destructive filesystem call

`safe-fs.ts` routes the final rename and the managed-file unlink through the `fsOps` record so tests can intercept exactly those two operations. The orphaned-temp sweep goes through `unlinkNoFollow` for the same reason, and derives its filename pattern from `tempNamePattern` in `safe-fs.ts` rather than carrying a copy: that sweep is only entitled to unlink a file because the *name* identifies it as one this SDK created, so two spellings of the naming rule would eventually let it either miss orphans or remove something it did not write. Calling `fs.rename`/`fs.unlink` directly makes the operation invisible to the atomicity and "no operation was attempted" assertions, which then pass vacuously.

There is a **third** hook, and it is deliberately not part of `fsOps`: the root-swap races mock `mkdir` and `open` through `vi.mock('node:fs/promises')`, because they have to fire *before* the root is pinned. Widening `fsOps` to cover those would blur what a "no filesystem operation was attempted" assertion means, so leave them separate.

On the platform bound: Node exposes no `renameat`/`unlinkat`, so `SUPPORTS_DIR_FD` is `false` on every release to date — but that is **not** the end of the story, and an older version of this note said it was. `SUPPORTS_PROC_FD` addresses children through `/proc/self/fd/<fd>/<name>`, which the kernel resolves from the inode the descriptor holds rather than from the name it was opened under. That **closes** the swap window on Linux, so the swap-race tests *run* there and are skipped only where neither capability is present. Two consequences worth keeping straight: the `(dev, ino)` identity re-check is the macOS floor only and must not be attempted on the fast path (`lstat` of `/proc/self/fd/<fd>` reports procfs's magic symlink, not the directory); and a green macOS test run is not evidence about any of this, since all ten of those tests skip locally and execute on Linux CI alone.

### 7. "Fixing" the platform bound, or adding a writability field to `ReconcileReport`

Two decisions here look like unfinished work and are not. Neither should be reversed without re-examining the threat model each was decided against.

- **Windows reparse-point checks (`GetFileAttributesW`, `FILE_FLAG_OPEN_REPARSE_POINT`) are deliberately not implemented.** Windows is not a supported or tested platform for this release, there is no Windows CI runner, and Node gives this module no `*at()` primitive that would make such checks meaningful anyway — off the Linux fast path the racy per-component `lstat` floor is what runs everywhere, rather than being a Windows-only fallback. The bound is documented in `safe-fs.ts` and the README instead. Keep the reserved-device-name handling in `skills-fs.ts`, since it keeps a root written on Linux usable when read from Windows, but do not read it as evidence that Windows is hardened. If Windows becomes supported, add the CI runner first and revisit both together.
- **`ReconcileReport` must not grow a "managed root is writable" field.** It has been asked for and rejected, and the reasoning is load-bearing. The SDK knows only its *own* identity, which trivially has write access — it just wrote there — and cannot know which identity will later run the agent. Any check it could perform would answer a different question than the one asked and would manufacture false confidence exactly where caution is wanted. The real mitigation is deployment-side: run the reconcile as a different identity than the agent, so the `0644`/`0755` modes deny something and a prompt-injected agent cannot rewrite its own instructions or the manifest. The operator's verification steps live in the README.

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
  | `resolveFromStore` — `skill.key !== key` (the store answered under another key) | `integrity_failure` |
  | `resolveFromStore` — `skill.version !== wantedVersion` | `wrong_version` |
  | `resolveFromStore` — success | `ok` |
  | `skills-fs.ts` `resolveReference` — deadline exhausted, or no store configured (both set `unavailable`) | `store_unavailable` |

  The two `integrity_failure` rows are **not** interchangeable, and the difference is the easy thing to get wrong. The `verifyRawSkill` row fires *inside* verification, so it records the `AgentControl Skill Integrity Failure` signal and writes the `ld.skills.integrity_failure` log record with one of the eight `IntegrityReasonCode` tokens. The key-mismatch row fires *after* verification has already passed, so it does neither — it is an outcome reason and nothing else, with no signal, no log record, and no `reason_code`. Do not "fix" that by adding an emission at the key check: the eight-token vocabulary does not cover it, so it would need a ninth token (`key_mismatch`) and a matching change in the Python SDK. A test asserts the silence in both directions.

  Adding an eighth row means answering "which of the five does a caller see?" before writing the code. `unavailable` stays a separate field rather than folding into `reason`: it is narrower, it is what suppresses pruning, and the two bottom rows above never reach an accessor at all.
- `wantedVersion` is passed **into** `SkillStore.getObject(kind, key, version)`, and the post-hoc `skill.version !== wantedVersion` check is kept anyway. The parameter is there because a store may hold several versions of one key and only the store can pick between them; the equality check is a **defense**, not the selection mechanism, because the store is untrusted. Removing either one is wrong: without the parameter a satisfiable pin gets reported as `wrong_version`, and without the check a lying store gets its answer through. Both shipped stores hold several versions of one key and honour the parameter: `getObject` answers a pin with exactly that version, and an omitted version with the newest held. A pin that misses while well-formed versions exist is `absent`; a pin that matches nothing well-formed falls through to the version-less entry, so a malformed object reaches verification and is withheld with a signal rather than reading as a deletion.
- `getSkill`'s contract — "resolves to `null`, never rejects; throws only when no store is configured" — is **frozen**. It is documented in its JSDoc and in the README, and every existing caller treats that `null` as "no skill", so a reason must be added *alongside* it (as `getSkillResult` was) and never by changing what `getSkill` returns. `getSkillResult` is a projection of the same `Resolution` and shares the single throw; it records no telemetry and writes no log record of its own, because the integrity record already fired inside verification before the resolution returned and reporting it again would double-count one failure. `getSkills` and `allSkills` deliberately have no reporting equivalents yet.
- This package has no logger abstraction — every `console.*` call site carries a `biome-ignore` saying so. Introducing a `logger` option is a package-wide API decision affecting unrelated call sites, not a skills change; until one exists, the integrity record has to be self-describing in the string it logs, which is why the event name appears both in the prefix and in the JSON.
- Signal names, property keys, wire field names (`contentHash`), the manifest filename and format, and the exported constants are **identical strings** to the Python SDK. A polyglot fleet has to reconcile the same directory identically, so changing one of these is a cross-language breaking change.
- `parseUsage` must continue to accept `input_tokens/output_tokens`, `inputTokens/outputTokens`, and `input/output` as all existing handlers return one of these variants.
