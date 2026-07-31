# `@launchdarkly/ai-openai-messages`

OpenAI handler for `@launchdarkly/ai-server` using the **OpenAI Responses API** (`openai`). Runs a manual function-call loop directly against the Responses API.

**`providesFor`:** `['OpenAI', 'messages']` — matches flag variations where `provider.name` is `"OpenAI"` and `meta.mode` is `"messages"`.

## Installation

```bash
yarn add @launchdarkly/ai-server @launchdarkly/ai-openai-messages
```

Set `OPENAI_API_KEY` in your environment (the OpenAI SDK reads it automatically).

## Usage

### With `config()`

```ts
import 'dotenv/config';
import { config, shutdown } from '@launchdarkly/ai-server';
import { createOpenAIHandler } from '@launchdarkly/ai-openai-messages';

const result = await config({
  key: 'my-ai-config-flag',
  handler: createOpenAIHandler(),
  toolHandlers: {
    search: async ({ query }) => { /* ... */ },
  },
}).invoke('What is feature flagging?', { kind: 'user', key: 'user-123' });

console.log(result.response);
await shutdown();
```

### Convenience wrapper

```ts
import { openaiMessages } from '@launchdarkly/ai-openai-messages';

const result = await openaiMessages(
  'What is feature flagging?',
  { kind: 'user', key: 'user-123' },
  { key: 'my-ai-config-flag', variables: { topic: 'feature flagging' } },
);
```

## How It Works

- Uses the system prompt defined in your LaunchDarkly flag config.
- Template placeholders (`{{variable}}`) in the prompt are substituted using `variables` before the call.
- If tools are defined in the flag config, executes them as the model requests and feeds results back until the model produces a final response.
- Emits an OTel span and LaunchDarkly telemetry for every call.

## Environment Variables

| Variable | Description |
|---|---|
| `OPENAI_API_KEY` | OpenAI API key (read automatically by the OpenAI SDK) |
| `LD_SDK_KEY` | LaunchDarkly server-side SDK key |
| `LD_SERVICE_NAME` | OTel `service.name` resource attribute (default: `nodejs-sdk`) |
| `LD_ENVIRONMENT` | `deployment.environment` attribute attached to telemetry |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP endpoint override (default: LaunchDarkly Observability backend) |
