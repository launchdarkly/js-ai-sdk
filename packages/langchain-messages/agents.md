# Agent Guide — `@launchdarkly/ai-langchain-messages`

This document tells an agent exactly how this package is implemented so it can be correctly modified, debugged, or used as a reference when building a new handler.

---

## Role and Routing

This is a **Tier 1 handler package**. It wraps LangChain chat models (`@langchain/core`) and exposes a `ProviderHandler` that routes to flag variations where:

```
providesFor = ['*', 'messages']
```

The `'*'` wildcard means this handler acts as a fallback for any `meta.mode === "messages"` variation that has no more-specific (exact-provider-name) handler registered. LangChain is a framework adapter — not a provider itself — so it routes through `langchain-anthropic`, `langchain-openai`, or other `BaseChatModel` implementations at runtime by inspecting `config.provider.name`. Using `'*'` lets users keep their flag variations configured with their real provider name (`"Anthropic"`, `"OpenAI"`, etc.) without needing a native handler for each.

> **Priority rule:** if the caller also registers an explicit provider handler (e.g. `['OpenAI', 'messages']`), that handler takes precedence over the wildcard for matching variations.

The handler is model-agnostic — it accepts any `BaseChatModel`. The default is `ChatOpenAI`.

---

## File Map

| File | Responsibility |
|---|---|
| `src/handler.ts` | All implementation — message building, tool binding, invoke loop, telemetry |
| `src/index.ts` | Barrel: `export { createLangChainHandler, langchainMessages }` |

---

## Exports

```ts
// Factory — accepts an optional BaseChatModel; defaults to new ChatOpenAI()
export function createLangChainHandler(llm?: BaseChatModel): ProviderHandler

// Convenience wrapper — identical to config({ ...options, key: configKey, handler: createLangChainHandler() }).invoke(userInput, context)
export const langchainMessages: (configKey: string, userInput: string, context: LDContext, options?: Omit<ConfigArgs, 'handler' | 'key'>) => Promise<ProviderResponse>
```

---

## Implementation Details

### 1. Message Construction (`buildMessages`)

Returns `BaseMessage[]` using LangChain message types:

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

history provided?
  → history user messages → HumanMessage
  → history assistant messages → AIMessage
  → system-role history messages are filtered out
  → Final order: [config messages] → [history messages] → [HumanMessage(userInput)]
```

`parseTemplate` is applied to every message's content.

### 2. Tool Schema Conversion (`buildTools`)

Each `Tool` in `config.tools` is converted to the OpenAI function-call format that LangChain's `bindTools` understands:

```ts
{
  type: 'function',
  function: {
    name,
    description: toolConfig.description ?? '',
    parameters: toolConfig.parameters,   // JSON Schema passed through
  },
}
```

### 3. Model Binding and Invoke Loop

```ts
const activeModel = toolDefs.length > 0
  ? (baseModel as any).bindTools(toolDefs)
  : baseModel;
```

`bindTools` is on the concrete model class, not `BaseChatModel`, so a cast to `any` is required. Calling `bindTools` with no tools would still work but is skipped for clarity.

The loop:

```
1. response = await activeModel.invoke(conversationMessages)
2. Accumulate response.usage_metadata?.input_tokens + output_tokens
3. Push response (AIMessage) onto conversationMessages
4. toolCalls = response.tool_calls ?? []
5. If none: output = response.content; break
6. For each tool call:
     - call toolHandlers[tc.name](tc.args)   // tc.args is already parsed
     - build ToolMessage({ tool_call_id: tc.id ?? tc.name, content: String(result) })
7. Push all ToolMessages onto conversationMessages
8. Repeat from step 1
```

### 4. Reading Tool Call Arguments

`tc.args` on a LangChain tool call is already a parsed object (not a JSON string). Pass it directly to `toolHandlers[tc.name]`.

### 5. Telemetry

Span name: `'langchain.invoke'`  
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

Span attributes set after the loop:
- `gen_ai.usage.input_tokens` — **total across all iterations**
- `gen_ai.usage.output_tokens` — **total across all iterations**
- `gen_ai.usage.total_tokens`

On error: `span.recordException(err)`, status ERROR, span ended, error re-thrown.

---

## OTel Setup

This package emits one span per invocation using `@opentelemetry/api`. **No OTel configuration is needed in this package** — the tracer provider is registered by `initClient()` in `@launchdarkly/ai-server` (or `@launchdarkly/ai-node`).

To receive spans, install the OTel SDK in your application:
```sh
npm install @launchdarkly/ai-otel   # bundles all required OTel packages
```

Span names and attributes are described in [Implementation Details → Telemetry](#5-telemetry) above.

---

## `initClient()` — When to Call It

**You do not need to call `initClient()` from this package.** Every entry point (`langchainMessages()`, `config().invoke()`) lazily initializes the LaunchDarkly client on the first call, as long as `LD_SDK_KEY` is set in the environment.

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
| `@langchain/core` | `BaseChatModel`, `HumanMessage`, `SystemMessage`, `AIMessage`, `ToolMessage`, `BaseMessage` |
| `@langchain/openai` | `ChatOpenAI` (default model) |
| `@launchdarkly/ai-server` | `AiConfigRep`, `Tool`, `ProviderHandler`, `model`, `parseTemplate` |
| `@opentelemetry/api` | `SpanStatusCode`, `trace.getTracer().startActiveSpan()` for span creation |

---

## Common Pitfalls

- **`usage_metadata` may be `undefined`**: not all `BaseChatModel` implementations return token usage. The `?? 0` guards on `input_tokens` and `output_tokens` are required. If usage is consistently `0`, the underlying model doesn't report it.
- **`bindTools` is not on `BaseChatModel`**: it exists on concrete subclasses. The `as any` cast is intentional. If you replace the cast with a proper type, you need to use a union or interface that includes `bindTools`.
- **`tc.id` may be `undefined`**: some LangChain model wrappers do not populate the tool call `id`. The `tc.id ?? tc.name` fallback ensures `ToolMessage` always has a non-empty `tool_call_id`.
- **`response.content` may not be a string**: if the model returns a complex content array, `typeof response.content === 'string'` will be false and `output` will be `''`. Extend the content extraction logic if you need to handle array content.
- **Custom models**: when passing a non-OpenAI `BaseChatModel`, ensure the model's `bindTools` accepts the OpenAI function-call format used here. Models from `@langchain/anthropic`, `@langchain/google-genai`, etc. use the same format via LangChain's abstraction.
