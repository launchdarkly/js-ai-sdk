# `@launchdarkly/ai-langchain-messages`

LangChain handler for `@launchdarkly/ai-server` using **LangChain chat models** (`@langchain/core`). Works with any `BaseChatModel` — defaults to `ChatOpenAI`. Runs a manual tool-call loop using LangChain's `bindTools` API.

**`providesFor`:** `['*', 'messages']` — matches any flag variation where `meta.mode` is `"messages"` and no more-specific handler is registered. LangChain is a framework adapter, not a provider: it routes through `langchain-anthropic`, `langchain-openai`, and others at runtime based on `config.provider.name`. Use `'*'` so that flags configured with `provider.name = "Anthropic"` or `"OpenAI"` are automatically handled without requiring a separate Anthropic or OpenAI handler.

Pass `{ providers: ['Bedrock'] }` to `createLangChainMessagesHandler` (and to `langchainMessages`) to accept only those `config.provider.name` values. Names must match the config exactly. Several scoped handlers can be registered together; the shortest list that contains the name wins. Omit `providers` to keep matching every provider.

## Installation

```bash
yarn add @launchdarkly/ai-server @launchdarkly/ai-langchain-messages dotenv
```

The default model is `ChatOpenAI`, so set `OPENAI_API_KEY` unless you pass a custom `BaseChatModel`.

### Built-in models

When you pass no model, the handler builds one from the lowercased `config.provider.name`:

| `provider.name` | Model | Package | Credentials |
|---|---|---|---|
| `anthropic` | `ChatAnthropic` | `@langchain/anthropic` | `ANTHROPIC_API_KEY` |
| `bedrock` | `ChatBedrockConverse`, with `model.region` prefixed onto the model id | `@langchain/aws` | the AWS credential chain |
| `gemini` | `ChatGoogleGenerativeAI` (Gemini API) | `@langchain/google-genai` | `GOOGLE_API_KEY` or `GEMINI_API_KEY` |
| anything else | `ChatOpenAI` | `@langchain/openai` | `OPENAI_API_KEY` |

The Anthropic, Bedrock, and Gemini packages are optional peer dependencies, so install the one a config needs, for example `yarn add @langchain/google-genai` for a Gemini config. Only an allowlist of generation settings from `config.model.parameters` reaches the constructor. For Gemini that is `temperature`, `top_p`, `top_k`, `max_output_tokens` (or `max_tokens`), `stop_sequences` (or `stop`), and the flat `thinking_budget` and `thinking_level` (`minimal`, `low`, `medium`, `high`, or `xhigh`; the level wins when both are set). A nested `thinking_config` and `include_thoughts` are not read, and `seed`, `frequency_penalty`, `presence_penalty`, and `media_resolution` are dropped because the TypeScript `ChatGoogleGenerativeAI` has no fields for them. `maxRetries`, when you pass it to the handler, reaches whichever model it builds.

## Usage

### With the default model (`ChatOpenAI`)

```ts
import 'dotenv/config';
import { config, shutdown } from '@launchdarkly/ai-server';
import { createLangChainMessagesHandler } from '@launchdarkly/ai-langchain-messages';

const result = await config({
  key: 'my-ai-config-flag',
  handler: createLangChainMessagesHandler(),
}).invoke('What is feature flagging?', { kind: 'user', key: 'user-123' });

console.log(result.response);
await shutdown();
```

### With a custom `BaseChatModel`

```ts
import { ChatAnthropic } from '@langchain/anthropic';
import { createLangChainMessagesHandler } from '@launchdarkly/ai-langchain-messages';

const handler = createLangChainMessagesHandler(new ChatAnthropic({ model: 'claude-opus-4-5' }));
```

A constructed instance cannot see flag parameters. Pass a function instead if the model should
be built after evaluation:

```ts
const handler = createLangChainMessagesHandler((config) => new ChatAnthropic({
  model: config.model.name,
  temperature: typeof config.model.parameters?.temperature === 'number' ? config.model.parameters.temperature : undefined,
}));
```

Pick out the settings you want by name. Don't spread `config.model.parameters` into the constructor:
it comes from the AI Config, and a spread would let it set constructor options such as `apiKey`,
`anthropicApiUrl` or `clientOptions`. If you pass no model, the handler builds one itself and
forwards only an allowlist of generation settings.

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
| `GOOGLE_API_KEY` | The Gemini API key when the handler builds `ChatGoogleGenerativeAI` for a Gemini config. One of this or `GEMINI_API_KEY` is required |
| `GEMINI_API_KEY` | Used for a Gemini config when `GOOGLE_API_KEY` is unset or empty |
| `LD_SDK_KEY` | LaunchDarkly server-side SDK key |
| `LD_SERVICE_NAME` | OTel `service.name` resource attribute (default: `nodejs-sdk`) |
| `LD_ENVIRONMENT` | `deployment.environment` attribute attached to telemetry |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP endpoint override (default: LaunchDarkly Observability backend) |
