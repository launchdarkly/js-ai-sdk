# `@launchdarkly/ai-claude-messages`

Anthropic Claude handler for `@launchdarkly/ai-server` using the **Anthropic Messages API** (`@anthropic-ai/sdk`). Runs a manual tool-use loop without the Claude Agent SDK layer.

**`providesFor`:** `['Anthropic', 'messages']` — matches flag variations where `provider.name` is `"Anthropic"` and `meta.mode` is `"messages"`.

## Installation

```bash
yarn add @launchdarkly/ai-server @launchdarkly/ai-claude-messages
```

Set `ANTHROPIC_API_KEY` in your environment (the Anthropic SDK reads it automatically).

## Usage

### With `config()`

```ts
import 'dotenv/config';
import { config, shutdown } from '@launchdarkly/ai-server';
import { createClaudeMessagesHandler } from '@launchdarkly/ai-claude-messages';

const result = await config({
  key: 'my-ai-config-flag',
  handler: createClaudeMessagesHandler(),
  toolHandlers: {
    search: async ({ query }) => { /* ... */ },
  },
}).invoke('What is feature flagging?', { kind: 'user', key: 'user-123' });

console.log(result.response);
await shutdown();
```

### Convenience wrapper

```ts
import { claudeMessages } from '@launchdarkly/ai-claude-messages';

const result = await claudeMessages(
  'What is feature flagging?',
  { kind: 'user', key: 'user-123' },
  { key: 'my-ai-config-flag', variables: { topic: 'feature flagging' } },
);
```

## How It Works

- Uses the system prompt and conversation history defined in your LaunchDarkly flag config.
- Template placeholders (`{{variable}}`) in the prompt are substituted using `variables` before the call.
- If tools are defined in the flag config, executes them as the model requests and feeds results back until the model produces a final response.
- Emits an OTel span and LaunchDarkly telemetry for every call.

## Choosing Between `claude-agents` and `claude-messages`

| | `claude-agents` | `claude-messages` |
|---|---|---|
| Underlying SDK | `@anthropic-ai/claude-agent-sdk` | `@anthropic-ai/sdk` |
| Tool loop | Managed by the Claude Agent SDK | Executed and fed back manually |
| Complexity | Lower (SDK manages loop) | More explicit control |

## Environment Variables

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key (read automatically by the Anthropic SDK) |
| `LD_SDK_KEY` | LaunchDarkly server-side SDK key |
| `LD_SERVICE_NAME` | OTel `service.name` resource attribute (default: `nodejs-sdk`) |
| `LD_ENVIRONMENT` | `deployment.environment` attribute attached to telemetry |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP endpoint override (default: LaunchDarkly Observability backend) |
