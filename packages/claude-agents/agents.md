# Agent Guide — `@launchdarkly/ai-claude-agents`

This document tells an agent exactly how this package is implemented so it can be correctly modified, debugged, or used as a reference when building a new handler.

---

## Role and Routing

This is a **Tier 1 handler package**. It wraps the `@anthropic-ai/claude-agent-sdk` and exposes a `ProviderHandler` that routes to flag variations where:

```
providesFor = ['Anthropic', 'agent']
```

That means the LaunchDarkly flag variation must have `provider.name === "Anthropic"` and `meta.mode === "agent"`.

---

## File Map

| File | Responsibility |
|---|---|
| `src/handler.ts` | All implementation — prompt building, MCP tool wiring, agentic loop, telemetry |
| `src/graph.ts` | `claudeGraph()` convenience wrapper around `graph()` |
| `src/native-graph.ts` | `toClaudeAgents()` native graph adapter |
| `src/builtins.ts` | Pre-constructed `NativeTool` sentinels for Claude built-in tools |
| `src/index.ts` | Barrel: re-exports all public symbols |

---

## Exports

```ts
// Factory — returns a ProviderHandler with providesFor attached
export function createClaudeAgentsHandler(): ProviderHandler

// Convenience wrapper — identical to config({ ...options, key: configKey, handler: createClaudeAgentsHandler() }).invoke(userInput, context)
export const claudeAgents: (configKey: string, userInput: string, context: LDContext, options?: Omit<ConfigArgs, 'handler' | 'key'>) => Promise<ProviderResponse>

// Graph convenience wrapper — identical to graph(key, { ...options, handlers: [createClaudeAgentsHandler()] })
export function claudeGraph(key: string, options: Omit<GraphOptions, 'handlers'>): { invoke(input, context, variables?): Promise<ProviderGraphResponse> }

// Native graph adapter — builds a Claude code-agents graph from a resolved GraphDefinition
export function toClaudeAgents(def: Promise<GraphDefinition>, opts?: object): { invoke(input?, variables?): Promise<ProviderGraphResponse> }

// NativeTool sentinels for Claude Code built-in capabilities
export const ClaudeBash: NativeTool
export const ClaudeRead: NativeTool
export const ClaudeEdit: NativeTool
export const ClaudeWrite: NativeTool
export const ClaudeGlob: NativeTool
export const ClaudeGrep: NativeTool
export const ClaudeWebFetch: NativeTool
export const ClaudeWebSearch: NativeTool
export const ClaudeTodoWrite: NativeTool
export const ClaudeNotebookEdit: NativeTool
```

---

## Implementation Details

### 1. Prompt Construction (`buildPrompt`)

The handler uses a flat `prompt` + optional `systemPrompt` shape that the claude-agent-sdk `query()` call accepts:

```
config.instructions present?
  → systemPrompt = parseTemplate(config.instructions, variables)
  → prompt = userInput

config.messages present?
  → system-role messages → systemPrompt (joined with \n)
  → non-system messages → joined as plain text → prepended to userInput
  → prompt = conversationHistory + "\n\n" + userInput

neither?
  → prompt = userInput, no systemPrompt

history provided?
  → Appends a "Conversation History:" block to systemPrompt
  → Format: "user: <content>\nassistant: <content>" per turn
```

Note: the `messages` path collapses conversation history into a single flat string — roles are not individually structured. This is a limitation of the agent SDK's `query()` interface, which takes one prompt string. The `history` parameter is also formatted as a text block appended to the system prompt, since the agent SDK accepts a single prompt string rather than structured message arrays.

Because of that, `invoke_agent` reports the opening turn as **one** `user` message holding the flattened text, not one message per configured role. That is what the model was actually sent; splitting the roles back out on the span would describe a request that never happened. Sending them as real turns would mean switching to `query()`'s streaming-input mode, which changes what the model receives and is a separate decision from telemetry.

### 2. Tool Wiring (`buildToolMCP`)

Tools are delivered via an in-process MCP server, not as raw JSON schema defs. The pipeline:

1. Each `Tool` in `config.tools` is converted to a claude-agent-sdk `tool()` call.
2. The tool schema is converted from JSON Schema to a Zod schema using `z.fromJSONSchema(toolConfig.parameters)`.
3. The tool's executor calls `toolHandlers[toolName](...args)` and returns `{ content: [{ type: 'text', text: String(result) }] }`.
4. All tools are registered in a single `createSdkMcpServer({ name: 'tool-mcp', ... })`.
5. The MCP server is passed to `query()` under the key `"tool-mcp"`.
6. Allowed tools are prefixed: `mcp__tool-mcp__<toolName>`.

If `config.tools` is absent, `toolMCP` and `allowedTools` are both `undefined`.

