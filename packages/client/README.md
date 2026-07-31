# `@launchdarkly/ai-server` — Core Client

The core package for the LaunchDarkly AI SDK. It owns the LaunchDarkly client lifecycle, telemetry pipeline, all shared types, and the primary entry points that handler packages depend on.

All handler packages (`@launchdarkly/ai-*`) depend on this package.

> **Node.js users:** consider installing [`@launchdarkly/ai-node`](../ai-node/README.md) instead. It re-exports this package's full API and bundles `@launchdarkly/node-server-sdk` as a hard dependency, so no peer dependency setup is needed.

## Installation

### Without telemetry

```bash
npm install @launchdarkly/ai-server
```

`@launchdarkly/node-server-sdk` is an optional peer dependency — include it for standard Node.js, or pass a pre-initialized client from another LD SDK (e.g. `@launchdarkly/vercel-server-sdk`) to `initClient(client)` for edge runtimes.

The SDK works fully without the OpenTelemetry packages — feature flags evaluate, handlers run, and LaunchDarkly AI events are tracked. Spans are created as no-ops. If you start `initClient()` without the OTel SDK packages installed, the SDK logs a single `console.warn` and continues normally.

### With telemetry (recommended for production)

To export traces to the LaunchDarkly Observability dashboard (or any OTLP-compatible backend), install the OTel SDK peer dependencies alongside the core package:

```bash
npm install @launchdarkly/ai-server \
  @opentelemetry/sdk-trace-node \
  @opentelemetry/sdk-trace-base \
  @opentelemetry/exporter-trace-otlp-http \
  @opentelemetry/otlp-exporter-base \
  @opentelemetry/resources \
  @opentelemetry/context-async-hooks \
  @opentelemetry/core
```

No code changes are required — `initClient()` detects the packages at runtime and sets up the tracer provider automatically.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `LD_SDK_KEY` | Yes | LaunchDarkly server-side SDK key |
| `LD_BASE_URI` | No | Override the LaunchDarkly polling base URI (e.g. for staging) |
| `LD_STREAM_URI` | No | Override the streaming URI |
| `LD_EVENTS_URI` | No | Override the events URI |
| `LD_SERVICE_NAME` | No | OTel `service.name` resource attribute (default: `nodejs-sdk`) |
| `LD_ENVIRONMENT` | No | `deployment.environment` resource attribute attached to telemetry |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | OTLP endpoint override (default: LaunchDarkly Observability backend) |

The client uses **lazy initialization**: importing the package does not connect to LaunchDarkly. The singleton is created automatically on the first API call that needs it (`config().invoke()`, `graph().invoke()`, `resolveGraph()`, etc.), as long as `LD_SDK_KEY` is set in the environment.

Call `initClient()` explicitly when you want to:
- Pass SDK or telemetry options programmatically (overriding env vars)
- Initialize at startup before the first AI call (e.g. to avoid latency on the first request)
- Fail fast at boot if `LD_SDK_KEY` is missing

```ts
import { initClient, shutdown, waitForTelemetry, shutdownTelemetry } from '@launchdarkly/ai-server';

// Standard Node.js path — auto-discovers @launchdarkly/node-server-sdk.
// Returns the initialized LDClientInterface for further use if needed.
const client = await initClient({
  sdkKey: 'sdk-...',
  serviceName: 'my-service',
  environment: 'production',
});

// Or skip initClient() and let the first model/graph call initialize lazily.

// Edge / custom runtime path — pass an already-initialized client.
// @launchdarkly/node-server-sdk is NOT required in this case.
// import { init } from '@launchdarkly/vercel-server-sdk';
// const vercelClient = init(clientSideId, edgeConfigClient);
// await initClient(vercelClient);

// Flush telemetry, flush LD events, and close the client.
await shutdown();
```

| Export | Description |
|---|---|
| `initClient(options?)` | Auto-discover and initialize `@launchdarkly/node-server-sdk`. Optional — the first AI API call triggers lazy init when `LD_SDK_KEY` is set. Returns `Promise<LDClientInterface>`. |
| `initClient(client)` | **BYOC overload** — accept a pre-initialized `LDClientInterface` (e.g. from `@launchdarkly/vercel-server-sdk` or any edge runtime). Skips SDK auto-discovery. |
| `getClient()` | Return the initialized `LDClientInterface`. Throws if `initClient` has not completed. |
| `shutdown()` | Flush all events and telemetry, then close the client. Call before process exit. |
| `waitForTelemetry()` | Wait for the OTel provider to be ready. Useful to avoid dropping early spans. |
| `shutdownTelemetry()` | Flush and stop the OTel exporter independently of the LD client. |
| `inspectConfig(key, context)` | Read an AI Config variation without invoking the model. Never throws. Returns `{ enabled, config, meta }`. |

