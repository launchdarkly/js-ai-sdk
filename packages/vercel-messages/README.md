# `@launchdarkly/ai-vercel-messages`

Wildcard messages adapter for the Vercel AI SDK. It uses AI SDK 7 `generateText` and `streamText`, so `config.model.name` can be an AI Gateway model id such as `anthropic/claude-sonnet-4`.

## Install

```bash
npm install @launchdarkly/ai-node @launchdarkly/ai-vercel-messages
```

This package does **not** dynamically import `@ai-sdk/openai` (or other provider packages) from `config.provider.name`. That is a LangChain pattern. Vercel AI SDK routing is:

1. **Default — AI Gateway.** The adapter builds Vercel's `creator/model` id from the config provider and model (`xAI` + `grok-4.5` becomes `spacexai/grok-4.5`). An already-qualified id such as `anthropic/claude-sonnet-4` remains unchanged. Authenticate with `AI_GATEWAY_API_KEY` or Vercel OIDC. Provider keys such as `OPENAI_API_KEY` are ignored on this path.
2. **Opt out — inject a model.** Pass `model` or `modelFactory`. The instance is used as-is and Gateway is not consulted:

```ts
import { openai } from '@ai-sdk/openai';
import { vercelMessages } from '@launchdarkly/ai-vercel-messages';

const result = await vercelMessages(key, input, context, {
  modelFactory: (config) => openai(config.model.name),
});
```

All LaunchDarkly providers are handled explicitly. Anthropic, OpenAI, Azure, Gemini, Cohere, DeepSeek, Meta, Mistral, Perplexity, and Vertex map directly. Bedrock, Cortex, Cursor, Databricks, and Fireworks AI infer the creator from a dotted id or known model family and fail locally if ambiguous. AI21 Labs and IBM Watson fail locally because Vercel's current catalog has no corresponding creator; inject a direct model for those providers.

## Usage

```ts
import { vercelMessages } from '@launchdarkly/ai-vercel-messages';

const result = await vercelMessages('support-assistant', 'How do flags work?', {
  kind: 'user',
  key: 'user-123',
});

console.log(result.response);
```

For explicit registration:

```ts
import { config } from '@launchdarkly/ai-node';
import { createVercelMessagesHandler } from '@launchdarkly/ai-vercel-messages';

const caller = config({
  key: 'support-assistant',
  handler: createVercelMessagesHandler({
    modelFactory: async (evaluatedConfig) => myProvider(evaluatedConfig.model.name),
    captureContent: true,
  }),
});
```

The handler advertises `['*', 'messages']`. Register only one wildcard messages adapter at a time; an exact provider handler takes precedence.

## Evaluate

`vercelEvaluate` wraps AI SDK 7 `experimental_evaluate`. The AI Config supplies the evaluation model id (Gateway by default). You supply `state` and `questions`. Inject `model` / `modelFactory` to use a provider `evaluationModel` instance instead of Gateway.

```ts
import { vercelEvaluate } from '@launchdarkly/ai-vercel-messages';

const result = await vercelEvaluate(
  'refund-classifier',
  'The support agent issued a full refund.',
  { kind: 'user', key: 'user-123' },
  {
    questions: {
      refunded: { type: 'boolean', instructions: 'Was a refund issued?' },
    },
  },
);

console.log(result.answers);
```

## Behavior

- Preserves gateway model ids and forwards safe generation parameters.
- Uses native structured messages, JSON Schema output, tools, and streaming.
- Maps text and image history into AI SDK model messages.
- Emits LaunchDarkly-correlated OpenTelemetry spans. Content capture is off by default.
