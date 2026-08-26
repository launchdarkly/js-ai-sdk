# LaunchDarkly AI SDK

- [Repository Layout](#repository-layout)
- [How It Works](#how-it-works)
- [Package Structure](#package-structure)
- [Quick Start](#quick-start)
  - [1. Install](#1-install)
  - [2. Configure environment](#2-configure-environment)
  - [3. Call a model](#3-call-a-model)
    - [3a. Convenience functions](#3a-convenience-functions)
    - [3b. `config(args)](#3b-configargs)`
    - [3c. `graph(key, options)](#3c-graphkey-options)`
    - [3d. `resolveGraph(key, options)](#3d-resolvegraphkey-options)`
    - [3e. Framework-native graph runners](#3e-framework-native-graph-runners)
    - [3f. Built-in / native tools (`NativeTool`)](#3f-built-in--native-tools-nativetool)
- [Managing configuration](#managing-configuration)
  - [Global registry](#global-registry)
  - [Scoping configuration](#scoping-configuration)
  - [Ad-hoc options](#ad-hoc-options)
- [Telemetry](#telemetry)
- [Development](#development)
  - [Running the examples](#running-the-examples)

---

A Node.js monorepo for integrating LaunchDarkly AgentControl with multiple AI providers. LaunchDarkly manages which model, provider, prompt, and tools are used at runtime via feature flags — your code just calls the right handler.

## Repository Layout

```
js-ai-sdk/
├── main.ts              # Entry point — brokers to an example based on CLI args
├── examples/            # Runnable examples (not part of any published package)
│   ├── agent.ts         # config() with the global registry
│   ├── graph.ts         # graph() multi-agent workflow
│   ├── native-graph.ts  # toClaudeAgents + resolveGraph native runner
│   ├── openai-only.ts   # config() with an OpenAI-only registry
│   ├── register.ts      # Global registry setup (handlers + tools)
│   ├── tools.ts         # Tool implementations (getPreferences, webSearch, etc.)
│   └── utils.ts         # Shared helpers (newContext, writeOutput)
├── examples/            # Sample data files (e.g. user_preferences.json)
├── packages/
│   ├── client/          # @launchdarkly/ai-server       — core client (Tier 0)
│   ├── ai-node/         # @launchdarkly/ai-node         — Node.js convenience wrapper (bundles node-server-sdk)
│   ├── claude-agents/   # @launchdarkly/ai-claude-agents
│   ├── claude-messages/ # @launchdarkly/ai-claude-messages
│   ├── openai-agents/   # @launchdarkly/ai-openai-agents
│   ├── openai-messages/ # @launchdarkly/ai-openai-messages
│   ├── langchain-agents/   # @launchdarkly/ai-langchain-agents
│   └── langchain-messages/ # @launchdarkly/ai-langchain-messages
├── .env.example         # Template — copy to .env and fill in your values
└── agents.md            # Architecture reference for AI agents and contributors
```

The `examples/` directory is a **sample implementation** showing how a consumer application wires the packages together. These files are not published and are not part of any package.

## How It Works

1. You define an AI config in LaunchDarkly (model, provider, system prompt, tools).
2. Your application fetches the variation for a user context.
3. The SDK routes to the correct provider handler, executes the call, and emits telemetry.
4. You can change providers, models, or prompts in LaunchDarkly without deploying code.

## Package Structure

This monorepo follows a three-tier architecture. Dependencies only flow downward.

```
Tier 2 — Consumer Application  (main.ts, your app)
         │
Tier 1 — Handler Packages      (@launchdarkly/ai-*)
         │
Tier 0 — Core Client           (@launchdarkly/ai-server)
```

### Core


| Package                                                          | Description                                                                                                   |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `[@launchdarkly/ai-server](packages/client/README.md)`           | Core client — LaunchDarkly lifecycle, telemetry, shared types, `config()`, `graph()`         |
| `[@launchdarkly/ai-node](packages/ai-node/README.md)`            | Node.js convenience wrapper — re-exports `@launchdarkly/ai-server` with `@launchdarkly/node-server-sdk` bundled as a hard dependency. Install this instead of `ai-server` for standard Node.js apps. |


### Handler Packages


| Package                                                                        | Provider  | Mode       | Description                                           |
| ------------------------------------------------------------------------------ | --------- | ---------- | ----------------------------------------------------- |
| `[@launchdarkly/ai-openai-messages](packages/openai-messages/README.md)`       | OpenAI    | `messages` | OpenAI Responses API with manual tool-call loop       |
| `[@launchdarkly/ai-openai-agents](packages/openai-agents/README.md)`           | OpenAI    | `agent`    | OpenAI Agents SDK — fully managed agentic loop        |
| `[@launchdarkly/ai-claude-messages](packages/claude-messages/README.md)`       | Anthropic | `messages` | Anthropic Messages API with manual tool-use loop      |
| `[@launchdarkly/ai-claude-agents](packages/claude-agents/README.md)`           | Anthropic | `agent`    | Claude Agent SDK — agentic loop with MCP tool support |
| `[@launchdarkly/ai-langchain-messages](packages/langchain-messages/README.md)` | `*` (any) | `messages` | Any `BaseChatModel` via LangChain `bindTools` loop    |
| `[@launchdarkly/ai-langchain-agents](packages/langchain-agents/README.md)`     | `*` (any) | `agent`    | LangGraph `createReactAgent` — managed ReAct loop     |


## Quick Start

### 1. Install

**Node.js** — single install, no peer dependency wiring:

```bash
npm install @launchdarkly/ai-node @launchdarkly/ai-openai-messages
```

`@launchdarkly/ai-node` is a thin barrel that re-exports all of `@launchdarkly/ai-server` and carries `@launchdarkly/node-server-sdk` as a hard dependency. `initClient()` auto-discovers it at runtime — no extra setup required.

**Edge / custom runtime** (Vercel, Cloudflare, etc.) — use the core package and pass your own client:

```bash
npm install @launchdarkly/ai-server @launchdarkly/vercel-server-sdk @launchdarkly/ai-openai-messages
```

Then call `initClient(preInitializedClient)` with your platform's LD client before the first AI call.

**With telemetry** (recommended for production) — traces export to the LaunchDarkly Observability dashboard:

```bash
npm install @launchdarkly/ai-node @launchdarkly/ai-otel @launchdarkly/ai-openai-messages
```

No code changes are needed between the two — `initClient()` detects whether the OTel packages are present at runtime and configures the tracer provider automatically. If they are absent, the SDK logs a one-time `console.warn` with the exact install command and continues normally.

### 2. Configure environment

```bash
cp .env.example .env
# Fill in LD_SDK_KEY and the API key for your provider
```

### 3. Call a model

#### 3a. Convenience functions

Each handler package exports a convenience function — the shortest path to a working call.


| Argument               | Type                                    | Required | Description                                     |
| ---------------------- | --------------------------------------- | -------- | ----------------------------------------------- |
| `userInput`            | `string | undefined`                    | Yes      | The user's message                              |
| `context`              | `LDContext`                             | Yes      | User/context for flag evaluation                |
| `options.key`          | `string`                                | Yes      | LaunchDarkly flag key                           |
| `options.toolHandlers` | `Record<string, Function | NativeTool>` | No       | Tool name → implementation or built-in sentinel |
| `options.variables`    | `Record<string, unknown>`               | No       | Template variables passed to `invoke()` (e.g. `{ user_input: userInput }`) |


```ts
import 'dotenv/config';
import { openaiMessages } from '@launchdarkly/ai-openai-messages';

const result = await openaiMessages(
  'What is feature flagging?',
  { kind: 'user', key: 'user-123' },
  { key: 'my-ai-config-flag', variables: { user_input: 'What is feature flagging?' } },
);

console.log(result.response);
```


| Function            | Package                               | Underlying SDK                   | API                          |
| ------------------- | ------------------------------------- | -------------------------------- | ---------------------------- |
| `openaiMessages`    | `@launchdarkly/ai-openai-messages`    | `openai`                         | OpenAI Responses API         |
| `openaiAgents`      | `@launchdarkly/ai-openai-agents`      | `@openai/agents`                 | OpenAI Agents SDK            |
| `claudeMessages`    | `@launchdarkly/ai-claude-messages`    | `@anthropic-ai/sdk`              | Anthropic Messages API       |
| `claudeAgents`      | `@launchdarkly/ai-claude-agents`      | `@anthropic-ai/claude-agent-sdk` | Claude Agent SDK (MCP)       |
| `langchainMessages` | `@launchdarkly/ai-langchain-messages` | `@langchain/core`                | LangChain `bindTools` loop   |
| `langchainAgents`   | `@launchdarkly/ai-langchain-agents`   | `@langchain/langgraph`           | LangGraph `createReactAgent` |


---

#### 3b. `config(args)`

`config()` accepts either a single handler or an array of handlers and routes to the correct one at invoke-time based on the flag variation's provider and mode. The handler can be one of the pre-built `create*Handler()` factories, an array of them, or any function you write — useful for internal endpoints or providers without a pre-built package.

Use `createHandler(providesFor, fn)` to build a custom handler. It attaches routing metadata (`providesFor`) so the handler works with `config()` routing and registries.


| Argument            | Type                                    | Required | Description                                            |
| ------------------- | --------------------------------------- | -------- | ------------------------------------------------------ |
| `args.key`          | `string`                                | Yes      | LaunchDarkly flag key                                  |
| `args.handler`      | `ProviderHandler \| ProviderHandler[]`  | No       | Single handler or pool to route between                |
| `args.toolHandlers` | `Record<string, Function \| NativeTool>` | No      | Tool name → implementation or built-in sentinel        |
| `args.registry`     | `RegistryInput`                         | No       | Registry to source handlers and tools from             |


Returns `{ invoke(...): Promise<ProviderResponse>, stream(...): AsyncGenerator<StreamEvent> }`.

`ProviderResponse` always contains `response`, `usage`, and `trackData`. When `skipJudges` is `false` (default), judge evaluations run inline and results appear in `judgeResults`. When `skipJudges: true`, `invoke()` instead returns `judgeTasks: JudgeTask[]` — pre-packaged, serialisable tasks ready to pass to a worker thread calling `runJudge(task, handlers)`.


```ts
import 'dotenv/config';
import { config, createHandler, shutdown } from '@launchdarkly/ai-server';
import { createOpenAIHandler } from '@launchdarkly/ai-openai-messages';
import { createOpenAIAgentHandler } from '@launchdarkly/ai-openai-agents';
import { createClaudeAgentsHandler } from '@launchdarkly/ai-claude-agents';
import { createClaudeMessagesHandler } from '@launchdarkly/ai-claude-messages';

// Single handler — must match the flag variation's provider+mode, or throws.
const internalHandler = createHandler(['InternalProvider', 'messages'], async (cfg, userInput) => {
  const response = await fetch('https://models.internal.example.com/generate', {
    method: 'POST',
    body: JSON.stringify({ model: cfg.model.name, prompt: userInput }),
  });
  const { text, usage } = await response.json();
  return { output: text, usage };
});

const singleResult = await config({
  key: 'my-ai-config-flag',
  handler: internalHandler,
}).invoke('What is feature flagging?', { kind: 'user', key: 'user-123' }, { user_name: 'Ada' });

// Multiple handlers — routing selects the match by provider + mode.
const result = await config({
  key: 'my-ai-config-flag',
  toolHandlers: {
    search: async ({ query }) => { /* ... */ },
  },
  handler: [
    createOpenAIHandler(),
    createOpenAIAgentHandler(),
    createClaudeAgentsHandler(),
    createClaudeMessagesHandler(),
  ],
}).invoke(
  'What is feature flagging?',
  { kind: 'user', key: 'user-123' },
  { user_name: 'Ada' },
);

console.log(result.response);
// Flushes pending LaunchDarkly events and OTel spans, then closes the connection
await shutdown();
```

---

#### 3c. `graph(key, options)`

Orchestrates a multi-agent workflow defined in a LaunchDarkly agent graph flag (a root agent plus directed edges). The SDK uses a **model-driven router**: it starts at the root node, presents outgoing edges as handoff choices to the model, and follows whichever edge the model selects — threading both the original user request and the previous node's response into each subsequent node. The loop terminates when the model produces a final answer (no edge selected), a leaf node is reached, a cycle is detected, or the step cap is hit.

Because each node runs through the same path as `config()`, every node emits its own telemetry and judges, tagged with the graph key. Graph-level `$ld:ai:graph:`* events wrap the full run.


| Argument               | Type                                    | Required | Description                                                  |
| ---------------------- | --------------------------------------- | -------- | ------------------------------------------------------------ |
| `key`                  | `string`                                | Yes      | LaunchDarkly agent graph flag key                            |
| `options.handlers`     | `ProviderHandler[]`                     | Yes      | Handler pool; each node is routed by its provider + mode     |
| `options.toolHandlers` | `Record<string, Function | NativeTool>` | No       | Tool name → implementation or built-in sentinel              |
| `options.graphJudge`   | `string`                                | No       | Optional judge config key evaluated against the final output |


Returns `{ invoke(input: string | undefined, context: LDContext, variables?: Record<string, any>): Promise<ProviderGraphResponse> }`.

```ts
import 'dotenv/config';
import { graph, shutdown } from '@launchdarkly/ai-server';
import { createClaudeAgentsHandler } from '@launchdarkly/ai-claude-agents';

const result = await graph('support-graph', {
  handlers: [createClaudeAgentsHandler()],
}).invoke('I was double charged', { kind: 'user', key: 'user-123' }, { account_tier: 'pro' });

console.log(result.response); // final output
console.log(result.usage);    // aggregate { input, output, total }
console.log(result.path);     // node keys in execution order, e.g. ['triage', 'billing']
console.log(result.nodes);    // each node's own response, keyed by node key

await shutdown();
```

Provider packages also export single-provider conveniences (`claudeGraph`, `openaiGraph`, `langchainGraph`) that pre-bind their handler. For mixed-provider graphs, use the base `graph()` and pass multiple handlers.

---

#### 3e. `resolveGraph(key, options)`

For framework packages that need to walk the topology and build their own execution structure (e.g. constructing a LangGraph or OpenAI Agents graph), use `resolveGraph` instead of `graph`. It returns a `GraphDefinition` without executing anything.

```ts
import { resolveGraph } from '@launchdarkly/ai-server';

const def = await resolveGraph('support-graph', {
  context: { kind: 'user', key: 'user-123' },
  handlers: [],
});

if (def.enabled) {
  // Walk root → leaves, building your framework's node/edge structure
  await def.traverse(async (node, ctx) => {
    // node.key, node.config, node.edges
  });

  // Or leaves → root
  await def.reverseTraverse(async (node, ctx) => { /* ... */ });
}
```

`GraphDefinition` also exposes `getNode`, `getChildNodes`, `getParentNodes`, `terminalNodes`, `edgesFrom`, `runNode`, and `route` for fine-grained control.

> **Note:** `handlers` is optional in `GraphArgs` when calling `resolveGraph`. Omit it entirely when passing the result to a framework-native runner — the runners below handle execution without going through `runNode`.

---

#### 3f. Framework-native graph runners

Each handler package ships a native runner that converts `resolveGraph` output into the provider's own multi-agent orchestration primitives. Native runners **bypass the SDK's model-driven router** and let the provider's SDK manage handoffs, tool loops, and conversation state.

All three runners share the same minimal signature:

```ts
toXxx(
  def: Promise<GraphDefinition>,
  opts?: { toolHandlers?, context? }
).invoke(input?, variables?)
```

##### `toOpenAIAgents` — OpenAI Agents SDK

Uses `reverseTraverse` (leaves → root) to build an `Agent` tree, wires children as handoffs, then runs the root with `Runner.run`.

```ts
import { resolveGraph } from '@launchdarkly/ai-server';
import { toOpenAIAgents } from '@launchdarkly/ai-openai-agents';

const result = await toOpenAIAgents(
  resolveGraph('support-graph', { context }),
  { toolHandlers: registry.tools, context }
).invoke('I was double charged');
```

##### `toLangGraph` — LangGraph `StateGraph`

Uses `traverse` (root → leaves) to build a compiled `StateGraph`. Single-child edges become direct edges after a tool loop; multi-child edges use `Command`-returning handoff tools (bound with `parallel_tool_calls: false`) so the model picks exactly one target.

```ts
import { resolveGraph } from '@launchdarkly/ai-server';
import { toLangGraph } from '@launchdarkly/ai-langchain-agents';

const result = await toLangGraph(
  resolveGraph('support-graph', { context }),
  {
    toolHandlers: registry.tools,
    context,
    // optional: supply your own model per node
    modelFactory: (node) => new ChatOpenAI({ model: node.config.model.name }),
  }
).invoke('I was double charged');
```

##### `toClaudeAgents` — Claude Agent SDK

Uses `reverseTraverse` (leaves → root) to wrap each child node as an MCP tool whose implementation runs `query()` in-process. The root node then runs a single top-level `query()` with its children accessible as sub-agent tools. Fully in-process; no cloud-registered agents required.

```ts
import { resolveGraph } from '@launchdarkly/ai-server';
import { toClaudeAgents } from '@launchdarkly/ai-claude-agents';

const result = await toClaudeAgents(
  resolveGraph('support-graph', { context }),
  { toolHandlers: registry.tools, context }
).invoke('I was double charged');
```

All three runners:

- Accept the same `toolHandlers` map as `graph()` (including `NativeTool` sentinels)
- Emit the same `$ld:ai:*` tracking events as `graph()` — per-node duration, token counts, handoff events, and graph-level summary
- Wrap execution in a parent OTel span for hierarchical traces

---

#### 3f. Built-in / native tools (`NativeTool`)

Some provider SDKs expose built-in capabilities (e.g. `WebSearch` in the Claude Agent SDK) that are handled natively by the provider rather than dispatched to a user function. Use a `NativeTool` sentinel in `toolHandlers` to opt in:

```ts
import { config } from '@launchdarkly/ai-server';
import { ClaudeWebSearch, createClaudeAgentsHandler } from '@launchdarkly/ai-claude-agents';

const result = await config({
  key: 'my-ai-config-flag',
  toolHandlers: {
    'web-search': ClaudeWebSearch,   // NativeTool sentinel — no function needed
    'get-prefs': async ({ id }) => { /* user function */ },
  },
  handler: [createClaudeAgentsHandler()],
}).invoke('What are the latest LD release notes?', { kind: 'user', key: 'user-123' });
```

The handler package recognises the sentinel, enables the provider's built-in tool, and still emits `$ld:ai:tool_call` tracking when the model invokes it.

Available Claude built-ins (from `@launchdarkly/ai-claude-agents`):


| Export               | Provider tool  |
| -------------------- | -------------- |
| `ClaudeBash`         | `Bash`         |
| `ClaudeRead`         | `Read`         |
| `ClaudeEdit`         | `Edit`         |
| `ClaudeWrite`        | `Write`        |
| `ClaudeGlob`         | `Glob`         |
| `ClaudeGrep`         | `Grep`         |
| `ClaudeWebFetch`     | `WebFetch`     |
| `ClaudeWebSearch`    | `WebSearch`    |
| `ClaudeTodoWrite`    | `TodoWrite`    |
| `ClaudeNotebookEdit` | `NotebookEdit` |


## Managing configuration

Handlers and tools can be registered once and reused across every call in your application. The `Registry` class is the vehicle for this — it holds a set of `ProviderHandler` instances and a map of tool implementations.

### Global registry

> ⚠️ It is generally recommended to use scoped registries over global to satisfy the [principle of least privilege](https://en.wikipedia.org/wiki/Principle_of_least_privilege).

`globalRegistry` is a process-wide singleton exported from `@launchdarkly/ai-server`. Populate it once at startup (typically in an initialisation module), then pass it as `registry` to any call site. All handlers and tools registered on it are available everywhere that registry is used.

```ts
import { globalRegistry, config, graph } from '@launchdarkly/ai-server';
import { createClaudeAgentsHandler, ClaudeWebSearch } from '@launchdarkly/ai-claude-agents';
import { createOpenAIHandler } from '@launchdarkly/ai-openai-messages';

// Called once at app startup
globalRegistry.register({
  handlers: [createClaudeAgentsHandler(), createOpenAIHandler()],
  tools: {
    'web-search': ClaudeWebSearch,
    'get-prefs': getPreferencesFn,
  },
});

// Any call site can reference it directly
const result = await config({ key: 'my-flag', registry: globalRegistry })
  .invoke(userInput, context);

const graphResult = await graph('support-graph', { registry: globalRegistry })
  .invoke(userInput, context);
```

You can call `register()` more than once to add handlers or tools incrementally. If two registrations target the same handler key (`provider:mode`) or tool name, the last one wins and a warning is logged.

### Scoping configuration

Scoping configurations allows you to define registries that have only a subset of supported handlers or tools. For example, you might want to create an OpenAI scoped registry that only handles OpenAI:

```ts
import { Registry } from '@launchdarkly/ai-server';
import { createOpenAIHandler } from '@launchdarkly/ai-openai-messages';
import { createOpenAIAgentHandler } from '@launchdarkly/ai-openai-agents';

const openaiRegistry = new Registry({
  handlers: [createOpenAIHandler(), createOpenAIAgentHandler()],
  tools: { 'get-prefs': getPreferencesFn },
});
```

When you have separate registries for separate concerns, use `compose()` to merge them into a single registry without mutating either source. When a handler key or tool name appears in both, `b` takes precedence over `a`.

```ts
import { compose } from '@launchdarkly/ai-server';

const baseRegistry = new Registry({
  handlers: [createOpenAIHandler()],
  tools: { 'get-prefs': getPreferencesFn },
});

const premiumRegistry = new Registry({
  handlers: [createClaudeAgentsHandler()],
  tools: { 'web-search': ClaudeWebSearch },
});

// Neither registry is mutated; premiumRegistry wins on any conflict
const combined = compose(baseRegistry, premiumRegistry);
```

### Ad-hoc options

For one-off calls that don't warrant a registry — a quick test, a script, or a call that genuinely needs a different handler — pass `handler` and `toolHandlers` directly on the call options. Inline options always take precedence over anything in the registry, so they can also be used to override a specific tool or handler for a single call without changing shared configuration.

```ts
import { config } from '@launchdarkly/ai-server';
import { createClaudeMessagesHandler } from '@launchdarkly/ai-claude-messages';

// No registry — handler and tools supplied inline
const result = await config({
  key: 'my-flag',
  handler: [createClaudeMessagesHandler()],
  toolHandlers: { 'my-tool': myToolFn },
}).invoke(userInput, context);

// Registry provides defaults; inline toolHandlers override for this call only
const result2 = await config({
  key: 'my-flag',
  registry: globalRegistry,
  toolHandlers: { 'get-prefs': overriddenPrefsFn },
}).invoke(userInput, context);
```

---

## Telemetry

Every handler wraps its provider call in an OpenTelemetry span following [Gen AI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/). The core client also emits LaunchDarkly AI telemetry events (duration, token counts, generation success/failure) automatically on every `config().invoke()` call. No extra instrumentation code is required.

When running inside `graph()`, every node's events carry the graph key, tool invocations emit `$ld:ai:tool_call`, and the graph run itself emits graph-level events (`$ld:ai:graph:invocation_success`/`invocation_failure`, `duration:total`, `total_tokens`, `path`, `handoff_success`/`handoff_failure`, `redirect`).

### Optional peer dependencies

The OpenTelemetry SDK packages are **optional peer dependencies** of `@launchdarkly/ai-server`, detected at runtime via dynamic import. `@launchdarkly/node-server-sdk` is an optional peer dependency of `@launchdarkly/ai-server` but a **hard dependency** of `@launchdarkly/ai-node`.

**`@launchdarkly/node-server-sdk`:**
- **Via `@launchdarkly/ai-node`:** Always present — `initClient(options?)` auto-discovers it with no extra configuration.
- **Via `@launchdarkly/ai-server` directly:** Optional peer dep. If installed, `initClient(options?)` initializes it automatically. If absent, `initClient(preInitializedClient)` must be called with a client from an alternative LD SDK (e.g. `@launchdarkly/vercel-server-sdk`). Calling `initClient()` without arguments when the node SDK is absent throws an error with a clear install message.

**OTel SDK packages** (`sdk-trace-node`, `exporter-trace-otlp-http`, etc.):
- **If installed:** `initClient()` sets up a `NodeTracerProvider` with a GZIP-compressed OTLP HTTP exporter, `AsyncLocalStorageContextManager`, and W3C trace-context/baggage propagators — no code changes needed.
- **If not installed:** `initClient()` emits a single `console.warn` with the install command and continues. Feature flags and AI calls work normally; spans become no-ops.

See [§1. Install](#1-install) for the exact commands.

### Environment variables

| Variable                      | Description                                                                        |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| `LD_SERVICE_NAME`             | OTel `service.name` resource attribute (default: `nodejs-sdk`)                     |
| `LD_ENVIRONMENT`              | `deployment.environment` resource attribute (e.g. `production`, `staging`)         |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP endpoint override (default: LaunchDarkly Observability backend)               |

See `.env.example` for a complete template.

## Development

After cloning, install dependencies and build the full workspace before running anything. The handler packages depend on the compiled output of `@launchdarkly/ai-server`, so `yarn build` must be run at least once before the packages can resolve each other.

```bash
# Install all workspace dependencies
yarn

# Build all packages (required after first clone and after changes to @launchdarkly/ai-server)
yarn build
```

### Available `make` commands

A `Makefile` is provided as a consistent interface alongside the `yarn` scripts. All targets delegate directly to their `yarn` equivalents.

| Command | `yarn` equivalent | Description |
|---|---|---|
| `make start` | `yarn start` | Run `main.ts` |
| `make build` | `yarn build` | Compile TypeScript |
| `make clean` | `yarn clean` | Remove compiled output |
| `make test` | `yarn test` | Run all package tests |
| `make typecheck` | `yarn typecheck` | Type-check all packages |
| `make lint` | `yarn lint:pkg` | Check `package.json` consistency |
| `make lint-fix` | `yarn lint:pkg:fix` | Fix `package.json` consistency issues |
| `make review` | `yarn review` | Run the code-review agent |
| `make size PKG=<name>` | `yarn size <name>` | Show packed size for a package |
| `make size-install PKG=<name>` | `yarn size:install <name>` | Show install size for a package |

### Running the examples

`main.ts` selects an example based on the first CLI argument. The second and third arguments are the flag key and user input, both of which have sensible defaults.

```bash
yarn start [example] [flag-key] [user-input]
```


| Example             | Command                   | What it demonstrates                                                                            |
| ------------------- | ------------------------- | ----------------------------------------------------------------------------------------------- |
| `agent` *(default)* | `yarn start agent`        | `config()` routed via the global registry — switches providers without code changes |
| `graph`             | `yarn start graph`        | `graph()` multi-agent workflow driven by a LaunchDarkly agent graph flag                        |
| `native-graph`      | `yarn start native-graph` | `toClaudeAgents` + `resolveGraph` — native Claude Agent SDK runner                              |
| `openai-only`       | `yarn start openai-only`  | `config()` with a custom `Registry` restricted to OpenAI handlers                   |


**Examples:**

```bash
# Default: agent example with the built-in flag key and question
yarn start

# Graph example with a custom flag key
yarn start graph my-graph-flag "Summarise the latest release notes"

# OpenAI-only registry, custom question
yarn start openai-only my-flag-key "What is feature flagging?"
```

Output from each run is written as a timestamped JSON file to the `output/` directory.

Each package has its own `tsconfig.json` that references `packages/client` for type resolution. See `[agents.md](agents.md)` for the full architecture reference.