### `config(args)`

The primary entry point for AI config invocations. Accepts either a single handler or an array of handlers and routes to the correct one at invoke-time based on the flag variation's provider and mode.

```ts
import { config } from '@launchdarkly/ai-server';
import { createOpenAIHandler } from '@launchdarkly/ai-openai-messages';
import { createOpenAIAgentHandler } from '@launchdarkly/ai-openai-agents';
import { createClaudeAgentsHandler } from '@launchdarkly/ai-claude-agents';

// Single handler — must match the flag variation's provider+mode, or throws.
const caller = config({
  key: 'my-ai-config-flag',
  handler: createOpenAIHandler(),
  toolHandlers: { myTool: myToolFn },      // optional: tool implementations
});

const result = await caller.invoke(
  'What is feature flagging?',
  { kind: 'user', key: 'user-123' },
  { userName: 'Alice' },                   // optional: template substitutions
);
console.log(result.response); // string
console.log(result.usage);    // { input, output, total }

// Multiple handlers — routing selects the match by provider + mode.
const router = config({
  key: 'my-ai-config-flag',
  toolHandlers: { search: searchFn },
  handler: [
    createOpenAIHandler(),        // providesFor: ['OpenAI', 'messages']
    createOpenAIAgentHandler(),   // providesFor: ['OpenAI', 'agent']
    createClaudeAgentsHandler(),  // providesFor: ['Anthropic', 'agent']
  ],
});

const result2 = await router.invoke('Summarize this document', { kind: 'user', key: 'user-123' });
console.log(result2.judgeResults); // judge evaluation results when skipJudges is false (default)
console.log(result2.trackData);    // run ID, config key, model name, etc.

// Multi-turn conversation — pass prior turns as history (4th arg after variables).
const history = [
  { role: 'user', content: 'What is feature flagging?' },
  { role: 'assistant', content: 'Feature flagging is a technique for safely releasing features...' },
];
const result3 = await caller.invoke('Can you give me an example?', { kind: 'user', key: 'user-123' }, undefined, history);

await shutdown();
```

### `graph(key, options)`

Runs a multi-agent workflow defined in a LaunchDarkly agent graph flag. The SDK uses a **model-driven router**: it starts at the root node, presents outgoing edges as handoff choices to the model, and follows whichever edge the model selects — threading both the original user request and the previous node's response into each subsequent node. The loop terminates when the model produces a final answer, a leaf is reached, a cycle is detected, or the step cap is hit.

Each node runs through the same tracked path as `config().invoke()`, so every node emits its own telemetry and judges, tagged with the graph key. Graph-level `$ld:ai:graph:*` events wrap the full run.

```ts
import { graph, shutdown } from '@launchdarkly/ai-server';
import { createClaudeAgentsHandler } from '@launchdarkly/ai-claude-agents';

const g = graph('support-graph', {
  handlers: [createClaudeAgentsHandler()], // pass multiple for mixed-provider graphs
  toolHandlers: { search: searchFn },
});

const result = await g.invoke(
  'I was double charged',
  { kind: 'user', key: 'user-123' },
  { account_tier: 'pro' },   // optional variables
);

console.log(result.response); // final output
console.log(result.usage);    // aggregate { input, output, total }

await shutdown();
```

Routing is by each node config's `provider.name` + `meta.mode`, so a single graph can mix providers when you pass multiple handlers. Provider packages also export a single-provider convenience (e.g. `claudeGraph`, `openaiGraph`, `langchainGraph`) that pre-binds their handler.

`resolveGraph(key, options)` returns a `GraphDefinition` without executing it. It still requires `context` at resolution time (it has no deferred `.invoke()`). The definition carries `.enabled` so you can branch on a disabled graph before traversing. `graph(...).invoke()` throws if the graph is disabled.

### `Registry` / `globalRegistry` / `compose`

