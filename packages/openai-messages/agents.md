# Agent Guide — `@launchdarkly/ai-openai-messages`

This document tells an agent exactly how this package is implemented so it can be correctly modified, debugged, or used as a reference when building a new handler.

---

## Role and Routing

This is a **Tier 1 handler package**. It wraps the OpenAI Responses API (`openai`) and exposes a `ProviderHandler` that routes to flag variations where:

```
providesFor = ['OpenAI', 'messages']
```

That means the LaunchDarkly flag variation must have `provider.name === "OpenAI"` and `meta.mode === "messages"`.

---

## File Map

| File | Responsibility |
|---|---|
| `src/handler.ts` | All implementation — message building, tool schema conversion, function-call loop, telemetry |
| `src/index.ts` | Barrel: `export { createOpenAIHandler, openaiMessages }` |

---

## Exports

```ts
// Factory — returns a ProviderHandler with providesFor attached
export function createOpenAIHandler(): ProviderHandler

// Convenience wrapper — identical to config({ ...options, key: configKey, handler: createOpenAIHandler() }).invoke(userInput, context)
export const openaiMessages: (configKey: string, userInput: string, context: LDContext, options?: Omit<ConfigArgs, 'handler' | 'key'>) => Promise<ProviderResponse>
```

---

## Implementation Details

### 1. Message Construction

The handler uses the OpenAI Responses API's `ResponseInputItem[]` format. It builds a flat array:

```
instructions = parseTemplate(config.instructions, variables)   // '' if absent

inputMessages = [
  { role: 'system', content: instructions },   // omitted if instructions is empty
  { role: 'user',   content: userInput },
]
```

Both `config.messages` and `config.instructions` are supported. `config.messages` takes priority: when it is present and non-empty, the messages array is used as the full input (with `userInput` appended as the final turn). `config.instructions` is the fallback used only when `messages` is absent or empty.

### 2. Tool Schema Conversion (`buildTools`)

Each `Tool` in `config.tools` is converted to `FunctionTool`:

```ts
{
  type: 'function',
  name,
  description: toolConfig.description ?? '',
  parameters: toolConfig.parameters,   // JSON Schema passed through as-is
  strict: false,
}
```

### 3. Function-Call Loop

The handler drives the tool loop manually via `openai.responses.create()` using the `previous_response_id` chaining mechanism:

```
1. responses.create({ model, input: inputMessages, tools? })
2. Accumulate usage.input_tokens + usage.output_tokens
3. Filter response.output for items where item.type === 'function_call'
4. If none: output = response.output_text; break
5. For each function_call:
     - args = JSON.parse(tc.arguments)
     - result = await toolHandlers[tc.name](args)
     - build { type: 'function_call_output', call_id: tc.call_id, output: String(result) }
6. responses.create({ model, previous_response_id: response.id, input: toolOutputs })
7. Accumulate tokens from new response
8. Repeat from step 3
```

Tool argument deserialization: `JSON.parse(tc.arguments)` — the Responses API delivers arguments as a JSON string.

### 4. Telemetry

Span name: `'openai.response'`  
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

Additional attribute set after the first response (response model may differ from requested):
- `gen_ai.response.model` = `response.model`

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

Span names and attributes are described in [Implementation Details → Telemetry](#4-telemetry) above.

---

## `initClient()` — When to Call It

**You do not need to call `initClient()` from this package.** Every entry point (`openaiMessages()`, `config().invoke()`) lazily initializes the LaunchDarkly client on the first call, as long as `LD_SDK_KEY` is set in the environment.

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
| `openai` | `OpenAI` client, `Responses.Response`, `ResponseFunctionToolCall`, `ResponseInputItem` |
| `@launchdarkly/ai-server` | `AiConfigRep`, `Tool`, `ProviderHandler`, `config`, `parseTemplate` |
| `@opentelemetry/api` | `SpanStatusCode`, `trace.getTracer().startActiveSpan()` for span creation |

---

## Common Pitfalls

- **`previous_response_id` chaining**: subsequent tool-result calls must pass `previous_response_id: response.id` and **not** re-send the original `inputMessages`. The Responses API uses stateful response chaining.
- **`tc.arguments` is a JSON string**: it must be parsed with `JSON.parse` before passing to `toolHandlers`. Do not pass the raw string.
- **`config.messages` takes priority over `config.instructions`**: when `config.messages` is present and non-empty, it is used as the full input (with `userInput` appended as the final turn). `config.instructions` is only used as a fallback when `messages` is absent or empty.
- **`output_text`**: the final text response is `response.output_text` (a convenience accessor), not `response.output[0].text`. If the model produces no text (e.g. all output items are tool calls), `output_text` is `null` — the `?? ''` guard is required.
