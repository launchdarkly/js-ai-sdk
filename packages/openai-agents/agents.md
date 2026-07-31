# Agent Guide — `@launchdarkly/ai-openai-agents`

This document tells an agent exactly how this package is implemented so it can be correctly modified, debugged, or used as a reference when building a new handler.

---

## Role and Routing

This is a **Tier 1 handler package**. It wraps the OpenAI Agents SDK (`@openai/agents`) and exposes a `ProviderHandler` that routes to flag variations where:

```
providesFor = ['OpenAI', 'agent']
```

That means the LaunchDarkly flag variation must have `provider.name === "OpenAI"` and `meta.mode === "agent"`.

---

## File Map

| File | Responsibility |
|---|---|
| `src/handler.ts` | All implementation — tool wiring, agent construction, run invocation, telemetry |
| `src/graph.ts` | `openaiGraph()` convenience wrapper around `graph()` |
| `src/native-graph.ts` | `toOpenAIAgents()` native graph adapter |
| `src/index.ts` | Barrel: re-exports all public symbols |

---

## Exports

```ts
// Factory — returns a ProviderHandler with providesFor attached
export function createOpenAIAgentHandler(): ProviderHandler

// Convenience wrapper — identical to config({ ...options, key: configKey, handler: createOpenAIAgentHandler() }).invoke(userInput, context)
export const openaiAgents: (
  configKey: string,
  userInput: string,
  context: LDContext,
  options?: Omit<ConfigArgs, 'handler' | 'key'>
) => Promise<ProviderResponse>

// Graph convenience wrapper — identical to graph(key, { ...options, handlers: [createOpenAIAgentHandler()] })
export function openaiGraph(key: string, options: Omit<GraphOptions, 'handlers'>): { invoke(input, context, variables?): Promise<ProviderGraphResponse> }

// Native graph adapter — builds an OpenAI Agents SDK swarm from a resolved GraphDefinition
export function toOpenAIAgents(def: Promise<GraphDefinition>, opts?: object): { invoke(input?, variables?): Promise<ProviderGraphResponse> }
```

---

## Implementation Details

### 1. Prompt / Instructions

`config.instructions` is used as the system prompt when present. If absent, `config.messages` is consulted: `system`-role messages are combined into the system prompt, and `user`/`assistant` messages form conversation history prepended to `userInput`. `config.instructions` always takes priority when both are present.

```ts
if (config.instructions) {
  instructions = parseTemplate(config.instructions, variables);
} else if (config.messages && config.messages.length > 0) {
  const sys = config.messages.filter((m) => m.role === 'system');
  const conv = config.messages.filter((m) => m.role !== 'system');
  if (sys.length > 0) instructions = parseTemplate(sys.map((m) => m.content).join('\n'), variables);
  const history = conv.map((m) => parseTemplate(m.content, variables)).join('\n');
  prompt = history ? `${history}\n\n${userInput}` : userInput;
}
```

The instructions string is passed directly to the `Agent` constructor as `instructions`. If absent, `instructions` is omitted from the constructor call entirely.

When `history` is provided, a "Conversation History:" block is appended to the `instructions` string with the format `user: <content>\nassistant: <content>` per turn.

### 2. Tool Wiring (`buildAgentTools`)

Each `Tool` in `config.tools` is converted to an Agents SDK `tool()` object:

```ts
tool({
  name,
  description: toolConfig.description ?? '',
  strict: false,
  parameters: toolConfig.parameters as any,   // JSON Schema passed directly
  execute: async (args) => {
    const result = await toolHandlers[name](args);
    return String(result);
  },
})
```

The `execute` function is called by the Agents SDK when the model requests this tool. Arguments are already parsed (not a raw JSON string) — the SDK handles deserialization.

If `config.tools` is absent, `tools` is an empty array and the Agent is constructed without tools.

### 3. Agent Construction and Run

```ts
const agent = new Agent({
  name: 'assistant',
  model: config.model.name,
  ...(instructions ? { instructions } : {}),
  ...(tools.length > 0 ? { tools } : {}),
});

const result = await run(agent, userInput);
```

The Agents SDK manages the full agentic loop — tool calls, retries, and re-prompting — internally. The handler does not implement any loop.

### 4. Reading Results

```ts
const output = result.finalOutput ?? '';
const { inputTokens, outputTokens, totalTokens } = result.state.usage;
```

Token counts are on `result.state.usage` using camelCase (`inputTokens`, not `input_tokens`). The returned `usage` object uses `input_tokens`/`output_tokens` so `@launchdarkly/ai-server`'s `parseUsage` normalizes them correctly.

### 5. Telemetry

Span name: `'openai.agent.run'`  
Span attributes set before the call:
- `gen_ai.operation.name` = `'chat'`
- `gen_ai.system` = `'openai'`
- `gen_ai.request.model` = `config.model.name`

Conversation content, only when the handler is built with `captureContent: true`
(off by default — content is PII): `gen_ai.system_instructions`,
`gen_ai.input.messages`, `gen_ai.output.messages` and `gen_ai.tool.definitions`
as canonical JSON, mirrored into the flat `gen_ai.prompt.{i}.*` /
`gen_ai.completion.{i}.*` attributes the LaunchDarkly trace view reads today.
`execute_tool` spans additionally carry `gen_ai.tool.call.arguments` and
`gen_ai.tool.call.result`. Content is never emitted as a span event.

Span attributes set after the run:
- `gen_ai.response.model` = `config.model.name` (the Agents SDK does not expose the actual deployed model name)
- `gen_ai.usage.input_tokens`
- `gen_ai.usage.output_tokens`
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

**You do not need to call `initClient()` from this package.** Every entry point (`openaiAgents()`, `config().invoke()`) lazily initializes the LaunchDarkly client on the first call, as long as `LD_SDK_KEY` is set in the environment.

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
| `@openai/agents` | `Agent`, `run()`, `tool()` |
| `@launchdarkly/ai-server` | `AiConfigRep`, `Tool`, `ProviderHandler`, `model`, `parseTemplate` |
| `@opentelemetry/api` | `SpanStatusCode`, `trace.getTracer().startActiveSpan()` for span creation |

---

## Common Pitfalls

- **`result.state.usage` uses camelCase**: `inputTokens`, `outputTokens`, `totalTokens` — not the snake_case used by the OpenAI REST API. The returned `usage` object converts these back to `input_tokens`/`output_tokens` so the client's normalizer works.
- **`execute` receives parsed args**: unlike the Responses API where arguments arrive as a JSON string, the Agents SDK parses them before calling `execute`. Do not call `JSON.parse` in the executor.
- **`typeof handler !== 'function'` guard**: the execute callback checks `typeof handler !== 'function'` before calling it, so passing a `NativeTool` instance as a `toolHandlers` value will produce a clear `"No handler registered"` error rather than an opaque TypeError.
- **No manual loop**: do not add a tool-call loop. The Agents SDK's `run()` handles everything. Adding a manual loop on top would double-execute tools.