A `Registry` bundles handlers and tool implementations that can be shared across `config()`, `graph()`, and `resolveGraph()` calls. Pass it as `options.registry`; local `handler`/`toolHandlers` always take precedence.

```ts
import { Registry, globalRegistry, compose, config } from '@launchdarkly/ai-server';
import { createClaudeAgentsHandler } from '@launchdarkly/ai-claude-agents';

// Build a reusable registry
const myRegistry = new Registry({
  handlers: [createClaudeAgentsHandler()],
  tools: { myTool: myToolFn },
});

// Or register incrementally
myRegistry.register({ tools: { anotherTool: anotherFn } });

// Use globalRegistry as a process-wide default
globalRegistry.register({ handlers: [createClaudeAgentsHandler()] });

// Combine two registries — b wins over a on conflict, neither is mutated
const combined = compose(myRegistry, anotherRegistry);

const router = config({ key: 'my-flag', registry: myRegistry });
```

### `inspectConfig(key, context)`

Reads an AI Config flag variation **without invoking any AI provider**. Use this for health checks, logging, feature-gate probes, or any situation where you need to know whether a config is enabled or what model it points to — without spending API quota.

```ts
import { inspectConfig } from '@launchdarkly/ai-server';

const result = await inspectConfig('my-ai-config-flag', { kind: 'user', key: 'user-123' });

if (!result.enabled) {
  console.log('Flag is off — skipping AI call');
} else {
  console.log(result.config?.model?.name); // e.g. 'claude-opus-4-5'
  console.log(result.meta?.variationKey);
}
```

**Guarantees:**
- Never throws — returns `{ enabled: false, config: null, meta: null }` on any error (network failure, bad key, schema mismatch, etc.)
- Does not emit LD telemetry events
- Does not call any AI provider
- Lazily initializes the LD client (same as all other entry points)

| Return field | Type | Description |
|---|---|---|
| `enabled` | `boolean` | Whether the flag variation is active |
| `config` | `AiConfigRep \| null` | The parsed AI config, or `null` when disabled or invalid |
| `meta` | `VariationMeta \| null` | Variation metadata (key, version, mode), or `null` when unreachable |

---

### Utility Helpers

```ts
import { parseTemplate, parseJSONWithPossibleFences } from '@launchdarkly/ai-server';

// Replaces {{variable}} placeholders, supports dot-notation ({{user.name}})
const prompt = parseTemplate('Hello, {{name}}!', { name: 'Alice' });

// Parses JSON that may be wrapped in ```json fences
const data = parseJSONWithPossibleFences<{ score: number }>(modelOutput);
```

## Shared Types

All types are re-exported from this package. Handler packages import them from here and never redefine them.

| Type | Description |
|---|---|
| `AiConfigRep` | The AI configuration object fetched from a LaunchDarkly flag variation |
| `Tool` | A tool definition (name, description, JSON Schema parameters) |
| `ProviderHandler` | The callable type that all handler packages produce |
| `ProviderResponse` | The value returned to callers: `{ response, usage, trackData, judgeResults?, judgeTasks? }`. `judgeResults` is populated when `skipJudges` is `false`; `judgeTasks` (a `JudgeTask[]`) is populated when `skipJudges: true`. |
| `ConfigArgs` | Arguments accepted by `config()` (key, handler, toolHandlers, registry) |
| `LDVariationMeta` | LaunchDarkly metadata on a flag variation (enabled, variationKey, version, mode) |
| `LDContext` | Owned by this package (structurally compatible with all LD SDK versions). Import from `@launchdarkly/ai-server` instead of directly from the LD SDK. |
| `LDClientInterface` | Minimal interface `(variation, track, flush, close)` that any LD SDK client satisfies structurally. Returned by `initClient()` and `getClient()`. |
| `GraphOptions` | Options accepted by `graph()` (handlers, toolHandlers, graphJudge — no context) |
| `GraphArgs` | Options accepted by `resolveGraph()` — extends `GraphOptions` with a required `context` |
| `GraphDefinition` | A resolved agent graph: topology accessors, `runNode`, and the traverse primitives |
| `GraphNode` / `GraphEdge` | A node (evaluated agent config + edges) and a directed edge (with handoff data) |
| `ProviderGraphResponse` | The value returned by `graph(...).invoke()`: `{ response, usage, trackData, judgeResults? }` |
| `GraphTopology` | The parsed graph flag shape (`root` + `edges`) |
