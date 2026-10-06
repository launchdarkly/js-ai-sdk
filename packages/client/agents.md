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
| `src/conversation.ts` | `withConversationId`, `ConversationIdSpanProcessor` — stamps `gen_ai.conversation.id` |
| `src/sdk-info.ts` | `$ld:ai:sdk:info` package registry and flush |
| `src/lifecycle.ts` | `initClient` (options or BYOC overloads), `getClient`, `shutdown`, `waitForTelemetry`, `shutdownTelemetry`, `extractVariation` |
| `src/client.ts` | `config()` |
| `src/tracking.ts` | `executeAndTrack`, `executeAndStream`, `wrapToolHandlers` |
| `src/graph.ts` | `graph()`, `resolveGraph()` |
| `src/types.ts` | All shared TypeScript types — including owned `LDContext`, `LDClientInterface`, `LDClientInterface` — plus the Agent Skills value types, their freezing factories, and `parseAiConfig`'s validators |
| `src/utils.ts` | `parseTemplate`, `parseJSONWithPossibleFences`, `createHandler` |
| `src/registry.ts` | `Registry`, `globalRegistry`, `compose` |
| `src/shutdown-hooks.ts` | The cleanup hooks `shutdown()` runs — how core clears experimental state without importing it |
| `src/skills-core.ts` | Agent Skills internals shared by the two layers above it: the store and telemetry seams, module state, integrity verification, store resolution |
| `src/skills.ts` | `skillRefs`, the content accessors, `InMemorySkillStore`, and the documented test-injection hooks |
| `src/skills-fdv2.ts` | Agent Skills delivery transport — the FDv2 protocol, the wire-key/`version` translation, the held object set, and `FDv2SkillStore`. Sits **below** the store seam; imports `skills-core` only, and nothing imports it |
| `src/skills-watch.ts` | Agent Skills eager re-reconcile — `watchSkills` / `SkillWatcher`, wiring the store's change listener to `writeSkills`. Sits **above** `skills-fs` and modifies none of it |
| `src/skills-fs.ts` | `writeSkills` — the manifest format, on-disk filenames, and reconcile semantics |
| `src/safe-fs.ts` | Symlink-refusing filesystem primitives. Knows nothing about skills; owns the single interceptable rename and unlink call sites |
| `src/index.ts` | Public barrel — the package root, and the only surface handler packages import from |
| `src/experimental.ts` | Experimental barrel — `@launchdarkly/ai-server/experimental`. Agent Skills is exported here and only here |

The Agent Skills module dependencies run **one way only**:

- `types` ← `skills-core` ← `skills`, and `types` + `safe-fs` + `skills-core` ← `skills-fs`. `skills-core.ts` imports neither `skills.ts` nor `skills-fs.ts`.
- `skills-fdv2.ts` sits *below* the seam and imports only `skills-core` + `types`; nothing imports it.
- `skills-watch.ts` sits *above* `skills-fs` and imports it without being imported back.

Do not add an edge that closes a cycle. The store and the emitter live in `skills-core.ts` so the accessor and filesystem layers cannot disagree about whether one is configured.

---

## Agent Skills — the delivery transport, and the one field that will bite you

`FDv2SkillStore` speaks LaunchDarkly's SDK-facing FDv2 channel (`GET /sdk/poll`, `GET /sdk/stream`, server-side SDK key in `Authorization`, a `basis` param once a payload has committed, `If-None-Match`/304). It sits below the seam and produces raw objects in the shape `SkillStore` documents; **nothing above the seam knows it exists**. If a transport change seems to require editing an accessor, verification, or `writeSkills`, the adapter boundary is wrong.

**The skill's version is in the object's `key`. `version` is the payload's.** Each version of a skill is its own object on the wire, identified as `<key>:<version>`:

```json
{"key":"pdf-extraction:3","kind":"skill","version":42,
 "object":{"contentType":"text/markdown","content":"…","contentHash":"…","name":"…"}}
```

The `3` after the delimiter is what a `{key, version}` reference pins; it becomes the seam's `version`, under the seam key `pdf-extraction`. `version` (42) is the version of the *payload*, and moves when anything in the environment moves, including an unrelated flag. Reading it as the skill's version fails **silently**: the object verifies, the hash matches, and the caller gets content under a meaningless version. Objects carry only `key`, `kind`, `version` and `object`, like a flag, so there is no other field to read.

- `splitWireKey` is the only place the wire key is read. `seamObjectFromPut` and `tombstoneFromDelete` both go through it, and the `version translation` suite asserts both directions.
- A wire key that will not split cleanly is *held*, not dropped (version-less, or with the offending text as its version), so verification withholds it as `invalid_version` under a key the caller recognises. Only a key with nothing before the delimiter is dropped.

**Skills are identified by `kind === 'skill'`; other kinds are ignored, not rejected.** Object kinds are open strings, and a skill arrives under the bare kind its producer registered. With the `kinds` declaration below, flag and segment objects should not arrive at all, but the skip stays and stays tested: throwing on an unknown kind would turn a payload that gained a new object kind into a permanent reconnect loop — a flag-delivery outage caused by a skills rollout.

**Every request declares `kinds=agent-skill`.** Delivery defaults to flags, so without it the store is served the flag payload and holds no skills while reporting healthy. It also narrows the connection to the one payload `ProtocolReader` is built for; otherwise a skill-enabled environment assigns two, and the reader warns and reads only the first. `FDV2_PAYLOAD_KIND` (the payload) and `FDV2_OBJECT_KIND` (the objects inside it) are different strings, asserted apart by source text so an alias cannot pass.

