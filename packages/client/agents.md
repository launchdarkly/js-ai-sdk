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
| `src/types.ts` | All shared TypeScript types — including owned `LDContext`, `LDClientInterface`, `LDClientInterface` |
| `src/utils.ts` | `parseTemplate`, `parseJSONWithPossibleFences`, `createHandler` |
| `src/registry.ts` | `Registry`, `globalRegistry`, `compose` |
| `src/index.ts` | Public barrel — the only surface handler packages import from |

---

## Public Exports (`src/index.ts`)

```ts
export type { InspectConfigResult } from './lifecycle.js';
export { getClient, initClient, inspectConfig, shutdown, shutdownTelemetry, waitForTelemetry } from './lifecycle.js';
export { registerAiSdkPackage } from './sdk-info.js';
export type { LDContext, LDClientInterface, LDSingleKindContext, LDMultiKindContext, LDUser } from './types.js';
export { ConversationIdSpanProcessor, setConversationIdIfAbsent, withConversationId } from './conversation.js';
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
3. If `judgeConfiguration.judges` is present, runs each judge handler (sampled by `samplingRate`) against the primary response, tracks `evaluationMetricKey`, and emits a `gen_ai.evaluation.result` span event on the judge's `invoke_agent` span (`gen_ai.evaluation.name` / `.score.value` / `.explanation`).
4. Returns `ProviderResponse`: `{ response: string, usage: { input, output, total }, trackData: TrackData, judgeResults?: Record<string, JudgeCallResult>, judgeTasks?: JudgeTask[] }`. `judgeResults` is populated when `skipJudges` is `false` (default) and judges ran; `judgeTasks` is populated when `skipJudges: true`.

---

## Conversation grouping

LaunchDarkly's conversation view groups spans on `gen_ai.conversation.id`. Bind a caller-supplied id around any `invoke()` / `stream()` / `graph().invoke()` call:

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
- **Explicit initialization — BYOC path.** `initClient(client)` accepts any pre-initialized object that satisfies `LDClientInterface` — this is the path for Vercel, Cloudflare, or other edge runtimes whose SDK has different init semantics. No `@launchdarkly/node-server-sdk` is required.
- **Return value.** `initClient()` returns `Promise<LDClientInterface>`. Callers that don't need the instance may discard the return value — this is a non-breaking change from the previous `Promise<void>` signature.
- `getClient()` throws if `initClient()` has not resolved — any code that calls `getClient()` directly must ensure initialization has occurred.
- `shutdown()` must be called before process exit. It flushes OTel spans, flushes LD events, and closes the LD client. `client.close()` runs even when `flush()` throws.

---

## Common Pitfalls

### 1. Calling `getClient()` before `initClient()` resolves

`getClient()` throws if no client has been initialized. Any code that calls `getClient()` directly (e.g. handler packages emitting LD tracking events) must only do so inside a handler call — by the time a handler runs, `config().invoke()` has already validated the flag variation, which requires an initialized client. Never call `getClient()` at module load time or in a package constructor.

### 2. Double-calling `shutdown()` in process-exit handlers

`shutdown()` is idempotent — calling it a second time is a no-op. However, if `client.flush()` throws during the first call, the singleton is still cleared so a second `shutdown()` call will not re-attempt the flush or throw. Ensure your process-exit handler does not assume `shutdown()` will re-try a failed flush. If you need guaranteed delivery, call `client.flush()` yourself and handle the error before calling `shutdown()`.

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
- Do not weaken the `parseAiConfig` validation — handler packages rely on `config` being valid when they receive it.
- `parseUsage` must continue to accept `input_tokens/output_tokens`, `inputTokens/outputTokens`, and `input/output` as all existing handlers return one of these variants.
