# `@launchdarkly/ai-langchain-messages`

LangChain handler for `@launchdarkly/ai-server` using **LangChain chat models** (`@langchain/core`). Works with any `BaseChatModel` — defaults to `ChatOpenAI`. Runs a manual tool-call loop using LangChain's `bindTools` API.

**`providesFor`:** `['*', 'messages']` — matches any flag variation where `meta.mode` is `"messages"` and no more-specific handler is registered. LangChain is a framework adapter, not a provider: it routes through `langchain-anthropic`, `langchain-openai`, and others at runtime based on `config.provider.name`. Use `'*'` so that flags configured with `provider.name = "Anthropic"` or `"OpenAI"` are automatically handled without requiring a separate Anthropic or OpenAI handler.

## Installation

```bash
yarn add @launchdarkly/ai-server @launchdarkly/ai-langchain-messages
```

The default model is `ChatOpenAI`, so set `OPENAI_API_KEY` unless you pass a custom `BaseChatModel`.

## Usage

### With the default model (`ChatOpenAI`)

```ts
import 'dotenv/config';
import { config, shutdown } from '@launchdarkly/ai-server';
import { createLangChainHandler } from '@launchdarkly/ai-langchain-messages';

const result = await config({
  key: 'my-ai-config-flag',
  handler: createLangChainHandler(),
}).invoke('What is feature flagging?', { kind: 'user', key: 'user-123' });

console.log(result.response);
await shutdown();
```

### With a custom `BaseChatModel`

```ts
import { ChatAnthropic } from '@langchain/anthropic';
import { createLangChainHandler } from '@launchdarkly/ai-langchain-messages';

const handler = createLangChainHandler(new ChatAnthropic({ model: 'claude-opus-4-5' }));
```

### Convenience wrapper

```ts
import { langchainMessages } from '@launchdarkly/ai-langchain-messages';

const result = await langchainMessages(
  'What is feature flagging?',
  { kind: 'user', key: 'user-123' },
  { key: 'my-ai-config-flag', variables: { topic: 'feature flagging' } },
);
```

## How It Works

- Uses the system prompt and conversation history defined in your LaunchDarkly flag config.
- Template placeholders (`{{variable}}`) in the prompt are substituted using `variables` before the call.
- If tools are defined in the flag config, binds them to the model and executes them as requested, feeding results back until the model produces a final response.
- Emits an OTel span and LaunchDarkly telemetry for every call.

## Environment Variables

| Variable | Description |
|---|---|
| `OPENAI_API_KEY` | Required when using the default `ChatOpenAI` model |
| `LD_SDK_KEY` | LaunchDarkly server-side SDK key |
| `LD_SERVICE_NAME` | OTel `service.name` resource attribute (default: `nodejs-sdk`) |
| `LD_ENVIRONMENT` | `deployment.environment` attribute attached to telemetry |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP endpoint override (default: LaunchDarkly Observability backend) |
