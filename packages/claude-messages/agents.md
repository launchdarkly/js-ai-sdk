# Agent Guide — `@launchdarkly/ai-claude-messages`

This document tells an agent exactly how this package is implemented so it can be correctly modified, debugged, or used as a reference when building a new handler.

---

## Role and Routing

This is a **Tier 1 handler package**. It wraps the Anthropic Messages API (`@anthropic-ai/sdk`) and exposes a `ProviderHandler` that routes to flag variations where:

```
providesFor = ['Anthropic', 'messages']
```

That means the LaunchDarkly flag variation must have `provider.name === "Anthropic"` and `meta.mode === "messages"`.

---

## File Map

| File | Responsibility |
|---|---|
| `src/handler.ts` | All implementation — message building, tool schema conversion, tool-use loop, telemetry |
| `src/index.ts` | Barrel: `export { createClaudeMessagesHandler, claudeMessages }` |

---

## Exports

```ts
// Factory — returns a ProviderHandler with providesFor attached
export function createClaudeMessagesHandler(): ProviderHandler

// Convenience wrapper — identical to config({ ...options, key: configKey, handler: createClaudeMessagesHandler() }).invoke(userInput, context)
export const claudeMessages: (configKey: string, userInput: string, context: LDContext, options?: Omit<ConfigArgs, 'handler' | 'key'>) => Promise<ProviderResponse>
```

---

## Implementation Details

### 1. Message Construction (`buildMessages`)

Returns `{ messages: MessageParam[], system?: string }` for the Anthropic Messages API:

```
config.instructions present?
  → system = parseTemplate(config.instructions, variables)
  → messages = [{ role: 'user', content: userInput }]

config.messages present?
  → system-role messages → system (joined with \n)
  → user/assistant messages → MessageParam[] with parseTemplate applied
  → append { role: 'user', content: userInput }

neither?
  → messages = [{ role: 'user', content: userInput }], no system

history provided?
  → history user/assistant messages are inserted after config messages, before userInput
  → system-role history messages are filtered out
  → Final order: [config messages] → [history messages] → [userInput]
```

### 2. Tool Schema Conversion (`buildTools`)

Each `Tool` in `config.tools` is converted to an `Anthropic.Tool`:

```ts
{
  name: toolConfig.name,
  description: toolConfig.description ?? '',
  input_schema: toolConfig.parameters as Anthropic.Tool.InputSchema,
}
```

The `parameters` field (JSON Schema) is passed directly as `input_schema` — no conversion needed.

### 3. Tool-Use Loop

The handler drives the loop manually against `anthropic.messages.create()`:

```
1. Call messages.create({ model, max_tokens, system?, messages, tools? })
2. Accumulate input_tokens + output_tokens from response.usage
3. If stop_reason !== 'tool_use': extract text blocks → output; break
4. Append { role: 'assistant', content: response.content } to conversation
5. For each tool_use block:
     - call toolHandlers[toolUse.name](toolUse.input)
     - build { type: 'tool_result', tool_use_id, content: String(result) }
6. Append { role: 'user', content: toolResults } to conversation
7. Repeat from step 1
```

`max_tokens` is read from `config.model.parameters?.max_tokens`, defaulting to `1024`.

Output is all `text`-type blocks joined: `response.content.filter(b => b.type === 'text').map(b => b.text).join('')`.

### 4. Telemetry

Span name: `'claude.messages'`  
Span attributes set before the call:
- `gen_ai.operation.name` = `'chat'`
- `gen_ai.system` = `'anthropic'`
- `gen_ai.request.model` = `config.model.name`

Conversation content, only when the handler is built with `captureContent: true`
(off by default — content is PII): `gen_ai.system_instructions`,
`gen_ai.input.messages`, `gen_ai.output.messages` and `gen_ai.tool.definitions`
as canonical JSON, mirrored into the flat `gen_ai.prompt.{i}.*` /
`gen_ai.completion.{i}.*` attributes the LaunchDarkly trace view reads today.
`execute_tool` spans additionally carry `gen_ai.tool.call.arguments` and
`gen_ai.tool.call.result`. Content is never emitted as a span event.

Span attributes set after the loop:
- `gen_ai.usage.input_tokens` — **total across all loop iterations**
- `gen_ai.usage.output_tokens` — **total across all loop iterations**
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

**You do not need to call `initClient()` from this package.** Every entry point (`claudeMessages()`, `config().invoke()`) lazily initializes the LaunchDarkly client on the first call, as long as `LD_SDK_KEY` is set in the environment.

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
| `@anthropic-ai/sdk` | `Anthropic` client, `MessageParam`, `Tool`, `ToolUseBlock`, `TextBlock`, `ToolResultBlockParam` |
| `@launchdarkly/ai-server` | `AiConfigRep`, `Tool`, `ProviderHandler`, `model`, `parseTemplate` |
| `@opentelemetry/api` | `SpanStatusCode`, `trace.getTracer().startActiveSpan()` for span creation |

---

## Common Pitfalls

- **Conversation must alternate `user` / `assistant`**: The Anthropic Messages API requires that messages strictly alternate roles. The `buildMessages` function ensures user/assistant messages from `config.messages` are appended as-is, then the final user input is appended. If your `config.messages` has two consecutive `user` messages, the API will reject the request.
- **Tool results go in a `user` turn**: After executing tool_use blocks, the results are appended as `{ role: 'user', content: toolResults[] }`. This is correct for the Anthropic API — do not change to `assistant`.
- **`input_schema` not `parameters`**: The Anthropic SDK uses `input_schema` (not `parameters` or `schema`). The JSON Schema from `Tool.parameters` maps directly to `input_schema`.
- **Token accumulation**: Tokens are summed across every loop iteration. The `usage` object returned by this handler contains the **total** for the entire multi-turn exchange, which is what `@launchdarkly/ai-server`'s telemetry tracking expects.
