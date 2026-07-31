# `@launchdarkly/ai-claude-agents`

Anthropic Claude handler for `@launchdarkly/ai-server` using the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`). Runs an agentic query loop with native MCP tool support.

**`providesFor`:** `['Anthropic', 'agent']` — matches flag variations where `provider.name` is `"Anthropic"` and `meta.mode` is `"agent"`.

## Installation

```bash
yarn add @launchdarkly/ai-server @launchdarkly/ai-claude-agents
```

Set `ANTHROPIC_API_KEY` in your environment (the Anthropic SDK reads it automatically).

## Usage

### With `config()`

```ts
import 'dotenv/config';
import { config, shutdown } from '@launchdarkly/ai-server';
import { createClaudeAgentsHandler } from '@launchdarkly/ai-claude-agents';

// Single handler
const result = await config({
  key: 'my-ai-config-flag',
  handler: createClaudeAgentsHandler(),
  toolHandlers: {
    search: async ({ query }) => { /* ... */ },
  },
}).invoke('What is feature flagging?', { kind: 'user', key: 'user-123' });

console.log(result.response);
await shutdown();
```

### Convenience wrapper

```ts
import { claudeAgents } from '@launchdarkly/ai-claude-agents';

const result = await claudeAgents(
  'What is feature flagging?',
  { kind: 'user', key: 'user-123' },
  { key: 'my-ai-config-flag', variables: { topic: 'feature flagging' } },
);
```

### Agent graphs — `claudeGraph()`

Runs a LaunchDarkly agent graph with the Claude agent handler pre-bound. Equivalent to calling the base `graph()` with `handlers: [createClaudeAgentsHandler()]`. See the [core client docs](../client/README.md#graphkey-options) for the full `graph()` API.

```ts
import { claudeGraph } from '@launchdarkly/ai-claude-agents';

const result = await claudeGraph('support-graph', {}).invoke(
  'I was double charged',
  { kind: 'user', key: 'user-123' },
);
```

## How It Works

- Uses the system prompt and conversation history defined in your LaunchDarkly flag config.
- Template placeholders (`{{variable}}`) in the prompt are substituted using `variables` before the call.
- If tools are defined in the flag config, the Claude Agent SDK handles all tool dispatch and the agentic loop automatically — no extra wiring needed.
- Emits an OTel span and LaunchDarkly telemetry for every call.

## Environment Variables

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key (read automatically by the Anthropic SDK) |
| `LD_SDK_KEY` | LaunchDarkly server-side SDK key |
| `LD_SERVICE_NAME` | OTel `service.name` resource attribute (default: `nodejs-sdk`) |
| `LD_ENVIRONMENT` | `deployment.environment` attribute attached to telemetry |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP endpoint override (default: LaunchDarkly Observability backend) |
