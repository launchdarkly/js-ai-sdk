# Agent Guide — `@launchdarkly/ai-langchain-agents`

This document tells an agent exactly how this package is implemented so it can be correctly modified, debugged, or used as a reference when building a new handler.

---

## Role and Routing

This is a **Tier 1 handler package**. It wraps LangGraph's `createReactAgent` (`@langchain/langgraph`) and exposes a `ProviderHandler` that routes to flag variations where:

```
providesFor = ['*', 'agent']
```

The `'*'` wildcard means this handler acts as a fallback for any `meta.mode === "agent"` variation that has no more-specific (exact-provider-name) handler registered. LangChain is a framework adapter — not a provider itself — so it routes through `langchain-anthropic`, `langchain-openai`, or other `BaseChatModel` implementations at runtime by inspecting `config.provider.name`. Using `'*'` lets users keep their flag variations configured with their real provider name (`"Anthropic"`, `"OpenAI"`, etc.) without needing a native handler for each.

> **Priority rule:** if the caller also registers an explicit provider handler (e.g. `['OpenAI', 'agent']`), that handler takes precedence over the wildcard for matching variations.

The handler is model-agnostic — it accepts any `BaseChatModel`. The default is `ChatOpenAI`.

---

## File Map

| File | Responsibility |
|---|---|
| `src/handler.ts` | All implementation — message building, LangGraph tool wiring, agent invocation, telemetry |
| `src/graph.ts` | `langchainGraph()` convenience wrapper around `graph()` |
| `src/native-graph.ts` | `toLangGraph()` native graph adapter |
| `src/index.ts` | Barrel: re-exports all public symbols |

---

## Exports

```ts
// Factory — accepts an optional BaseChatModel; defaults to new ChatOpenAI()
export function createLangChainAgentsHandler(llm?: BaseChatModel): ProviderHandler

// Convenience wrapper — identical to config({ ...options, key: configKey, handler: createLangChainAgentsHandler() }).invoke(userInput, context)
export const langchainAgents: (configKey: string, userInput: string, context: LDContext, options?: Omit<ConfigArgs, 'handler' | 'key'>) => Promise<ProviderResponse>

// Graph convenience wrapper — identical to graph(key, { ...options, handlers: [createLangChainAgentsHandler()] })
export function langchainGraph(key: string, options: Omit<GraphOptions, 'handlers'>, llm?: BaseChatModel): { invoke(input, context, variables?): Promise<ProviderGraphResponse> }

// Native graph adapter — builds a LangGraph state machine from a resolved GraphDefinition
export function toLangGraph(def: Promise<GraphDefinition>, opts?: object): { invoke(input?, variables?): Promise<ProviderGraphResponse> }
```

---

## Implementation Details

### 1. Message Construction (`buildInitialMessages`)

Returns `BaseMessage[]` using LangChain message types (identical logic to `langchain-messages`):

```
config.instructions present?
  → [SystemMessage(parseTemplate(instructions, variables)), HumanMessage(userInput)]

config.messages present?
  → system-role messages → SystemMessage (joined with \n)
  → user messages → HumanMessage
  → assistant messages → AIMessage
  → append HumanMessage(userInput)

neither?
  → [HumanMessage(userInput)]
```

`parseTemplate` is applied to every message's content.

### 2. Tool Wiring (`buildAgentTools`)

Each `Tool` in `config.tools` is converted using LangGraph's `tool()` function from `@langchain/core/tools`:

```ts
tool(
  async (args: Record<string, unknown>) => {
    const result = await toolHandlers[name](args);
    return String(result);
  },
  {
    name,
    description: toolConfig.description ?? '',
    schema: toolConfig.parameters as any,   // JSON Schema
  },
)
```

The `schema` field accepts a JSON Schema object directly (no Zod conversion needed for newer `@langchain/core` versions).

### 3. Agent Construction and Invocation

```ts
const agent = createAgent({ model: baseModel, tools, ...(systemPrompt ? { systemPrompt } : {}) });
const result = await agent.invoke({ messages: initialMessages });
```

When `history` is provided, a "Conversation History:" block is appended to `systemPrompt` (via `extractSystemPrompt`) with the format `user: <content>\nassistant: <content>` per turn.

`createAgent` from `'langchain'` builds a production-ready ReAct-style agent. The `model` field accepts a `BaseChatModel` instance or a provider-prefixed string (e.g. `"openai:gpt-4o"`). The handler passes the initial messages and lets LangGraph manage all tool calls, retries, and re-prompting internally.

### 4. Extracting Output

```ts
const lastMessage: BaseMessage = result.messages[result.messages.length - 1];
const output = typeof lastMessage.content === 'string' ? lastMessage.content : '';
```

LangGraph returns the full message history in `result.messages`. The final response is always the last message.

### 5. Token Accumulation

Token usage is summed from `usage_metadata` on every message in `result.messages`:

```ts
for (const msg of result.messages as BaseMessage[]) {
  const usage = (msg as any).usage_metadata;
  if (usage) {
    totalInputTokens += usage.input_tokens ?? 0;
    totalOutputTokens += usage.output_tokens ?? 0;
  }
}
```

Every AI message in the LangGraph trace (including intermediate tool-calling steps) that reports usage is included. This gives the true total cost of the full agent run.

### 6. Telemetry

