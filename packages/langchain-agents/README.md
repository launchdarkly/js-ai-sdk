# `@launchdarkly/ai-langchain-agents`

LangChain handler for `@launchdarkly/ai-server` using **LangGraph's `createReactAgent`** (`@langchain/langgraph`). Delegates the full agentic loop to the LangGraph ReAct agent. Works with any `BaseChatModel` — defaults to `ChatOpenAI`.

**`providesFor`:** `['*', 'agent']` — matches any flag variation where `meta.mode` is `"agent"` and no more-specific handler is registered. LangChain is a framework adapter, not a provider: it routes through `langchain-anthropic`, `langchain-openai`, and others at runtime based on `config.provider.name`. Use `'*'` so that flags configured with `provider.name = "Anthropic"` or `"OpenAI"` are automatically handled without requiring a separate Anthropic or OpenAI handler.

## Installation

```bash
yarn add @launchdarkly/ai-server @launchdarkly/ai-langchain-agents
```

The default model is `ChatOpenAI`, so set `OPENAI_API_KEY` unless you pass a custom `BaseChatModel`.

## Usage

### With the default model (`ChatOpenAI`)

```ts
import 'dotenv/config';
import { config, shutdown } from '@launchdarkly/ai-server';
import { createLangChainAgentsHandler } from '@launchdarkly/ai-langchain-agents';

const result = await config({
  key: 'my-ai-config-flag',
  handler: createLangChainAgentsHandler(),
  toolHandlers: {
    search: async ({ query }) => { /* ... */ },
  },
}).invoke('Research and summarize feature flagging best practices', { kind: 'user', key: 'user-123' });

console.log(result.response);
await shutdown();
```

### With a custom `BaseChatModel`

```ts
import { ChatAnthropic } from '@langchain/anthropic';
import { createLangChainAgentsHandler } from '@launchdarkly/ai-langchain-agents';

const handler = createLangChainAgentsHandler(new ChatAnthropic({ model: 'claude-opus-4-5' }));
```

### Convenience wrapper

```ts
import { langchainAgents } from '@launchdarkly/ai-langchain-agents';

const result = await langchainAgents(
  'Research feature flagging best practices',
  { kind: 'user', key: 'user-123' },
  { key: 'my-ai-config-flag', variables: { topic: 'feature flagging' } },
);
```

### Native graph adapter — `toLangGraph()`

Converts a `resolveGraph()` result into a framework-native LangGraph `StateGraph`. Pre-order traversal (root → leaves) builds a compiled `StateGraph`. Single-child edges become direct edges after a tool loop; multi-child edges use `Command`-returning handoff tools (bound with `parallel_tool_calls: false`) so the model picks exactly one target.

```ts
import { resolveGraph } from '@launchdarkly/ai-server';
import { toLangGraph } from '@launchdarkly/ai-langchain-agents';

const ctx = { kind: 'user', key: 'user-123' };
const result = await toLangGraph(
  resolveGraph('support-graph', { context: ctx }),
  {
    toolHandlers: registry.tools,
    context: ctx,
    // optional: supply your own model per node
    modelFactory: (node) => new ChatOpenAI({ model: node.config.model.name }),
  },
).invoke('I was double charged');

console.log(result.response);
```

## How It Works

- Uses the system prompt and conversation history defined in your LaunchDarkly flag config.
- Template placeholders (`{{variable}}`) in the prompt are substituted using `variables` before the call.
- The LangGraph ReAct agent manages the full reasoning and tool-call loop autonomously — reasoning through steps, calling tools, and deciding when to stop.
- Emits an OTel span and LaunchDarkly telemetry for every call.

## Choosing Between `langchain-agents` and `langchain-messages`

| | `langchain-agents` | `langchain-messages` |
|---|---|---|
| Orchestration | LangGraph ReAct agent | Manual tool loop |
| Reasoning style | ReAct (reason + act cycles) | Single invoke per tool round-trip |
| Best for | Complex multi-step reasoning | Straightforward tool calls |

## Environment Variables

| Variable | Description |
|---|---|
| `OPENAI_API_KEY` | Required when using the default `ChatOpenAI` model |
| `LD_SDK_KEY` | LaunchDarkly server-side SDK key |
| `LD_SERVICE_NAME` | OTel `service.name` resource attribute (default: `nodejs-sdk`) |
| `LD_ENVIRONMENT` | `deployment.environment` attribute attached to telemetry |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP endpoint override (default: LaunchDarkly Observability backend) |