### 3. Agentic Loop

The claude-agent-sdk handles the loop internally. The handler iterates the `query()` async generator and waits for a message with a `result` key — that is the final text output. Token usage is read from `message.usage`.

```ts
for await (const message of query({ prompt, options: { ... } })) {
  if ('result' in message) {
    // done — extract output and usage
  }
}
```

### 4. Telemetry

Each invocation emits the same three-span vocabulary as the other five handlers:
one `invoke_agent` root carrying LaunchDarkly correlation, one `chat`
child per model response, and one `execute_tool <name>` child per tool call. All
children are direct children of the root — siblings, not a chain — so per-turn
latency is not reported as cumulative.

`query()` reports no request boundaries, so the handler derives them from the
message stream — and the stream is subtler than it looks. Three properties, each
measured against Agent SDK 0.3.220 rather than assumed:

1. **An `assistant` message is not a call.** The CLI emits one message per content
   block of a response and dispatches those blocks one at a time, so a single call
   surfaces as several messages sharing a `request_id` and repeating one `usage`
   bag. `request_id` is the unit; usage and identity are written once, from the
   first message, and later messages contribute only their content blocks.
2. **Those messages are not adjacent.** Tool executions land between them, so the
   grouping is keyed across the whole run, not only while messages are consecutive.
3. **`system` messages are not boundaries.** A burst of `thinking_tokens` arrives
   *during* every call, the last in the same millisecond as the response. Only a
   `user` message — carrying the tool results the next call is sent — and a `system`
   `init` mark local work finishing. That is a whitelist, so a subtype added by a
   future CLI is inert rather than silently collapsing the timings.

A response's window therefore runs from the last local work to that response's
**first** message. The API had already returned every block by then, so extending
to the last message would put the intervening tool executions inside the model call.
Spans are built when the run flushes, with explicit start and end timestamps.

Each `chat` span carries `gen_ai.input.messages`: the conversation as it stood when
its response began. The handler keeps a running list of every turn the run produces
— the opening prompt, each assistant reply, and each `user` message carrying tool
results — and copies that list onto a span when a new response starts.

The list is copied, but the turns inside it are shared on purpose. The CLI holds a
whole response before dispatching any of its blocks, so the request that followed
carried the complete assistant turn; a block still arriving here belonged to it all
along. Spans are built at flush time, by which point every turn is whole. Copying
the turns instead would freeze each one mid-assembly and drop content the model
demonstrably saw.

**One conversation per agent, not per run.** A subagent's own model calls arrive on
the parent's message stream, tagged with the `parent_tool_use_id` of the `Task` call
that spawned it, and interleaved with the main thread's. Conversations are therefore
keyed on that id (`null` = the main thread); a single flat list would hand a
main-thread call an input containing turns from a conversation it was never part of.

A subagent's `chat` span carries `gen_ai.agent.name` and its own turns, and
deliberately carries **neither** `gen_ai.system_instructions` nor
`gen_ai.tool.definitions`: it runs under its own agent definition's prompt and its own
subset of tools, and this side is told neither. Its opening prompt is the `Task` call's
argument, already on that `execute_tool` span.

### The tool catalog

Every entry is keyed on the name the model saw, which is also the name that tool's
`execute_tool` span carries — that is what lets a reader join the catalog to the calls
made against it.