Span name: `'langchain.agent'`  
Span attributes set before the call:
- `gen_ai.operation.name` = `'chat'`
- `gen_ai.system` = `'langchain'`
- `gen_ai.request.model` = `config.model.name`

Conversation content, only when the handler is built with `captureContent: true`
(off by default — content is PII): `gen_ai.system_instructions`,
`gen_ai.input.messages`, `gen_ai.output.messages` and `gen_ai.tool.definitions`
as canonical JSON, mirrored into the flat `gen_ai.prompt.{i}.*` /
`gen_ai.completion.{i}.*` attributes the LaunchDarkly trace view reads today.
`execute_tool` spans additionally carry `gen_ai.tool.call.arguments` and
`gen_ai.tool.call.result`. Content is never emitted as a span event.

Span attributes set after the agent run:
- `gen_ai.usage.input_tokens` — summed from all messages
- `gen_ai.usage.output_tokens` — summed from all messages
- `gen_ai.usage.total_tokens`

On error: `span.recordException(err)`, status ERROR, span ended, error re-thrown.

---

## OTel Setup

This package emits one span per invocation using `@opentelemetry/api`. **No OTel configuration is needed in this package** — the tracer provider is registered by `initClient()` in `@launchdarkly/ai-server` (or `@launchdarkly/ai-node`).

To receive spans, install the OTel SDK in your application:
```sh
npm install @launchdarkly/ai-otel   # bundles all required OTel packages
```

Span names and attributes are described in [Implementation Details → Telemetry](#6-telemetry) above.

---

## `initClient()` — When to Call It

**You do not need to call `initClient()` from this package.** Every entry point (`langchainAgents()`, `config().invoke()`) lazily initializes the LaunchDarkly client on the first call, as long as `LD_SDK_KEY` is set in the environment.

**Call `initClient()` explicitly in your application startup code when you need to:**

- **Pass custom options** — `serviceName`, `environment`, or a custom `otlpEndpoint`:
  ```ts
  import { initClient } from '@launchdarkly/ai-node'; // or '@launchdarkly/ai-server'
  await initClient({ serviceName: 'my-service', environment: 'production' });
  ```
- **Use an edge runtime (BYOC path)** — pass a pre-initialized client from `@launchdarkly/vercel-server-sdk`, Cloudflare, or any other SDK:
  ```ts
  import { initClient } from '@launchdarkly/ai-server';
  const ldClient = await createYourEdgeSdkClient(process.env.LD_SDK_KEY!);
  await initClient(ldClient);
  ```
- **Pre-warm the connection** — call `initClient()` at startup to avoid cold-start latency on the first user request.

`initClient()` is idempotent — calling it twice is a no-op. Never call `initClient()` inside this handler package; initialization belongs in application startup code. Full details in the [`@launchdarkly/ai-server` agents.md](../client/agents.md#lifecycle-invariants).

---

## Dependencies

| Package | Why |
|---|---|
| `@langchain/core` | `BaseChatModel`, `HumanMessage`, `SystemMessage`, `AIMessage`, `BaseMessage`, `tool()` |
| `langchain` | `createAgent` from `langchain` (high-level agent harness) |
| `@langchain/langgraph` | `StateGraph`, `ToolNode`, `toolsCondition` (used in `toLangGraph`) |
| `@langchain/openai` | `ChatOpenAI` (default model) |
| `@launchdarkly/ai-server` | `AiConfigRep`, `Tool`, `ProviderHandler`, `model`, `parseTemplate` |
| `@opentelemetry/api` | `SpanStatusCode`, `trace.getTracer().startActiveSpan()` for span creation |

---

## Common Pitfalls

- **No manual tool loop**: `createAgent` manages the entire reasoning loop internally. Do not add a manual tool-call loop on top — it would be redundant and would interfere with LangGraph's state graph.
- **`result.messages` is the full history**: the agent appends every intermediate AI message, tool call, and tool result. Always take the **last** message as the final output.
- **`usage_metadata` may be sparse**: not every message carries usage. The accumulation loop silently skips messages where `usage_metadata` is `undefined`. If total tokens are `0`, the underlying model doesn't report per-message usage.
- **`schema` format**: `tool()` from `@langchain/core/tools` accepts JSON Schema via the `schema` field. Older versions required a Zod schema — if you downgrade `@langchain/core`, you may need to add `z.fromJSONSchema()` conversion (as done in `claude-agents`).
- **`tool()` executor receives parsed args**: LangGraph parses the model's tool call arguments before calling the executor. Do not call `JSON.parse` inside the tool executor.
- **`lastMessage.content` may not be a string**: if the final message is a tool call or has a complex content array, the `typeof ... === 'string'` check returns false and `output` will be `''`. This should not occur in a well-behaved ReAct agent but is guarded defensively.
- **`addMessages` and all annotation-reducer symbols must be module-level imports.** `StateAnnotation.Root({ reducer: addMessages })` is evaluated when the module loads — `addMessages` must already be in scope. Dynamically importing it inside a function (e.g. as a lazy import) and then referencing it in the annotation is safe in TypeScript *today* because TypeScript erases type annotations at runtime. However it is a footgun in Python (where `from __future__ import annotations` defers resolution to module scope via `get_type_hints()`) and is a latent risk in TypeScript if the import is ever lazified after the `Annotation.Root(...)` call is moved inside a function. Keep all reducer symbols at the top of the module.