**No `mv` parameter.** It selects the *flag* data model, and delivery ignores it for non-flag payloads.

**HTTP 422 is fatal.** Delivery answers 422 when a connection's declared kinds exclude every payload assigned to it, and chose a non-400 4xx because LD SDKs treat those as terminal. `classifyStatus` returns a `FatalTransportError` and the normal give-up path runs: `failed` and `lastError` are set, `waitForSkills` resolves `false` at once, and `connectionFailures` is left untouched (it counts consecutive *recoverable* failures, and a fatal never retries).

**Polling and streaming have different default hosts.** `GET /sdk/poll` uses `DEFAULT_BASE_URI` (`sdk.launchdarkly.com`) and `GET /sdk/stream` uses `DEFAULT_STREAM_URI` (`stream.launchdarkly.com`), as in the base server-side SDK. The fake endpoint serves both from one origin, so tests cannot catch a stream request sent to the polling host. A lone `baseUri` applies to both, since a relay or private instance usually serves both from one host; `streamUri` overrides the stream origin on its own.

**Changes commit at `payload-transferred`, not as objects arrive.** A payload version is the unit of consistency. A half-applied full transfer would publish a state the server never described and briefly empty the store, which with pruning on deletes skill files. An interrupted transfer keeps last known good. Listeners fire once per changed object, all at `payload-transferred` — which is why `watchSkills` debounces.

**A commit is the only thing that publishes a first payload, and a 304 is not one.** `isInitialized()` — the fact `writeSkills('*')` authorizes a prune on — goes true when a payload *commits*, so every other answer has to stop short of claiming one. A `payload-transferred` that applied nothing reports neither a commit nor an up-to-date answer, and does not adopt the selector of a payload it never applied: a `none` intent that no object followed builds no pending set, nor does an `intentCode` this SDK does not recognise, and a foreign payload's contents are declined. A poll adopts the response `ETag` only from a body that completed an exchange — a commit, or a `none` intent, which is the server saying the content held is what the etag describes; an unrecognised intent says the opposite, since the body carried objects `ignoreUnderUnknownIntent` dropped, and leaving that poll unconditional is what keeps the body arriving and the warning repeating instead of silenced behind a 304. And a 304 *confirms* the payload held rather than establishing one, because the exchange it stands in for cannot establish one either. Loosen any of the three and the other two carry a store that received nothing into a prune of every managed `SKILL.md` on disk: an empty committed set reads as an environment that revoked every skill, and a 304 carries nothing to notice it on. There is no cached basis to make it safe — `basis` and `etag` both start `null` with no injection point, so a 304 reaching a store that holds nothing takes a server answering a request that carried no etag at all.

**`objectsRevoked` counts revocations, not tombstones.** A full transfer revokes by omission, so `payloadTransferred` diffs the committed set against the pending one and pushes departures into `changes` as tombstones per `(key, version)`: a listener that reads versions needs both halves of a version move. The counter, which operators alert on, counts only a key the payload dropped altogether; a key surviving under a new version was not revoked. `keysFullyRevoked` is where the two granularities part.

**The first payload intent is read, and assumed to be the skill payload.** The `kinds` declaration narrows the connection to one payload and the protocol says to ignore all but the first intent, so `payloads[0]` is read. The risk: an `xfer-full` for *another* payload would start an empty pending set, and the next `payload-transferred` would publish it — every skill revoked, and with pruning on, files deleted.

