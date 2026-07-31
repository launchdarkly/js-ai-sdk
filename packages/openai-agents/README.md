# `@launchdarkly/ai-openai-agents`

OpenAI handler for `@launchdarkly/ai-server` using the **OpenAI Agents SDK** (`@openai/agents`). Delegates the full agentic loop — tool calls, retries, and orchestration — to the Agents SDK.

**`providesFor`:** `['OpenAI', 'agent']` — matches flag variations where `provider.name` is `"OpenAI"` and `meta.mode` is `"agent"`.

## Installation

```bash
yarn add @launchdarkly/ai-server @launchdarkly/ai-openai-agents
```

Set `OPENAI_API_KEY` in your environment (the OpenAI SDK reads it automatically).

## Usage

### With `config()`

```ts
import 'dotenv/config';
import { config, shutdown } from '@launchdarkly/ai-server';
import { createOpenAIAgentHandler } from '@launchdarkly/ai-openai-agents';

const result = await config({
  key: 'my-ai-config-flag',
  handler: createOpenAIAgentHandler(),
  toolHandlers: {
    search: async ({ query }) => { /* ... */ },
  },
}).invoke('Summarize today\'s changelog', { kind: 'user', key: 'user-123' });

console.log(result.response);
await shutdown();
```

### Convenience wrapper

```ts
import { openaiAgents } from '@launchdarkly/ai-openai-agents';

const result = await openaiAgents(
  'Summarize today\'s changelog',
  { kind: 'user', key: 'user-123' },
  { key: 'my-ai-config-flag', variables: { topic: 'changelog' } },
);
```

## How It Works

- Uses the system prompt and tools defined in your LaunchDarkly flag config.
- Template placeholders (`{{variable}}`) in the prompt are substituted using `variables` before the call.
- The OpenAI Agents SDK manages the full agentic loop — tool dispatch, re-prompting, and termination — automatically.
- Emits an OTel span and LaunchDarkly telemetry for every call.

## Choosing Between `openai-agents` and `openai-messages`

| | `openai-agents` | `openai-messages` |
|---|---|---|
| Underlying SDK | `@openai/agents` | `openai` (Responses API) |
| Tool loop | Managed by Agents SDK | Executed and fed back manually |
| Complexity | Lower (SDK manages loop) | More explicit control |

## Environment Variables

| Variable | Description |
|---|---|
| `OPENAI_API_KEY` | OpenAI API key (read automatically by the OpenAI SDK) |
| `LD_SDK_KEY` | LaunchDarkly server-side SDK key |
| `LD_SERVICE_NAME` | OTel `service.name` resource attribute (default: `nodejs-sdk`) |
| `LD_ENVIRONMENT` | `deployment.environment` attribute attached to telemetry |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP endpoint override (default: LaunchDarkly Observability backend) |