| AI Config key | what the model saw          | catalogued as | schema        |
|---------------|-----------------------------|---------------|---------------|
| `search`      | `mcp__tool-mcp__search`     | `search`      | AI Config's   |
| `webSearch`   | `WebSearch` (provider tool) | `WebSearch`   | AI Config's   |
| —             | `Read` (CLI's own)          | `Read`        | none reported |

The middle row needs `partitionTools`' `nativeToolAliases`: a `NativeTool` binds an AI
Config key to a provider tool whose name is its own. Catalogued under the AI Config key
it appeared twice — once with the config's schema and once, from `init`, without.

What stays out of reach is the request the CLI actually assembled — its own system
prompt, and the schemas for its built-in tools — because that happens in another
process out of context this side never receives. Those tools are listed by name once
`init` announces them, with no `parameters`: "offered, schema not ours to state"
describes the run better than omitting a tool the model could call.

**The CLI's own OTel exporter is deliberately never enabled.** Its span names
(`claude_code.llm_request`, `claude_code.tool`, `claude_code.tool.execution`,
`claude_code.tool.blocked_on_user`) are outside the semantic conventions and only
become `chat` / `execute_tool` after a LaunchDarkly-specific ingest translation,
and they duplicate spans this handler already emits. Measured on an 8-turn run:
27 extra tool spans and 27 spans with no `gen_ai.operation.name` at all. A trace
this SDK produces has to read the same way on any OTel backend.

Root-span attributes:
- `gen_ai.operation.name` = `'invoke_agent'`
- `gen_ai.system` / `gen_ai.provider.name` = `'anthropic'`
- `gen_ai.request.model` / `gen_ai.response.model` = `config.model.name`
- `gen_ai.conversation.id` = a caller-supplied id from `withConversationId`, or the `session_id` from the `init` message when the caller supplied none. Write-if-absent: the caller id wins. An app that opens a fresh CLI session per turn and re-feeds history must pass its own conversation id, or each turn becomes its own conversation.
- run-cumulative usage from the result message: `gen_ai.usage.input_tokens`
  (uncached + cache-read + cache-creation), `output_tokens`, `total_tokens`,
  `cache_read.input_tokens`, `cache_creation.input_tokens`

`chat` span attributes, all read off that one API response:
- `gen_ai.operation.name` = `'chat'`
- `gen_ai.system` / `gen_ai.provider.name` = `'anthropic'`
- `gen_ai.request.model` / `gen_ai.response.model` = `message.model`
- `gen_ai.response.id` = the message's `request_id`
- `gen_ai.response.finish_reasons` = `[message.stop_reason]`, **when the Agent SDK
  reports one.** Measured against 0.3.220 it does not: `stop_reason` and
  `stop_details` are both `null` on every assistant message, and only the run-level
  `result` message carries a `stop_reason`. The attribute is therefore absent in
  practice on this handler alone. It is written the moment the SDK starts populating
  the field; nothing is derived in the meantime, because inferring `tool_use` from
  the presence of a `tool_use` content block would put a value on the span that the
  provider never returned.
- `gen_ai.conversation.id` = same write-if-absent rule as the root: caller-supplied id, else this message's `session_id`
- that call's own usage — not the run's, which would multiply the reported cost by
  the number of turns

Conversation content, only when the handler is built with `captureContent: true`
(off by default — content is PII): `gen_ai.system_instructions`,
`gen_ai.input.messages`, `gen_ai.output.messages` and `gen_ai.tool.definitions`
as canonical JSON, mirrored into the flat `gen_ai.prompt.{i}.*` /
`gen_ai.completion.{i}.*` attributes the LaunchDarkly trace view reads today. The
split matches the other five handlers: the **root** carries the prompt and the
final answer, each **`chat`** span carries that turn's own output (its tool calls
and reasoning blocks included) and no input, and `execute_tool` spans carry
`gen_ai.tool.call.arguments` and `gen_ai.tool.call.result`. Content is never
emitted as a span event.

On error: `span.recordException(err)`, status set to ERROR, span ended, error re-thrown.

---

## OTel Setup

This package emits a correlated agent/model/tool span tree using
`@opentelemetry/api`. **No OTel configuration is needed in this package** —
the tracer provider is registered by `initClient()` in
`@launchdarkly/ai-server` (or `@launchdarkly/ai-node`).

To receive spans, install the OTel SDK in your application:
```sh
npm install @launchdarkly/ai-otel   # bundles all required OTel packages
```

Span names and attributes are described in [Implementation Details → Telemetry](#4-telemetry) above.

---

## `initClient()` — When to Call It

**You do not need to call `initClient()` from this package.** Every entry point (`claudeAgents()`, `config().invoke()`) lazily initializes the LaunchDarkly client on the first call, as long as `LD_SDK_KEY` is set in the environment.

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
| `@anthropic-ai/claude-agent-sdk` | `query()`, `tool()`, `createSdkMcpServer()` |
| `@launchdarkly/ai-server` | `AiConfigRep`, `Tool`, `ProviderHandler`, `model`, `parseTemplate` |
| `@opentelemetry/api` | `SpanStatusCode`, `trace.getTracer().startActiveSpan()` for span creation |
| `zod` | `z.fromJSONSchema()` to convert tool parameter schemas |

---

## Common Pitfalls

- **`z.fromJSONSchema`** is used to convert tool parameter schemas from JSON Schema to Zod. If a tool's `parameters` schema is not valid JSON Schema, this will throw at tool-build time, before the query runs.
- **MCP tool name prefix**: tools registered in the MCP server are accessible as `mcp__tool-mcp__<name>`. The `allowedTools` array must use this prefix; omitting it will cause the agent to not invoke any tools.
- **`message.usage` shape**: the raw usage object from the claude-agent-sdk is returned unchanged. Telemetry and `@launchdarkly/ai-server` normalization add `input_tokens`, `cache_read_input_tokens`, and `cache_creation_input_tokens` so normalized input and total token counts include every billed input category. Public `ProviderResponse.usage.inputDetails` exposes the uncached, cache-read, and cache-creation breakdown.