- `ProtocolReader` therefore learns the skills payload (from the intent's `id` or the `(p:<id>:<version>)` selector) and declines a transfer of any other: one warning, counted in `diagnostics.payloadsIgnored`, last known good kept.
- A transfer that names no payload is applied, since one-payload delivery is the common case.
- The first transfer on a connection has nothing to compare against; the separate warning on a multi-payload intent covers it.

**A hashless object is held, not dropped.** Verification withholds it as `missing_content_hash`, and the transport makes that loud: an error per object, a summary each time the held store becomes wholly hashless or its withheld set changes, and `diagnostics.hashlessObjects`. Dropping it would report `absent` — indistinguishable from "no such skill" — and let a prune delete the last known-good copy on disk. Never synthesize a hash from the delivered content; that verifies nothing.

- Neither error repeats for a payload re-delivered unchanged, which matters in polling mode, where the same payload arrives every interval.
- What has been reported is tracked in each `ProtocolReader`'s own `HashlessMemory` (exposed to tests as `_warnedHashless`): per store, so two stores in one process do not suppress each other's reports, and capped, so a frequently versioned environment cannot grow it without bound.

**`SkillObjectSet.snapshot` collapses to one object per key, keyed by the bare skill key.** `<root>/<key>/SKILL.md` is a single path, so a whole-store consumer must see one object per key; otherwise a `'*'` reconcile writes one path twice and `allSkills` returns two versions of a skill. Both consumers also collapse for themselves through `newestByKey`, because the seam admits any store. The keys must be skill keys, not wire `key:version` keys, because `writeSkills('*')` derives its prune keep-set from them. `getObject` still resolves a pinned version from the full set.

**There is one network timeout.** `readTimeoutMs` is applied through a `ReadDeadline` composed with the store's abort signal, so connect, headers and each body read share it. Its default is per mode: `DEFAULT_POLL_TIMEOUT_MS` for a whole poll request, `DEFAULT_STREAM_READ_TIMEOUT_MS` for the gap between reads on a stream (tripping it on a quiet stream *reconnects*). The `timeouts` suite measures the bound against a socket that accepts and never answers. Do not add a separate connect timeout.

**A body read that fails is recoverable; a protocol-reader or dispatch error is not.**

- `iterSse` wraps read failures (a reset, a truncated chunk, the read deadline) as `RecoverableTransportError`, since a live stream dies mid-body far more often than it refuses to open. The delivery loop treats anything else as a bug and stops for the process lifetime.
- An error thrown by the consumer's loop body while the generator is suspended at a `yield` passes through unwrapped, so a bug still surfaces as one.
- A poll body or streamed event over `MAX_RESPONSE_CHARS` is a `FatalTransportError`, not a read failure, and takes the give-up path like a 422 (`failed` and `lastError` set, `connectionFailures` untouched). The size belongs to the environment, so a retry would re-download up to 64 Mi characters on every backoff step, from every process, and never set `failed`.
- Every retry delay is clamped to `maxBackoffMs` and floored at `initialBackoffMs`, so `Retry-After: 0` cannot cause a tight reconnect loop. A blank `Retry-After` means "no delay given", not zero (`Number("")` is `0`).

**What resets the failure counter, and what escapes it.** The counter is reported as `connectionFailures`; it bounds nothing, and it no longer drives the backoff (see the next paragraph). Recoverable failures are retried for the life of the store, and there is no `maxConsecutiveFailures` option: a count bound would turn a short outage into a process that never sees another revocation. Only a fatal status stops delivery.

- **It resets only on a completed exchange** — a committed payload, or a `none` intent — not when a connection returns. A stream only ever ends by being dropped, so resetting on return would count every healthy, server-recycled connection as a failure.
- **`none` counts** because a reconnect whose basis is already current is answered with `none` and commits nothing; requiring a commit would report a healthy stream for an environment whose skills never change as failing.
- **A parsed `xfer-full` or `xfer-changes` intent does not reset it.** A server that announces a transfer and drops before `payload-transferred`, every time, has delivered nothing, and would otherwise read as healthy in `connectionFailures` for as long as it kept doing so (pinned by the `counts each drop of a server that announces a transfer and drops` test).
- **A non-catastrophic `goodbye` is exempt from the counter** only on a connection that completed such an exchange, tracked per attempt by `reachedServer`. Otherwise a server that says goodbye before sending any intent could reconnect without limit, never reaching `diagnostics` or `failed`. An exempt `goodbye` sets no `lastError` and logs nothing above debug: `ProtocolReader` cannot tell a recycle from a failure, so it logs the goodbye at debug and leaves the warning to the delivery loop, which warns only for a disconnect that counts.

Keep both halves — the reset rule and the `reachedServer` qualifier.

**The backoff step is not the failure counter.** `backoffAttempt` advances on every reconnect after a failure or a dropped stream, a `goodbye` recycle included, and returns to the first step only when the stream that just ended had been open for `BACKOFF_RESET_INTERVAL_MS` (60 s, as js-core's `Backoff` and the Python SDK's `BACKOFF_RESET_INTERVAL`), or when a poll completes (`pollIntervalMs` already spaces polls). Resetting it on a commit or a `none` instead would let a degraded server that answers and then drops be reconnected at `initialBackoffMs` by every process for as long as it stayed degraded, and with no failure bound nothing else would stop that. The interval is not an option; tests shorten it through the instance's `_backoffResetIntervalMs`.

**The SDK key goes only where it was pointed, enforced in two places.** Every request carries the server-side SDK key in `Authorization`.

- `requireHttpsUri` checks both `baseUri` and `streamUri` in the `FDv2SkillStore` constructor (after the lone-`baseUri` resolution, even with an injected `Requester`): `https://` with a host, or plain `http://` to loopback only (`localhost`, `127.0.0.1`, `::1`, where the test doubles listen). Anything else throws with a message naming `https://` and the defaults.
- Both fetches in `FetchRequester` use `redirect: 'manual'`, because `fetch`'s default `'follow'` copies `Authorization` onto whatever host `Location` names. Any 3xx — same host included, and an `opaqueredirect` if the runtime produces one — is a `FatalTransportError` through `classifyStatus`, handled exactly like 401/403. A 304 is not a redirect and is settled first.

The Python SDK enforces the same pair with the same wording; change both or neither.

**HTTP 400 is recoverable once, and only when there was state to drop.** The `basis` selector and the `If-None-Match` etag are the only client state in a request.

- A 400 on a request carrying either arrives as `StaleRequestStateError`: the state is dropped and a full transfer is requested from scratch. A second 400 is fatal.
- A 400 on a request carrying neither is fatal at once; a retry would be byte-identical.
- Do not make 400 unconditionally fatal: a stale selector would strand delivery for the process lifetime. 405, 406, 414 and 501 stay fatal.

**`close` aborts the signal, not just a flag.** The delivery task is awaiting a stream read, so a flag it never checks would leave a healthy stream running until exit. The store's signal is the parent of every `ReadDeadline`, so one abort reaches a pending connect and a pending read alike; a closing store is not reported as a failure. Every backoff, deadline and `waitForSkills` timer is `unref`ed, so a background store never keeps `node` up.

**The store refuses two things loudly rather than degrading.**

- `addListener` throws for any kind but `'skill'`, in `FDv2SkillStore` and `InMemorySkillStore` alike: a listener on another kind would silently never fire. `removeListener` accepts any kind, so a consumer can detach unconditionally.
- `close` is final: `start` throws afterwards rather than opening a second delivery loop. A store that gave up on its own is different: `start` runs delivery again with the failure count and backoff started over, and clears `failed`, and is a no-op while delivery is running. Closing leaves `failed` as `null` (it is the caller's decision, not a delivery failure), and both a closed store and one that gave up answer `waitForSkills` immediately.

---

## Public Exports (`src/index.ts`)

This block is **generated from `src/index.ts`, verbatim and in its order** — it is not a curated
summary. Regenerate it rather than hand-editing, or it drifts from `index.ts`.

```ts
export type { AiConfigRep } from './client.js';
export { config } from './client.js';
export type { ContentCaptureOptions, SpanMessage, SpanMessagePart, ToolDefinitionInput } from './content.js';
export {
  langChainContentText,
  langChainFinishReasons,
  langChainSpanMessages,
  setInputContentAttributes,
  setOutputContentAttributes,
  setToolCallContentAttributes,
  setToolDefinitionAttributes,
  textMessage,
  toSemconvFinishReason,
} from './content.js';
export {
  ConversationIdSpanProcessor,
  setConversationIdIfAbsent,
  withConversationId,
} from './conversation.js';
export { graph, resolveGraph } from './graph.js';
export type { CanonicalTurn, ConfigTurn } from './history.js';
export {
  anyMultimodal,
  composeHistory,
  contentToText,
  hasMultimodalContent,
  imageBlockToUrl,
  isContentBlocks,
} from './history.js';
export { buildJudgeTasks, runJudge } from './judges.js';
export type { InspectConfigResult } from './lifecycle.js';
export { getClient, initClient, inspectConfig, shutdown, shutdownTelemetry, waitForTelemetry } from './lifecycle.js';
export { compose, globalRegistry, Registry } from './registry.js';
export { registerAiSdkPackage } from './sdk-info.js';
export { makeNodeTrackData, makeRunTrackData } from './tracking.js';
export type {
  ConfigArgs,
  ConfigMessage,
  ContentBlock,
  GraphArgs,
  GraphDefinition,
  GraphEdge,
  GraphNode,
  GraphOptions,
  GraphStreamEvent,
  GraphTopology,
  HandlerStreamEvent,
  ImageContentBlock,
  JudgeCallResult,
  JudgeRunResult,
  JudgeTask,
  LDClientInterface,
  LDContext,
  LDMultiKindContext,
  LDSingleKindContext,
  LDUser,
  Message,
  MessageContent,
  ProviderGraphResponse,
  ProviderHandler,
  ProviderResponse,
  ProviderSetupFn,
  RegistryInput,
  RouteResult,
  RunNodeOptions,
  StreamEvent,
  TextContentBlock,
  TokenUsage,
  Tool,
  ToolHandlerFn,
  TrackData,
  TraverseVisitor,
  VariationMeta as LDVariationMeta,
} from './types.js';
export {
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
  omitModelStamps,
  parseJSONWithPossibleFences,
  parseTemplate,
  setLdSpanAttributes,
  setModelIdentityAttributes,
  setUsageSpanAttributes,
} from './utils.js';
```

## Experimental Exports (`src/experimental.ts`)

Published as `@launchdarkly/ai-server/experimental` (a subpath in `package.json` `exports`, built
alongside the root by `tsup.config.ts`). Names here may change in a minor release and are **absent
from the package root**. `@launchdarkly/ai-node/experimental` re-exports this entry point. Generated from
`src/experimental.ts` the same way as the block above.

```ts
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
export { DEFAULT_BASE_URI, DEFAULT_STREAM_URI, FDv2SkillStore } from './skills-fdv2.js';
export type { WriteSkillsOptions } from './skills-fs.js';
export { MANIFEST_FILENAME, MANIFEST_VERSION, SKILL_FILENAME, writeSkills } from './skills-fs.js';
export type { WatchSkillsOptions } from './skills-watch.js';
export { DEFAULT_DEBOUNCE_MS, SkillWatcher, watchSkills } from './skills-watch.js';
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
```

The stage rules (shared spec §0.3), which every change here must keep:

- **Core never names experimental.** No root export, core type, function signature, or option may
  mention an experimental name. `AiConfigRep.skills` is therefore typed structurally rather than as
  `SkillReference[]`, and the store is set with `setSkillStore`, not an `initClient` option.
  Experimental code may import core freely.
- **Core reaches experimental only through an internal hook**, and a failure there is caught and
  logged, never thrown into the core call. Core never imports an experimental module: an experimental
  module registers its cleanup with `registerShutdownHook` (`src/shutdown-hooks.ts`) when it loads,
  and `shutdown()` runs whatever is registered. Today the one hook is Agent Skills', registered by
  `skills-core.ts`. A test asserts that loading the root registers no Agent Skills hook.
- **Both entry points are in the API report.** `etc/ai-server.api.md` (root) and
  `etc/ai-server-experimental.api.md` are checked in; CI runs
  `yarn workspace @launchdarkly/ai-server api:check`. After an intended surface change run
  `yarn workspace @launchdarkly/ai-server api:update` (or `yarn api:update` from this directory) and
  commit both reports.
- **Promotion to core** adds root exports and keeps these as `/** @deprecated use the root export */`
  re-exports until the next major.

When adding a new export, add it here. Handler packages must never deep-import build paths (e.g. `@launchdarkly/ai-server/dist/client`). The only sub-path anyone may import is the published `@launchdarkly/ai-server/experimental`, and a handler package does so only for an experimental feature it integrates with; everything else comes from the package root.

`MAX_SKILL_CONTENT_BYTES` and `SKILL_OBJECT_KIND` are deliberately **not** exported; both stay internal to `skills-core.ts`, and an absence assertion enforces it. Do not re-export either from `index.ts` or `experimental.ts`:

- The size cap is a local bound on content the platform produces. Exporting it would semver-lock a number this SDK does not own; the `over_size_cap` reason string already reports the bound when it withholds content.
- The kind is the SDK-side value handed to a `SkillStore`, not the wire contract, and publishing it would imply otherwise.

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
3. If `judgeConfiguration.judges` is present, runs each judge handler (sampled by `samplingRate`) against the primary response, tracks `evaluationMetricKey`, and emits a `gen_ai.evaluation.result` span event on the judge's `invoke_agent` span (`gen_ai.evaluation.name` / `.score.value` / `.explanation`).
4. Returns `ProviderResponse`: `{ response: string, usage: { input, output, total }, trackData: TrackData, judgeResults?: Record<string, JudgeCallResult>, judgeTasks?: JudgeTask[] }`. `judgeResults` is populated when `skipJudges` is `false` (default) and judges ran; `judgeTasks` is populated when `skipJudges: true`.

---

## Conversation grouping

LaunchDarkly's conversation view groups spans on `gen_ai.conversation.id`. Bind a caller-supplied id around any `invoke()` / `stream()` / `graph().invoke()` / `graph().stream()` call:

```ts
import { withConversationId, config } from '@launchdarkly/ai-node';

await withConversationId('thread-123', () =>
  config({ key, handler }).invoke(userInput, ctx),
);
```

Call `initClient()` before binding. Until it runs there is no OTel context manager registered, and
OTel's default discards the context — so an id bound before initialization is dropped and that run's
spans go out unstamped. The SDK warns once when this happens rather than failing silently. Lazy
initialization is still supported; it just means the very first run of a process loses its id, and
every run after it is fine.

```ts
await initClient();
await withConversationId('thread-123', () => config({ key, handler }).invoke(input, ctx));
```

`stream()` binds at call time rather than on first `next()`, so handing the generator off and
iterating it later — the normal shape for a chat app — keeps the id:

```ts
const gen = withConversationId('thread-123', () => config({ key, handler }).stream(input, ctx));
for await (const event of gen) { /* spans opened here still carry thread-123 */ }
```

Only the id is re-applied per step; the ambient context at iteration time is otherwise untouched,
so streaming span parenting is the same as it is with no id bound.

`initClient()` registers a span processor that stamps the id write-if-absent on every SDK span (root, chat, execute_tool, graph). The processor is registered on the *global* tracer provider, so it is scoped to spans from `@launchdarkly/ai-*` tracers only — a caller-supplied id must not land on third-party instrumentation spans (HTTP, Postgres, the outbound provider call). No id is invented when the caller supplies none — a UUID, a trace id, or a content hash would violate the semantic conventions.

This is an OTel context value, not W3C baggage, so the id does not leak onto outbound provider HTTP calls. A multi-tenant process must bind a different id per request; do not put it on the tracer resource.

---

## OTel Setup

The core client owns all OTel initialization. `initClient()` sets up a `NodeTracerProvider` with `ConversationIdSpanProcessor` and a `BatchSpanProcessor` plus an OTLP HTTP exporter when the optional OTel peer deps are installed.

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
- **Explicit initialization — BYOC path.** `initClient(client, options?)` accepts any pre-initialized object that satisfies `LDClientInterface` — this is the path for Vercel, Cloudflare, or other edge runtimes whose SDK has different init semantics. No `@launchdarkly/node-server-sdk` is required. The optional second argument is the same options bag as the other overload, passed whole to telemetry setup (`otlpEndpoint`, `serviceName` and `environment` mean the same thing).
- **Options are ignored once the client singleton exists.** The skill store is not an option: `setSkillStore(store)` (experimental entry point) sets it independently of `initClient`, on every call, so a client that initialized lazily can be given one later. A nullish argument never clears a configured store; only `shutdown()` does, and it clears skills state unconditionally, before its own early return, because that state can exist without a client. A throw from that clearing is logged and does not fail `shutdown()`. Any options key `initClient` does not read, a `skillStore` key included, is ignored with a generic warning that names the key but not the feature or its setter.
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

`Skill.content` is a `Uint8Array`: the verified verbatim bytes that were hashed. The SDK treats it as opaque — no frontmatter accessor, no YAML dependency, and no decode step (the wire string is encoded to bytes exactly once, during verification in `skills-core.ts`). Do not add a parser, a convenience accessor, or an encoding assumption; consumers who want structure parse the bytes themselves. Same contract as the Python SDK.

### 4. Assuming `writeSkills`'s `timeout` is in milliseconds

It is in **seconds**, defaulting to `10`. The signature is a cross-language contract that must match the Python SDK exactly, so the usual TypeScript `timeoutMs` instinct is wrong here.

### 4a. Passing `debounceMs` and `timeout` in the same unit

`WatchSkillsOptions` is `WriteSkillsOptions` plus two fields, so one options bag carries `debounceMs` in **milliseconds** (the TypeScript convention) beside `timeout` in **seconds** (the cross-language contract from pitfall 4). `{ debounceMs: 500, timeout: 10 }` is the sane pair; `{ debounceMs: 0.5, timeout: 10_000 }` is a 1 ms coalescing window and a nearly three-hour reconcile budget. Both are guarded for sign and finiteness, not for plausibility.

### 4b. Reading "no `removed` action" as "nothing is stale"

Prune is **suppressed** — not merely empty — whenever the run cannot tell what is still current:

- an incomplete retrieval (no store configured, a store that threw, an exhausted timeout);
- a store whose `isInitialized()` answers `false` (delivery has not sent a payload yet);
- a withholding that could not be attributed to a key (the `'*'` form's run-level `error`);
- a corrupt manifest.

Each case puts an `error` action in the report, sets `ok` to `false`, and prunes nothing — including skills that genuinely were revoked. To know whether revocation has taken effect, read `ok` and `errors`, not the absence of `removed`.

### 4c. Two watchers on one root, or `writeSkills` on a watched root

Run one reconcile per root at a time. Two interleaved runs read the same manifest and each writes it back from its own picture, so the loser's entries vanish while its files stay on disk unmanaged. `SkillWatcher` serializes its own reconciles, but cannot see a second watcher on the same root or a caller's own `writeSkills` against it. Do neither.

### 4d. Expecting revocation to reach a boot-only `writeSkills` deployment

With an explicit list, `watchSkills` does not close the gap either. A requested skill the store answers `absent` for stays in the requested set as an `error` action and is not pruned, and the watcher listens only to the skill store, so unpinning a skill from an AI Config is not seen. Only `watchSkills('*', …)` removes a revoked skill from disk without a re-run.

Without `watchSkills`, the revocation bound is process lifetime: a skill revoked after boot stays on disk until the process reconciles again, so a restart (or an explicit re-run of `writeSkills`) is the incident-response action — and content an agent has already read into a conversation is out of reach at this layer either way.

### 5. Relaxing a path or manifest check in `skills-fs.ts`

`keyRejectionReason` and `unsafePathReason` are shared by the write and prune paths so the two cannot disagree about which paths this SDK may destroy, and both are **non-relaxable**. The same goes for the manifest rules: a destructive operation is allowed only on a path the manifest lists under a matching key, and a corrupt manifest (including one larger than `MAX_MANIFEST_BYTES`, 8 MiB) suppresses every destructive action. Each has a dedicated abuse-case test in `src/__tests__/skills-fs.test.ts`; if one starts failing, the defense changed, not the test.

Three specifics a later contributor is most likely to widen:

- **The 22 Windows reserved device names** — `con`, `prn`, `aux`, `nul`, `com1`–`com9`, `lpt1`–`lpt9` — are rejected by `keyRejectionReason` on every platform.
  - No `process.platform === 'win32'` gate: a root written by a Linux container and read from a Windows host is an ordinary deployment, and with no Windows CI runner a platform branch would be untested.
  - Not in `isValidSkillKey` or `SKILL_KEY_PATTERN` either. `parseAiConfig` fails closed on a bad `skills` entry, so a grammar rejection would invalidate the *whole* AI Config for a customer who never touches Windows. `skillRefs` would also drop the reference (with a warning), shortening what it hands `writeSkills` so prune deletes the skill's on-disk copy — "fails to write on Windows" becomes "deleted on Linux". The 255-byte path-component bound lives in this layer for the same reason.
  - The set is exact: `com0` and `lpt0` are not reserved, and no case folding or suffix stripping is needed because the key grammar admits no uppercase, no `.`, and no `$`.
- **Adoption narrows the clobber refusal; it is not a hole in it.** A file at a managed path with no manifest entry is adopted (recorded, reported `skipped_current`) only when its on-disk sha256 equals the resolved content hash. That lets a reconcile killed between the content writes and the final manifest write heal instead of wedging. Adopt on anything weaker than an exact hash match and the guarantee is gone. `skipped_current` is reused because a new `ReconcileActionKind` member would break every consumer with an exhaustive `switch`.
- **`readRegularFile` is what makes that read safe**, and every part is load-bearing:
  - `O_NONBLOCK`, because opening a FIFO with no writer blocks forever and would hang the reconcile and the event loop;
  - `O_NOFOLLOW`;
  - an `fstat` on the *handle*, not a `stat` on the path, refusing anything that is not a regular file.

  A failed read is a refusal, never a fall-through to the write. There is no `O_BINARY` (Node does no CRLF translation) — the one deliberate difference from the Python twin.

### 6. Bypassing `fsOps` for a destructive filesystem call

`safe-fs.ts` routes the final rename and the managed-file unlink through the `fsOps` record so tests can intercept exactly those two operations. Calling `fs.rename`/`fs.unlink` directly hides the operation from the atomicity and "no operation was attempted" assertions, which then pass vacuously.

- The orphaned-temp sweep goes through `unlinkNoFollow` for the same reason, and takes its filename pattern from `tempNamePattern` in `safe-fs.ts` rather than a copy. The sweep may only unlink a file whose *name* marks it as one this SDK created, so two spellings of the rule would eventually miss orphans or remove something it did not write.
- A **third** hook is deliberately outside `fsOps`: the root-swap races mock `mkdir` and `open` through `vi.mock('node:fs/promises')`, because they must fire *before* the root is pinned. Folding them into `fsOps` would blur what a "no filesystem operation was attempted" assertion means.

On the platform bound: Node has no `renameat`/`unlinkat`, so `SUPPORTS_DIR_FD` is `false` on every release to date. But `SUPPORTS_PROC_FD` addresses children through `/proc/self/fd/<fd>/<name>`, which the kernel resolves from the descriptor's inode rather than the name it was opened under. That **closes** the swap window on Linux, so the swap-race tests run there and skip only where neither capability exists. Two consequences:

- The `(dev, ino)` identity re-check is the macOS floor only and must not run on the fast path: `lstat` of `/proc/self/fd/<fd>` reports procfs's magic symlink, not the directory.
- A green macOS run proves nothing here: all ten of those tests skip locally and run only on Linux CI.

### 7. "Fixing" the platform bound, or adding a writability field to `ReconcileReport`

Two decisions here look like unfinished work and are not. Do not reverse either without re-examining the threat model behind it.

- **Windows reparse-point checks (`GetFileAttributesW`, `FILE_FLAG_OPEN_REPARSE_POINT`) are deliberately not implemented.** Windows is not a supported or tested platform for this release, there is no Windows CI runner, and Node has no `*at()` primitive that would make such checks meaningful: off the Linux fast path, the racy per-component `lstat` floor runs everywhere. The bound is documented in `safe-fs.ts` and the README. Keep the reserved-device-name check (it keeps a Linux-written root usable from Windows), but do not read it as Windows hardening. If Windows becomes supported, add the CI runner first, then revisit both together.
- **`ReconcileReport` must not grow a "managed root is writable" field.** The SDK knows only its *own* identity, which just wrote there, and cannot know which identity will run the agent, so any such field would create false confidence. The real mitigation is deployment-side: run the reconcile as a different identity than the agent, so the `0644`/`0755` modes stop a prompt-injected agent from rewriting its own instructions or the manifest. The operator's verification steps are in the README.

---

## Adding a New Export

1. Implement the function/type in the appropriate `src/*.ts` file.
2. Add a named export to `src/index.ts` — or to `src/experimental.ts` if the feature is experimental.
3. Rebuild: `yarn build` from this directory, then `yarn api:update` (from this directory) and commit the changed `etc/*.api.md` report.
4. All handler packages pick up the change automatically via the local `file:../client` dependency.

## Invariants to Preserve

- Do not add dependencies on any `@launchdarkly/ai-*` handler package. This package has no upward dependencies.
- Do not add a hard dependency on `@launchdarkly/node-server-sdk` or any other LD SDK. The node SDK must remain an optional peer, discovered via dynamic `import()`.
- Handler packages and consumer code must import `LDContext` from `@launchdarkly/ai-server` — not directly from any LD SDK. The owned definition in `src/types.ts` is structurally compatible with all LD SDK versions.
- Do not weaken the `parseAiConfig` validation — handler packages rely on `config` being valid when they receive it. The `skills` array fails **closed**: one malformed reference fails the whole parse, rather than silently materializing a partial skill set.
- Do not interpret skill content anywhere — no frontmatter parsing, no YAML dependency, no encoding assumption beyond the one wire-string encode inside integrity verification. See pitfall 3.
- Skills telemetry goes through the private emitter seam in `skills-core.ts` and nowhere else.
  - **Never** call `client.track()` for a skills operation: these are LaunchDarkly product signals, and `track()` would need an LD context, spend the customer's event volume, and land in their data export.
  - Exactly three signal names exist (`AgentControl Skill Integrity Failure`, `AgentControl Skill Materialized`, `AgentControl Skill Revoked Received`), an allowlist, not a floor. `AgentControl Skill SDK Reference Returned` and `AgentControl Skill Content Retrieved` must **never** be emitted.
  - Every signal is built by a `record*` function in `skills-core.ts`, so the allowlist is enforced in one place.
- No filesystem paths and no skill content in telemetry — hashes and byte counts only. Paths belong in the `ReconcileReport`, which is user-facing API.
- The `ld.skills.integrity_failure` log record is a **documented customer-facing contract**, not a debug line:
  - built only by the `record*` recorders in `skills-core.ts` — `recordIntegrityFailure` for the eight verification failures, `recordKeyMismatch` and `recordVersionMismatch` for the two boundary ones;
  - written to `console.error` on every failure, unconditionally, because it is the only detection surface a customer with telemetry off (or no reachable telemetry destination) has;
  - keys inserted in **alphabetical order**, so `JSON.stringify` is byte-identical to the Python SDK's `json.dumps(record, sort_keys=True, separators=(",", ":"))` for the same failure, modulo `language`; do not reorder them;
  - absent optional fields are omitted, never emitted as `null`.

  Renaming the event, renaming or dropping a field, or emitting a null is a breaking change to a security control customers alert on.
- `reason_code` is a **closed ten-token vocabulary**: `hash_mismatch`, `invalid_key`, `invalid_version`, `key_mismatch`, `missing_content`, `missing_content_hash`, `not_an_object`, `not_utf8`, `over_size_cap`, `version_mismatch`.
  - Eight are one per `recordIntegrityFailure` call site. `key_mismatch` and `version_mismatch` come from `recordKeyMismatch` and `recordVersionMismatch` at the retrieval boundary and write the log record without the signal (see the outcome table below).
  - The two boundary codes are reachable only after all eight verification checks pass, so they never coincide with a verification code. They can compete with each other; the key check runs first, because an answer that is not the requested skill makes its version moot.
  - An eleventh token must land in the Python SDK, the README's `reason_code` table, and the vocabulary test in `src/__tests__/skills.test.ts` in the same change; a one-sided token silently breaks a customer's cross-language alert rule.
  - `reason_code` stays **out** of telemetry properties; it belongs to the customer-owned log record, not LaunchDarkly's counter.
- `SkillOutcomeReason` is a **closed five-token vocabulary** — `absent`, `integrity_failure`, `ok`, `store_unavailable`, `wrong_version` — published by `getSkillResult`, branched on by customers, and identical in the Python SDK.
  - A sixth token must land in the Python SDK, the README's `reason` table, and the union-exhaustiveness test in `src/__tests__/skills.test.ts` in the same change.
  - It is coarser than `IntegrityReasonCode`: the ten integrity tokens say *which check failed* (for the operator, via the log record); the five outcome tokens say *what the caller got*.
  - The version mismatch has a token in each, spelled differently on purpose — `version_mismatch` the code, `wrong_version` the outcome — so a detection rule is unambiguous about which surface it matches. Do not unify them.
  - `verifyRawSkill` returns `null` without surfacing which integrity token fired, deliberately; the operator already has it from the log record.
- `Resolution.reason` is set **explicitly at every construction site**, never derived from the prose in `Resolution.error`. The field is required so a new internal outcome must pick a public token rather than inherit `'absent'` by omission. The mapping:

  | Where the resolution is built | `reason` |
  |---|---|
  | `resolveFromStore` — the store threw (also sets `unavailable`) | `store_unavailable` |
  | `resolveFromStore` — `raw` is not an object (null, an array, a scalar) | `absent` |
  | `resolveFromStore` — `verifyRawSkill` returned `null` | `integrity_failure` |
  | `resolveFromStore` — `skill.key !== key` (the store answered under another key) | `integrity_failure` |
  | `resolveFromStore` — `skill.version !== wantedVersion` (the store answered a pin with another version) | `wrong_version` |
  | `resolveFromStore` — success | `ok` |
  | `skills-fs.ts` `resolveReference` — deadline exhausted, or no store configured (both set `unavailable`) | `store_unavailable` |

  - **The two `integrity_failure` rows differ.** The `verifyRawSkill` row fires inside verification: the `AgentControl Skill Integrity Failure` signal **and** the `ld.skills.integrity_failure` log record. The key-mismatch row fires after verification passed, via `recordKeyMismatch`: **the log record only** (`reason_code: key_mismatch`, plus a `served_key` field no other record carries), no signal.
  - **The `wrong_version` row also writes a record only**, via `recordVersionMismatch`: `reason_code: version_mismatch`, a record-only `served_version` field, and a `version` field carrying the version *requested*. `getSkill` collapses `wrong_version` to `null`, so without the record an operator on the default accessor could not see a store answering pins with the wrong version.
  - **Why a record but no signal, for both boundary rows.** The record is the customer-owned detection path, and sharing the event identity lets one SIEM rule catch both, with the code as the discriminator. The usual cause is a broken custom store adapter, not an attacker, so LaunchDarkly's counter stays out — the same false positive the not-an-object row avoids by reading as `absent`. The two rows are one decision: a change that gives either a signal must justify it for both. Tests pin both directions for each row; do not emit the signal or drop the record.
  - **Shipped stores never produce the mismatch rows.** `FDv2SkillStore` and `InMemorySkillStore` answer a pin with that version or nothing, so `wrong_version` needs a **hand-built** store that ignores its version argument. A test using a shipped store gets `absent` and silently stops covering the row.
  - **Keep both checks in `resolveFromStore`.** `verifyRawSkill` is unary (is one object self-consistent?); a mismatch is relational (object vs. request). Threading an expected key or version into it would make the parameter optional at every call site, and a check that vanishes when a caller forgets an argument is worse than one at the single site where both values are in hand.
  - **Adding a row** means answering "which of the five does a caller see?" before writing the code. `unavailable` stays a separate field: it is narrower, it is what suppresses pruning, and the `skills-fs.ts` row never reaches an accessor.
- `wantedVersion` is passed **into** `SkillStore.getObject(kind, key, version)`, and the post-hoc `skill.version !== wantedVersion` check is kept too. Removing either is wrong:
  - The parameter lets the store choose among several held versions. Without it, a satisfiable pin reads as `wrong_version` and writes a `version_mismatch` record accusing a correct store.
  - The check is a **defense**, because the store is untrusted. Without it, a lying store's answer gets through.

  Both shipped stores honour the parameter: a pin gets exactly that version, an omitted version gets the newest held. A pin that misses while well-formed versions exist is `absent`; a pin that matches nothing well-formed falls through to the version-less entry, so a malformed object reaches verification and is withheld with a signal instead of reading as a deletion.
- `getSkill`'s contract — "resolves to `null`, never rejects; throws only when no store is configured" — is **frozen** (documented in its JSDoc and the README). Callers treat that `null` as "no skill", so new reporting goes *alongside* it, as `getSkillResult` does. `getSkillResult` projects the same `Resolution` and shares the single throw; it records no telemetry and writes no log record of its own, because the integrity record already fired during verification. `getSkills` and `allSkills` have no reporting equivalents.
- This package has no logger abstraction; every `console.*` call site carries a `biome-ignore` saying so. A `logger` option would be a package-wide API decision, not a skills change. Until one exists, the integrity record must be self-describing in the string it logs, which is why the event name appears both in the prefix and in the JSON.
- Signal names, property keys, wire field names (`contentHash`), the manifest filename and format, and the exported constants are **identical strings** to the Python SDK. A polyglot fleet has to reconcile the same directory identically, so changing one of these is a cross-language breaking change.
- `parseUsage` must continue to accept `input_tokens/output_tokens`, `inputTokens/outputTokens`, and `input/output` as all existing handlers return one of these variants.
